// Task 140: command parity through the extracted interface. One bot, one
// session; the nine-command matrix plus the deliberate failures run through
// `createCommandHost`/`parseCommand` from src/commands.ts (no mailbox, no
// scenario); one NDJSON row per command and a packed status before/after.
// Run: CE_TOKEN=… node --import ./scripts/ts-ext-register.mjs \
//   packages/bot-client/tests/command-parity.ts --url ws://127.0.0.1:4173 \
//   --label 140-parity --name parity
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { connectBot } from "../src/connection.ts";
import { openNodeSocket } from "../src/node-socket.ts";
import { createCommandHost, parseCommand, type CommandResult, type CommandStatus } from "../src/commands.ts";

const args = new Map<string, string>();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) if (argv[i]!.startsWith("--")) args.set(argv[i]!.slice(2), argv[i + 1] ?? "");
const URL_ = args.get("url") ?? "ws://127.0.0.1:4173";
const LABEL = args.get("label") ?? "140-parity";
const NAME = args.get("name") ?? "parity";
const token = (process.env.CE_TOKEN ?? "").trim() || readFileSync(join(homedir(), ".config/ce-arena/qa-token.pem"), "utf8").trim();
const STAMP = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const LOG = `plan/dsh-tasks/logs/${LABEL}-${STAMP}.log`;
const NDJSON = `plan/dsh-tasks/logs/${LABEL}-${STAMP}.ndjson`;
const HALL = "brutalist-building-1-cbake.floor-1.hall";
const HALL0 = "brutalist-building-1-cbake-0.floor-1.hall";
/** The key approach (outside); the 132 keydoor leg 2. */
const KEY = { x: -7.1, z: 27.6 };
/** The arm's east approach; the 132 keydoor leg 1. */
const EAST = { x: -13.9, z: 16.5 };
const CHECK_MS = 5_000;
const SAMPLE_MS = 250;

mkdirSync("plan/dsh-tasks/logs", { recursive: true });
const t0 = Date.now();
const secs = (): number => Math.round((Date.now() - t0) / 100) / 10;
const round2 = (n: number): number => Math.round(n * 100) / 100;
const lines: string[] = [];
const record = (line: string): void => {
  const row = `t=${secs().toFixed(1)}s ${line}`;
  lines.push(row);
  console.log(row);
  appendFileSync(LOG, `${row}\n`);
};
const rows: Array<Record<string, unknown>> = [];
let done = false;
let issueFlag = false;
let hostRef: ReturnType<typeof createCommandHost> | undefined;

function issue(what: string): void {
  if (issueFlag) return;
  issueFlag = true;
  const row = `ISSUE t=${secs().toFixed(1)}s what=${what} last=${lines[lines.length - 1] ?? "-"}`;
  lines.push(row);
  console.log(row);
  appendFileSync(LOG, `${row}\n`);
  try {
    hostRef?.abort();
  } catch {
    // the host may be idle
  }
}

const session = await connectBot({
  url: URL_,
  token,
  name: NAME,
  role: "qa",
  openSocket: openNodeSocket,
  onLog: (l) => {
    record(`[conn] ${l}`);
    if (!done && (l.includes("connection lost") || l.includes("SERVER_FULL"))) issue(`conn ${l}`);
  },
});
const world = session.world;
const started = Date.now();
while ((!world.self() || !world.sceneGraph()) && Date.now() - started < 15_000) {
  await new Promise((r) => setTimeout(r, 50));
}
const me0 = world.self();
if (!me0) {
  record("FATAL no owned pawn");
  session.close();
  process.exit(2);
}
const host = createCommandHost({ session, log: record });
hostRef = host;
record(`joined self=${me0.id} pos=${me0.x.toFixed(2)},${me0.z.toFixed(2)} place=${world.placeOf(me0)?.id ?? "?"} players=[${[...world.playerIds()].join(",")}] healthSupported=${world.healthOf(me0.id) !== undefined}`);

// The retrieve target: a non-key pickup if the map has one.
const pickups = [...world.pickups()];
const PICKUP = pickups.find((p) => p !== "key" && p !== "alien-weapon-1") ?? pickups.find((p) => p !== "key");

type Step = { id: string; name: string; args: Record<string, unknown>; target?: { x: number; z: number }; expectWhy?: string };
const matrix: Step[] = [
  { id: "m1", name: "arm", args: {} },
  { id: "m2", name: "goto", args: { place: HALL } },
  { id: "m3", name: "stand", args: { x: KEY.x, y: 0, z: KEY.z }, target: KEY },
  { id: "m4", name: "walk", args: { points: [EAST, KEY] }, target: KEY },
  { id: "m5", name: "reload", args: {} },
  { id: "m6", name: "hunt", args: { minutes: 0.5 } },
  { id: "m7", name: "patrol", args: { places: [HALL, HALL0], minutes: 0.5 } },
  ...(PICKUP ? [{ id: "m8", name: "retrieve", args: { pickup: PICKUP } }] : []),
  { id: "m9", name: "getkey", args: {} },
  { id: "f1", name: "goto", args: {}, expectWhy: "bad-args" },
  { id: "f2", name: "stand", args: { x: KEY.x, y: 99, z: KEY.z }, expectWhy: "wrong-floor" },
  { id: "f3", name: "stand", args: { x: "bad", y: 0, z: 0 }, expectWhy: "bad-args" },
  { id: "f4", name: "hunt", args: { minutes: 0.2 }, expectWhy: "bad-args" },
  { id: "f5", name: "nope", args: {}, expectWhy: "unknown-task" },
];

let lastSample: { x: number; z: number; task: string | null } | null = null;
const checkTimer = setInterval(() => {
  if (done || issueFlag) return;
  let s: CommandStatus;
  try {
    s = host.status("check");
  } catch (err) {
    issue(`status-threw ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  const pos = s.pos ? { x: s.pos[0], z: s.pos[2] } : null;
  const task = s.task;
  const row = `CHECK t=${secs().toFixed(1)}s task=${task ?? "-"} pos=${pos ? `${pos.x.toFixed(2)},${pos.z.toFixed(2)}` : "-"} place=${s.place} hp=${s.hp ?? "-"} dead=${s.dead ? 1 : 0}`;
  lines.push(row);
  console.log(row);
  appendFileSync(LOG, `${row}\n`);
  if (pos && lastSample && task && (task === "walk" || task === "stand") && lastSample.task === task && Math.hypot(pos.x - lastSample.x, pos.z - lastSample.z) < 0.05) {
    issue(`frozen task=${task}`);
  }
  lastSample = pos ? { x: pos.x, z: pos.z, task } : null;
}, CHECK_MS);

let okCount = 0;
let failCount = 0;
try {
  for (const step of matrix) {
    if (issueFlag) break;
    const before = host.status(step.id);
    record(`STATUS before id=${step.id} ${JSON.stringify(before)}`);
    record(`TASK start name=${step.name} id=${step.id}`);
    const at = Date.now();
    let result: CommandResult;
    const parsed = parseCommand({ name: step.name, args: step.args });
    if ("error" in parsed) {
      result = { ok: false, code: 1, why: parsed.error };
    } else {
      result = await host.dispatch({ id: step.id, name: step.name, args: step.args }, { onLine: (line) => record(`  ${line}`) });
    }
    const ms = Date.now() - at;
    const after = host.status(step.id);
    const ok = result.ok;
    const why = result.ok ? null : result.why;
    const code = result.ok ? (result.code ?? 0) : result.code;
    record(`TASK ${ok ? "done" : "fail"} name=${step.name} ok=${ok ? 1 : 0} code=${code} why=${why ?? "-"} ms=${ms}`);
    record(`STATUS after id=${step.id} ${JSON.stringify(after)}`);
    const pos = after.pos ? { x: after.pos[0], z: after.pos[2] } : null;
    const d = step.target && pos ? Math.hypot(pos.x - step.target.x, pos.z - step.target.z) : null;
    const row: Record<string, unknown> = {
      t: Number(secs().toFixed(1)),
      id: step.id,
      name: step.name,
      args: step.args,
      ok,
      code,
      why,
      ms,
      statusBefore: before,
      statusAfter: after,
      pos: pos ? [round2(pos.x), round2(pos.z)] : null,
      d: d === null ? null : round2(d),
    };
    if (step.name === "arm") {
      row.weapon = after.weapon;
      row.ammo = after.ammo;
    }
    if (step.name === "hunt" && result.ok && result.data) {
      row.kills = result.data.kills;
      row.shots = result.data.shots;
    }
    if (step.name === "reload" && result.ok && result.data) {
      row.ammo = result.data.ammo;
      row.crate = result.data.crate;
    }
    rows.push(row);
    appendFileSync(NDJSON, `${JSON.stringify(row)}\n`);
    record(`ROW ${JSON.stringify(row)}`);
    if (ok) okCount += 1;
    else failCount += 1;
    if (step.expectWhy !== undefined && (ok || why !== step.expectWhy)) {
      issue(`why-drift ${step.id} expected=${step.expectWhy} got=${ok ? "ok" : why}`);
    }
    // A brief settle between commands so the 5 s CHECK sees the idle task.
    await new Promise((r) => setTimeout(r, SAMPLE_MS));
  }
} catch (err) {
  issue(`driver-error ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
} finally {
  done = true;
  clearInterval(checkTimer);
  try {
    record(`EXIT rows=${rows.length} ok=${okCount} fail=${failCount} elapsed=${secs()}s`);
  } catch {
    // best effort
  }
  session.close();
}
process.exit(issueFlag ? 1 : 0);
