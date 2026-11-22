// Task 145 spike: which layer freezes the pawn during the 140 patrol's
// `pickup:key`? One session; a send wrapper and a 500 ms pose/keys/doors
// sampler around runMission; the trial is the argument (r1 patrol, r2 raw walk,
// r3 retrieve:key, r4 = r1 on a fresh host). No source change; the host's
// `lastProcessedInput` is not exposed to the bot client, so the SEND counts and
// the world's pose are the evidence.
// Run: CE_TOKEN=… node --import ./scripts/ts-ext-register.mjs \
//   packages/bot-client/tests/probe-patrol-freeze.ts --url ws://127.0.0.1:4173 \
//   --trial r1 --dir plan/dsh-tasks/live/145-freeze
import { appendFileSync, copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { connectBot } from "../src/connection.ts";
import { openNodeSocket } from "../src/node-socket.ts";
import { runMission } from "../src/brain.ts";
import { parseMission } from "../src/missions.ts";
import { wishTo } from "../../../src/shared/nav/follow.ts";

const args = new Map<string, string>();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) if (argv[i]!.startsWith("--")) args.set(argv[i]!.slice(2), argv[i + 1] ?? "");
const URL_ = args.get("url") ?? "ws://127.0.0.1:4173";
const LABEL = args.get("label") ?? "145-freeze";
const NAME = args.get("name") ?? "freeze-probe";
const TRIAL = (args.get("trial") ?? "r1").toLowerCase();
const DIR = args.get("dir") ?? "plan/dsh-tasks/live/145-freeze";
const token = (process.env.CE_TOKEN ?? "").trim() || readFileSync(join(homedir(), ".config/ce-arena/qa-token.pem"), "utf8").trim();
const STAMP = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const NDJSON = `plan/dsh-tasks/logs/${LABEL}-${STAMP}-${TRIAL}.ndjson`;

mkdirSync(DIR, { recursive: true });
mkdirSync("plan/dsh-tasks/logs", { recursive: true });
const t0 = Date.now();
const secs = (): number => Math.round((Date.now() - t0) / 100) / 10;
const round2 = (n: number): number => Math.round(n * 100) / 100;
const record = (line: string): void => {
  console.log(`t=${secs().toFixed(1)}s ${line}`);
};
const ndjson = (o: Record<string, unknown>): void => {
  appendFileSync(NDJSON, `${JSON.stringify({ t: Number(secs().toFixed(1)), ...o })}\n`);
};

const session = await connectBot({
  url: URL_,
  token,
  name: NAME,
  role: "qa",
  openSocket: openNodeSocket,
  onLog: (l) => record(`[conn] ${l}`),
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
record(`HOST self=${me0.id} spectate=${session.spectate} role=${world.role() ?? "?"} scope=[${(world.scope() ?? []).join(",")}] players=[${[...world.playerIds()].join(",")}] lastProcessedInput=not-exposed`);
record(`POSE-start x=${round2(me0.x)} y=${round2(me0.y)} z=${round2(me0.z)} place=${world.placeOf(me0)?.id ?? "?"}`);
const placements = world.pickupPlacements();
const keyRow = placements.find((p) => p.id === "key");
record(`KEY present=${world.pickups().includes("key")} keys=[${world.keys().join(",")}] pickups=[${world.pickups().join(",")}] doorsOpen=${world.doors().filter((d) => d.open).length}`);
record(`KEY placement=${keyRow ? `x${round2(keyRow.minX)}..${round2(keyRow.maxX)} y${round2(keyRow.minY)}..${round2(keyRow.maxY)} z${round2(keyRow.minZ)}..${round2(keyRow.maxZ)}` : "none"}`);
ndjson({ kind: "host", self: me0.id, spectate: session.spectate, keys: world.keys(), pickups: world.pickups() });

// --- the send wrapper: the first and every 10th frame; SEND-NONE after 1 s ---
const rawSend = session.input.sendInput.bind(session.input);
let sends = 0;
let lastSendAt = Date.now();
let lastCmd = { moveX: 0, moveZ: 0, yaw: 0 };
session.input.sendInput = (cmd) => {
  sends += 1;
  lastSendAt = Date.now();
  lastCmd = { moveX: cmd.moveX, moveZ: cmd.moveZ, yaw: cmd.yaw };
  if (sends === 1 || sends % 10 === 0) {
    record(`SEND t=${secs()} n=${sends} moveX=${round2(cmd.moveX)} moveZ=${round2(cmd.moveZ)} yaw=${round2(cmd.yaw)}`);
  }
  ndjson({ kind: "send", n: sends, moveX: round2(cmd.moveX), moveZ: round2(cmd.moveZ), yaw: round2(cmd.yaw) });
  rawSend(cmd);
};
const noneTimer = setInterval(() => {
  if (Date.now() - lastSendAt >= 1000) {
    record(`SEND-NONE t=${secs()} n=${sends} lastMove=${round2(lastCmd.moveX)},${round2(lastCmd.moveZ)}`);
    ndjson({ kind: "send-none", n: sends, lastMove: lastCmd });
  }
}, 1000);

// --- the pose/keys/doors sampler ---
const poseTimer = setInterval(() => {
  const me = world.self();
  if (!me) return;
  const place = world.placeOf(me)?.id ?? "?";
  const h = world.healthOf(me.id);
  const row = `POSE t=${secs()} x=${round2(me.x)} y=${round2(me.y)} z=${round2(me.z)} place=${place} hp=${h?.hp ?? "?"} dead=${h?.dead ? 1 : 0} keys=[${world.keys().join(",")}] doorsOpen=${world.doors().filter((d) => d.open).length}`;
  record(row);
  ndjson({ kind: "pose", x: round2(me.x), y: round2(me.y), z: round2(me.z), place, hp: h?.hp ?? null, dead: h?.dead ?? null, keys: world.keys(), doorsOpen: world.doors().filter((d) => d.open).length });
}, 500);

const log = (line: string): void => {
  record(`ACTION ${line}`);
  ndjson({ kind: "action", line });
};
const error = (line: string): void => {
  record(`ACTION-ERR ${line}`);
  ndjson({ kind: "action", line, err: true });
};

let code: number | null = null;
try {
  if (TRIAL === "r2") {
    record("TRIAL r2 raw walk to -13.9,16.5 for 15 s");
    const until = Date.now() + 15_000;
    while (Date.now() < until) {
      const me = world.self();
      if (!me) break;
      session.input.sendInput(wishTo({ x: me.x, y: me.y, z: me.z, vx: 0, vz: 0, yaw: me.yaw }, { x: -13.9, z: 16.5 }, 1));
      await new Promise((r) => setTimeout(r, 50));
    }
  } else if (TRIAL === "r3") {
    record("TRIAL r3 retrieve:key@outside (30 s timeout)");
    const mission = parseMission("retrieve:key@outside");
    if (!mission) record("FATAL bad mission");
    else code = await runMission(session, mission, { timeoutMs: 30_000, log, error });
  } else {
    record(`TRIAL ${TRIAL} patrol [hall, hall0] (30 s timeout)`);
    const mission = parseMission("patrol:brutalist-building-1-cbake.floor-1.hall,brutalist-building-1-cbake-0.floor-1.hall");
    if (!mission) record("FATAL bad mission");
    else code = await runMission(session, mission, { timeoutMs: 30_000, log, error });
  }
} catch (err) {
  record(`FATAL ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  ndjson({ kind: "fatal", error: String(err) });
} finally {
  clearInterval(noneTimer);
  clearInterval(poseTimer);
  try {
    copyFileSync(NDJSON, join(DIR, `${LABEL}-${STAMP}-${TRIAL}.ndjson`));
  } catch {
    // the logs copy is the evidence; the raw copy is best effort
  }
  record(`EXIT trial=${TRIAL} code=${code ?? "-"} sends=${sends} elapsed=${secs()}s ndjson=${NDJSON}`);
  session.close();
}
process.exit(0);
