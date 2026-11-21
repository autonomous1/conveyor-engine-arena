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
const LOG = `plan/dsh-tasks/logs/${LABEL}-${STAMP}.log`;
const SAMPLE_MS = 250;
const SEND_MS = 250;
const MAX_TEXT = 256;
const TASK_TIMEOUT_MS = 180_000;

mkdirSync(DIR, { recursive: true });
mkdirSync("plan/dsh-tasks/logs", { recursive: true });
const t0 = Date.now();
const secs = (): number => Math.round((Date.now() - t0) / 100) / 10;
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
const replies = new Map<string, Record<string, unknown>>();

function emit(cmd: Cmd, origin: Origin, ev: Record<string, unknown>): void {
  const text = JSON.stringify(ev);
  if (text.length > MAX_TEXT) record(`EV-TOO-LONG id=${cmd.id} len=${text.length}`);
  out({ ...ev });
  record(`EV-SEND to=${origin.from ?? "-"} len=${text.length} ${text}`);
  if (origin.via === "msg" && origin.from !== undefined) enqueueSay(text, origin.from);
}

function sendStatus(cmd: Cmd, origin: Origin): void {
  const body = buildStatus(cmd.id);
  const text = JSON.stringify(body);
  out({ ...body });
  record(`STATUS id=${cmd.id} len=${text.length} ${text}`);
  if (origin.via === "msg" && origin.from !== undefined) enqueueSay(text, origin.from);
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
      log: (line) => {
        record(`  ${label} ${line}`);
        const m = /no plan: ([a-z-]+)/.exec(line);
        if (m) lastNoPlan = m[1]!;
      },
      error: (line) => record(`  ${label} ERROR ${line}`),
    });
    if (code === 0) return { ok: true, code: 0 };
    if (code === 2) return { ok: false, code: 2, why: `no-plan:${lastNoPlan ?? "unknown"}` };
    if (code === 3) return { ok: false, code: 3, why: "timeout" };
    return { ok: false, code, why: `code:${code}` };
  } catch (err) {
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
      record(`HUNT end kills=${kills} shots=${shots} minutes=${minutes} elapsed=${secs()}s`);
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
      record(`HUNT end kills=${kills} shots=${shots} minutes=${minutes} elapsed=${secs()}s`);
      return { ok: false, code: 1, why: "died" };
    }
    if (outcome === "no_ammo") {
      consecutiveNoAmmo += 1;
      if (consecutiveNoAmmo >= 2 && world.ammo() === 0) {
        record(`HUNT end kills=${kills} shots=${shots} minutes=${minutes} elapsed=${secs()}s`);
        return { ok: false, code: 1, why: "no-ammo" };
      }
    } else {
      consecutiveNoAmmo = 0;
    }
    await sleep(200);
  }
  record(`HUNT end kills=${kills} shots=${shots} minutes=${minutes} elapsed=${secs()}s`);
  if (!sawTarget) return { ok: false, code: 1, why: "no-target" };
  return { ok: true, code: 0, data: { minutes, kills, shots, hp: world.healthOf(selfId)?.hp ?? null } };
};

const patrolHandler = async (a: Record<string, unknown>): Promise<Result> => {
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
  record(`PATROL end places=[${visited.join(",")}] minutes=${minutes} elapsed=${secs()}s code=${code}`);
  if (died || world.healthOf(selfId)?.dead === true) return { ok: false, code: 1, why: "died" };
  if (code === 3) return { ok: true, code: 0, data: { minutes, places: visited } };
  if (code === 2) return { ok: false, code: 2, why: `no-plan:${lastNoPlan ?? "unknown"}` };
  return { ok: false, code, why: `code:${code}` };
};

const HANDLERS: Record<string, (a: Record<string, unknown>) => Promise<Result>> = {
  arm: armHandler,
  goto: gotoHandler,
  stand: standHandler,
  reload: reloadHandler,
  hunt: huntHandler,
  patrol: patrolHandler,
};

// --- dispatcher -----------------------------------------------------------
async function runTask(cmd: Cmd, origin: Origin): Promise<void> {
  const t = Date.now();
  busy = { id: cmd.id, name: cmd.name };
  record(`TASK-START id=${cmd.id} name=${cmd.name} t=${secs()}s`);
  emit(cmd, origin, { t: "ev", id: cmd.id, name: cmd.name, ev: "start" });
  let result: Result;
  try {
    const handler = HANDLERS[cmd.name];
    result = handler ? await handler(cmd.args ?? {}) : { ok: false, code: 1, why: "unknown-task" };
  } catch (err) {
    result = { ok: false, code: 1, why: `error:${err instanceof Error ? err.message : String(err)}` };
  }
  const ms = Date.now() - t;
  busy = undefined;
  lastResult = { id: cmd.id, ok: result.ok };
  const ev: Record<string, unknown> = result.ok
    ? { t: "ev", id: cmd.id, name: cmd.name, ev: "done", ok: true, code: 0, ms, ...(result.note ? { note: result.note } : {}), ...(result.data ?? {}) }
    : { t: "ev", id: cmd.id, name: cmd.name, ev: "fail", ok: false, code: result.code, why: result.why, ms };
  record(`TASK-DONE id=${cmd.id} name=${cmd.name} ok=${result.ok} code=${ev.code} why=${result.ok ? "-" : result.why} ms=${ms}`);
  emit(cmd, origin, ev);
}

function handleCommand(cmd: Cmd, origin: Origin): void {
  record(`CMD-RECV via=${origin.via} from=${origin.from ?? "-"} id=${cmd.id} name=${cmd.name} args=${JSON.stringify(cmd.args ?? {})}`);
  if (executed.has(cmd.id)) {
    emit(cmd, origin, { t: "ev", id: cmd.id, name: cmd.name, ev: "fail", ok: false, code: 1, why: "duplicate", ms: 0 });
    return;
  }
  if (cmd.name === "status") {
    executed.add(cmd.id);
    sendStatus(cmd, origin);
    return;
  }
  if (busy) {
    emit(cmd, origin, { t: "ev", id: cmd.id, name: cmd.name, ev: "fail", ok: false, code: 1, why: "busy", ms: 0 });
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
  try {
    writeStatus(snapshot());
  } catch {
    // best effort
  }
  record(`EXIT scenario=${exitScenario} steps=${exitSteps} msgKeys=${msgKeyCount()} elapsed=${secs()}s`);
  writeFileSync(LOG, `${lines.join("\n")}\n`);
  session.close();
  process.exit(code);
}

const sender = setInterval(() => {
  if (!stop) flushOne();
}, SEND_MS);
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
