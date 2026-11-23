// Task 147 split probe: does the frozen session's host admit the client's
// inputs? Every 250 ms it records the host's admitted input seq (`PROC
// processed=`, the snapshot's `lastProcessedInput`, read from the kernel
// client's `lastAckInput` through `session.net`), the driver's send attempts,
// the snapshots applied, and the world pose; the 500 ms `POSE` sampler is the
// second witness. Trials:
//   r4 — one bot on a freshly restarted host, the 140 patrol (`pickup:key`).
//   r5 — A joins, walks ~2 m off the pad, clean close; B rejoins (inherits A's
//        end pose) and runs the same patrol.
//   r7 — A patrols once (picks up the key), clean close holding it; B rejoins
//        (inherits pose + key) and patrols into the hall — the R5 freeze recipe.
//   r1 — the 145 patrol trial (kept for the moving comparison).
//   r2 — a raw 15 s walk; r3 — `retrieve:key@outside` (the 145 side trials).
// No mission timeout change; no reconnect. `t` is session-local (it restarts
// at each join), so R5's A and B are read as two windows in one log.
// Run: CE_TOKEN=… node --import ./scripts/ts-ext-register.mjs \
//   packages/bot-client/tests/probe-patrol-freeze.ts --url ws://127.0.0.1:4173 \
//   --trial r4 --name freeze-147 --dir plan/dsh-tasks/logs/147-r4
import { appendFileSync, copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join as pathJoin } from "node:path";
import { connectBot, type BotSession } from "../src/connection.ts";
import { openNodeSocket } from "../src/node-socket.ts";
import { runMission } from "../src/brain.ts";
import { parseMission } from "../src/missions.ts";
import { wishTo } from "../../../src/shared/nav/follow.ts";

const args = new Map<string, string>();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) if (argv[i]!.startsWith("--")) args.set(argv[i]!.slice(2), argv[i + 1] ?? "");
const URL_ = args.get("url") ?? "ws://127.0.0.1:4173";
const LABEL = args.get("label") ?? "147";
const NAME = args.get("name") ?? "freeze-147";
const TRIAL = (args.get("trial") ?? "r4").toLowerCase();
const DIR = args.get("dir") ?? `plan/dsh-tasks/logs/${LABEL}-${TRIAL}`;
const token = (process.env.CE_TOKEN ?? "").trim() || readFileSync(pathJoin(homedir(), ".config/ce-arena/qa-token.pem"), "utf8").trim();
const STAMP = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const NDJSON = `plan/dsh-tasks/logs/${LABEL}-${STAMP}-${TRIAL}.ndjson`;
const HALL = "brutalist-building-1-cbake.floor-1.hall";
const HALL0 = "brutalist-building-1-cbake-0.floor-1.hall";
const PAD = { x: -6.85, z: 2.31 };
const WALK_TARGET = { x: -5.39, z: 2.79 };

mkdirSync(DIR, { recursive: true });
mkdirSync("plan/dsh-tasks/logs", { recursive: true });
let t0 = Date.now();
const secs = (): number => Math.round((Date.now() - t0) / 100) / 10;
const r2 = (n: number): number => Math.round(n * 100) / 100;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const record = (who: string, line: string): void => {
  console.log(`t=${secs().toFixed(1)}s [${who}] ${line}`);
};
const ndjson = (o: Record<string, unknown>): void => {
  appendFileSync(NDJSON, `${JSON.stringify({ t: Number(secs().toFixed(1)), ...o })}\n`);
};
const where = (s: BotSession): { x: number; z: number } | undefined => {
  const me = s.world.self();
  return me ? { x: me.x, z: me.z } : undefined;
};
const fmt = (p: { x: number; z: number } | undefined): string => (p ? `${r2(p.x)},${r2(p.z)}` : "none");

/** Join one live seat and wait for its pawn + scene graph. */
async function join(name: string, who: string): Promise<BotSession> {
  record(who, `CONNECT name=${name} url=${URL_}`);
  const s = await connectBot({
    url: URL_,
    token,
    name,
    role: "qa",
    openSocket: openNodeSocket,
    onLog: (l) => record(who, `[conn] ${l}`),
  });
  const started = Date.now();
  while ((!s.world.self() || !s.world.sceneGraph()) && Date.now() - started < 15_000) await sleep(50);
  if (!s.world.self()) {
    record(who, "FATAL no owned pawn");
    s.close();
    process.exit(2);
  }
  return s;
}

type Obs = { sends: () => number; stop: () => void };

/**
 * Install the per-session instruments: the send wrapper (first and every 10th
 * frame), the 250 ms PROC sampler, the 500 ms POSE sampler, and SEND-NONE.
 * Resets the session clock so `t` starts at this join.
 */
function observe(session: BotSession, who: string): Obs {
  t0 = Date.now();
  const rawSend = session.input.sendInput.bind(session.input);
  let sends = 0;
  let lastSendAt = Date.now();
  let lastCmd = { moveX: 0, moveZ: 0, yaw: 0 };
  session.input.sendInput = (cmd) => {
    sends += 1;
    lastSendAt = Date.now();
    lastCmd = { moveX: cmd.moveX, moveZ: cmd.moveZ, yaw: cmd.yaw };
    if (sends === 1 || sends % 10 === 0) {
      record(who, `SEND n=${sends} moveX=${r2(cmd.moveX)} moveZ=${r2(cmd.moveZ)} yaw=${r2(cmd.yaw)}`);
    }
    ndjson({ kind: "send", sess: who, n: sends, moveX: r2(cmd.moveX), moveZ: r2(cmd.moveZ), yaw: r2(cmd.yaw) });
    rawSend(cmd);
    if (sends % 10 === 0) proc();
  };
  const noneTimer = setInterval(() => {
    if (Date.now() - lastSendAt >= 1000) {
      record(who, `SEND-NONE n=${sends} lastMove=${r2(lastCmd.moveX)},${r2(lastCmd.moveZ)}`);
      ndjson({ kind: "send-none", sess: who, n: sends, lastMove: lastCmd });
    }
  }, 1000);
  const proc = (): void => {
    const me = session.world.self();
    if (!me) return;
    const processed = session.net.processedInput();
    const snap = session.net.snapshots();
    const stale = session.net.stale();
    const frames = session.net.frames();
    record(who, `PROC processed=${processed} sent=${sends} snap=${snap} stale=${stale} frames=${frames} self=${r2(me.x)},${r2(me.z)} place=${session.world.placeOf(me)?.id ?? "?"}`);
    ndjson({ kind: "proc", sess: who, processed, sent: sends, snap, stale, frames, x: r2(me.x), z: r2(me.z) });
  };
  const procTimer = setInterval(proc, 250);
  const poseTimer = setInterval(() => {
    const me = session.world.self();
    if (!me) return;
    const place = session.world.placeOf(me)?.id ?? "?";
    const h = session.world.healthOf(me.id);
    const doorsOpen = session.world.doors().filter((d) => d.open).length;
    record(who, `POSE x=${r2(me.x)} y=${r2(me.y)} z=${r2(me.z)} place=${place} hp=${h?.hp ?? "?"} dead=${h?.dead ? 1 : 0} keys=[${session.world.keys().join(",")}] doorsOpen=${doorsOpen}`);
    ndjson({ kind: "pose", sess: who, x: r2(me.x), y: r2(me.y), z: r2(me.z), place, hp: h?.hp ?? null, dead: h?.dead ?? null, keys: session.world.keys(), doorsOpen });
  }, 500);
  return {
    sends: () => sends,
    stop() {
      clearInterval(noneTimer);
      clearInterval(procTimer);
      clearInterval(poseTimer);
    },
  };
}

/** The join record: the seat, the input link's baseline, the pose, the key. */
function hostLine(s: BotSession, who: string): void {
  const me = s.world.self();
  if (!me) return;
  record(who, `HOST self=${me.id} spectate=${s.spectate} role=${s.world.role() ?? "?"} scope=[${(s.world.scope() ?? []).join(",")}] players=[${[...s.world.playerIds()].join(",")}] processedInput=${s.net.processedInput()} snapshots=${s.net.snapshots()} frames=${s.net.frames()}`);
  record(who, `POSE-start x=${r2(me.x)} y=${r2(me.y)} z=${r2(me.z)} place=${s.world.placeOf(me)?.id ?? "?"}`);
  const placements = s.world.pickupPlacements();
  const keyRow = placements.find((p) => p.id === "key");
  record(who, `KEY present=${s.world.pickups().includes("key")} pickups=${s.world.pickups().length} keys=[${s.world.keys().join(",")}] doorsOpen=${s.world.doors().filter((d) => d.open).length}`);
  record(who, `KEY placement=${keyRow ? `x${r2(keyRow.minX)}..${r2(keyRow.maxX)} y${r2(keyRow.minY)}..${r2(keyRow.maxY)} z${r2(keyRow.minZ)}..${r2(keyRow.maxZ)}` : "none"}`);
  ndjson({ kind: "host", sess: who, self: me.id, spectate: s.spectate, processedInput: s.net.processedInput(), keys: s.world.keys(), pickups: s.world.pickups() });
}

/** One live seat from join to clean close; `fn` is the trial body. */
async function withSession(
  name: string,
  who: string,
  fn: (s: BotSession, who: string) => Promise<number | null>,
): Promise<number | null> {
  const s = await join(name, who);
  const obs = observe(s, who);
  hostLine(s, who);
  let code: number | null = null;
  try {
    code = await fn(s, who);
  } catch (err) {
    record(who, `FATAL ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    ndjson({ kind: "fatal", sess: who, error: String(err) });
  } finally {
    obs.stop();
    record(who, `EXIT trial=${TRIAL} code=${code ?? "-"} sends=${obs.sends()} elapsed=${secs()}s ndjson=${NDJSON}`);
    s.close();
  }
  return code;
}

/** The 140 patrol: the same plan (`steps=4`, `pickup:key`), 30 s timeout. */
async function patrol(s: BotSession, who: string): Promise<number | null> {
  record(who, `TRIAL ${TRIAL} patrol [hall, hall0] (30 s timeout)`);
  const mission = parseMission(`patrol:${HALL},${HALL0}`);
  if (!mission) {
    record(who, "FATAL bad mission");
    return null;
  }
  const log = (line: string): void => {
    record(who, `ACTION ${line}`);
    ndjson({ kind: "action", sess: who, line });
  };
  const error = (line: string): void => {
    record(who, `ACTION-ERR ${line}`);
    ndjson({ kind: "action", sess: who, line, err: true });
  };
  return runMission(s, mission, { timeoutMs: 30_000, log, error });
}

/** Walk toward a point for at most `seconds`, stopping within 0.1 m. */
async function walkTo(s: BotSession, target: { x: number; z: number }, seconds: number): Promise<void> {
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    const me = s.world.self();
    if (!me) break;
    const dx = target.x - me.x;
    const dz = target.z - me.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.1) break;
    s.input.sendInput({ moveX: dx / d, moveZ: dz / d, yaw: Math.atan2(dx, dz) });
    await sleep(50);
  }
}

/** A → clean close → B rejoins on the inherited pose → the 140 patrol. */
async function runR5(): Promise<void> {
  const a0 = { x: 0, z: 0 };
  let aEnd: { x: number; z: number } | undefined;
  await withSession(`${NAME}-a`, "A", async (s, who) => {
    const me0 = s.world.self()!;
    a0.x = me0.x;
    a0.z = me0.z;
    record(who, `A JOIN x=${r2(me0.x)} z=${r2(me0.z)} (walk ~2 m to ${WALK_TARGET.x},${WALK_TARGET.z}, 1 s)`);
    await walkTo(s, WALK_TARGET, 2);
    const me1 = s.world.self()!;
    aEnd = { x: me1.x, z: me1.z };
    record(who, `A END x=${r2(me1.x)} z=${r2(me1.z)} moved=${r2(Math.hypot(me1.x - a0.x, me1.z - a0.z))}`);
    return null;
  });
  await sleep(800);
  const movedA = aEnd ? Math.hypot(aEnd.x - a0.x, aEnd.z - a0.z) : 0;
  if (!aEnd || movedA < 0.5) {
    record("A", `FATAL A did not move off the pad (moved=${r2(movedA)}) — R5 invalid`);
    process.exit(3);
  }
  record("B", `BASELINE inherited-expected=${fmt(aEnd)} (A's end pose; pad=${PAD.x},${PAD.z})`);
  await withSession(NAME, "B", async (s, who) => {
    const b0 = s.world.self()!;
    record(who, `B JOIN x=${r2(b0.x)} z=${r2(b0.z)} delta-from-A-end=${r2(Math.hypot(b0.x - aEnd!.x, b0.z - aEnd!.z))}`);
    await sleep(400);
    const b1 = s.world.self()!;
    record(who, `B IDLE-400ms x=${r2(b1.x)} z=${r2(b1.z)}`);
    ndjson({ kind: "join", sess: who, aEnd: { x: r2(aEnd!.x), z: r2(aEnd!.z) }, b0: { x: r2(b0.x), z: r2(b0.z) }, b1: { x: r2(b1.x), z: r2(b1.z) } });
    return patrol(s, who);
  });
}

/** A collects the key with the patrol, closes holding it; B inherits pose+key and patrols. */
async function runR7(): Promise<void> {
  let aEnd: { x: number; z: number } | undefined;
  let aKeys: string[] = [];
  await withSession(`${NAME}-a`, "A", async (s, who) => {
    record(who, "A patrol #1 collects the key (expected: pickup:key then no plan: unsatisfiable)");
    const code = await patrol(s, who);
    const me = s.world.self()!;
    aEnd = { x: me.x, z: me.z };
    aKeys = s.world.keys();
    record(who, `A END x=${r2(me.x)} z=${r2(me.z)} keys=[${aKeys.join(",")}] pickup-key-present=${s.world.pickups().includes("key")} code=${code ?? "-"}`);
    ndjson({ kind: "join", sess: who, phase: "a-end", keys: aKeys, x: r2(me.x), z: r2(me.z) });
    return code;
  });
  await sleep(800);
  if (!aEnd || !aKeys.includes("key")) {
    record("A", `FATAL A did not hold the key after patrol #1 (keys=[${aKeys.join(",")}]) — r7 invalid`);
    process.exit(3);
  }
  record("B", `BASELINE inherited-expected=${fmt(aEnd)} key=held (A's end pose)`);
  await withSession(NAME, "B", async (s, who) => {
    const b0 = s.world.self()!;
    record(who, `B JOIN x=${r2(b0.x)} z=${r2(b0.z)} delta-from-A-end=${r2(Math.hypot(b0.x - aEnd!.x, b0.z - aEnd!.z))} keys=[${s.world.keys().join(",")}] pickup-key-present=${s.world.pickups().includes("key")}`);
    await sleep(400);
    const b1 = s.world.self()!;
    record(who, `B IDLE-400ms x=${r2(b1.x)} z=${r2(b1.z)}`);
    ndjson({ kind: "join", sess: who, aEnd: { x: r2(aEnd!.x), z: r2(aEnd!.z) }, b0: { x: r2(b0.x), z: r2(b0.z) }, b1: { x: r2(b1.x), z: r2(b1.z) }, keys: s.world.keys() });
    return patrol(s, who);
  });
}

try {
  record("RUN", `START trial=${TRIAL} name=${NAME} wall=${new Date().toISOString()} url=${URL_}`);
  if (TRIAL === "r7") {
    await runR7();
  } else if (TRIAL === "r5") {
    await runR5();
  } else if (TRIAL === "r2") {
    await withSession(NAME, "BOT", async (s, who) => {
      record(who, "TRIAL r2 raw walk to -13.9,16.5 for 15 s");
      const until = Date.now() + 15_000;
      while (Date.now() < until) {
        const me = s.world.self();
        if (!me) break;
        s.input.sendInput(wishTo({ x: me.x, y: me.y, z: me.z, vx: 0, vz: 0, yaw: me.yaw }, { x: -13.9, z: 16.5 }, 1));
        await sleep(50);
      }
      return null;
    });
  } else if (TRIAL === "r3") {
    await withSession(NAME, "BOT", async (s, who) => {
      record(who, "TRIAL r3 retrieve:key@outside (30 s timeout)");
      const mission = parseMission("retrieve:key@outside");
      if (!mission) {
        record(who, "FATAL bad mission");
        return null;
      }
      const log = (line: string): void => {
        record(who, `ACTION ${line}`);
        ndjson({ kind: "action", sess: who, line });
      };
      const error = (line: string): void => {
        record(who, `ACTION-ERR ${line}`);
        ndjson({ kind: "action", sess: who, line, err: true });
      };
      return runMission(s, mission, { timeoutMs: 30_000, log, error });
    });
  } else {
    await withSession(NAME, "BOT", patrol);
  }
} catch (err) {
  record("RUN", `FATAL ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  ndjson({ kind: "fatal", error: String(err) });
} finally {
  try {
    copyFileSync(NDJSON, pathJoin(DIR, `${LABEL}-${STAMP}-${TRIAL}.ndjson`));
  } catch {
    // the logs copy is the evidence; the raw copy is best effort
  }
}
process.exit(0);
