// Task 123: one persistent bot as a message-driven command surface.
//
// Commands arrive as data on two ingresses:
//   mailbox: <dir>/inbox.ndjson   {"cmd":"task","id":"c1","name":"arm","args":{}}
//   msg:     the host frame      {"t":"cmd","id":"c1","name":"arm","args":{}}
// A small registry runs them one at a time (status excepted), and every task
// reports `start` then exactly one `done`/`fail`, plus a packed `status`.
// Replies go to the outbox always, and back to the sender via `say` for msg
// commands. The mailbox/transport machinery is the task-122 `live-link` fork.
//
// The host is also the session recorder, so the relay no longer assembles its
// statistics from logs by hand:
//   <dir>/transcript.ndjson  one row per dispatched command, appended; the row's
//                            statusAfter is the packed status at task end
//   <dir>/session.json       the roll-up, overwritten at EXIT
//   <dir>/notes.md           `{"cmd":"note","text":"…"}` appended as a bullet
// Transcript and notes append across sessions; session.json is per session.
//
//   --scenario <file>   run an NDJSON step list over the msg loopback (to selfId)
//   no --scenario       live mailbox command host
//
// Run: CE_TOKEN=… node --import ./scripts/ts-ext-register.mjs \
//   packages/bot-client/tests/command-host.ts --url ws://127.0.0.1:4173 \
//   --dir plan/dsh-tasks/live/123-cmd --label 123-cmd --name cmd-host \
//   [--scenario packages/bot-client/tests/scenarios/c1.ndjson]
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { connectBot } from "../src/connection.ts";
import { openNodeSocket } from "../src/node-socket.ts";
import { runMission } from "../src/brain.ts";
import { NOTE_MAX, openMailbox } from "../src/mailbox.ts";
import { parseMission } from "../src/missions.ts";
import { hasLineOfSight } from "../../../src/shared/hitscan.ts";
import { EYE_HEIGHT, PITCH_LIMIT } from "../../../src/shared/look.ts";
import { GRENADE_BLAST_MIN_PERCENT, GRENADE_BLAST_RADIUS, GRENADE_GRAVITY, GRENADE_SPEED, type GrenadePose } from "../../../src/shared/grenade.ts";
import { MAX_HP } from "../../../src/shared/health.ts";
import { createNavCache } from "../../../src/shared/nav/legs.ts";
import { planPath } from "../../../src/shared/nav/path.ts";
import { wishTo } from "../../../src/shared/nav/follow.ts";

const args = new Map<string, string>();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) if (argv[i]!.startsWith("--")) args.set(argv[i]!.slice(2), argv[i + 1] ?? "");
const token = (process.env.CE_TOKEN ?? "").trim() || readFileSync(join(homedir(), ".config/ce-arena/qa-token.pem"), "utf8").trim();
const STAMP = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const LABEL = args.get("label") ?? "123-cmd";
const DIR = args.get("dir") ?? "plan/dsh-tasks/live/123-cmd";
const NAME = args.get("name") ?? "cmd-host";
const SCENARIO = args.get("scenario") ?? undefined;
const LOG = `plan/dsh-tasks/logs/${LABEL}-${STAMP}.log`;
/** Task 128 spike: the 250 ms trace of the wedge (task, step, nearest door, presses). */
const TRACE = `plan/dsh-tasks/logs/${LABEL}-${STAMP}.ndjson`;
const SAMPLE_MS = 250;
const SEND_MS = 250;
const MAX_TEXT = 256;
const TASK_TIMEOUT_MS = 180_000;

mkdirSync("plan/dsh-tasks/logs", { recursive: true });
const t0 = Date.now();
const START_ISO = new Date(t0).toISOString();
// The mailbox owns the six files and the inbox offset (task 137).
const mailbox = openMailbox({ dir: DIR, startedAt: t0, startAtEnd: true });
/** First known hp after the welcome; set once the seat is ours. Null when unknown. */
let hpStart: number | null = null;
const secs = (): number => Math.round((Date.now() - t0) / 100) / 10;
/** Task 130: a handler's own window, not the process uptime (`secs`). */
const taskElapsed = (start: number): string => ((Date.now() - start) / 1000).toFixed(1);
const lines: string[] = [];
const record = (line: string): void => {
  const row = `t=${secs().toFixed(1)}s ${line}`;
  lines.push(row);
  console.log(row);
};
const out = (event: Record<string, unknown>): void => {
  mailbox.out(event);
};
const writeStatus = (body: Record<string, unknown>): void => {
  mailbox.status(body);
};

const session = await connectBot({
  url: args.get("url") ?? "ws://localhost:4173",
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
const selfId = me0.id;
const players = new Set(world.playerIds());
/** First known hp after the welcome (the welcome seeds it); null when unknown. */
hpStart = world.healthOf(selfId)?.hp ?? null;

// --- packed status --------------------------------------------------------
const round2 = (n: number): number => Math.round(n * 100) / 100;
function buildStatus(id: string): Record<string, unknown> {
  const me = world.self();
  const h = me ? world.healthOf(me.id) : undefined;
  const body: Record<string, unknown> = {
    t: "status",
    id,
    self: selfId,
    place: me ? (world.placeOf(me)?.id ?? "?") : "-",
    hp: h?.hp ?? null,
    dead: h ? h.dead : null,
    weapon: world.weapon() ?? "none",
    ammo: world.ammo(),
    pos: me ? [round2(me.x), round2(me.y), round2(me.z)] : null,
    task: busy?.name ?? null,
    last: lastResult ? { id: lastResult.id, ok: lastResult.ok } : null,
  };
  let trimmed = 0;
  while (JSON.stringify(body).length > MAX_TEXT) {
    if ("pos" in body) delete body.pos;
    else if ("last" in body) delete body.last;
    else break;
    trimmed += 1;
  }
  if (trimmed > 0) record(`STATUS-TRIM fields=${trimmed}`);
  return body;
}

// --- send queue (one row per 250 ms, the host cap) ------------------------
type Queued = { to: number; text: string };
const queue: Queued[] = [];
let sent = 0;
const enqueueSay = (text: string, to: number): void => {
  queue.push({ to, text });
};
function flushOne(): void {
  const row = queue.shift();
  if (!row) return;
  if (!session.messages.say(row.text, row.to)) {
    record(`MSG-SEND-FAIL to=${row.to} why=say-false`);
    return;
  }
  sent += 1;
}

// --- events ---------------------------------------------------------------
type Origin = { via: "mailbox" | "msg"; from?: number };
type Result = { ok: true; code?: number; note?: string; data?: Record<string, unknown> } | { ok: false; code: number; why: string };
type Cmd = { t: "cmd"; id: string; name: string; args?: Record<string, unknown> };
let busy: { id: string; name: string } | undefined;
let lastResult: { id: string; ok: boolean } | null = null;
const executed = new Set<string>();
// Cooperative abort: the brain calls `onTick` each mission-loop pass; the tick
// throws when an abort command set the flag, so the mission unwinds, the task
// reports `aborted`, and a queued follow-up command starts.
class AbortMission extends Error {}
let abortRequested = false;
let pending: { cmd: Cmd; origin: Origin } | undefined;
const abortTick = (): void => {
  if (abortRequested) throw new AbortMission("aborted");
};
const replies = new Map<string, Record<string, unknown>>();

// --- task 128 spike state -------------------------------------------------
let presses = 0;
let brainStep = "";
let replanReason = "";
let planSteps = 0;
let lastDoorId: string | null = null;
const rawUse = session.input.use.bind(session.input);
session.input.use = () => {
  presses += 1;
  record(`USE n=${presses}`);
  return rawUse();
};

// --- recorder -------------------------------------------------------------
// The host owns the session record: one transcript row per dispatched command,
// a roll-up at exit, and the operator's notes. Shapes are in the task's brief.
type TranscriptRow = {
  at: string;
  via: "mailbox" | "msg";
  from: number | null;
  id: string;
  name: string;
  args: Record<string, unknown>;
  ev: "done" | "fail" | "status" | "ack";
  ok: boolean;
  why: string | null;
  ms: number;
  statusAfter: Record<string, unknown>;
};
/** Session counters. `commands` counts terminal task rows (done|fail, not status/note). */
const tally = { commands: 0, ok: 0, fail: 0, kills: 0, shots: 0, visits: 0 };
function writeTranscript(row: TranscriptRow): void {
  const line = JSON.stringify(row);
  mailbox.transcript(row);
  record(`TRANSCRIPT id=${row.id} name=${row.name} ev=${row.ev} ok=${row.ok} len=${line.length}`);
}
/** Count one terminal task event: commands/ok/fail plus the hunt and patrol counters. */
function countTask(ev: Record<string, unknown>): void {
  tally.commands += 1;
  if (ev.ev === "done") tally.ok += 1;
  else tally.fail += 1;
  if (typeof ev.kills === "number") tally.kills += ev.kills;
  if (typeof ev.shots === "number") tally.shots += ev.shots;
  if (Array.isArray(ev.places)) tally.visits += ev.places.length;
}

function emit(cmd: Cmd, origin: Origin, ev: Record<string, unknown>): void {
  const text = JSON.stringify(ev);
  if (text.length > MAX_TEXT) record(`EV-TOO-LONG id=${cmd.id} len=${text.length}`);
  out({ ...ev });
  record(`EV-SEND to=${origin.from ?? "-"} len=${text.length} ${text}`);
  if (origin.via === "msg" && origin.from !== undefined) enqueueSay(text, origin.from);
}

function sendStatus(cmd: Cmd, origin: Origin): Record<string, unknown> {
  const body = buildStatus(cmd.id);
  const text = JSON.stringify(body);
  out({ ...body });
  record(`STATUS id=${cmd.id} len=${text.length} ${text}`);
  if (origin.via === "msg" && origin.from !== undefined) enqueueSay(text, origin.from);
  return body;
}

// --- handlers -------------------------------------------------------------
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const walkWithRecovery = async (target: { x: number; z: number }, ms: number, label: string): Promise<boolean> => {
  const deadline = Date.now() + ms;
  let lastX = Number.NaN;
  let lastZ = Number.NaN;
  let lastProgress = Date.now();
  let attempts = 0;
  while (Date.now() < deadline) {
    const me = world.self();
    if (!me) return false;
    const d = Math.hypot(me.x - target.x, me.z - target.z);
    if (d <= 0.6) {
      session.input.sendInput({ moveX: 0, moveZ: 0, yaw: me.yaw });
      await sleep(120);
      return true;
    }
    if (Number.isFinite(lastX) && Math.hypot(me.x - lastX, me.z - lastZ) < 0.15) {
      if (Date.now() - lastProgress > 1500) {
        attempts += 1;
        record(`${label}: STUCK #${attempts} at ${me.x.toFixed(2)},${me.y.toFixed(2)},${me.z.toFixed(2)} d=${d.toFixed(2)}`);
        if (attempts > 6) return false;
        const yaw = Math.atan2(target.x - me.x, target.z - me.z);
        const side = attempts % 2 === 1 ? 1 : -1;
        const sidePoint = { x: me.x + Math.cos(yaw) * side * 2.2, z: me.z - Math.sin(yaw) * side * 2.2 };
        const until = Date.now() + 700;
        while (Date.now() < until) {
          const p2 = world.self();
          if (!p2) break;
          session.input.sendInput(wishTo({ x: p2.x, y: p2.y, z: p2.z, vx: 0, vz: 0, yaw: p2.yaw }, sidePoint, 1));
          await sleep(50);
        }
        lastX = Number.NaN;
        lastProgress = Date.now();
        continue;
      }
    } else {
      lastX = me.x;
      lastZ = me.z;
      lastProgress = Date.now();
    }
    session.input.sendInput(wishTo({ x: me.x, y: me.y, z: me.z, vx: 0, vz: 0, yaw: me.yaw }, target, 1));
    await sleep(50);
  }
  record(`${label}: timeout`);
  return false;
};

const armHandler = async (): Promise<Result> => {
  if ((world.weapon() ?? "") !== "") return { ok: true, code: 0, note: "already-armed" };
  if (![...world.pickups()].includes("alien-weapon-1")) {
    record("arm: alien-weapon-1 is not on the map");
    return { ok: false, code: 1, why: "not-armed" };
  }
  record("arm: east approach");
  await walkWithRecovery({ x: -13.9, z: 16.5 }, 60_000, "arm east");
  record("arm: climb");
  const climbed = await walkWithRecovery({ x: -23.9, z: 16.5 }, 60_000, "arm climb");
  record(`arm climb=${climbed} weapon=${world.weapon() ?? "none"} ammo=${world.ammo()}`);
  const me = world.self();
  if (me && me.y > 0.6) await walkWithRecovery({ x: -14.0, z: 16.5 }, 30_000, "arm step-off");
  return (world.weapon() ?? "") !== "" ? { ok: true, code: 0 } : { ok: false, code: 1, why: "not-armed" };
};

const runMissionTask = async (missionText: string, label: string): Promise<Result> => {
  const mission = parseMission(missionText);
  if (!mission) return { ok: false, code: 1, why: "bad-args" };
  let lastNoPlan: string | null = null;
  try {
    const code = await runMission(session, mission, {
      timeoutMs: TASK_TIMEOUT_MS,
      onTick: abortTick,
      log: (line) => {
        record(`  ${label} ${line}`);
        const m = /no plan: ([a-z-]+)/.exec(line);
        if (m) lastNoPlan = m[1]!;
        const st = /^start (\S+)/.exec(line);
        if (st) brainStep = st[1]!;
        const rp = /^replan (\S+)/.exec(line);
        if (rp) replanReason = rp[1]!;
        const pd = /plan done .*?steps=(\d+)/.exec(line);
        if (pd) planSteps = Number(pd[1]);
      },
      error: (line) => record(`  ${label} ERROR ${line}`),
    });
    if (code === 0) return { ok: true, code: 0 };
    if (code === 2) return { ok: false, code: 2, why: `no-plan:${lastNoPlan ?? "unknown"}` };
    if (code === 3) return { ok: false, code: 3, why: "timeout" };
    return { ok: false, code, why: `code:${code}` };
  } catch (err) {
    if (err instanceof AbortMission) return { ok: false, code: 4, why: "aborted" };
    return { ok: false, code: 1, why: `error:${err instanceof Error ? err.message : String(err)}` };
  }
};

const gotoHandler = async (a: Record<string, unknown>): Promise<Result> => {
  const place = typeof a.place === "string" ? a.place : "";
  if (place.length === 0) return { ok: false, code: 1, why: "bad-args" };
  return runMissionTask(`reach:${place}`, "goto");
};

// Task 132: a point destination is a wishTo walk, not a `stand:` plan. The
// planner's `stand:` is retired from this driver; `goto:<place>` is the step
// when a door is in the way.
const standHandler = async (a: Record<string, unknown>): Promise<Result> => {
  const x = Number(a.x);
  const y = Number(a.y);
  const z = Number(a.z);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return { ok: false, code: 1, why: "bad-args" };
  const yawArg = a.yaw === undefined ? undefined : Number(a.yaw);
  if (a.yaw !== undefined && !Number.isFinite(yawArg)) return { ok: false, code: 1, why: "bad-args" };
  const me = world.self();
  if (!me) return { ok: false, code: 1, why: "no-self" };
  // wishTo is planar: never walk to a point on another floor.
  if (Math.abs(me.y - y) > 0.75) return { ok: false, code: 1, why: "wrong-floor" };
  if (abortRequested) return { ok: false, code: 4, why: "aborted" };
  record(`STAND start x=${x} z=${z} yaw=${yawArg ?? "keep"}`);
  const ok = await walkWithRecovery({ x, z }, 90_000, "stand");
  if (abortRequested) return { ok: false, code: 4, why: "aborted" };
  if (!ok) {
    const at = world.self();
    record(`STAND stuck at=${at ? `${at.x.toFixed(2)},${at.z.toFixed(2)}` : "?"} target=${x},${z}`);
    return { ok: false, code: 3, why: `stuck:${x},${z}` };
  }
  const done = world.self();
  const finalYaw = yawArg ?? done?.yaw ?? 0;
  session.input.sendInput({ moveX: 0, moveZ: 0, yaw: finalYaw });
  await sleep(300);
  const settled = world.self();
  const d = settled ? Math.hypot(settled.x - x, settled.z - z) : Infinity;
  record(`STAND done at=${settled ? `${settled.x.toFixed(2)},${settled.z.toFixed(2)}` : "?"} yaw=${settled?.yaw ?? finalYaw} d=${d.toFixed(2)}`);
  return { ok: true, code: 0, data: { x, z, yaw: finalYaw } };
};

const RELOAD_TIMEOUT_MS = 90_000;
const reloadHandler = async (a: Record<string, unknown>): Promise<Result> => {
  if (world.ammo() > 0) return { ok: true, code: 0, note: "already-loaded", data: { ammo: world.ammo() } };
  type Placement = { id: string; kind?: string; minX: number; maxX: number; minZ: number; maxZ: number; minY?: number; maxY?: number };
  const avail = new Set(world.pickups());
  const pin = typeof a.crate === "string" && a.crate.length > 0 ? a.crate : undefined;
  const me = world.self();
  const crates = (world.pickupPlacements() as Placement[])
    .filter((p) => p.kind === "ammo" && avail.has(p.id))
    .filter((p) => (world.placeOf({ x: (p.minX + p.maxX) / 2, y: (p.minY ?? 0) + 0.2, z: (p.minZ + p.maxZ) / 2 })?.id ?? "") === "outside")
    .map((p) => ({ p, d: me ? Math.hypot((p.minX + p.maxX) / 2 - me.x, (p.minZ + p.maxZ) / 2 - me.z) : 0 }))
    .sort((u, v) => (pin ? (u.p.id === pin ? -1 : v.p.id === pin ? 1 : 0) : u.d - v.d) || (u.p.id < v.p.id ? -1 : u.p.id > v.p.id ? 1 : 0));
  const crate = crates[0]?.p;
  if (!crate) return { ok: false, code: 1, why: "no-crate" };
  record(`RELOAD start ammo=${world.ammo()} crate=${crate.id}`);
  const mission = parseMission(`retrieve:${crate.id}@outside`);
  if (!mission) return { ok: false, code: 1, why: "bad-args" };
  let lastNoPlan: string | null = null;
  const code = await runMission(session, mission, {
    timeoutMs: RELOAD_TIMEOUT_MS,
    onTick: abortTick,
    log: (line) => {
      record(`  reload ${line}`);
      const m = /no plan: ([a-z-]+)/.exec(line);
      if (m) lastNoPlan = m[1]!;
    },
    error: (line) => record(`  reload ERROR ${line}`),
  });
  const ammo = world.ammo();
  if (code === 0 && ammo > 0) {
    record(`RELOAD done crate=${crate.id} ammo=${ammo} code=${code}`);
    return { ok: true, code: 0, data: { ammo, crate: crate.id } };
  }
  const why = code === 0 ? "no-ammo" : code === 2 ? `no-plan:${lastNoPlan ?? "unknown"}` : code === 3 ? "timeout" : `code:${code}`;
  record(`RELOAD fail crate=${crate.id} why=${why}`);
  return { ok: false, code: code === 0 ? 1 : code, why };
};

const huntHandler = async (a: Record<string, unknown>): Promise<Result> => {
  const startedAt = Date.now();
  const minutes = a.minutes === undefined ? 2 : Number(a.minutes);
  if (!Number.isFinite(minutes) || minutes < 0.5 || minutes > 10) return { ok: false, code: 1, why: "bad-args" };
  const weapon = a.weapon === undefined ? "laser" : String(a.weapon);
  if (weapon === "grenade") return { ok: false, code: 1, why: "unsupported-weapon" };
  if (weapon !== "laser") return { ok: false, code: 1, why: "bad-args" };
  if ((world.weapon() ?? "") === "") return { ok: false, code: 1, why: "not-armed" };
  if (world.ammo() <= 0) return { ok: false, code: 1, why: "no-ammo" };
  const deadline = Date.now() + minutes * 60_000;
  let kills = 0;
  let shots = 0;
  let sawTarget = false;
  let consecutiveNoAmmo = 0;
  record(`HUNT start minutes=${minutes} weapon=laser ammo=${world.ammo()} hp=${world.healthOf(selfId)?.hp ?? null}`);
  while (Date.now() < deadline) {
    if (world.healthOf(selfId)?.dead === true) {
      record(`HUNT end kills=${kills} shots=${shots} minutes=${minutes} elapsed=${taskElapsed(startedAt)}s`);
      return { ok: false, code: 1, why: "died" };
    }
    const me = world.self();
    if (!me) return { ok: false, code: 1, why: "lost-self" };
    const npcs = world.others()
      .filter((p) => !players.has(p.id) && world.healthOf(p.id)?.dead !== true && (world.placeOf(p)?.id ?? "") === "outside")
      .map((p) => ({ p, d: Math.hypot(p.x - me.x, p.z - me.z) }))
      .sort((u, v) => u.d - v.d);
    const nearest = npcs[0];
    if (!nearest) { await sleep(1_000); continue; }
    const tgt = nearest.p;
    sawTarget = true;
    record(`HUNT target id=${tgt.id} d=${nearest.d.toFixed(1)} place=outside`);
    let outcome = "timeout";
    let targetShots = 0;
    const mission = parseMission(`attack:${tgt.id}`);
    if (!mission) continue;
    const code = await runMission(session, mission, {
      timeoutMs: Math.min(60_000, Math.max(1_000, deadline - Date.now())),
      onTick: abortTick,
      log: (line) => {
        record(`  hunt ${line}`);
        if (/attack: fire/.test(line)) { shots += 1; targetShots += 1; }
        if (/attack: dead/.test(line)) outcome = "dead";
        else if (/attack: lost/.test(line)) outcome = "lost";
        else if (/attack: no_ammo/.test(line)) outcome = "no_ammo";
        else if (/attack: died/.test(line)) outcome = "died";
      },
      error: (line) => record(`  hunt ERROR ${line}`),
    });
    if (world.healthOf(tgt.id)?.dead === true) { kills += 1; outcome = "dead"; }
    record(`HUNT result id=${tgt.id} outcome=${outcome} shots=${targetShots} kills=${kills} code=${code}`);
    if (outcome === "died" || world.healthOf(selfId)?.dead === true) {
      record(`HUNT end kills=${kills} shots=${shots} minutes=${minutes} elapsed=${taskElapsed(startedAt)}s`);
      return { ok: false, code: 1, why: "died" };
    }
    if (outcome === "no_ammo") {
      consecutiveNoAmmo += 1;
      if (consecutiveNoAmmo >= 2 && world.ammo() === 0) {
        record(`HUNT end kills=${kills} shots=${shots} minutes=${minutes} elapsed=${taskElapsed(startedAt)}s`);
        return { ok: false, code: 1, why: "no-ammo" };
      }
    } else {
      consecutiveNoAmmo = 0;
    }
    await sleep(200);
  }
  record(`HUNT end kills=${kills} shots=${shots} minutes=${minutes} elapsed=${taskElapsed(startedAt)}s`);
  if (!sawTarget) return { ok: false, code: 1, why: "no-target" };
  return { ok: true, code: 0, data: { minutes, kills, shots, hp: world.healthOf(selfId)?.hp ?? null } };
};

const patrolHandler = async (a: Record<string, unknown>): Promise<Result> => {
  const startedAt = Date.now();
  const raw = Array.isArray(a.places) ? a.places : [];
  if (raw.length < 2 || raw.some((p) => typeof p !== "string" || (p as string).trim().length === 0)) {
    return { ok: false, code: 1, why: "bad-args" };
  }
  const places = (raw as string[]).map((p) => p.trim());
  const minutes = a.minutes === undefined ? 3 : Number(a.minutes);
  if (!Number.isFinite(minutes) || minutes < 0.5 || minutes > 10) return { ok: false, code: 1, why: "bad-args" };
  const mission = parseMission(`patrol:${places.join(",")}`);
  if (!mission) return { ok: false, code: 1, why: "bad-args" };
  record(`PATROL start places=[${places.join(",")}] minutes=${minutes}`);
  const visited: string[] = [];
  let died = false;
  const sampler = setInterval(() => {
    const me = world.self();
    if (!me) return;
    const place = world.placeOf(me)?.id;
    if (place && !visited.includes(place)) {
      visited.push(place);
      record(`PATROL place=${place} t=${secs()}s`);
    }
    if (world.healthOf(selfId)?.dead === true) died = true;
  }, 500);
  let lastNoPlan: string | null = null;
  let code = 1;
  try {
    code = await runMission(session, mission, {
      timeoutMs: minutes * 60_000,
      onTick: abortTick,
      log: (line) => {
        record(`  patrol ${line}`);
        const m = /no plan: ([a-z-]+)/.exec(line);
        if (m) lastNoPlan = m[1]!;
      },
      error: (line) => record(`  patrol ERROR ${line}`),
    });
  } finally {
    clearInterval(sampler);
  }
  record(`PATROL end places=[${visited.join(",")}] minutes=${minutes} elapsed=${taskElapsed(startedAt)}s code=${code}`);
  if (died || world.healthOf(selfId)?.dead === true) return { ok: false, code: 1, why: "died" };
  if (code === 3) return { ok: true, code: 0, data: { minutes, places: visited } };
  if (code === 2) return { ok: false, code: 2, why: `no-plan:${lastNoPlan ?? "unknown"}` };
  return { ok: false, code, why: `code:${code}` };
};

type PickupRow = { id: string; kind?: string; minX: number; maxX: number; minZ: number; maxZ: number; minY?: number; maxY?: number };
function pickupPlace(item: PickupRow): string {
  return world.placeOf({ x: (item.minX + item.maxX) / 2, y: (item.minY ?? 0) + 0.2, z: (item.minZ + item.maxZ) / 2 })?.id ?? "outside";
}
const retrieveHandler = async (a: Record<string, unknown>): Promise<Result> => {
  const pickup = typeof a.pickup === "string" ? a.pickup : "";
  if (pickup.length === 0) return { ok: false, code: 1, why: "bad-args" };
  const item = (world.pickupPlacements() as PickupRow[]).find((row) => row.id === pickup);
  if (!item) return { ok: false, code: 1, why: "no-pickup" };
  const place = typeof a.place === "string" && a.place.length > 0 ? a.place : pickupPlace(item);
  const mission = parseMission(`retrieve:${pickup}@${place}`);
  if (!mission) return { ok: false, code: 1, why: "bad-args" };
  record(`RETRIEVE start pickup=${pickup} place=${place}`);
  let lastNoPlan: string | null = null;
  const code = await runMission(session, mission, {
    timeoutMs: TASK_TIMEOUT_MS,
    onTick: abortTick,
    log: (line) => {
      record(`  retrieve ${line}`);
      const m = /no plan: ([a-z-]+)/.exec(line);
      if (m) lastNoPlan = m[1]!;
      const st = /^start (\S+)/.exec(line);
      if (st) brainStep = st[1]!;
      const rp = /^replan (\S+)/.exec(line);
      if (rp) replanReason = rp[1]!;
    },
    error: (line) => record(`  retrieve ERROR ${line}`),
  });
  const held = world.keys().includes(pickup) || !world.pickups().includes(pickup);
  if (code === 0 && held) {
    record(`RETRIEVE done pickup=${pickup} place=${place}`);
    return { ok: true, code: 0, data: { pickup, place } };
  }
  if (code === 0) return { ok: false, code: 1, why: "not-picked" };
  if (code === 2) return { ok: false, code: 2, why: `no-plan:${lastNoPlan ?? "unknown"}` };
  if (code === 3) return { ok: false, code: 3, why: "timeout" };
  return { ok: false, code, why: `code:${code}` };
};

const getkeyHandler = async (): Promise<Result> => {
  const key = (world.pickupPlacements() as PickupRow[]).find((row) => row.kind === "key" && world.pickups().includes(row.id));
  if (!key) return { ok: false, code: 1, why: "no-key" };
  return retrieveHandler({ pickup: key.id });
};

// The point planner's `stand` wedges on the wall between the south pad and the key
// (steps=1, stuck forever); the arm handler's raw walker does not. Expose it so the
// test can route by waypoints: {"points":[{"x":-13.9,"z":16.5},{"x":-7.1,"z":27.6}]}.
const walkHandler = async (a: Record<string, unknown>): Promise<Result> => {
  const raw = Array.isArray(a.points)
    ? a.points
    : a.x !== undefined || a.z !== undefined ? [{ x: a.x, z: a.z }] : [];
  const points = raw
    .map((p) => ({ x: Number((p as Record<string, unknown>).x), z: Number((p as Record<string, unknown>).z) }))
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.z));
  if (points.length === 0) return { ok: false, code: 1, why: "bad-args" };
  for (let i = 0; i < points.length; i += 1) {
    if (abortRequested) return { ok: false, code: 4, why: "aborted" };
    const p = points[i]!;
    record(`WALK leg=${i + 1}/${points.length} to=${p.x},${p.z}`);
    const ok = await walkWithRecovery(p, 60_000, `walk${i + 1}`);
    const me = world.self();
    record(`WALK leg=${i + 1} ok=${ok} at=${me ? `${me.x.toFixed(1)},${me.y.toFixed(1)},${me.z.toFixed(1)}` : "?"} hp=${world.healthOf(selfId)?.hp ?? null}`);
    if (!ok) return { ok: false, code: 3, why: `stuck:${p.x},${p.z}` };
  }
  return { ok: true, code: 0, data: { points } };
};

// --- projectile (task 141) -----------------------------------------------
// Migrated from projectile-run.ts: the aim solver, the movement/probe, the
// trace and the trial matrix are the source's. The factory gives each
// invocation its own state (the source's module-level globals); the host's
// world/session/record/sleep/wishTo/selfId/players are the entry, and the
// finish returns a Result instead of exiting.
// The host's record, captured at module scope: the projectile factory shadows
// `record` with its own plan-line wrapper (the source driver's parser).
const hostRecord = record;

class ProjectileEnd extends Error {
  result: Result;
  constructor(result: Result) {
    super("projectile done");
    this.result = result;
  }
}

const createProjectile = (opts: { bands: number[]; throws: number; seconds: number; trial: string; fallback: string; filter: string; route: string }) => {
  const BANDS = opts.bands;
  const THROWS = opts.throws;
  const TRIAL = opts.trial;
  const FALLBACK = opts.fallback;
  const FILTER = opts.filter;
  const ROUTE = opts.route;
  const RUN_MS = Math.min(opts.seconds * 1000, TASK_TIMEOUT_MS);
  const SAMPLER_MS = 50;
  const TRACE_PATH = `plan/dsh-tasks/live/141-projectile/projectile-${STAMP}.json`;
  const t0 = Date.now();
  const secs = (): number => Math.round((Date.now() - t0) / 100) / 10;
  const localLines: string[] = [];
  const rows: Array<Record<string, unknown>> = [];
  let noSend = 0;
  type TraceRow = { t: number; x: number; z: number; y: number; yaw: number; place: string; band: number | null; d: number | null; los: boolean; stand: string | null; plan: string; cmd: string; slide: boolean; stuck: boolean };
  type AttemptRow = { t: number; band: number; offset: number; point: string; place: string; los: boolean; pathOk: boolean | null; pathReason: string | null; code: number | null; reason: string | null; fallback: string; slide: number; stuck: number; bandReached: number | null; timeToBand: number | null; dt: number };
  const trace: TraceRow[] = [];
  const attempts: AttemptRow[] = [];
  let planNow = "none";
  let lastNoPlan: string | null = null;
  let bandNow: number | null = null;
  let standNow: string | null = null;
  const noPlanReason = (): string | null => lastNoPlan;
  let lastCmd = { moveX: 0, moveZ: 0, yaw: 0 };
  let stopSampler: () => void = () => {};
  const record = (line: string): void => {
    hostRecord(line);
    localLines.push(`t=${secs().toFixed(1)}s ${line}`);
    const trimmed = line.trim();
    if (/(plan start|plan done|no plan:|replan |start |finish )/.test(trimmed)) planNow = trimmed;
    const noPlan = /no plan: ([a-z-]+)/.exec(trimmed);
    if (noPlan) lastNoPlan = `no plan: ${noPlan[1]}`;
  };
  const aborted = (): boolean => abortRequested;
  const expectedLoss = (d: number): number => {
    if (!(d < GRENADE_BLAST_RADIUS)) return 0;
    const pct = Math.max(GRENADE_BLAST_MIN_PERCENT, Math.min(100, Math.round(100 * (1 - d / GRENADE_BLAST_RADIUS))));
    return (MAX_HP * pct) / 100;
  };
  const summarize = (): Record<string, unknown> => {
    const planLines = localLines.filter((l) => l.includes("plan done"));
    const steps = planLines.map((l) => Number(/steps=(\d+)/.exec(l)?.[1] ?? 0));
    const noPlan: Record<string, number> = {};
    for (const l of localLines) {
      const m = /no plan: ([a-z-]+)/.exec(l);
      if (m) noPlan[m[1]!] = (noPlan[m[1]!] ?? 0) + 1;
    }
    return {
      plans: planLines.length,
      plansStepsGt1: steps.filter((n) => n > 1).length,
      noPlan,
      replanStuck: localLines.filter((l) => l.includes("replan stuck")).length,
      bandMoveFailed: localLines.filter((l) => l.includes("band move failed")).length,
      fallbacks: attempts.filter((a) => a.fallback === "straight").length,
      attempts: attempts.length,
      slideSeconds: Math.round((trace.filter((r) => r.slide).length * SAMPLER_MS) / 100) / 10,
      stuckSeconds: Math.round((trace.filter((r) => r.stuck).length * SAMPLER_MS) / 100) / 10,
      traceRows: trace.length,
    };
  };
  const finish = (result: Result): never => {
    stopSampler();
    try {
      mkdirSync("plan/dsh-tasks/live/141-projectile", { recursive: true });
      writeFileSync(TRACE_PATH, `${JSON.stringify({ trial: { name: TRIAL, fallback: FALLBACK, filter: FILTER, route: ROUTE }, metrics: summarize(), attempts, trace, throws: rows }, null, 1)}\n`);
    } catch {
      // the trace is evidence; a write failure must not change the run
    }
    throw new ProjectileEnd(result);
  };

  // --- blast snapshot (task 110) -------------------------------------------
  type PawnRow = { id: number; owner: boolean; player: boolean; hp: number | null; dead: boolean; x: number; y: number; z: number };
  const snapshotPawns = (): PawnRow[] => {
    const me = world.self();
    if (!me) return [];
    const out: PawnRow[] = [];
    const push = (p: { id: number; x: number; y: number; z: number }, owner: boolean): void => {
      const h = world.healthOf(p.id);
      out.push({ id: p.id, owner, player: players.has(p.id), hp: h?.hp ?? null, dead: h?.dead === true, x: p.x, y: p.y, z: p.z });
    };
    push(me, true);
    for (const p of world.others()) push(p, false);
    return out;
  };
  let throwNo = 0;

  // --- target + velocity ----------------------------------------------------
  type Sample = { t: number; x: number; z: number };
  const history = new Map<number, Sample[]>();
  const poseOf = (id: number) => world.others().find((p) => p.id === id);
  const isNpc = (id: number): boolean => !players.has(id) && id !== selfId && world.healthOf(id)?.dead !== true && (badTargets.get(id) ?? 0) <= Date.now();
  const selectTarget = (): number | undefined => {
    const me = world.self();
    if (!me) return undefined;
    const candidates = world.others()
      .filter((p) => isNpc(p.id) && (world.placeOf(p)?.id ?? "outside") === "outside")
      .map((p) => ({ id: p.id, d: Math.hypot(p.x - me.x, p.z - me.z) }))
      .sort((a, b) => a.d - b.d);
    return candidates[0]?.id;
  };
  let targetId: number | undefined;
  const badTargets = new Map<number, number>();
  const sampleTarget = (): void => {
    if (targetId === undefined) return;
    const p = poseOf(targetId);
    if (!p) return;
    const list = history.get(targetId) ?? [];
    list.push({ t: Date.now(), x: p.x, z: p.z });
    while (list.length > 20) list.shift();
    history.set(targetId, list);
  };
  const velocityOf = (id: number): { x: number; z: number; speed: number } => {
    const list = history.get(id) ?? [];
    if (list.length < 2) return { x: 0, z: 0, speed: 0 };
    const last = list[list.length - 1]!;
    let first = list[0]!;
    for (let i = list.length - 2; i >= 0; i -= 1) {
      if (last.t - list[i]!.t <= 400) first = list[i]!;
      else break;
    }
    const dt = (last.t - first.t) / 1000;
    if (!(dt > 0.1)) return { x: 0, z: 0, speed: 0 };
    const x = (last.x - first.x) / dt;
    const z = (last.z - first.z) / dt;
    return { x, z, speed: Math.hypot(x, z) };
  };

  // --- aim ------------------------------------------------------------------
  function solvePitch(d: number, dh: number): { pitch: number; tFlight: number } | undefined {
    const v = GRENADE_SPEED;
    const g = GRENADE_GRAVITY;
    if (!(d > 0.01)) return undefined;
    const v2 = v * v;
    const disc = v2 * v2 - g * (g * d * d + 2 * dh * v2);
    if (disc < 0) return undefined;
    const tan = (v2 - Math.sqrt(disc)) / (g * d);
    const pitch = Math.atan(tan);
    if (!Number.isFinite(pitch) || Math.abs(pitch) > PITCH_LIMIT) return undefined;
    return { pitch, tFlight: d / (v * Math.cos(pitch)) };
  }
  type Aim = { yaw: number; pitch: number; d: number; dh: number; tFlight: number; pred: { x: number; y: number; z: number }; outOfRange?: boolean };
  function aimAt(id: number, lead: boolean): Aim | undefined {
    const me = world.self();
    const tgt = poseOf(id);
    if (!me || !tgt) return undefined;
    const eye = { x: me.x, y: me.y + EYE_HEIGHT, z: me.z };
    const vt = lead ? velocityOf(id) : { x: 0, z: 0, speed: 0 };
    let pred = { x: tgt.x, y: tgt.y + 1.0, z: tgt.z };
    let sol: { pitch: number; tFlight: number } | undefined;
    for (let i = 0; i < 4; i += 1) {
      const dx = pred.x - eye.x;
      const dz = pred.z - eye.z;
      const d = Math.hypot(dx, dz);
      const dh = pred.y - eye.y;
      sol = solvePitch(d, dh);
      if (!sol) return { yaw: Math.atan2(dx, dz), pitch: 0, d, dh, tFlight: 0, pred, outOfRange: true };
      pred = { x: tgt.x + vt.x * sol.tFlight, y: tgt.y + 1.0, z: tgt.z + vt.z * sol.tFlight };
    }
    const dx = pred.x - eye.x;
    const dz = pred.z - eye.z;
    const d = Math.hypot(dx, dz);
    return { yaw: Math.atan2(dx, dz), pitch: sol!.pitch, d, dh: pred.y - eye.y, tFlight: sol!.tFlight, pred };
  }
  const eyeNow = () => {
    const me = world.self();
    return me ? { x: me.x, y: me.y + EYE_HEIGHT, z: me.z } : undefined;
  };

  // --- movement: the projectile's wishTo walker (1.2 m side-step, 4 tries) --
  const walkWithRecovery = async (target: { x: number; z: number }, ms: number, label: string): Promise<boolean> => {
    const deadline = Date.now() + ms;
    let lastX = Number.NaN;
    let lastZ = Number.NaN;
    let lastProgress = Date.now();
    let attempts = 0;
    while (Date.now() < deadline) {
      if (aborted()) finish({ ok: false, code: 4, why: "aborted" });
      const me = world.self();
      if (!me) return false;
      const d = Math.hypot(me.x - target.x, me.z - target.z);
      if (d <= 0.6) {
        session.input.sendInput({ moveX: 0, moveZ: 0, yaw: me.yaw });
        await sleep(120);
        return true;
      }
      if (Number.isFinite(lastX) && Math.hypot(me.x - lastX, me.z - lastZ) < 0.15) {
        if (Date.now() - lastProgress > 1500) {
          attempts += 1;
          record(`${label}: STUCK #${attempts} at ${me.x.toFixed(2)},${me.y.toFixed(2)},${me.z.toFixed(2)} d=${d.toFixed(2)}`);
          if (attempts > 4) return false;
          const yaw = Math.atan2(target.x - me.x, target.z - me.z);
          const side = attempts % 2 === 1 ? 1 : -1;
          const sidePoint = { x: me.x + Math.cos(yaw) * side * 1.2, z: me.z - Math.sin(yaw) * side * 1.2 };
          const until = Date.now() + 700;
          while (Date.now() < until) {
            const p2 = world.self();
            if (!p2) break;
            session.input.sendInput(wishTo({ x: p2.x, y: p2.y, z: p2.z, vx: 0, vz: 0, yaw: p2.yaw }, sidePoint, 1));
            await sleep(50);
          }
          lastX = Number.NaN;
          lastProgress = Date.now();
          continue;
        }
      } else {
        lastX = me.x;
        lastZ = me.z;
        lastProgress = Date.now();
      }
      session.input.sendInput(wishTo({ x: me.x, y: me.y, z: me.z, vx: 0, vz: 0, yaw: me.yaw }, target, 1));
      await sleep(50);
    }
    record(`${label}: timeout`);
    return false;
  };

  // --- trial trace + reachability probe (task 112) -------------------------
  const planCache = createNavCache();
  const traceStart = (): void => {
    let prev: { x: number; z: number; t: number } | null = null;
    let stuckStart: number | null = null;
    const timer = setInterval(() => {
      const me = world.self();
      if (!me) {
        prev = null;
        stuckStart = null;
        return;
      }
      const now = Date.now();
      const dt = prev ? (now - prev.t) / 1000 : 0;
      const dx = prev ? me.x - prev.x : 0;
      const dz = prev ? me.z - prev.z : 0;
      const moved = Math.hypot(dx, dz);
      const wish = Math.hypot(lastCmd.moveX, lastCmd.moveZ);
      let slide = false;
      if (prev && dt > 0 && moved > 0.05 && wish > 0.1) {
        const dot = (dx * lastCmd.moveX + dz * lastCmd.moveZ) / (moved * wish);
        slide = dot < Math.SQRT1_2;
      }
      if (wish > 0.1 && moved < 0.02) stuckStart ??= now;
      else stuckStart = null;
      const stuck = stuckStart !== null && now - stuckStart > 500;
      const tg = targetId === undefined ? undefined : poseOf(targetId);
      trace.push({
        t: secs(),
        x: me.x,
        z: me.z,
        y: me.y,
        yaw: me.yaw,
        place: world.placeOf(me)?.id ?? "?",
        band: bandNow,
        d: tg ? Math.hypot(tg.x - me.x, tg.z - me.z) : null,
        los: hasLosNow(),
        stand: standNow,
        plan: planNow.slice(0, 80),
        cmd: `${lastCmd.moveX.toFixed(2)},${lastCmd.moveZ.toFixed(2)}`,
        slide,
        stuck,
      });
      prev = { x: me.x, z: me.z, t: now };
    }, SAMPLER_MS);
    stopSampler = () => clearInterval(timer);
  };
  const spanStats = (from: number): { slide: number; stuck: number } => {
    let slide = 0;
    let stuck = 0;
    for (let i = from; i < trace.length; i += 1) {
      if (trace[i]!.slide) slide += 1;
      if (trace[i]!.stuck) stuck += 1;
    }
    return { slide: (slide * SAMPLER_MS) / 1000, stuck: (stuck * SAMPLER_MS) / 1000 };
  };
  const probePath = (point: { x: number; z: number }): { ok: boolean; reason: string | null } => {
    const graph = world.sceneGraph();
    const me = world.self();
    if (!graph || !me) return { ok: false, reason: "no-graph" };
    const live = new Map(world.doors().map((d) => [d.id, d] as const));
    const doors = world
      .doors()
      .map((d) => {
        const body = world.doorBody(d.id);
        return body ? { ...body, open: d.open, locked: d.locked } : undefined;
      })
      .filter((d) => d !== undefined);
    const gate = (portal: any): any => {
      if (portal.kind !== "door") return "open";
      const id = portal.door ?? portal.id;
      const door = live.get(id);
      if (!door) return portal.locked === true ? "locked" : "closed-unlocked";
      if (door.open) return "open";
      if (door.locked) return "locked";
      return "closed-unlocked";
    };
    const plan = planPath(graph as any, { x: me.x, y: me.y, z: me.z }, { x: point.x, y: 0, z: point.z }, gate, {
      view: { aabbs: world.aabbs, doors: doors as any, pawnRadius: world.pawnRadius, pawnHeight: world.pawnHeight },
      cache: planCache,
      regions: world.regions(),
    });
    return plan.ok ? { ok: true, reason: null } : { ok: false, reason: plan.reason };
  };
  const walkPlace = async (place: string, timeoutMs: number, label: string): Promise<boolean> => {
    const mission = parseMission(`reach:${place}`);
    if (!mission) return false;
    const code = await runMission(session, mission, {
      timeoutMs,
      log: (l) => record(`  ${label} ${l}`),
      error: (l) => record(`  ${label} ERROR ${l}`),
    });
    return code === 0;
  };
  const OFFSETS = [0, 25, -25, 50, -50, 90, -90, 135, -135, 180];
  function pickLosPoint(band: number, tried: ReadonlySet<number>): { x: number; z: number; y: number; offset: number } | undefined {
    if (targetId === undefined) return undefined;
    const me = world.self();
    const tg = poseOf(targetId);
    if (!me || !tg) return undefined;
    const base = Math.atan2(me.x - tg.x, me.z - tg.z);
    const aimPoint = { x: tg.x, y: tg.y + 1.0, z: tg.z };
    for (const off of OFFSETS) {
      if (tried.has(off)) continue;
      const a = base + (off * Math.PI) / 180;
      const x = tg.x + Math.sin(a) * band;
      const z = tg.z + Math.cos(a) * band;
      const place = world.placeOf({ x, y: 0, z });
      if (!place || place.id !== "outside") continue;
      const eye = { x, y: 0 + EYE_HEIGHT, z };
      if (hasLineOfSight(eye, aimPoint, world.aabbs)) return { x, z, y: 0, offset: off };
    }
    return undefined;
  }
  function hasLosNow(): boolean {
    const me = world.self();
    const tg = targetId === undefined ? undefined : poseOf(targetId);
    if (!me || !tg) return false;
    return hasLineOfSight({ x: me.x, y: me.y + EYE_HEIGHT, z: me.z }, { x: tg.x, y: tg.y + 1.0, z: tg.z }, world.aabbs);
  }
  async function reachBand(band: number, deadline: number): Promise<number> {
    const tried = new Set<number>();
    for (let attempt = 0; attempt < 4 && Date.now() < deadline; attempt += 1) {
      if (aborted()) finish({ ok: false, code: 4, why: "aborted" });
      const me = world.self();
      const tg = targetId === undefined ? undefined : poseOf(targetId);
      if (!me || !tg) return Infinity;
      const d = Math.hypot(tg.x - me.x, tg.z - me.z);
      if (Math.abs(d - band) <= 1.2 && hasLosNow()) return d;
      const cand = pickLosPoint(band, tried);
      if (!cand) {
        record(`  no LOS point at band=${band} for target ${targetId}; blacklisting it`);
        badTargets.set(targetId!, Date.now() + 20_000);
        targetId = undefined;
        return Infinity;
      }
      const place = world.placeOf(cand)?.id ?? "?";
      if (ROUTE === "place") {
        const here = world.placeOf(me)?.id ?? "?";
        if (here !== place) {
          const fromC = trace.length;
          const startedC = Date.now();
          bandNow = band;
          standNow = `place:${place}`;
          record(`  move band=${band}: place ${here} -> ${place} for point ${cand.x.toFixed(2)},${cand.z.toFixed(2)}`);
          const okPlace = await walkPlace(place, Math.min(15_000, Math.max(1000, deadline - Date.now())), `place${band}`);
          const statsC = spanStats(fromC);
          attempts.push({ t: secs(), band, offset: cand.offset, point: `${cand.x.toFixed(2)},${cand.z.toFixed(2)}`, place, los: true, pathOk: null, pathReason: null, code: okPlace ? 0 : 2, reason: okPlace ? null : "place-route-failed", fallback: "place", ...statsC, bandReached: null, timeToBand: null, dt: (Date.now() - startedC) / 1000 });
          if (!okPlace) tried.add(cand.offset);
          continue;
        }
        attempts.push({ t: secs(), band, offset: cand.offset, point: `${cand.x.toFixed(2)},${cand.z.toFixed(2)}`, place, los: true, pathOk: null, pathReason: null, code: null, reason: "place-noop", fallback: "place-noop", slide: 0, stuck: 0, bandReached: null, timeToBand: null, dt: 0 });
      }
      let pathOk: boolean | null = null;
      let pathReason: string | null = null;
      if (FILTER === "path") {
        const probe = probePath(cand);
        pathOk = probe.ok;
        pathReason = probe.reason;
        if (!probe.ok) {
          record(`  ATTEMPT band=${band} point=${cand.x.toFixed(2)},${cand.z.toFixed(2)} place=${place} los=1 path=0 reason=${probe.reason}; next offset`);
          attempts.push({ t: secs(), band, offset: cand.offset, point: `${cand.x.toFixed(2)},${cand.z.toFixed(2)}`, place, los: true, pathOk, pathReason, code: null, reason: null, fallback: "none", slide: 0, stuck: 0, bandReached: null, timeToBand: null, dt: 0 });
          tried.add(cand.offset);
          continue;
        }
      }
      const from = trace.length;
      const started = Date.now();
      bandNow = band;
      standNow = `${cand.x.toFixed(2)},${cand.z.toFixed(2)}`;
      record(`  move band=${band}: target=${targetId} d=${d.toFixed(2)} to (${cand.x.toFixed(2)},${cand.z.toFixed(2)}) los=${hasLosNow()}${pathOk === null ? "" : ` path=${pathOk ? 1 : 0}`}`);
      sampleTarget();
      lastNoPlan = null;
      planNow = "wish";
      const ok = await walkWithRecovery(cand, Math.min(8000, Math.max(1000, deadline - Date.now())), `band${band}`);
      const end = world.self();
      const endT = targetId === undefined ? undefined : poseOf(targetId);
      let fallback = "none";
      if (!ok && FALLBACK === "straight") {
        fallback = "straight";
        const until = Date.now() + 2000;
        while (Date.now() < until) {
          if (aborted()) finish({ ok: false, code: 4, why: "aborted" });
          const m2 = world.self();
          if (!m2) break;
          const d2 = Math.hypot(cand.x - m2.x, cand.z - m2.z);
          if (d2 <= 0.6) break;
          session.input.sendInput(wishTo({ x: m2.x, y: m2.y, z: m2.z, vx: 0, vz: 0, yaw: m2.yaw }, { x: cand.x, z: cand.z }, 1));
          await sleep(80);
        }
      }
      const stats = spanStats(from);
      const endD = end && endT ? Math.hypot(endT.x - end.x, endT.z - end.z) : null;
      const reached = endD !== null && Math.abs(endD - band) <= 1.2 && hasLosNow() ? endD : null;
      const reason = noPlanReason() ? noPlanReason()!.replace(/^no plan:\s*/, "") : ok ? null : "walk-failed";
      record(`  band move ${ok ? "done" : "failed"} d=${endD === null ? "?" : endD.toFixed(2)} los=${hasLosNow()} fallback=${fallback} slide=${stats.slide.toFixed(1)}s stuck=${stats.stuck.toFixed(1)}s`);
      attempts.push({ t: secs(), band, offset: cand.offset, point: `${cand.x.toFixed(2)},${cand.z.toFixed(2)}`, place, los: true, pathOk, pathReason, code: ok ? 0 : reason === "walk-failed" ? 3 : 2, reason, fallback, ...stats, bandReached: reached, timeToBand: reached === null ? null : (Date.now() - started) / 1000, dt: (Date.now() - started) / 1000 });
      if (!ok && FALLBACK !== "straight") tried.add(cand.offset);
    }
    const m = world.self();
    const t = targetId === undefined ? undefined : poseOf(targetId);
    return m && t ? Math.hypot(t.x - m.x, t.z - m.z) : Infinity;
  }

  // --- one throw ------------------------------------------------------------
  async function track(ms = 700): Promise<void> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (aborted()) finish({ ok: false, code: 4, why: "aborted" });
      sampleTarget();
      await sleep(50);
    }
  }

  async function throwOne(band: number, model: "flat" | "ballistic" | "ballistic+lead"): Promise<void> {
    if (targetId === undefined) return;
    const respawnBy = Date.now() + 10_000;
    for (;;) {
      if (aborted()) finish({ ok: false, code: 4, why: "aborted" });
      const me = world.self();
      const hp = me ? world.healthOf(me.id) : undefined;
      if (me && hp?.dead !== true && (hp?.hp ?? 1) > 0) break;
      if (Date.now() >= respawnBy) {
        record("DEAD no respawn within 10 s; closing");
        finish({ ok: false, code: 3, why: "dead" });
      }
      await sleep(200);
    }
    const no = (throwNo += 1);
    await track(400);
    if (targetId === undefined) return;
    const lead = model === "ballistic+lead";
    let aim = aimAt(targetId, lead);
    if (!aim || aim.outOfRange) {
      record(`band=${band} model=${model}: out of range or no aim (d=${aim?.d.toFixed(1)})`);
      return;
    }
    let losOk = hasLineOfSight(eyeNow() ?? { x: 0, y: 0, z: 0 }, aim.pred, world.aabbs);
    for (let attempt = 0; !losOk && attempt < 2; attempt += 1) {
      if (aborted()) finish({ ok: false, code: 4, why: "aborted" });
      const current = aim;
      if (!current) break;
      record(`SKIP los=false band=${band} model=${model} d=${current.d.toFixed(2)}; re-positioning (#${attempt + 1})`);
      await reachBand(band, Date.now() + 10_000);
      aim = aimAt(targetId, lead);
      if (!aim || aim.outOfRange) break;
      const eye = eyeNow();
      if (!eye) break;
      losOk = hasLineOfSight(eye, aim.pred, world.aabbs);
    }
    if (!losOk) {
      record(`NO-FIRE band=${band} model=${model}: no line of sight to the predicted point`);
      rows.push({ t: secs(), band, model, targetId, fired: false, los: false });
      if (targetId !== undefined) {
        badTargets.set(targetId, Date.now() + 20_000);
        targetId = undefined;
      }
      return;
    }
    const me0 = world.self();
    const tg0 = targetId === undefined ? undefined : poseOf(targetId);
    if (!me0 || !tg0) return;
    const faceYaw = model === "flat" ? Math.atan2(tg0.x - me0.x, tg0.z - me0.z) : aim?.yaw ?? Math.atan2(tg0.x - me0.x, tg0.z - me0.z);
    session.input.sendInput({ moveX: 0, moveZ: 0, yaw: faceYaw });
    await sleep(220);
    const me = world.self();
    const tg = targetId === undefined ? undefined : poseOf(targetId);
    if (!me || !tg) return;
    const shotAim = aimAt(targetId, lead);
    if (!shotAim || shotAim.outOfRange) {
      record(`NO-FIRE band=${band} model=${model}: re-aim out of range`);
      return;
    }
    const yaw = model === "flat" ? Math.atan2(tg.x - me.x, tg.z - me.z) : shotAim.yaw;
    const pitch = model === "flat" ? 0 : shotAim.pitch;
    const eye = { x: me.x, y: me.y + EYE_HEIGHT, z: me.z };
    const losFinal = hasLineOfSight(eye, shotAim.pred, world.aabbs);
    if (!losFinal) {
      record(`NO-FIRE band=${band} model=${model}: LOS lost at the press`);
      rows.push({ t: secs(), band, model, targetId, fired: false, los: false });
      return;
    }
    const vt = velocityOf(targetId);
    const hp0 = world.healthOf(targetId)?.hp ?? null;
    const aimedId = targetId;
    const before = snapshotPawns();
    const beforeIds = new Set(world.grenades().map((g) => g.id));
    const sent = session.input.grenade(yaw, pitch);
    record(`THROW band=${band} model=${model} d=${shotAim.d.toFixed(2)} dh=${shotAim.dh.toFixed(2)} vt=(${vt.x.toFixed(2)},${vt.z.toFixed(2)})|${vt.speed.toFixed(2)} aim=(${yaw.toFixed(3)},${pitch.toFixed(3)}) poseYaw=${me.yaw.toFixed(2)} faceYaw=${faceYaw.toFixed(2)} tFlight=${shotAim.tFlight.toFixed(2)} pred=(${shotAim.pred.x.toFixed(2)},${shotAim.pred.y.toFixed(2)},${shotAim.pred.z.toFixed(2)}) los=${losFinal} sent=${sent} hp0=${hp0}`);
    if (!sent) {
      noSend += 1;
      record(`NO-SEND band=${band} model=${model}: session input is not open (${noSend}/2)`);
      if (noSend >= 2) finish({ ok: false, code: 3, why: "no-send" });
      return;
    }
    const start = Date.now();
    const landedIdsBefore = new Set(world.landed().map((g) => g.id));
    const knownIds = new Set(world.grenades().map((g) => g.id));
    let hp600: number | null = null;
    let hp1600: number | null = null;
    let atFlight: { x: number; z: number } | null = null;
    let stop: GrenadePose | null = null;
    let stopTarget: { x: number; y: number; z: number } | null = null;
    let stopAt: number | null = null;
    let atStop: PawnRow[] | null = null;
    let after: PawnRow[] | null = null;
    let flightUpdates = 0;
    let lastPose: string | null = null;
    while (Date.now() - start < 4_500) {
      if (aborted()) finish({ ok: false, code: 4, why: "aborted" });
      const now = Date.now();
      if (stop === null) {
        const fresh = world.landed().find((g) => !landedIdsBefore.has(g.id));
        if (fresh) {
          stop = fresh;
          stopAt = Math.round((now - start) / 10) / 100;
          atStop = snapshotPawns();
          const t = targetId === undefined ? undefined : poseOf(targetId);
          if (t) stopTarget = { x: t.x, y: t.y, z: t.z };
        }
      }
      const g = world.grenades().filter((row) => !knownIds.has(row.id)).sort((a, b) => b.id - a.id)[0];
      if (g) {
        const sig = `${g.x.toFixed(2)},${g.y.toFixed(2)},${g.z.toFixed(2)},${g.stop ? 1 : 0}`;
        if (sig !== lastPose) {
          lastPose = sig;
          flightUpdates += 1;
        }
      }
      if (atFlight === null && now - start >= shotAim.tFlight * 1000) {
        const t = targetId === undefined ? undefined : poseOf(targetId);
        if (t) atFlight = { x: t.x, z: t.z };
      }
      if (hp600 === null && now - start >= 600) hp600 = targetId === undefined ? null : world.healthOf(targetId)?.hp ?? null;
      if (hp1600 === null && now - start >= 1600) {
        hp1600 = targetId === undefined ? null : world.healthOf(targetId)?.hp ?? null;
        after = snapshotPawns();
      }
      if (hp1600 !== null && (stop !== null || now - start > 4_000)) break;
      await sleep(50);
    }
    const leadErr = atFlight ? Math.hypot(atFlight.x - shotAim.pred.x, atFlight.z - shotAim.pred.z) : null;
    const surface = stop === null ? "none" : !stop.n ? "pawn" : stop.n[1] !== 0 ? "ground" : "prop";
    const missH = stop ? Math.hypot(stop.x - shotAim.pred.x, stop.z - shotAim.pred.z) : null;
    const missV = stop ? stop.y - shotAim.pred.y : null;
    const toTarget = stop && stopTarget ? Math.hypot(stop.x - stopTarget.x, stop.z - stopTarget.z) : null;
    const dead = world.healthOf(targetId)?.dead === true;
    const drop = hp0 !== null && hp1600 !== null ? hp0 - hp1600 : 0;
    const hit = dead || drop >= 40;
    const stopPos = stop ? { x: stop.x, y: stop.y, z: stop.z } : null;
    const atStopById = new Map((atStop ?? []).map((r) => [r.id, r] as const));
    const afterById = new Map((after ?? []).map((r) => [r.id, r] as const));
    type BlastRow = PawnRow & { hp1: number | null; d: number | null; loss: number | null; exp: number | null; res: number | null; match: boolean | null; exact: boolean | null; missing: boolean; inR: boolean; beyondWounded: boolean; wounded: boolean };
    const blastRows: BlastRow[] = [];
    for (const b of before) {
      const q = atStopById.get(b.id);
      if (!q || !stopPos) continue;
      const d = Math.hypot(stopPos.x - q.x, stopPos.y - q.y, stopPos.z - q.z);
      const a = afterById.get(b.id);
      const hp1 = a?.hp ?? world.healthOf(b.id)?.hp ?? null;
      const loss = b.hp !== null && hp1 !== null ? b.hp - hp1 : null;
      const exp = b.hp !== null ? Math.min(expectedLoss(d), b.hp) : null;
      const res = loss !== null && exp !== null ? loss - exp : null;
      const frameDead = a?.dead === true || world.healthOf(b.id)?.dead === true;
      blastRows.push({
        ...b,
        hp1,
        d,
        loss,
        exp,
        res,
        match: res === null ? null : b.owner ? res === 0 : Math.abs(res) <= 2,
        exact: res === null ? null : res === 0,
        dead: frameDead || hp1 === 0,
        missing: hp1 === null,
        inR: d < GRENADE_BLAST_RADIUS,
        beyondWounded: d >= GRENADE_BLAST_RADIUS && loss !== null && loss > 0,
        wounded: loss !== null && loss > 0,
      });
    }
    const num = (n: number | null): string => (n === null ? "?" : `${Math.round(n * 100) / 100}`);
    const bit = (v: boolean | null): string => (v === null ? "?" : v ? "1" : "0");
    for (const r of blastRows) {
      record(`BLAST throw=${no} id=${r.id} owner=${r.owner ? 1 : 0} player=${r.player ? 1 : 0} d=${num(r.d)} hp0=${num(r.hp)} hp1=${num(r.hp1)} loss=${num(r.loss)} exp=${num(r.exp)} res=${num(r.res)} match=${bit(r.match)} dead=${r.dead ? 1 : 0}`);
    }
    const blastSum = {
      inR: blastRows.filter((r) => r.inR).length,
      wounded: blastRows.filter((r) => r.wounded).length,
      multi: blastRows.filter((r) => r.wounded).length >= 2,
      ownerLoss: blastRows.find((r) => r.owner)?.loss ?? null,
      targetLoss: blastRows.find((r) => r.id === aimedId)?.loss ?? null,
      beyondWounded: blastRows.filter((r) => r.beyondWounded).length,
      missing: blastRows.filter((r) => r.missing).length,
      mismatch: blastRows.filter((r) => r.match === false).length,
    };
    record(`BLAST-SUM throw=${no} band=${band} model=${model} stop=${stop ? `${stop.x.toFixed(2)},${stop.y.toFixed(2)},${stop.z.toFixed(2)}` : "none"} n=${stop?.n ? stop.n.join(",") : "-"} surface=${surface} pawns=${blastRows.length} inR=${blastSum.inR} wounded=${blastSum.wounded} multi=${blastSum.multi ? 1 : 0} ownerLoss=${num(blastSum.ownerLoss)} targetLoss=${num(blastSum.targetLoss)} beyondWounded=${blastSum.beyondWounded} missing=${blastSum.missing} mismatch=${blastSum.mismatch}`);
    record(`  RESULT band=${band} model=${model} leadErr=${leadErr === null ? "?" : leadErr.toFixed(2)} landed=${stop ? `${stop.x.toFixed(2)},${stop.y.toFixed(2)},${stop.z.toFixed(2)}${stop.n ? ` n=${stop.n.join(",")}` : ""}` : "none"} surface=${surface} missH=${missH === null ? "?" : missH.toFixed(2)} missV=${missV === null ? "?" : missV.toFixed(2)} toTarget=${toTarget === null ? "?" : toTarget.toFixed(2)} stopAt=${stopAt === null ? "?" : stopAt.toFixed(2)} flight=${flightUpdates} hp600=${hp600} hp1600=${hp1600} hit=${hit} kill=${dead} selfHp=${world.health()?.hp ?? "?"}`);
    rows.push({
      t: secs(),
      band,
      model,
      targetId,
      fired: true,
      d: Math.round(shotAim.d * 100) / 100,
      dh: Math.round(shotAim.dh * 100) / 100,
      vt: { x: Math.round(vt.x * 100) / 100, z: Math.round(vt.z * 100) / 100, speed: Math.round(vt.speed * 100) / 100 },
      aim: { yaw: Math.round(yaw * 1000) / 1000, pitch: Math.round(pitch * 1000) / 1000 },
      poseYaw: Math.round(me.yaw * 100) / 100,
      faceYaw: Math.round(faceYaw * 1000) / 1000,
      tFlight: Math.round(shotAim.tFlight * 100) / 100,
      pred: shotAim.pred,
      los: true,
      hp0,
      hp600,
      hp1600,
      leadErr: leadErr === null ? null : Math.round(leadErr * 100) / 100,
      landed: stop ? { id: stop.id, x: stop.x, y: stop.y, z: stop.z, ...(stop.n ? { n: stop.n } : {}) } : null,
      surface,
      miss: missH === null || missV === null ? null : { h: Math.round(missH * 100) / 100, v: Math.round(missV * 100) / 100 },
      toTarget: toTarget === null ? null : Math.round(toTarget * 100) / 100,
      stopAt,
      flight: flightUpdates,
      blast: {
        stop: stopPos,
        n: stop?.n ?? null,
        surface,
        pawns: blastRows,
        ...blastSum,
        kills: blastRows.filter((r) => r.dead && r.wounded).length,
      },
      hit,
      kill: dead,
    });
    if (dead) targetId = undefined;
  }

  const run = async (): Promise<Result> => {
    const rawSend = session.input.sendInput.bind(session.input);
    session.input.sendInput = (cmd: { moveX: number; moveZ: number; yaw: number }) => {
      lastCmd = { moveX: cmd.moveX, moveZ: cmd.moveZ, yaw: cmd.yaw };
      rawSend(cmd);
    };
    try {
      record(`projectile start self=${selfId} bands=${BANDS.join(",")} throws=${THROWS} seconds=${opts.seconds} trial=${TRIAL}/${FALLBACK}/${FILTER}/${ROUTE}`);
      record(`weapon=${world.weapon() ?? "none"} ammo=${world.ammo()} hp=${world.health()?.hp ?? "?"} others=${world.others().length}`);
      traceStart();
      try {
        const end = t0 + RUN_MS;
        const controlBand = BANDS[BANDS.length - 1] ?? 20;
        for (let i = 0; i < 2 && Date.now() < end; i += 1) {
          if (aborted()) finish({ ok: false, code: 4, why: "aborted" });
          if (targetId === undefined) targetId = selectTarget();
          if (targetId === undefined) {
            record("no outside non-player target");
            break;
          }
          await reachBand(controlBand, Math.min(end, Date.now() + 20_000));
          await throwOne(controlBand, "flat");
          await sleep(1100);
        }
        for (const band of BANDS) {
          for (const model of ["ballistic", "ballistic+lead"] as const) {
            for (let i = 0; i < THROWS && Date.now() < end; i += 1) {
              if (aborted()) finish({ ok: false, code: 4, why: "aborted" });
              if (targetId === undefined) targetId = selectTarget();
              if (targetId === undefined) {
                record(`no target for band ${band}; skipping`);
                await sleep(500);
                break;
              }
              const d = await reachBand(band, Math.min(end, Date.now() + 20_000));
              record(`positioned band=${band} d=${d.toFixed(2)} target=${targetId}`);
              await throwOne(band, model);
              sampleTarget();
              await sleep(1100);
            }
          }
        }
      } catch (err) {
        if (err instanceof ProjectileEnd) throw err;
        record(`ERROR ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      }
      const fired = rows.filter((r) => r.fired === true).length;
      const hits = rows.filter((r) => r.hit === true).length;
      const kills = rows.filter((r) => r.kill === true).length;
      record(`PROJECTILE end rows=${rows.length} fired=${fired} hits=${hits} kills=${kills} attempts=${attempts.length} elapsed=${secs()}s`);
      finish({ ok: true, code: 0, data: { attempts: attempts.length, fired, hits, kills, metrics: summarize(), trace: TRACE_PATH } });
    } catch (e) {
      if (e instanceof ProjectileEnd) return e.result;
      record(`ERROR ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
      return { ok: false, code: 1, why: `error:${e instanceof Error ? e.message : String(e)}` };
    } finally {
      stopSampler();
      session.input.sendInput = rawSend;
    }
    return { ok: false, code: 1, why: "unreachable" };
  };
  return run;
};

const projectileHandler = async (a: Record<string, unknown>): Promise<Result> => {
  const rawBands = a.bands;
  const bands = Array.isArray(rawBands)
    ? rawBands.map((n) => Number(n))
    : typeof rawBands === "string" && rawBands.trim().length > 0
      ? rawBands.split(",").map((s) => Number(s.trim()))
      : [5, 10, 20];
  if (bands.length === 0 || bands.some((n) => !Number.isFinite(n) || n <= 0 || n > 30)) return { ok: false, code: 1, why: "bad-args" };
  const throwsRaw = a.throws === undefined ? 4 : Number(a.throws);
  if (!Number.isInteger(throwsRaw) || throwsRaw < 1 || throwsRaw > 8) return { ok: false, code: 1, why: "bad-args" };
  const secondsRaw = a.seconds === undefined ? 120 : Number(a.seconds);
  if (!Number.isFinite(secondsRaw) || secondsRaw < 10) return { ok: false, code: 1, why: "bad-args" };
  const seconds = Math.min(secondsRaw, TASK_TIMEOUT_MS / 1000);
  const trial = typeof a.trial === "string" ? a.trial : "control";
  const fallback = typeof a.fallback === "string" ? a.fallback : "straight";
  const filter = typeof a.filter === "string" ? a.filter : "none";
  const route = typeof a.route === "string" ? a.route : "point";
  return createProjectile({ bands, throws: throwsRaw, seconds, trial, fallback, filter, route })();
};

const HANDLERS: Record<string, (a: Record<string, unknown>) => Promise<Result>> = {
  arm: armHandler,
  goto: gotoHandler,
  stand: standHandler,
  walk: walkHandler,
  reload: reloadHandler,
  hunt: huntHandler,
  patrol: patrolHandler,
  retrieve: retrieveHandler,
  getkey: getkeyHandler,
  projectile: projectileHandler,
};

// --- dispatcher -----------------------------------------------------------
async function runTask(cmd: Cmd, origin: Origin): Promise<void> {
  const t = Date.now();
  busy = { id: cmd.id, name: cmd.name };
  abortRequested = false;
  brainStep = "";
  replanReason = "";
  planSteps = 0;
  record(`TASK-START id=${cmd.id} name=${cmd.name} t=${secs()}s`);
  emit(cmd, origin, { t: "ev", id: cmd.id, name: cmd.name, ev: "start" });
  let result: Result;
  try {
    const handler = HANDLERS[cmd.name];
    result = handler ? await handler(cmd.args ?? {}) : { ok: false, code: 1, why: "unknown-task" };
  } catch (err) {
    result = err instanceof AbortMission
      ? { ok: false, code: 4, why: "aborted" }
      : { ok: false, code: 1, why: `error:${err instanceof Error ? err.message : String(err)}` };
  }
  abortRequested = false;
  const ms = Date.now() - t;
  busy = undefined;
  lastResult = { id: cmd.id, ok: result.ok };
  const ev: Record<string, unknown> = result.ok
    ? { t: "ev", id: cmd.id, name: cmd.name, ev: "done", ok: true, code: 0, ms, ...(result.note ? { note: result.note } : {}), ...(result.data ?? {}) }
    : { t: "ev", id: cmd.id, name: cmd.name, ev: "fail", ok: false, code: result.code, why: result.why, ms };
  record(`TASK-DONE id=${cmd.id} name=${cmd.name} ok=${result.ok} code=${ev.code} why=${result.ok ? "-" : result.why} ms=${ms}`);
  emit(cmd, origin, ev);
  countTask(ev);
  writeTranscript({
    at: new Date().toISOString(),
    via: origin.via,
    from: origin.from ?? null,
    id: cmd.id,
    name: cmd.name,
    args: cmd.args ?? {},
    ev: result.ok ? "done" : "fail",
    ok: result.ok,
    why: result.ok ? null : result.why,
    ms,
    statusAfter: buildStatus(cmd.id),
  });
  const next = pending;
  pending = undefined;
  if (next) handleCommand(next.cmd, next.origin);
}

function handleCommand(cmd: Cmd, origin: Origin): void {
  record(`CMD-RECV via=${origin.via} from=${origin.from ?? "-"} id=${cmd.id} name=${cmd.name} args=${JSON.stringify(cmd.args ?? {})}`);
  if (executed.has(cmd.id)) {
    const ev = { t: "ev", id: cmd.id, name: cmd.name, ev: "fail", ok: false, code: 1, why: "duplicate", ms: 0 };
    emit(cmd, origin, ev);
    countTask(ev);
    writeTranscript({
      at: new Date().toISOString(), via: origin.via, from: origin.from ?? null,
      id: cmd.id, name: cmd.name, args: cmd.args ?? {},
      ev: "fail", ok: false, why: "duplicate", ms: 0, statusAfter: buildStatus(cmd.id),
    });
    return;
  }
  if (cmd.name === "abort") {
    executed.add(cmd.id);
    const wasBusy = busy?.name ?? null;
    abortRequested = true;
    const ev = { t: "ev", id: cmd.id, name: "abort", ev: "done", ok: true, code: 0, note: wasBusy ? `aborting:${wasBusy}` : "no-task", ms: 0 };
    emit(cmd, origin, ev);
    writeTranscript({
      at: new Date().toISOString(), via: origin.via, from: origin.from ?? null,
      id: cmd.id, name: "abort", args: cmd.args ?? {},
      ev: "ack", ok: true, why: null, ms: 0, statusAfter: buildStatus(cmd.id),
    });
    return;
  }
  if (cmd.name === "status") {
    executed.add(cmd.id);
    const body = sendStatus(cmd, origin);
    writeTranscript({
      at: new Date().toISOString(), via: origin.via, from: origin.from ?? null,
      id: cmd.id, name: cmd.name, args: cmd.args ?? {},
      ev: "status", ok: true, why: null, ms: 0, statusAfter: body,
    });
    return;
  }
  if (busy) {
    if (abortRequested && pending === undefined) {
      pending = { cmd, origin };
      record(`CMD-QUEUED id=${cmd.id} name=${cmd.name} behind the abort of ${busy.id}`);
      return;
    }
    const ev = { t: "ev", id: cmd.id, name: cmd.name, ev: "fail", ok: false, code: 1, why: "busy", ms: 0 };
    emit(cmd, origin, ev);
    countTask(ev);
    writeTranscript({
      at: new Date().toISOString(), via: origin.via, from: origin.from ?? null,
      id: cmd.id, name: cmd.name, args: cmd.args ?? {},
      ev: "fail", ok: false, why: "busy", ms: 0, statusAfter: buildStatus(cmd.id),
    });
    return;
  }
  executed.add(cmd.id);
  void runTask(cmd, origin);
}

// --- msg ingress ----------------------------------------------------------
const seen = new Set<string>();
function pollMessages(): void {
  for (const row of world.messages()) {
    const key = `${row.from}:${row.seq}:${row.at}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (row.to !== 0 && row.to !== selfId) {
      record(`MSG-SKIP from=${row.from} to=${row.to} seq=${row.seq}`);
      continue;
    }
    let parsed: Record<string, unknown> | undefined;
    try {
      parsed = JSON.parse(row.text) as Record<string, unknown>;
    } catch {
      parsed = undefined;
    }
    out({ type: "msg", from: row.from, to: row.to, seq: row.seq, at: row.at, text: row.text, lagMs: Date.now() - row.at });
    if (!parsed || typeof parsed.id !== "string") continue;
    if (parsed.t === "cmd" && typeof parsed.name === "string") {
      handleCommand(parsed as Cmd, { via: "msg", from: row.from });
    } else if (parsed.t === "ev" || parsed.t === "status") {
      replies.set(parsed.id, parsed);
    }
  }
}

// --- mailbox ingress ------------------------------------------------------
let autoId = 0;

function handleMailbox(raw: string): void {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    out({ type: "error", why: "bad json", raw });
    return;
  }
  const id = msg.id === undefined || msg.id === null || msg.id === "" ? `auto-${(autoId += 1)}` : String(msg.id);
  switch (String(msg.cmd ?? "")) {
    case "task": {
      const name = typeof msg.name === "string" ? msg.name : "";
      if (name.length === 0) {
        out({ type: "error", id, why: "bad-task" });
        return;
      }
      const cmdArgs = msg.args && typeof msg.args === "object" && !Array.isArray(msg.args) ? (msg.args as Record<string, unknown>) : {};
      handleCommand({ t: "cmd", id, name, args: cmdArgs }, { via: "mailbox" });
      break;
    }
    case "ping":
      out({ type: "pong", id, self: selfId });
      break;
    case "status": {
      const body = buildStatus(id ?? "status");
      out({ ...body });
      record(`STATUS id=${id ?? "status"} len=${JSON.stringify(body).length}`);
      writeTranscript({
        at: new Date().toISOString(), via: "mailbox", from: null,
        id: id ?? "status", name: "status", args: {},
        ev: "status", ok: true, why: null, ms: 0, statusAfter: body,
      });
      break;
    }
    case "note": {
      const text = typeof msg.text === "string" ? msg.text.trim() : "";
      if (text.length === 0) {
        out({ type: "error", id, why: "empty-note" });
        break;
      }
      const note = text.length > NOTE_MAX ? text.slice(0, NOTE_MAX) : text;
      const at = new Date().toISOString();
      mailbox.note(note);
      out({ type: "ack", id, what: "note", len: note.length });
      record(`NOTE len=${note.length} file=${mailbox.files.notes}`);
      writeTranscript({
        at, via: "mailbox", from: null, id, name: "note", args: { text: note },
        ev: "ack", ok: true, why: null, ms: 0, statusAfter: buildStatus(id),
      });
      break;
    }
    case "send":
    case "say": {
      const to = msg.to === undefined || msg.to === "*" || msg.to === "" ? 0 : Number(msg.to);
      enqueueSay(String(msg.text ?? ""), Number.isInteger(to) && to >= 0 ? to : 0);
      out({ type: "ack", id, what: "send", state: "queued" });
      break;
    }
    case "quit":
      out({ type: "bye", id });
      finish(0);
      break;
    default:
      out({ type: "error", id, why: `unknown cmd "${String(msg.cmd ?? "")}"` });
  }
}

// --- scenario runner ------------------------------------------------------
function matchesAwait(reply: Record<string, unknown>, want: string): boolean {
  if (want === "status") return reply.t === "status";
  if (reply.t !== "ev") return false;
  return reply.ev === want;
}

async function runScenario(file: string): Promise<void> {
  const steps = readFileSync(file, "utf8").split("\n").filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as { send: Cmd; await?: string; timeoutMs?: number; expect?: Record<string, unknown> });
  record(`SCENARIO start file=${file} steps=${steps.length}`);
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i]!;
    const cmd = step.send;
    const want = step.await ?? "done";
    if (!cmd || cmd.t !== "cmd" || typeof cmd.id !== "string") {
      record(`SCENARIO FAIL step=${i + 1} id=- why=bad-step`);
      finish(2);
    }
    replies.delete(cmd.id);
    const t = Date.now();
    enqueueSay(JSON.stringify(cmd), selfId);
    const deadline = t + (step.timeoutMs ?? TASK_TIMEOUT_MS);
    let reply: Record<string, unknown> | undefined;
    let why: string | undefined;
    for (;;) {
      reply = replies.get(cmd.id);
      if (reply) {
        if (matchesAwait(reply, want)) break;
        if (want === "done" && reply.t === "ev" && reply.ev === "fail") {
          why = String(reply.why ?? "fail");
          break;
        }
        if (want === "fail" && reply.t === "ev" && reply.ev === "done") {
          why = "expected-fail";
          break;
        }
      }
      if (Date.now() > deadline) {
        why = "timeout";
        break;
      }
      await sleep(50);
    }
    if (why === undefined && reply && step.expect) {
      for (const key of Object.keys(step.expect)) {
        if (reply[key] !== step.expect[key]) {
          why = `expect:${key}=${String(reply[key])}`;
          break;
        }
      }
    }
    const ms = Date.now() - t;
    const ok = why === undefined;
    record(`SCENARIO step=${i + 1} id=${cmd.id} await=${want} ok=${ok} ms=${ms}${ok ? "" : ` why=${why}`}`);
    if (!ok) {
      exitScenario = "fail";
      exitSteps = i + 1;
      record(`SCENARIO FAIL step=${i + 1} id=${cmd.id} why=${why}`);
      finish(2);
    }
  }
  exitScenario = "pass";
  exitSteps = steps.length;
  record(`SCENARIO PASS steps=${steps.length}`);
  finish(0);
}

// --- status heartbeat -----------------------------------------------------
function snapshot(): Record<string, unknown> {
  const me = world.self();
  const h = me ? world.healthOf(me.id) : undefined;
  return {
    self: me ? { id: me.id, x: me.x, y: me.y, z: me.z, place: world.placeOf(me)?.id ?? "?", hp: h?.hp ?? null, dead: h?.dead === true, weapon: world.weapon() ?? "none", ammo: world.ammo() } : null,
    others: world.others().map((p) => ({ id: p.id, d: Math.round(Math.hypot(p.x - (me?.x ?? 0), p.z - (me?.z ?? 0)) * 10) / 10, player: players.has(p.id), hp: world.healthOf(p.id)?.hp ?? null })),
    messages: { sent, received: replies.size, supported: world.messagesSupported() },
    claims: { total: world.claims().size, msgKeys: msgKeyCount() },
    task: busy ?? null,
    queue: queue.length,
    pid: process.pid,
  };
}
function msgKeyCount(): number {
  let n = 0;
  for (const key of world.claims().keys()) if (key.startsWith("msg:")) n += 1;
  return n;
}

// --- lifecycle -------------------------------------------------------------
let stop = false;
let exitScenario = "none";
let exitSteps = 0;
function finish(code: number): never {
  stop = true;
  clearInterval(timer);
  clearInterval(sender);
  clearInterval(traceTimer);
  clearInterval(deathTimer);
  try {
    writeStatus(snapshot());
  } catch {
    // best effort
  }
  try {
    const roll = {
      start: START_ISO,
      elapsed: Math.round((Date.now() - t0) / 1000),
      commands: tally.commands,
      ok: tally.ok,
      fail: tally.fail,
      kills: tally.kills,
      shots: tally.shots,
      visits: tally.visits,
      hpStart,
      hpEnd: world.healthOf(selfId)?.hp ?? null,
    };
    mailbox.session(roll);
    record(`SESSION commands=${roll.commands} ok=${roll.ok} fail=${roll.fail} kills=${roll.kills} shots=${roll.shots} visits=${roll.visits}`);
  } catch (err) {
    record(`SESSION write failed: ${String(err)}`);
  }
  record(`EXIT scenario=${exitScenario} steps=${exitSteps} msgKeys=${msgKeyCount()} elapsed=${secs()}s`);
  writeFileSync(LOG, `${lines.join("\n")}\n`);
  session.close();
  process.exit(code);
}

const sender = setInterval(() => {
  if (!stop) flushOne();
}, SEND_MS);
// Task 128 spike: 250 ms pose/step/nearest-door/press trace for the wedge.
const traceTimer = setInterval(() => {
  if (stop) return;
  const me = world.self();
  if (!me) return;
  let nearest: { id: string; d: number; open: boolean; locked: boolean } | undefined;
  let best = Infinity;
  let doorsOpen = 0;
  for (const door of world.doors()) {
    if (door.open) doorsOpen += 1;
    const body = world.doorBody(door.id);
    if (!body) continue;
    const dist = Math.hypot(body.position[0] - me.x, body.position[2] - me.z);
    if (dist < best) {
      best = dist;
      nearest = { id: door.id, d: round2(dist), open: door.open, locked: door.locked };
    }
  }
  if (nearest && nearest.id !== lastDoorId) {
    lastDoorId = nearest.id;
    record(`DOORBODY id=${nearest.id} body=${JSON.stringify(world.doorBody(nearest.id))}`);
  }
  const row = {
    t: secs(),
    x: round2(me.x),
    y: round2(me.y),
    z: round2(me.z),
    place: world.placeOf(me)?.id ?? "?",
    task: busy?.name ?? null,
    step: brainStep,
    planSteps,
    nearest,
    doorsOpen,
    usePresses: presses,
    keyAvail: world.pickups().includes("key"),
    pickupCount: world.pickups().length,
    replanReason,
    keys: [...world.keys()],
  };
  try {
    appendFileSync(TRACE, `${JSON.stringify(row)}\n`);
  } catch {
    // best effort
  }
}, SAMPLE_MS);
// Task 130: the death/respawn sampler — the live proof of the packed `dead`.
let lastDead: boolean | null = null;
const deathTimer = setInterval(() => {
  if (stop) return;
  const h = world.healthOf(selfId);
  if (!h) return;
  if (lastDead === null) {
    lastDead = h.dead;
    return;
  }
  if (h.dead !== lastDead) {
    record(`${h.dead ? "DEATH-SAMPLE" : "RESPAWN-SAMPLE"} hp=${h.hp} dead=${h.dead} t=${secs().toFixed(1)}s`);
    lastDead = h.dead;
  }
}, SAMPLE_MS);
const timer = setInterval(() => {
  if (stop) return;
  try {
    for (const raw of mailbox.poll()) handleMailbox(raw);
    pollMessages();
    writeStatus(snapshot());
  } catch (err) {
    record(`tick error: ${String(err)}`);
  }
}, SAMPLE_MS);

process.on("SIGINT", () => finish(130));
process.on("SIGTERM", () => finish(143));
process.on("uncaughtException", (err) => {
  record(`UNCAUGHT ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  finish(1);
});

record(`READY self=${selfId} messagesSupported=${world.messagesSupported()} scenario=${SCENARIO ?? "none"} inbox=${mailbox.files.inbox} outbox=${mailbox.files.outbox} status=${mailbox.files.status}`);

if (SCENARIO) {
  exitScenario = "fail";
  void (async () => {
    try {
      await runScenario(SCENARIO);
    } catch (err) {
      record(`SCENARIO ERROR ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      finish(2);
    }
  })();
}
