// Task 123: one persistent bot as a message-driven command surface.
// Task 139: the ten handlers and the status projection live in
// `../src/commands.ts`; this script is the CLI/token/mailbox/recorder/trace
// driver and keeps the `start` -> `done`/`fail` envelope.
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
import { createCommandHost, type CommandResult, type CommandStatus } from "../src/commands.ts";
import { openNodeSocket } from "../src/node-socket.ts";
import { NOTE_MAX, openMailbox } from "../src/mailbox.ts";

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
const host = createCommandHost({ session, log: record });
/** An abort was sent and its task has not ended: queue the next command once. */
let abortPending = false;
/** First known hp after the welcome (the welcome seeds it); null when unknown. */
hpStart = world.healthOf(selfId)?.hp ?? null;

const round2 = (n: number): number => Math.round(n * 100) / 100;

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
type Cmd = { t: "cmd"; id: string; name: string; args?: Record<string, unknown> };
const executed = new Set<string>();
/** A command held behind an abort that is still unwinding. */
let pending: { cmd: Cmd; origin: Origin } | undefined;
const replies = new Map<string, Record<string, unknown>>();
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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

function sendStatus(cmd: Cmd, origin: Origin): CommandStatus {
  const body = host.status(cmd.id);
  const text = JSON.stringify(body);
  out({ ...body });
  record(`STATUS id=${cmd.id} len=${text.length} ${text}`);
  if (origin.via === "msg" && origin.from !== undefined) enqueueSay(text, origin.from);
  return body;
}

// --- dispatcher -----------------------------------------------------------
/** The mission lines the driver's 250 ms trace samples (the host forwards them raw). */
function parseTrace(line: string): void {
  const st = /^start (\S+)/.exec(line);
  if (st) brainStep = st[1]!;
  const rp = /^replan (\S+)/.exec(line);
  if (rp) replanReason = rp[1]!;
  const pd = /plan done .*?steps=(\d+)/.exec(line);
  if (pd) planSteps = Number(pd[1]);
}

/**
 * Write the projectile's trace document (the host returns it in `artifact`; it
 * never touches fs). The 141 path and columns are unchanged.
 */
function writeProjectileTrace(body: unknown): string {
  const path = `plan/dsh-tasks/live/141-projectile/projectile-${STAMP}.json`;
  try {
    mkdirSync("plan/dsh-tasks/live/141-projectile", { recursive: true });
    writeFileSync(path, `${JSON.stringify(body, null, 1)}\n`);
  } catch {
    // the trace is evidence; a write failure must not change the run
  }
  return path;
}

async function runTask(cmd: Cmd, origin: Origin): Promise<void> {
  const t = Date.now();
  abortPending = false;
  brainStep = "";
  replanReason = "";
  planSteps = 0;
  record(`TASK-START id=${cmd.id} name=${cmd.name} t=${secs()}s`);
  emit(cmd, origin, { t: "ev", id: cmd.id, name: cmd.name, ev: "start" });
  let result: CommandResult;
  try {
    result = await host.dispatch(cmd, {
      onLine: (line) => {
        record(`  ${line}`);
        parseTrace(line);
      },
    });
  } catch (err) {
    result = { ok: false, code: 1, why: `error:${err instanceof Error ? err.message : String(err)}` };
  }
  const ms = Date.now() - t;
  abortPending = false;
  // The projectile's trace document is data, not an event field: write it and
  // put the path where 141's event had it.
  const data: Record<string, unknown> = result.ok ? { ...(result.data ?? {}) } : {};
  if (result.ok && result.artifact?.name === "projectile") data.trace = writeProjectileTrace(result.artifact.body);
  const ev: Record<string, unknown> = result.ok
    ? { t: "ev", id: cmd.id, name: cmd.name, ev: "done", ok: true, code: 0, ms, ...(result.note ? { note: result.note } : {}), ...data }
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
    statusAfter: host.status(cmd.id),
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
      ev: "fail", ok: false, why: "duplicate", ms: 0, statusAfter: host.status(cmd.id),
    });
    return;
  }
  if (cmd.name === "abort") {
    executed.add(cmd.id);
    const wasBusy = host.busy?.name ?? null;
    host.abort();
    abortPending = true;
    const ev = { t: "ev", id: cmd.id, name: "abort", ev: "done", ok: true, code: 0, note: wasBusy ? `aborting:${wasBusy}` : "no-task", ms: 0 };
    emit(cmd, origin, ev);
    writeTranscript({
      at: new Date().toISOString(), via: origin.via, from: origin.from ?? null,
      id: cmd.id, name: "abort", args: cmd.args ?? {},
      ev: "ack", ok: true, why: null, ms: 0, statusAfter: host.status(cmd.id),
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
  if (host.busy) {
    if (abortPending && pending === undefined) {
      pending = { cmd, origin };
      record(`CMD-QUEUED id=${cmd.id} name=${cmd.name} behind the abort of ${host.busy.id}`);
      return;
    }
    const ev = { t: "ev", id: cmd.id, name: cmd.name, ev: "fail", ok: false, code: 1, why: "busy", ms: 0 };
    emit(cmd, origin, ev);
    countTask(ev);
    writeTranscript({
      at: new Date().toISOString(), via: origin.via, from: origin.from ?? null,
      id: cmd.id, name: cmd.name, args: cmd.args ?? {},
      ev: "fail", ok: false, why: "busy", ms: 0, statusAfter: host.status(cmd.id),
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
      const body = host.status(id ?? "status");
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
        ev: "ack", ok: true, why: null, ms: 0, statusAfter: host.status(id),
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
    task: host.busy ?? null,
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
    task: host.busy?.name ?? null,
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
