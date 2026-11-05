/**
 * `ce-bot` — connect and idle, or run a mission.
 * Node stays here: argv, the token file, and `ws`. The brain does not import it.
 * A kick does not stick. After the seat drops, task 14's reconnect loop joins again.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { runMission } from "./brain.js";
import { BotAuthRejected, BotRejected, connectBot, type BotSession } from "./connection.js";
import { parseMission } from "./missions.js";
import { openNodeSocket } from "./node-socket.js";

const HELP = `ce-bot connect --url <ws://host> --token-file <path> [--name <name>] [--model <id>] [--scene-graph <file>] [--role bot|qa|player]
ce-bot run --url <ws://host> --token-file <path> --goal <mission> [--name <name>] [--model <id>] [--scene-graph <file>] [--role bot|qa] [--count <n>] [--timeout-s <seconds>]

connect  Open a seat, print a world-model summary every 5s, and stay idle.
run      Chase a mission until it is met, it cannot be planned, or the timeout.

Goals:
  retrieve:<pickup>@<place>   Pick up <pickup>. The place is the goal name.
  reach:<place>               Stand in <place>.
  patrol:<place>,<place>,…   Loop reach until the timeout.
  idle                        Succeed immediately.

Options:
  --url           WebSocket or HTTP URL of the host
  --token-file    File containing an access JWT (hello auth field)
  --name          Display name on hello (default: bot). Ignored when --count > 1.
  --model         Character id (default: arena.json modelChoices[0])
  --scene-graph   Scene graph JSON used before the host frame arrives
  --role          Expected welcome role. connect has no default. run defaults to bot.
  --goal          Mission text (run only)
  --count         Connections to open (run only, default 1). Names are bot-1..bot-N when count > 1.
  --timeout-s     Seconds before run gives up (default 300)
  --help          Show this help

Exit codes: 0 goal met, 1 usage or connection error, 2 no plan, 3 timeout, 4 auth or seat rejected.
`;

type Role = "bot" | "qa" | "player";

type Args = {
  help: boolean;
  command?: string;
  url?: string;
  tokenFile?: string;
  name?: string;
  model?: string;
  sceneGraph?: string;
  role?: Role;
  goal?: string;
  count?: number;
  timeoutS?: number;
};

type Io = {
  log: (line: string) => void;
  error: (line: string) => void;
  /** Install SIGINT/SIGTERM only for the process entry, not when a test imports this file. */
  signals?: boolean;
};

function parseArgs(argv: readonly string[]): Args {
  const out: Args = { help: false };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") {
      out.help = true;
      continue;
    }
    const value = (): string => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`missing value for ${arg}`);
      i += 1;
      return next;
    };
    if (arg === "--url") out.url = value();
    else if (arg === "--token-file") out.tokenFile = value();
    else if (arg === "--name") out.name = value();
    else if (arg === "--model") out.model = value();
    else if (arg === "--scene-graph") out.sceneGraph = value();
    else if (arg === "--goal") out.goal = value();
    else if (arg === "--count") {
      const text = value();
      const count = Number(text);
      if (!Number.isInteger(count) || count < 1) throw new Error(`bad count ${text}`);
      out.count = count;
    } else if (arg === "--timeout-s") {
      const text = value();
      const timeoutS = Number(text);
      if (!Number.isFinite(timeoutS) || timeoutS <= 0) throw new Error(`bad timeout ${text}`);
      out.timeoutS = timeoutS;
    } else if (arg === "--role") {
      const role = value();
      if (role !== "bot" && role !== "qa" && role !== "player") throw new Error(`bad role ${role}`);
      out.role = role;
    } else if (arg.startsWith("--")) throw new Error(`unknown option ${arg}`);
    else rest.push(arg);
  }
  out.command = rest[0];
  if (rest.length > 1) throw new Error(`unexpected ${rest.slice(1).join(" ")}`);
  return out;
}

function rejectCode(err: unknown): number {
  if (err instanceof BotAuthRejected) return 4;
  if (err instanceof BotRejected && err.code === "SERVER_FULL") return 4;
  return 1;
}

function rejectLine(err: unknown): string {
  if (err instanceof BotRejected && err.code === "SERVER_FULL") return "SERVER_FULL: no free seat";
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Parse argv and run. Returns the process exit code. Does not call `process.exit`. */
export async function runCli(argv: readonly string[], io: Partial<Io> = {}): Promise<number> {
  const log = io.log ?? ((line: string) => console.log(line));
  const error = io.error ?? ((line: string) => console.error(line));
  const sessions: BotSession[] = [];
  const stop = (): void => {
    for (const session of sessions) session.close();
  };
  if (io.signals) {
    process.on("SIGINT", () => {
      stop();
      process.exit(0);
    });
    process.on("SIGTERM", () => {
      stop();
      process.exit(0);
    });
  }

  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    log(HELP);
    return 1;
  }
  if (args.help) {
    log(HELP);
    return 0;
  }
  if (args.command === undefined) {
    log(HELP);
    return 1;
  }
  if (args.command !== "connect" && args.command !== "run") {
    error(`unknown command ${args.command}`);
    log(HELP);
    return 1;
  }
  if (!args.url || !args.tokenFile) {
    error(`${args.command} needs --url and --token-file`);
    log(HELP);
    return 1;
  }
  if (args.command === "run" && !args.goal) {
    error("run needs --goal");
    log(HELP);
    return 1;
  }
  const mission = args.command === "run" ? parseMission(args.goal ?? "") : undefined;
  if (args.command === "run" && !mission) {
    error(`bad goal ${args.goal}`);
    log(HELP);
    return 1;
  }

  let token = "";
  let sceneGraph: unknown;
  try {
    token = readFileSync(args.tokenFile, "utf8").trim();
    if (args.sceneGraph) sceneGraph = JSON.parse(readFileSync(args.sceneGraph, "utf8")) as unknown;
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    log(HELP);
    return 1;
  }

  const count = args.command === "run" ? args.count ?? 1 : 1;
  const role = args.command === "run" ? args.role ?? "bot" : args.role;
  const timeoutMs = (args.timeoutS ?? 300) * 1000;

  try {
    for (let i = 0; i < count; i += 1) {
      const name = count > 1 ? `bot-${i + 1}` : args.name ?? "bot";
      const session = await connectBot({
        url: args.url,
        token,
        name,
        ...(role ? { role } : {}),
        ...(args.model ? { model: args.model } : {}),
        ...(sceneGraph !== undefined ? { sceneGraph } : {}),
        openSocket: openNodeSocket,
        onLog: (line) => error(line),
      });
      sessions.push(session);
    }
  } catch (err) {
    stop();
    error(rejectLine(err));
    return rejectCode(err);
  }

  if (args.command === "connect") {
    const session = sessions[0]!;
    const print = () => log(session.world.summary());
    print();
    const timer = setInterval(print, 5_000);
    return new Promise(() => {
      // SIGINT/SIGTERM close the session when this process is the entry.
      void timer;
    });
  }

  const codes = await Promise.all(sessions.map((session) => runMission(session, mission!, {
    timeoutMs,
    log,
    error,
  })));
  stop();
  return codes.find((code) => code !== 0) ?? 0;
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  runCli(process.argv.slice(2), { signals: true }).then((code) => {
    process.exit(code);
  }).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
