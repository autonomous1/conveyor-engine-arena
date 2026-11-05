/**
 * `ce-bot connect` — open a seat, print the world model, stay idle.
 * Behaviour is task 15. This file is the Node entry: it may read files and open `ws`.
 */
import { readFileSync } from "node:fs";
import { connectBot } from "./connection.js";
import { openNodeSocket } from "./node-socket.js";

const HELP = `ce-bot connect --url <ws://host> --token-file <path> [--name <name>] [--model <id>] [--scene-graph <file>] [--role bot|qa|player]

Connect to an arena, print a world-model summary every 5s, and stay idle.

Options:
  --url           WebSocket or HTTP URL of the host
  --token-file    File containing an access JWT (hello auth field)
  --name          Display name on hello (default: bot)
  --model         Character id (default: arena.json modelChoices[0])
  --scene-graph   Scene graph JSON used before the host frame arrives
  --role          Expected welcome role: bot, qa, or player
  --help          Show this help
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
    else if (arg === "--role") {
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

async function main(): Promise<void> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.log(HELP);
    process.exit(1);
  }
  if (args.help) {
    console.log(HELP);
    process.exit(0);
  }
  if (args.command === undefined) {
    console.log(HELP);
    process.exit(1);
  }
  if (args.command !== "connect") {
    console.error(`unknown command ${args.command}`);
    console.log(HELP);
    process.exit(1);
  }
  if (!args.url || !args.tokenFile) {
    console.error("connect needs --url and --token-file");
    console.log(HELP);
    process.exit(1);
  }
  const token = readFileSync(args.tokenFile, "utf8").trim();
  const sceneGraph = args.sceneGraph ? JSON.parse(readFileSync(args.sceneGraph, "utf8")) as unknown : undefined;
  const session = await connectBot({
    url: args.url,
    token,
    name: args.name ?? "bot",
    ...(args.role ? { role: args.role } : {}),
    ...(args.model ? { model: args.model } : {}),
    ...(sceneGraph !== undefined ? { sceneGraph } : {}),
    openSocket: openNodeSocket,
    onLog: (line) => console.error(line),
  });
  const print = () => console.log(session.world.summary());
  print();
  const timer = setInterval(print, 5_000);
  const stop = () => {
    clearInterval(timer);
    session.close();
  };
  process.on("SIGINT", () => {
    stop();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    stop();
    process.exit(0);
  });
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
