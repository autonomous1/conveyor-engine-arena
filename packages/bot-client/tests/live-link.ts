// Prototype: one persistent bot seat with a file mailbox, so the driving LLM
// session can query the live pawn and send it orders between tool calls.
//
//   <dir>/inbox.ndjson   commands, one JSON per line (appended by the driver session)
//   <dir>/outbox.ndjson  acks, replies, received messages (appended by this process)
//   <dir>/status.json    live snapshot, rewritten every 250 ms
//
// Transport (task 122): the host `msg` frame. Out: `session.messages.say(text, to)`
// (`to` is a pawn id, 0 = broadcast). In: `world.messages()`, the last 64 rows.
// The host stamps `from`/`seq`/`at`, batches one frame per 20 Hz tick (<=4 rows/s)
// and drops a per-sender row past 4 queued, so this driver paces one send per
// 250 ms through a single queue. Text is 1..256 chars; a rejected row is
// counted by the host, never acked.
//
// One bot (the operator may play or spectate):
//   CE_TOKEN=… node --import ./scripts/ts-ext-register.mjs \
//     packages/bot-client/tests/live-link.ts --url ws://127.0.0.1:4173 \
//     --dir plan/dsh-tasks/live/122-link-a --label 122-link-a --name link-a
// Two bots (operator spectating only; the third seat stays free):
//   … --dir plan/dsh-tasks/live/122-link-b --label 122-link-b --name link-b
//
// Drive it (append one JSON line per command; `to` is `*` or a pawn id):
//   {"cmd":"ping"}  {"cmd":"status"}
//   {"cmd":"say","to":"*","text":"hello"}   {"cmd":"quit"}
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { connectBot } from "../src/connection.ts";
import { openNodeSocket } from "../src/node-socket.ts";

const args = new Map<string, string>();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) if (argv[i]!.startsWith("--")) args.set(argv[i]!.slice(2), argv[i + 1] ?? "");
const token = (process.env.CE_TOKEN ?? "").trim() || readFileSync(join(homedir(), ".config/ce-arena/qa-token.pem"), "utf8").trim();
const STAMP = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const LABEL = args.get("label") ?? "link";
const DIR = args.get("dir") ?? "plan/dsh-tasks/live";
const NAME = args.get("name") ?? `bot-${LABEL}-${STAMP.slice(11, 19).replace(/:/g, "")}`;
const INBOX = join(DIR, "inbox.ndjson");
const OUTBOX = join(DIR, "outbox.ndjson");
const STATUS = join(DIR, "status.json");
const LOG = `plan/dsh-tasks/logs/${LABEL}-${STAMP}.log`;
const SAMPLE_MS = 250;
const SEND_MS = 250;
const MAX_TEXT = 256;
// Diagnostic counter-example for the host's per-sender queue bound: flush the
// whole queue in one tick (the 5th of a burst is dropped host-side). Default 0.
const UNPACED = args.get("unpaced") === "1";

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
  appendFileSync(OUTBOX, `${JSON.stringify({ t: secs(), at: new Date().toISOString(), ...event })}\n`);
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
record(`joined self=${selfId} pos=${me0.x.toFixed(2)},${me0.z.toFixed(2)} players=[${[...players].join(",")}] messagesSupported=${world.messagesSupported()} claimsSupported=${world.claimsSupported()}`);

// --- send queue: one row per 250 ms tick, the host's cap ------------------
type Queued = { to: number; text: string; id?: string };
const queue: Queued[] = [];
let sent = 0;
function normalizeTo(raw: unknown): number | undefined {
  if (raw === undefined || raw === "" || raw === "*") return 0;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}
function flushOne(): void {
  while (queue.length > 0) {
    const row = queue.shift()!;
    const ok = session.messages.say(row.text, row.to);
    if (!ok) {
      record(`MSG-SEND-FAIL to=${row.to} why=say-false`);
      out({ type: "error", id: row.id, what: "send", why: "say-false", to: row.to });
    } else {
      sent += 1;
      record(`MSG-SEND to=${row.to} text=${row.text}`);
      out({ type: "msg-sent", id: row.id, to: row.to, text: row.text });
    }
    if (!UNPACED) break;
  }
}

// --- receive: host rows, 64-row ring --------------------------------------
const seen = new Set<string>();
let received = 0;
let skipped = 0;
function pollMessages(): void {
  for (const row of world.messages()) {
    const key = `${row.from}:${row.seq}:${row.at}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (row.to !== 0 && row.to !== selfId) {
      skipped += 1;
      record(`MSG-SKIP from=${row.from} to=${row.to} seq=${row.seq}`);
      out({ type: "msg-skip", from: row.from, to: row.to, seq: row.seq, at: row.at });
      continue;
    }
    received += 1;
    const lagMs = Date.now() - row.at;
    record(`MSG-RECV from=${row.from} to=${row.to} seq=${row.seq} at=${row.at} text=${row.text}`);
    out({ type: "msg", from: row.from, to: row.to, seq: row.seq, at: row.at, text: row.text, lagMs });
  }
}

// --- status ---------------------------------------------------------------
function msgKeys(): number {
  let n = 0;
  for (const key of world.claims().keys()) if (key.startsWith("msg:")) n += 1;
  return n;
}
function snapshot(): Record<string, unknown> {
  const me = world.self();
  const h = me ? world.healthOf(me.id) : undefined;
  return {
    self: me ? { id: me.id, x: me.x, y: me.y, z: me.z, place: world.placeOf(me)?.id ?? "?", hp: h?.hp ?? null, dead: h?.dead === true, weapon: world.weapon() ?? "none", ammo: world.ammo() } : null,
    others: world.others().map((p) => ({ id: p.id, d: Math.round(Math.hypot(p.x - (me?.x ?? 0), p.z - (me?.z ?? 0)) * 10) / 10, player: players.has(p.id), hp: world.healthOf(p.id)?.hp ?? null })),
    messages: { sent, received, supported: world.messagesSupported() },
    claims: { total: world.claims().size, msgKeys: msgKeys() },
    queue: queue.length,
    pid: process.pid,
  };
}
function writeHeartbeat(): void {
  try {
    writeStatus(snapshot());
  } catch (err) {
    record(`status write failed: ${String(err)}`);
  }
}

// --- inbox commands -------------------------------------------------------
let processed = 0;
const readInbox = (): string[] => {
  if (!existsSync(INBOX)) return [];
  return readFileSync(INBOX, "utf8").split("\n").filter((l) => l.trim().length > 0);
};
processed = readInbox().length; // ignore commands from an earlier run
record(`inbox=${INBOX} skipping ${processed} old command(s)`);

function handleCommand(raw: string): void {
  let cmd: Record<string, unknown>;
  try {
    cmd = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    out({ type: "error", why: "bad json", raw });
    return;
  }
  const id = typeof cmd.id === "string" ? cmd.id : undefined;
  const kind = String(cmd.cmd ?? "");
  switch (kind) {
    case "ping":
      out({ type: "pong", id, self: selfId });
      break;
    case "status": {
      const snap = snapshot();
      out({ type: "status", id, ...snap });
      writeStatus(snap);
      break;
    }
    case "send":
    case "say": {
      const toRaw = cmd.to;
      const to = normalizeTo(toRaw);
      if (to === undefined) {
        record(`MSG-BAD-TO raw=${String(toRaw)}`);
        out({ type: "error", id, what: "send", why: "bad-to", to: toRaw });
        break;
      }
      const body = String(cmd.text ?? "").trim();
      if (body.length === 0 || body.length > MAX_TEXT) {
        out({ type: "error", id, what: "send", why: body.length === 0 ? "empty" : "too-long", len: body.length });
        break;
      }
      queue.push({ to, text: body, id });
      record(`MSG-QUEUE to=${to} text=${body}`);
      out({ type: "ack", id, what: "send", state: "queued", to, text: body });
      break;
    }
    case "quit":
      record("quit requested");
      out({ type: "bye", id });
      finish(0);
      break;
    default:
      out({ type: "error", id, why: `unknown cmd "${kind}"` });
  }
}

let stop = false;
function finish(code: number): never {
  stop = true;
  clearInterval(timer);
  clearInterval(sender);
  writeHeartbeat();
  record(`EXIT sent=${sent} received=${received} msgKeys=${msgKeys()} elapsed=${secs()}s`);
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
    if (all.length < processed) processed = 0; // inbox was truncated/rewritten
    for (let i = processed; i < all.length; i += 1) handleCommand(all[i]!);
    processed = all.length;
    pollMessages();
    writeHeartbeat();
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

record(`READY self=${selfId} messagesSupported=${world.messagesSupported()} inbox=${INBOX} outbox=${OUTBOX} status=${STATUS}`);
