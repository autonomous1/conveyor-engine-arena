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
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
const token = (process.env.CE_TOKEN ?? "").trim() || readFileSync(join(homedir(), ".config/ce-arena/qa-token.pem"), "utf8").trim();
const STAMP = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const LABEL = args.get("label") ?? "123-cmd";
const DIR = args.get("dir") ?? "plan/dsh-tasks/live/123-cmd";
const NAME = args.get("name") ?? "cmd-host";
const SCENARIO = args.get("scenario") ?? undefined;
const INBOX = join(DIR, "inbox.ndjson");
const OUTBOX = join(DIR, "outbox.ndjson");
const STATUS = join(DIR, "status.json");
/** Recorder: append one row per dispatched command. */
const TRANSCRIPT = join(DIR, "transcript.ndjson");
/** Recorder: append the operator's notes. */
const NOTES = join(DIR, "notes.md");
/** Recorder: the per-session roll-up (overwritten at exit). */
const SESSION = join(DIR, "session.json");
/** The note text is mailbox-side, so it has no 256 cap; this is its own bound. */
const NOTE_MAX = 2_000;
const LOG = `plan/dsh-tasks/logs/${LABEL}-${STAMP}.log`;
/** Task 128 spike: the 250 ms trace of the wedge (task, step, nearest door, presses). */
const TRACE = `plan/dsh-tasks/logs/${LABEL}-${STAMP}.ndjson`;
const SAMPLE_MS = 250;
const SEND_MS = 250;
const MAX_TEXT = 256;
const TASK_TIMEOUT_MS = 180_000;

mkdirSync(DIR, { recursive: true });
mkdirSync("plan/dsh-tasks/logs", { recursive: true });
const t0 = Date.now();
const START_ISO = new Date(t0).toISOString();
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
  appendFileSync(OUTBOX, `${JSON.stringify(event)}\n`);
};
const writeStatus = (body: Record<string, unknown>): void => {
  const tmp = `${STATUS}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ at: new Date().toISOString(), t: secs(), ...body }, null, 1)}\n`);
  renameSync(tmp, STATUS);
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
  appendFileSync(TRANSCRIPT, `${line}\n`);
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

const standHandler = async (a: Record<string, unknown>): Promise<Result> => {
  const x = Number(a.x);
  const y = Number(a.y);
  const z = Number(a.z);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return { ok: false, code: 1, why: "bad-args" };
  const yaw = a.yaw === undefined ? "" : `,${Number(a.yaw)}`;
  if (a.yaw !== undefined && !Number.isFinite(Number(a.yaw))) return { ok: false, code: 1, why: "bad-args" };
  return runMissionTask(`stand:${x},${y},${z}${yaw}`, "stand");
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
let processed = 0;
let autoId = 0;
const readInbox = (): string[] => {
  if (!existsSync(INBOX)) return [];
  return readFileSync(INBOX, "utf8").split("\n").filter((l) => l.trim().length > 0);
};
processed = readInbox().length; // ignore commands from an earlier run

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
      appendFileSync(NOTES, `- ${at} ${note}\n`);
      out({ type: "ack", id, what: "note", len: note.length });
      record(`NOTE len=${note.length} file=${NOTES}`);
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
    writeFileSync(SESSION, `${JSON.stringify(roll)}\n`);
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
    const all = readInbox();
    if (all.length < processed) processed = 0;
    for (let i = processed; i < all.length; i += 1) handleMailbox(all[i]!);
    processed = all.length;
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

record(`READY self=${selfId} messagesSupported=${world.messagesSupported()} scenario=${SCENARIO ?? "none"} inbox=${INBOX} outbox=${OUTBOX} status=${STATUS}`);

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
