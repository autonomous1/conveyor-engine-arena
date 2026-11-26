// Task 158: the per-command, fresh-host suite.
//
// Question: does each of the eleven commands reach its designed result in a
// freshly started live arena, with no hard stall, no plan failure, no building
// penetration and no unexpected issue, reproducibly across three unattended
// passes?
//
// One process: build once, then for each trial spawn its OWN host (the
// operator's own recipe plus a PORT override, detached so this process owns the
// whole group), connect one bot, run the trip, close, kill the group, wait for
// the port, next trial. The trial table is data (`command-suite.trials.json`);
// this file hardcodes no command behaviour beyond the table's fields.
//
// Run:
//   ARENA_AUTH=required ARENA_VERIFY_KEY_FILE="$HOME/.config/ce-arena/ed25519.pub.pem" \
//   CE_TOKEN="$(cat ~/.config/ce-arena/qa-token.pem)" \
//     node --import ./scripts/ts-ext-register.mjs packages/bot-client/probe/command-suite.ts \
//     --port 4175 --passes 3 --negatives --label 158-suite --name s158
//
// Ad-hoc point (task 168): `--goto-at x,y,z` dispatches 167's `gotoAt` for one
// coordinate; `y` is parsed and ignored (the pawn's own floor supplies it), the
// trial table is untouched, and the artifacts are named `168-goto-at-…`.
//
// Iteration: `--only arm-1 --passes 1 --no-build`.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { connectBot, type BotSession } from "../src/connection.ts";
import { openNodeSocket } from "../src/node-socket.ts";
import { loadSurface, type SurfaceModule } from "./surface.ts";
import type { CommandHost, CommandResult } from "./commands-prototype.ts";
import { capsuleOverlapsAabb } from "../../../src/shared/pickups.ts";

// --- argv -----------------------------------------------------------------
const args = new Map<string, string>();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i]!;
  if (!a.startsWith("--")) continue;
  const next = argv[i + 1];
  if (next === undefined || next.startsWith("--")) args.set(a.slice(2), "1");
  else {
    args.set(a.slice(2), next);
    i += 1;
  }
}
/** `--goto-at x,y,z`: one ad-hoc coordinate; y is parsed and ignored. */
const GOTO_AT = args.get("goto-at") ?? "";
/** The artifact base names the point by x,z: y is not part of the coordinate. */
const GOTO_AT_BASE = ((): string => {
  const parts = GOTO_AT.split(",");
  const xz = parts.length === 3 ? `${parts[0]}_${parts[2]}` : GOTO_AT;
  return xz.replace(/[^0-9a-z.-]/gi, "_");
})();
const MODE: "list" | "test" | "goto" | "shell" | "suite" | "none" =
  args.has("list") ? "list" : args.has("test") ? "test" : GOTO_AT.length > 0 ? "goto" : args.has("shell") ? "shell" : args.has("suite") ? "suite" : "none";
const TEST_ID = args.get("test") ?? "";
/**
 * `--attach ws://…`: use the operator's running host; never spawn or kill one.
 * `--port` also adopts an already-answering listener (see `main`): the operator
 * started it, so the suite uses it and never builds, spawns, or kills it.
 */
let ATTACH = args.get("attach") ?? "";
const PORT = Number(args.get("port") ?? 4175);
/** `--seats n`: shell seats to open on one host (1..3). */
const SEATS = Number(args.get("seats") ?? 1);
const PASSES = Number(args.get("passes") ?? 3);
/** Wall-clock cap for a suite (a full fresh-host run is ~15 min; a stall must not burn hours). */
const MAX_MIN = Number(args.get("max-min") ?? 16);
const NAME = args.get("name") ?? "s158";
// `--shell` NEVER builds: `npm run build:server` compiles the (coder-owned)
// `src/`, and a concurrent coder suite must not race it. `--build 1` is ignored
// in shell mode; `--test`/`--suite` keep their build (they need a fresh dist).
const SHELL_NEVER_BUILDS = MODE === "shell";
let BUILD = SHELL_NEVER_BUILDS
  ? false
  : args.get("build") === "1"
    ? true
    : args.get("build") === "0" || args.has("no-build") || ATTACH.length > 0
      ? false
      : true;
const ROOT = process.cwd();
const TRIALS_FILE = "packages/bot-client/probe/command-suite.trials.json";
const STAMP = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const LOG_DIR = "plan/dsh-tasks/logs";
/** Each mode owns its artifact basename so one test never overwrites another. */
const LABEL = args.get("label");
/** `--surface proto|probe`: the command module the suite dispatches (default probe). */
const SURFACE_EXPLICIT = args.has("surface");
// `--shell` defaults to the proto surface when the fork has the combat module:
// the probe copy is the 158/171 legacy command module (pinned arm pads, no prop
// selector), and silently running it made `arm` walk to the old outside climb
// (2026-11-25). An explicit `--surface probe` still runs the legacy copy.
const SURFACE_NAME = args.get("surface")
  ?? (MODE === "shell" && existsSync("packages/bot-client/proto/combat.ts") ? "proto" : "probe");
/** The selected command module; `main` assigns it before any trial runs. */
let selectedSurface: SurfaceModule | undefined;
/** The shell's shutdown hook; the process signal handlers route through it. */
let shellShutdown: ((reason: string, code: number) => void) | undefined;
const BASE = LABEL
  ? `${LABEL}-${STAMP}`
  : MODE === "test" ? `158-test-${TEST_ID}-${STAMP}`
  : MODE === "goto" ? `168-goto-at-${GOTO_AT_BASE}-${STAMP}`
  : MODE === "shell" ? `171-shell-${STAMP}`
  : MODE === "list" ? `158-list-${STAMP}` : `158-suite-${STAMP}`;
const LOG = `${LOG_DIR}/${BASE}.log`;
const NDJSON = `${LOG_DIR}/${BASE}.ndjson`;
const TRACE = `${LOG_DIR}/${BASE}.trace.ndjson`;
const SUMMARY = `${LOG_DIR}/${BASE}.summary.md`;
const USAGE =
  "usage: command-suite.ts --list | --test <id> | --goto-at x,y,z | --shell [--seats 1..4] [--no-build; never builds] | --suite [--port n] [--no-build] [--surface proto|probe]\n" +
  "  one test = one process: one host, one bot, one verdict; --goto-at = one ad-hoc coordinate (y parsed and ignored); --shell = held-open sessions with a bot> prompt and `<seat> <verb>` lines (help/seats/status/abort/q); --suite = 3 passes of the 15 positives + both controls; --surface = the command module (default probe)";
/** Per-trial host log so one trial never overwrites another's host output. */
const hostLogPath = (tag: string): string => `${LOG_DIR}/${MODE === "goto" ? "168" : "158"}-host-${tag.replace(/[/#]/g, "-")}-${STAMP}.log`;
const SAMPLE_MS = 250;
/** A precondition is a normal dispatch, but the suite cannot spend 180 s on a hang. */
const PRE_TIMEOUT_MS = Number(args.get("pre-timeout") ?? 90_000);
const URL = ATTACH || `ws://127.0.0.1:${PORT}`;
const HTTP = URL.replace(/^ws/, "http");
const TOKEN = (process.env.CE_TOKEN ?? "").trim() ||
  readFileSync(join(homedir(), ".config/ce-arena/qa-token.pem"), "utf8").trim();
const VERIFY_KEY = process.env.ARENA_VERIFY_KEY_FILE ?? "";

const t0 = Date.now();
const secs = (): number => Math.round((Date.now() - t0) / 100) / 10;
const round2 = (n: number): number => Math.round(n * 100) / 100;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

mkdirSync(LOG_DIR, { recursive: true });
const lines: string[] = [];
/**
 * The shell's prompt hook: `record` is the one console writer, and in `--shell`
 * mode a write can land after the prompt (a command result, a status row, a
 * collision line), leaving the prompt buried. The hook re-prompts once per
 * synchronous burst, so a multi-row status gets one `bot> `, not one per row.
 * Set only while the shell's readline is open; `finish` clears it.
 */
let shellReprompt: (() => void) | undefined;
let repromptQueued = false;
function queueShellReprompt(): void {
  if (!shellReprompt || repromptQueued) return;
  repromptQueued = true;
  setImmediate(() => {
    repromptQueued = false;
    shellReprompt?.();
  });
}
function record(line: string): void {
  const row = `t=${secs().toFixed(1)}s ${line}`;
  lines.push(row);
  console.log(row);
  appendFileSync(LOG, `${row}\n`);
  queueShellReprompt();
}
/** File-only: the shell's handler chatter (hunt/patrol loops) stays out of the console. */
function recordFile(line: string): void {
  const row = `t=${secs().toFixed(1)}s ${line}`;
  lines.push(row);
  appendFileSync(LOG, `${row}\n`);
}
function writeOut(path: string, body: string): void {
  try {
    writeFileSync(path, body);
  } catch (err) {
    record(`WRITE-FAIL path=${path} ${String(err)}`);
  }
}

// --- trial table ----------------------------------------------------------
type Point = { x: number; z: number };
type Constants = { spawnPad: Point; EAST: Point; KEY: Point; HALL: string; HALL0: string };
type Expect = { ok?: boolean[]; code?: number[]; why?: string[]; whyPrefix?: string[] };
type DesignCheck =
  | { kind: "weaponNot"; value: string }
  | { kind: "keysContains"; value: string }
  | { kind: "place"; place: string }
  | { kind: "dist"; point?: string; at?: Point; max: number }
  | { kind: "dataGte"; field: string; min: number }
  | { kind: "dataContainsAll"; field: string; values: string[] }
  | { kind: "dataHas"; field: string }
  | { kind: "artifactRows"; min: number }
  | { kind: "goneOrHeld"; pickup: string }
  | { kind: "statusTaskNull" };
type TrialDef = {
  id: string;
  title: string;
  name: string;
  args: Record<string, unknown>;
  pre?: Array<{ name: string; args?: Record<string, unknown> }>;
  moving: boolean;
  timeoutMs: number;
  expect: Expect;
  design?: DesignCheck[];
  allowDeath?: boolean;
  requires?: string[];
  negative?: "plan" | "stallOrPen";
  armGate?: boolean;
  progress?: boolean;
  abortAtMs?: number;
  abortWithinMs?: number;
  argsFrom?: "wallBox" | "outsideAmmo";
};
const table = JSON.parse(readFileSync(TRIALS_FILE, "utf8")) as { constants: Constants; trials: TrialDef[] };
const C = table.constants;
const TRIALS = table.trials;
const PASS_TRIALS = TRIALS.filter((t) => !t.negative);
const TRIALS_HASH = createHash("sha256").update(readFileSync(TRIALS_FILE)).digest("hex");

// --- build identity -------------------------------------------------------
type BuildId = { head: string; status: string; dist: string; server: string; bot: string; buildMs?: number; buildOut?: string };
function sh(cmd: string, argv2: string[]): string {
  const r = spawnSync(cmd, argv2, { cwd: ROOT, encoding: "utf8" });
  return (r.stdout ?? "").trim();
}
function sha256File(path: string): string {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return "missing";
  }
}
function buildIdentity(): BuildId {
  const id: BuildId = {
    head: sh("git", ["rev-parse", "HEAD"]),
    status: sh("git", ["status", "--porcelain"]),
    dist: "missing",
    server: sha256File("dist/server/main.js"),
    bot: sha256File("packages/bot-client/dist/ce-bot.mjs"),
  };
  if (SHELL_NEVER_BUILDS) {
    record("BUILD skipped reason=shell-never-builds (dist must be current; run npm run build:server yourself)");
    if (args.get("build") === "1") record("BUILD ignored flag=--build 1 (--shell never builds src/)");
    id.dist = id.server;
  } else if (BUILD) {
    record("BUILD start npm run build:server");
    const at = Date.now();
    const r = spawnSync("npm", ["run", "build:server"], { cwd: ROOT, encoding: "utf8" });
    id.buildMs = Date.now() - at;
    id.buildOut = `${r.stdout ?? ""}\n${r.stderr ?? ""}`.trim().slice(-2000);
    record(`BUILD done status=${r.status} ms=${id.buildMs}`);
    if (r.status !== 0) {
      record(`BUILD FAILED\n${id.buildOut}`);
      abortSuite(2, "build failed");
    }
    id.dist = sha256File("dist/server/main.js");
    id.server = id.dist;
  } else {
    id.dist = id.server;
  }
  return id;
}

// --- host lifecycle -------------------------------------------------------
type HostHandle = {
  child: ChildProcess;
  port: number;
  tag: string;
  ready: Promise<void>;
  stderrTail: string[];
  exited: Promise<number | null>;
};
let currentHost: HostHandle | undefined;
/** The bot's ws, wrapped so a stall can be attributed to the socket. */
type SockTrack = { ws?: { readyState?: number; bufferedAmount?: number }; acks: number; resyncs: number; lastSeq: number; lastFrame: string; close?: { code?: number; reason: string } };
const sock: SockTrack = { acks: 0, resyncs: 0, lastSeq: 0, lastFrame: "" };
function trackSocket(url: string): ReturnType<typeof openNodeSocket> {
  const ws = openNodeSocket(url);
  sock.ws = ws as unknown as SockTrack["ws"];
  sock.acks = 0;
  sock.resyncs = 0;
  sock.lastSeq = 0;
  sock.lastFrame = "";
  sock.close = undefined;
  ws.addEventListener("message", (ev: { data?: unknown }) => {
    const text = typeof ev.data === "string" ? ev.data : "";
    const at = text.indexOf("{");
    if (at < 0) return;
    try {
      const msg = JSON.parse(text.slice(at)) as { type?: string; t?: string; code?: unknown; category?: unknown; reason?: unknown; envelope?: { seq?: number } };
      sock.lastFrame = typeof msg.type === "string" ? msg.type : typeof msg.t === "string" ? msg.t : "";
      if (msg.type === "error" || msg.type === "reject") {
        // The client closes on these without logging them; keep the host's reason.
        record(`SOCKET frame type=${msg.type} code=${String(msg.code ?? "-")} category=${String(msg.category ?? "-")} reason=${String(msg.reason ?? "-")}`);
      }
      if (msg.type === "snapshot" && typeof msg.envelope?.seq === "number") sock.lastSeq = msg.envelope.seq;
    } catch {
      // not JSON: an arena text frame we do not need here
    }
  });
  const raw = (ws as unknown as { send: (data: string) => void }).send.bind(ws);
  (ws as unknown as { send: (data: string) => void }).send = (data: string) => {
    if (typeof data === "string") {
      if (data.includes('"ack"')) sock.acks += 1;
      else if (data.includes('"resync"')) sock.resyncs += 1;
    }
    return raw(data);
  };
  return ws;
}
/** Set by the shared suite session's onLog; read by each trial. */
let sharedConnLost: string | null = null;

function startHost(port: number, tag: string, logPath: string): HostHandle {
  const child = spawn("npm", ["start"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), ARENA_AUTH: "required", ARENA_VERIFY_KEY_FILE: VERIFY_KEY },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderrTail: string[] = [];
  const hostLine = (stream: string, text: string): void => {
    for (const line of text.split("\n")) {
      if (line.trim().length === 0) continue;
      appendFileSync(logPath, `${new Date().toISOString()} ${tag} ${stream} ${line}\n`);
      if (stream === "err") {
        stderrTail.push(line);
        if (stderrTail.length > 40) stderrTail.shift();
      }
    }
  };
  let resolveReady!: () => void;
  let rejectReady!: (err: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  let settled = false;
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    rejectReady(new Error(`host url not printed in 20000ms; stderr=${stderrTail.slice(-5).join(" | ")}`));
  }, 20_000);
  let buf = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    hostLine("out", text);
    buf += text;
    const parts = buf.split("\n");
    buf = parts.pop() ?? "";
    for (const line of parts) {
      const at = line.indexOf("{");
      if (at < 0 || settled) continue;
      try {
        const parsed = JSON.parse(line.slice(at)) as { url?: unknown };
        if (typeof parsed.url === "string" && parsed.url.includes(`:${port}`)) {
          settled = true;
          clearTimeout(timer);
          resolveReady();
        }
      } catch {
        // npm's own prefix lines are noise
      }
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => hostLine("err", chunk.toString()));
  const exited = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        rejectReady(new Error(`host exited code=${code} before its url; stderr=${stderrTail.slice(-8).join(" | ")}`));
      }
      resolve(code);
    });
    child.once("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        rejectReady(err instanceof Error ? err : new Error(String(err)));
      }
      resolve(null);
    });
  });
  const handle: HostHandle = { child, port, tag, ready, stderrTail, exited };
  currentHost = handle;
  return handle;
}

async function portAnswers(port: number, timeoutMs = 800): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/arena.json`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitPortFree(port: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!(await portAnswers(port, 400))) return true;
    await sleep(100);
  }
  return !(await portAnswers(port, 400));
}

async function stopHost(h: HostHandle): Promise<{ exit: string; free_ms: number; freed: boolean }> {
  const at = Date.now();
  const pid = h.child.pid;
  if (pid !== undefined && h.child.exitCode === null) {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
  let freed = await waitPortFree(h.port, 5_000);
  if (!freed && pid !== undefined) {
    record(`HOST SIGKILL tag=${h.tag} pid=${pid}`);
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // already gone
    }
    freed = await waitPortFree(h.port, 4_000);
  }
  await Promise.race([h.exited, sleep(1_000)]);
  if (currentHost === h) currentHost = undefined;
  const exit = h.child.exitCode !== null ? `code:${h.child.exitCode}` : `sig:${h.child.signalCode ?? "?"}`;
  return { exit, free_ms: Date.now() - at, freed };
}

function killCurrentHostSync(): void {
  const h = currentHost;
  if (!h || h.child.pid === undefined) return;
  try {
    process.kill(-h.child.pid, "SIGTERM");
  } catch {
    // already gone
  }
}

// --- shapes ---------------------------------------------------------------
type Sample = {
  t: number; x: number; y: number; z: number; place: string; task: string | null;
  hp: number | null; dead: boolean | null; ammo: number; weapon: string; snap: number;
  processed: number; stale: number; pen: Array<{ id: number | null; source: string }>;
  static_s: number; busy: boolean; keys: string[];
  rs?: number; buf?: number; acks?: number; resyncs?: number; last_seq?: number; last_frame?: string;
};
type TrialRow = Record<string, unknown>;

function abortSuite(code: number, why: string): never {
  record(`SUITE ABORT code=${code} why=${why}`);
  writeOut(SUMMARY, `# 158 run aborted\n\n${why}\n\nSee ${LOG} and the per-trial host logs (${LOG_DIR}/158-host-*-${STAMP}.log).\n`);
  killCurrentHostSync();
  process.exit(code);
}

// --- per-trial resolution -------------------------------------------------
function outsideAmmo(world: BotSession["world"]): string | undefined {
  const me = world.self();
  const avail = new Set(world.pickups());
  const rows = world.pickupPlacements()
    .filter((p) => p.kind === "ammo" && avail.has(p.id))
    .map((p) => ({ p, cx: (p.minX + p.maxX) / 2, cz: (p.minZ + p.maxZ) / 2 }))
    .filter(({ p, cx, cz }) => (world.placeOf({ x: cx, y: (p.minY ?? 0) + 0.2, z: cz })?.id ?? "") === "outside")
    .map((r) => ({ ...r, d: me ? Math.hypot(r.cx - me.x, r.cz - me.z) : 0 }))
    .sort((a, b) => a.d - b.d || (a.p.id < b.p.id ? -1 : 1));
  return rows[0]?.p.id;
}

function wallBox(world: BotSession["world"]): { x: number; y: number; z: number; box: Record<string, unknown> } | undefined {
  const me = world.self();
  if (!me) return undefined;
  let best: { b: (typeof world.aabbs)[number]; maxY: number; cx: number; cz: number } | undefined;
  for (const b of world.aabbs) {
    const maxY = b.maxY ?? 0;
    const area = (b.maxX - b.minX) * (b.maxZ - b.minZ);
    if (area < 4) continue;
    const cx = (b.minX + b.maxX) / 2;
    const cz = (b.minZ + b.maxZ) / 2;
    if (Math.hypot(cx - me.x, cz - me.z) > 40) continue;
    if (!best || maxY > best.maxY) best = { b, maxY, cx, cz };
  }
  if (!best) return undefined;
  return {
    x: best.cx,
    y: Math.round(me.y),
    z: best.cz,
    box: { id: (best.b as { id?: number }).id ?? null, source: (best.b as { source?: string }).source ?? "aabb", maxY: best.maxY, minY: best.b.minY ?? 0 },
  };
}

function resolveTrial(def: TrialDef, world: BotSession["world"]): { args: Record<string, unknown>; resolved: Record<string, unknown> } {
  const out: Record<string, unknown> = JSON.parse(JSON.stringify(def.args ?? {}));
  const resolved: Record<string, unknown> = {};
  if (def.argsFrom === "outsideAmmo" || out.pickup === "@outside-ammo") {
    const id = outsideAmmo(world);
    if (id) {
      if (out.pickup === "@outside-ammo") out.pickup = id;
      resolved.pickup = id;
    } else {
      resolved.pickup = null;
    }
  }
  if (def.argsFrom === "wallBox") {
    const wb = wallBox(world);
    if (wb) {
      out.x = round2(wb.x);
      out.y = wb.y;
      out.z = round2(wb.z);
      resolved.wallBox = wb.box;
      resolved.point = { x: round2(wb.x), z: round2(wb.z) };
    }
  }
  return { args: out, resolved };
}

// --- running one trial ----------------------------------------------------
type TrialOutcome = { row: TrialRow; verdict: string; reasons: string[]; fatal: boolean };

function nowMs(): number {
  return Date.now();
}

async function oneTrial(pass: number, def: TrialDef, attempt: number, shared?: BotSession): Promise<TrialOutcome> {
  const tag = `p${pass}/${def.id}${attempt > 0 ? `#${attempt + 1}` : ""}`;
  const row: TrialRow = {
    pass, trial: def.id, name: def.name, args: def.args, attempt, resolved: {},
    pre: [], host: {}, join_ms: null, pre_ms: null, ms: null, ok: null, code: null, why: null,
    verdict: "INVALID", reasons: [], policy: { moving: def.moving, timeout_ms: def.timeoutMs },
    stall_hard_s: 0, stall_soft_s: 0, stall_s: 0, replans: 0, pen: [], net_freeze_s: 0,
    before: null, after: null, data: null, trace_rows: 0,
  };
  const reasons: string[] = [];
  const fatal: string[] = [];
  const warn: string[] = [];
  let host: HostHandle | undefined;
  let session: BotSession | undefined = shared;
  const ownsSession = shared === undefined;
  let hostRef: CommandHost | undefined;
  const trialLines: string[] = [];
  let connLost: string | null = sharedConnLost;
  let cmdStartIdx = 0;

  const invalid = (why: string): TrialOutcome => {
    reasons.push(`invalid:${why}`);
    row.verdict = "INVALID";
    row.reasons = reasons;
    return { row, verdict: "INVALID", reasons, fatal: true };
  };
  // A shared host (--attach) cannot be restarted between trials, so an item a
  // previous trial consumed is not a command failure: the trial is SKIPped.
  const skip = (why: string): TrialOutcome => {
    reasons.push(`skip:${why}`);
    row.verdict = "SKIP";
    row.reasons = reasons;
    return { row, verdict: "SKIP", reasons, fatal: false };
  };

  try {
    if (!ATTACH) {
      if (await portAnswers(PORT)) return invalid(`port ${PORT} already answers`);
      record(`HOST spawn pass=${pass} trial=${def.id} port=${PORT}${attempt > 0 ? ` attempt=${attempt + 1}` : ""}`);
      host = startHost(PORT, tag, hostLogPath(def.id));
      const at = nowMs();
      await host.ready;
      row.host = { pid: host.child.pid, ready_ms: nowMs() - at };
      record(`HOST ready pass=${pass} trial=${def.id} ms=${(row.host as { ready_ms: number }).ready_ms}${attempt > 0 ? ` attempt=${attempt + 1}` : ""}`);
    } else {
      row.host = { attached: true, url: URL };
      record(`HOST attach pass=${pass} trial=${def.id} url=${URL}${attempt > 0 ? ` attempt=${attempt + 1}` : ""}`);
    }
    const arenaRes = await fetch(`${HTTP}/arena.json`, { signal: AbortSignal.timeout(5_000) });
    if (!arenaRes.ok) return invalid(`arena.json ${arenaRes.status}`);
    const arena = (await arenaRes.json()) as { authRequired?: boolean; aabbs?: unknown[] };
    if (arena.authRequired !== true) return invalid("authRequired !== true");

    if (!session) {
      session = await connectBot({
        url: URL,
        token: TOKEN,
        name: `${NAME}-p${pass}-${def.id}`,
        role: "qa",
        openSocket: trackSocket,
        onLog: (l) => {
          trialLines.push(`[conn] ${l}`);
          // The 158-patrol finding: a mid-command close must be visible in the
          // artifact, not only in trialLines, and it must be a verdict reason.
          record(`[conn] ${l}`);
          const cm = /^close code=(\S+) reason=(.*?) rs=/.exec(l);
          if (cm) sock.close = { code: cm[1] === "none" ? undefined : Number(cm[1]), reason: cm[2] === "-" ? "" : cm[2] };
          if (l.includes("connection lost") || l.includes("SERVER_FULL") || l.includes("session abort")) connLost = l;
        },
      });
    }
    const world = session.world;
    const joinAt = nowMs();
    while ((!world.self() || !world.sceneGraph()) && nowMs() - joinAt < 15_000) await sleep(50);
    row.join_ms = nowMs() - joinAt;
    const me0 = world.self();
    if (!me0) {
      record(`JOIN-FAIL pass=${pass} trial=${def.id} no self`);
      return invalid("no-self");
    }
    const players = [...world.playerIds()];
    record(
      `JOIN pass=${pass} trial=${def.id} self=${me0.id} place=${world.placeOf(me0)?.id ?? "?"} players=[${players.join(",")}] ` +
      `weapon=${world.weapon() ?? "none"} keys=[${world.keys().join(",")}] graph=${world.sceneGraphHash() ?? "-"} ` +
      `aabbs=${world.aabbs.length} withMaxY=${world.aabbs.filter((b) => b.maxY !== undefined).length}`,
    );
    if (!ATTACH && world.playerIds().size !== 1) return invalid(`seat players=${players.join(",")}`);
    if (ATTACH && players.length === 0) return invalid("no players");
    row.snap_start = session.net.snapshots();
    if (shared) {
      // A shared session that stops receiving snapshots is the 147 stall: fail
      // fast at the next trial instead of running it against a frozen world.
      const s0 = session.net.snapshots();
      await sleep(300);
      if (session.net.snapshots() === s0) abortSuite(2, `world frozen at ${def.id}: snap=${s0} flat for 300 ms`);
    }
    const seatIds = [...world.playerIds()];
    if (!world.sceneGraph()) return invalid("no scene graph");
    // Every trial assumes the pad start. On a shared host the seat is reused at
    // the previous trial's end pose, so a stand/path to an outside point would
    // press a wall from inside the hall (run 19:36 stand). Never score that.
    let startMe = world.self();
    if (startMe) {
      let startD = Math.hypot(startMe.x - C.spawnPad.x, startMe.z - C.spawnPad.z);
      // Operator-authorized (qa token has the teleport scope): only this
      // session's own pawn, only back to the trial table's spawn pad, attach only.
      if (ATTACH && startD > 0.5) {
        const snap0 = session.net.snapshots();
        record(`TELEPORT from=${round2(startMe.x)},${round2(startMe.y)},${round2(startMe.z)} to=${C.spawnPad.x},0,${C.spawnPad.z} snap=${snap0}`);
        session.input.teleport(C.spawnPad.x, 0, C.spawnPad.z, 0);
        const until = nowMs() + 2_000;
        while (nowMs() < until) {
          const m = world.self();
          if (m && Math.hypot(m.x - C.spawnPad.x, m.z - C.spawnPad.z) < 0.5) break;
          await sleep(50);
        }
        startMe = world.self();
        startD = startMe ? Math.hypot(startMe.x - C.spawnPad.x, startMe.z - C.spawnPad.z) : startD;
        const snap1 = session.net.snapshots();
        record(`TELEPORT done at=${startMe ? `${round2(startMe.x)},${round2(startMe.y)},${round2(startMe.z)}` : "?"} d=${round2(startD)} snap=${snap1}`);
        // A teleport that does not land AND a snapshot count that did not move
        // is the 147 publish stall, not a blocked landing: abort, never loop
        // through the remaining trials against a frozen world.
        if (startD > 0.5 && snap1 === snap0) {
          abortSuite(2, `world frozen: snap=${snap1} flat for 2 s at ${startMe ? `${round2(startMe.x)},${round2(startMe.y)},${round2(startMe.z)}` : "?"} (trial ${def.id}); teleport cannot land`);
        }
      }
      row.start_pos = [round2(startMe.x), round2(startMe.y), round2(startMe.z)];
      if (startD > 3) {
        if (ATTACH) return skip(`start-pose:${round2(startD)}m`);
        return invalid(`start-pose:${round2(startD)}m`);
      }
    }
    const held = new Set(world.keys());
    const present = new Set(world.pickups());
    const armed = (world.weapon() ?? "") !== "";
    for (const needed of def.requires ?? []) {
      if (present.has(needed)) continue;
      // The trial needs the *benefit*, not the pickup on the map: a held key or
      // an equipped weapon satisfies a `requires` row (only `arm` itself needs
      // to acquire the weapon, and it is skipped below when already armed).
      if (needed === "key" && held.has("key")) continue;
      if (needed === "alien-weapon-1" && armed) continue;
      if (ATTACH) return skip(held.has(needed) ? `already-held:${needed}` : `consumed:${needed}`);
      return invalid(`map-dirty missing=${needed}`);
    }
    if (def.name === "arm" && armed) return skip("already-armed");

    const { args: cmdArgs, resolved } = resolveTrial(def, world);
    row.args = cmdArgs;
    row.resolved = resolved;
    if (def.name === "getkey" && held.has("key")) return skip("already-held:key");
    if (def.name === "retrieve" && (resolved.pickup == null || !present.has(String(cmdArgs.pickup)))) {
      const id = typeof resolved.pickup === "string" ? resolved.pickup : String(cmdArgs.pickup);
      if (ATTACH) return skip(held.has(id) ? `already-held:${id}` : `consumed:${id}`);
      return invalid("no outside ammo pickup");
    }
    if (def.argsFrom === "wallBox" && resolved.wallBox === undefined) return invalid("no wall box");

    hostRef = selectedSurface!.createCommandHost({
      session,
      log: (line) => {
        trialLines.push(line);
        record(`  ${line}`);
      },
    });

    const snap = (): Record<string, unknown> => {
      const st = hostRef!.status();
      return { place: st.place, hp: st.hp, ammo: st.ammo, weapon: st.weapon, keys: [...world.keys()], pos: st.pos ?? null, dead: st.dead };
    };
    row.before = snap();

    // --- preconditions (before the clock) ---------------------------------
    const preAt = nowMs();
    for (const pre of def.pre ?? []) {
      if (pre.name === "getkey") {
        if (held.has("key")) {
          record(`PRE pass=${pass} trial=${def.id} name=getkey skip=already-held`);
          (row.pre as unknown[]).push({ name: "getkey", ok: true, skipped: "already-held", ms: 0 });
          continue;
        }
        if (!present.has("key")) return skip("consumed:key");
      }
      const at2 = nowMs();
      let ok = false;
      let why: string | null = null;
      try {
        const dispatchP = hostRef.dispatch({ id: `${tag}-pre-${pre.name}`, name: pre.name, args: pre.args ?? {}, }, {
          onLine: (l) => {
            trialLines.push(l);
            record(`  ${l}`);
          },
        });
        dispatchP.catch(() => undefined);
        const settled = await Promise.race([dispatchP.then((r) => ({ kind: "done" as const, r })), sleep(PRE_TIMEOUT_MS).then(() => null)]);
        if (settled === null) {
          hostRef.abort();
          await Promise.race([dispatchP, sleep(5_000)]);
          ok = false;
          why = "timeout";
        } else {
          ok = settled.r.ok;
          why = settled.r.ok ? null : settled.r.why;
        }
      } catch (err) {
        why = `threw:${err instanceof Error ? err.message : String(err)}`;
      }
      const ms = nowMs() - at2;
      (row.pre as unknown[]).push({ name: pre.name, ok, why, ms });
      record(`PRE pass=${pass} trial=${def.id} name=${pre.name} ok=${ok ? 1 : 0} why=${why ?? "-"} ms=${ms}`);
      if (!ok) {
        row.pre_ms = nowMs() - preAt;
        return invalid(`precondition ${pre.name} why=${why ?? "-"}`);
      }
    }
    row.pre_ms = nowMs() - preAt;

    // --- the clock --------------------------------------------------------
    const tCmd = nowMs();
    cmdStartIdx = trialLines.length;
    let brainAction = "";
    let statRun = 0;
    let statMax = 0;
    let pickupRun = 0;
    let pickupMax = 0;
    let netRun = 0;
    let netMax = 0;
    let armedAt: number | null = null;
    let lastPos: { x: number; y: number; z: number } | null = null;
    let lastNet: { snap: number; processed: number } | null = null;
    let traceCount = 0;
    let lastSample: Sample | null = null;
    let sawDead = false;
    // A second player (or a seat collision) mid-trial invalidates the run: the
    // 158 player-join finding — a fresh connection can take over the bot's seat.
    let foreign: number[] | null = null;
    // The press detector (task 158): a point stand that stops closing on its
    // target for 15 s is a hard stall even while the recovery jitter moves the
    // pawn. The freeze rule alone cannot see a pawn pressed into a wall.
    let targetPoint: { x: number; z: number } | null = null;
    const ax = cmdArgs.x;
    const az = cmdArgs.z;
    if (typeof ax === "number" && typeof az === "number") targetPoint = { x: ax, z: az };
    else if (Array.isArray(cmdArgs.points)) {
      const lastPt = cmdArgs.points[cmdArgs.points.length - 1] as { x?: unknown; z?: unknown } | undefined;
      if (lastPt && typeof lastPt.x === "number" && typeof lastPt.z === "number") targetPoint = { x: lastPt.x, z: lastPt.z };
    }
    let bestDist = Infinity;
    let progRun = 0;
    let progMax = 0;
    let penSeen: Array<{ id: number | null; source: string }> = [];
    let penSeenCount = 0;
    // Every building contact (true radius), one log line per episode.
    let contacting = new Set<string>();
    // A closed socket is not a "publish stall": name it, fail the trial, abort.
    let socketClosed = false;
    const collisions: Array<{ t: number; id: number | null; source: string; at: string }> = [];
    let stopped = false;
    let lastSampleAt = 0;

    const onSample = (): void => {
      if (stopped || !session) return;
      const me = world.self();
      if (!me) return;
      if (!socketClosed && sock.ws && sock.ws.readyState === 3) {
        socketClosed = true;
        // `t` is declared further down (TDZ): compute the command-relative time here.
        const tt = (nowMs() - tCmd) / 1000;
        record(`SOCKET closed t=${round2(tt)}s (readyState=3) code=${sock.close?.code ?? "none"} reason=${sock.close?.reason || "-"} — aborting the command`);
        try {
          hostRef?.abort();
        } catch {
          // idle
        }
      }
      const ids = [...world.playerIds()].sort((a, b) => a - b);
      if (ids.length !== seatIds.length && foreign === null) {
        foreign = ids;
        record(`FOREIGN players=[${ids.join(",")}] seat=[${seatIds.join(",")}] — aborting`);
        try {
          hostRef?.abort();
        } catch {
          // idle
        }
      }
      // Real elapsed time, not the nominal interval: a plan compile blocks the
      // event loop, so `setInterval` can miss ticks exactly when a freeze or a
      // press is being measured. Counting 0.25 s per sample would under-report.
      const nowSample = nowMs();
      const dt = lastSampleAt === 0 ? 0 : (nowSample - lastSampleAt) / 1000;
      lastSampleAt = nowSample;
      const t = (nowSample - tCmd) / 1000;
      const busy = hostRef?.busy !== undefined;
      const st = hostRef!.status();
      const net = { snap: session.net.snapshots(), processed: session.net.processedInput(), stale: session.net.stale() };
      const pen: Array<{ id: number | null; source: string }> = [];
      const hits: Array<{ id: number | null; source: string }> = [];
      for (const b of world.aabbs) {
        const maxY = b.maxY ?? 0;
        if (maxY <= me.y + 0.35) continue;
        // A pickup's trigger volume (`<id>-box`) is not an obstacle: the pawn
        // is meant to stand inside it to take the item.
        const source = (b as { source?: string }).source ?? "";
        if (source.endsWith("-box") || source === "aabb") continue;
        const box = { minX: b.minX, maxX: b.maxX, minY: b.minY ?? 0, maxY, minZ: b.minZ, maxZ: b.maxZ };
        const id = (b as { id?: number }).id ?? null;
        const hitPen = capsuleOverlapsAabb(me.x, me.y, me.z, world.pawnRadius - 0.05, world.pawnHeight, box);
        if (hitPen) pen.push({ id, source });
        // Contact at the true radius: every building touch, not just >5 cm.
        if (capsuleOverlapsAabb(me.x, me.y, me.z, world.pawnRadius, world.pawnHeight, box)) hits.push({ id, source });
      }
      const keyOf = (q: { id: number | null; source: string }): string => `${q.id ?? "?"}:${q.source}`;
      for (const h of hits) {
        if (!contacting.has(keyOf(h))) {
          const at = `${round2(me.x)},${round2(me.y)},${round2(me.z)}`;
          collisions.push({ t: round2(t), ...h, at });
          record(`COLLIDE t=${round2(t)}s box=${h.id ?? "?"} src=${h.source} at=${at}`);
        }
      }
      contacting = new Set(hits.map(keyOf));
      if (pen.length > 0) {
        penSeenCount += 1;
        for (const p of pen) if (!penSeen.some((q) => q.id === p.id && q.source === p.source)) penSeen.push(p);
      }
      if (busy && lastPos && Math.hypot(me.x - lastPos.x, me.z - lastPos.z) < 0.05 && Math.abs(me.y - lastPos.y) < 0.05) statRun += dt;
      else statRun = 0;
      if (busy) statMax = Math.max(statMax, statRun);
      if (targetPoint && busy) {
        const d = Math.hypot(me.x - targetPoint.x, me.z - targetPoint.z);
        if (d < bestDist - 0.25) {
          bestDist = d;
          progRun = 0;
        } else progRun += dt;
        progMax = Math.max(progMax, progRun);
      }
      if (busy && brainAction.startsWith("pickup:")) {
        pickupRun += dt;
        pickupMax = Math.max(pickupMax, pickupRun);
      } else {
        pickupRun = 0;
      }
      if (busy && lastNet && net.snap === lastNet.snap && net.processed === lastNet.processed) netRun += dt;
      else netRun = 0;
      netMax = Math.max(netMax, netRun);
      lastPos = { x: me.x, y: me.y, z: me.z };
      lastNet = { snap: net.snap, processed: net.processed };
      if (armedAt === null && (world.weapon() ?? "") !== "") armedAt = t;
      const sample: Sample = {
        t: round2(t), x: round2(me.x), y: round2(me.y), z: round2(me.z),
        place: world.placeOf(me)?.id ?? "?", task: st.task, hp: st.hp, dead: st.dead,
        ammo: st.ammo, weapon: st.weapon, snap: net.snap, processed: net.processed, stale: net.stale,
        pen, static_s: round2(statRun), busy, keys: [...world.keys()],
        rs: sock.ws?.readyState ?? -1, buf: sock.ws?.bufferedAmount ?? -1, acks: sock.acks, resyncs: sock.resyncs, last_seq: sock.lastSeq, last_frame: sock.lastFrame,
      };
      appendFileSync(TRACE, `${JSON.stringify({ pass, trial: def.id, ...sample })}\n`);
      traceCount += 1;
      lastSample = sample;
      if (st.dead === true) sawDead = true;
    };
    const sampler = setInterval(onSample, SAMPLE_MS);

    const p = hostRef.dispatch({ id: `${tag}-cmd`, name: def.name, args: cmdArgs }, {
      onLine: (line) => {
        trialLines.push(line);
        record(`  ${line}`);
        const s = /(?:^|\s)start (\S+)/.exec(line);
        if (s) brainAction = s[1]!;
        const f = /(?:^|\s)finish (\S+)/.exec(line);
        if (f && brainAction === f[1]) brainAction = "";
      },
    });
    p.catch(() => undefined);

    record(`TASK start pass=${pass} trial=${def.id} name=${def.name}`);
    let result: CommandResult | undefined;
    let timedOut = false;
    let abortMs: number | null = null;
    if (def.abortAtMs !== undefined) {
      const first = await Promise.race([p.then((r) => ({ kind: "done" as const, r })), sleep(def.abortAtMs).then(() => null)]);
      if (first === null) {
        const atAbort = nowMs();
        hostRef.abort();
        record(`TASK abort pass=${pass} trial=${def.id} at=${def.abortAtMs}ms`);
        const settled = await Promise.race([p.then((r) => ({ kind: "done" as const, r })), sleep(15_000).then(() => null)]);
        abortMs = nowMs() - atAbort;
        if (settled === null) {
          timedOut = true;
          result = { ok: false, code: 3, why: "abort-unwind-timeout" };
        } else result = settled.r;
      } else {
        result = first.r;
      }
    } else {
      const r = await Promise.race([p.then((r2) => ({ kind: "done" as const, r: r2 })), sleep(def.timeoutMs).then(() => null)]);
      if (r === null) {
        timedOut = true;
        hostRef.abort();
        record(`TASK timeout pass=${pass} trial=${def.id} ms=${def.timeoutMs}`);
        await Promise.race([p, sleep(5_000)]);
        result = { ok: false, code: 3, why: "timeout" };
      } else result = r.r;
    }
    const ms = nowMs() - tCmd;
    await sleep(300);
    stopped = true;
    clearInterval(sampler);
    const statusAfterAbort = hostRef.status();
    row.ms = ms;
    row.snap_end = session.net.snapshots();
    row.ok = result.ok;
    row.code = result.ok ? (result.code ?? 0) : result.code;
    row.why = result.ok ? null : result.why;
    row.data = result.ok ? (result.data ?? null) : null;
    row.artifact_rows = result.ok && result.artifact ? ((result.artifact.body as { throws?: unknown[] })?.throws?.length ?? 0) : 0;
    row.trace_rows = traceCount;
    row.stall_s = round2(statMax);
    row.stall_hard_s = statMax >= 15 ? round2(statMax) : 0;
    row.stall_soft_s = statMax >= 3 && statMax < 15 ? round2(statMax) : 0;
    row.pickup_stall_s = round2(pickupMax);
    row.progress_s = round2(progMax);
    row.net_freeze_s = round2(netMax);
    row.armed_at_s = armedAt === null ? null : round2(armedAt);
    row.pen = penSeen.slice(0, 12);
    row.pen_samples = penSeenCount;
    row.socket_closed = socketClosed;
    row.sock_close = sock.close ?? null;
    row.collision_count = collisions.length;
    row.collisions = collisions.slice(0, 20);
    row.abort_ms = abortMs;
    row.status_after_task = statusAfterAbort.task;
    row.after = snap();
    record(`TASK done  pass=${pass} trial=${def.id} name=${def.name} ok=${result.ok ? 1 : 0} code=${row.code} why=${row.why ?? "-"} ms=${ms}`);
    if (lastSample) {
      const last = lastSample as Sample;
      record(`CHECK pass=${pass} trial=${def.id} t=${last.t}s task=${last.task ?? "-"} pos=${last.x},${last.y},${last.z} snap=${last.snap} processed=${last.processed} stale=${last.stale} pen=${last.pen.length}`);
    }

    // --- checks -----------------------------------------------------------
    const cmdLines = trialLines.slice(cmdStartIdx);
    const replans = cmdLines.filter((l) => l.includes("replan stuck")).length;
    row.replans = replans;
    const expect = def.expect;
    const why = result.ok ? "" : result.why;
    if (expect.ok !== undefined && !expect.ok.includes(result.ok)) fatal.push(`result:ok=${result.ok}`);
    if (expect.code !== undefined && !expect.code.includes(row.code as number)) fatal.push(`result:code=${String(row.code)}`);
    if (!result.ok && expect.why !== undefined && !expect.why.includes(why)) fatal.push(`result:why=${why}`);
    if (!result.ok && expect.whyPrefix !== undefined && !expect.whyPrefix.some((pre) => why.startsWith(pre))) fatal.push(`result:why=${why}`);
    if (result.ok) {
      const designReasons = evalDesign(def.design ?? [], {
        world, row, result, resolved, statusTaskNull: statusAfterAbort.task === null,
      });
      for (const r of designReasons) fatal.push(`design:${r}`);
    }
    if (!result.ok && why.startsWith("no-plan:")) fatal.push(`plan-fail:${why}`);
    if (replans >= 5) fatal.push(`replan-stuck:${replans}`);
    else if (replans >= 3) warn.push(`replan-warn:${replans}`);
    if (def.moving && statMax >= 15) fatal.push(`stall-hard:${round2(statMax)}s`);
    else if (def.moving && statMax >= 3) warn.push(`stall-soft:${round2(statMax)}s`);
    if (def.progress && progMax >= 15) fatal.push(`stall-progress:${round2(progMax)}s`);
    if (netMax >= 5) fatal.push(`net-freeze:${round2(netMax)}s`);
    if (penSeen.length > 0) fatal.push(`penetration:${penSeen.slice(0, 3).map((q) => `${q.id ?? "?"}/${q.source}`).join(",")}`);
    if (sawDead && !def.allowDeath) fatal.push("died");
    if (connLost) fatal.push(`conn:${connLost}`);
    if (socketClosed) fatal.push("socket:closed");
    if (timedOut) fatal.push("timeout");
    if (def.abortAtMs !== undefined && (abortMs === null || abortMs > (def.abortWithinMs ?? 5_000))) {
      fatal.push(`abort-late:${abortMs === null ? "never" : `${abortMs}ms`}`);
    }
    if (def.armGate) {
      if (armedAt === null || armedAt > 10) fatal.push(`arm-gate:armed=${armedAt === null ? "never" : `${round2(armedAt)}s`}`);
      if (pickupMax > 2) fatal.push(`arm-gate:pickup-stall=${round2(pickupMax)}s`);
    }

    // negative controls: FAIL is the designed result; the check is that it
    // failed for the intended reason.
    let negativeTripped: boolean | null = null;
    if (def.negative === "plan") {
      negativeTripped = fatal.some((r) => r.startsWith("plan-fail:") || r.startsWith("result:why=no-plan:"));
    } else if (def.negative === "stallOrPen") {
      negativeTripped = fatal.some((r) => r.startsWith("stall-hard:") || r.startsWith("stall-progress:") || r.startsWith("penetration:"));
    }
    row.negative = def.negative ?? null;
    row.negative_tripped = negativeTripped;

    if (fatal.length > 0) reasons.push(...fatal);
    if (warn.length > 0) reasons.push(...warn);
    let verdict = fatal.length > 0 ? "FAIL" : warn.length > 0 ? "WARN" : "PASS";
    if (def.negative) verdict = fatal.length > 0 ? "FAIL" : "PASS";
    if (foreign) {
      verdict = "INVALID";
      reasons.unshift(`players:[${foreign.join(",")}]`);
    }
    row.verdict = verdict;
    row.foreign_players = foreign;
    row.reasons = reasons;
    return { row, verdict, reasons, fatal: fatal.length > 0 };
  } catch (err) {
    const msg = err instanceof Error ? `${err.message}` : String(err);
    record(`TRIAL ERROR pass=${pass} trial=${def.id} ${msg}`);
    reasons.push(`error:${msg}`);
    row.verdict = "INVALID";
    row.reasons = reasons;
    return { row, verdict: "INVALID", reasons, fatal: true };
  } finally {
    if (hostRef && hostRef.busy) {
      try {
        hostRef.abort();
        await sleep(200);
      } catch {
        // best effort
      }
    }
    if (session && ownsSession) {
      try {
        session.close();
      } catch {
        // already closed
      }
      await sleep(400);
    }
    if (host) {
      const kill = await stopHost(host);
      row.host = { ...(row.host as Record<string, unknown>), kill: kill.exit, free_ms: kill.free_ms, freed: kill.freed };
      record(`HOST kill pass=${pass} trial=${def.id} pid=${host.child.pid} exit=${kill.exit} free_ms=${kill.free_ms}${kill.freed ? "" : " NOT-FREE"}`);
    } else if (ATTACH) {
      record(`HOST leave pass=${pass} trial=${def.id} url=${URL} (operator-owned, not touched)`);
    }
  }
}

// --- the design checks ----------------------------------------------------
type DesignCtx = {
  world: BotSession["world"];
  row: TrialRow;
  result: CommandResult;
  resolved: Record<string, unknown>;
  statusTaskNull: boolean;
};
function evalDesignChecks(checks: DesignCheck[], ctx: DesignCtx): string[] {
  const out: string[] = [];
  const after = (ctx.row.after ?? {}) as Record<string, unknown>;
  const data = (ctx.result.ok ? ctx.result.data : undefined) ?? {};
  const artifactRows = (ctx.row.artifact_rows as number | undefined) ?? 0;
  const resolvedPickup = ctx.resolved.pickup as string | undefined;
  const pos = after.pos as [number, number, number] | null | undefined;
  for (const c of checks) {
    switch (c.kind) {
      case "weaponNot":
        if ((after.weapon as string ?? "none") === c.value) out.push(`weapon=${c.value}`);
        break;
      case "keysContains":
        if (!((after.keys as string[] | undefined) ?? []).includes(c.value)) out.push(`keys-missing=${c.value}`);
        break;
      case "place":
        if ((after.place as string | undefined) !== c.place) out.push(`place=${String(after.place)} != ${c.place}`);
        break;
      case "dist": {
        const point = c.at ?? (c.point ? (C as unknown as Record<string, Point>)[c.point] : undefined);
        if (!point || !pos) { out.push(`dist-${c.point ?? "adhoc"}=no-pos`); break; }
        const d = Math.hypot(pos[0] - point.x, pos[2] - point.z);
        if (d > c.max) out.push(`dist-${c.point ?? "adhoc"}=${round2(d)}>${c.max}`);
        break;
      }
      case "dataGte": {
        const v = Number((data as Record<string, unknown>)[c.field]);
        if (!Number.isFinite(v) || v < c.min) out.push(`data.${c.field}=${String((data as Record<string, unknown>)[c.field])}<${c.min}`);
        break;
      }
      case "dataContainsAll": {
        const arr = ((data as Record<string, unknown>)[c.field] as unknown[] | undefined) ?? [];
        const missing = c.values.filter((v) => !arr.includes(v));
        if (missing.length) out.push(`data.${c.field} missing=[${missing.join(",")}] got=[${arr.join(",")}]`);
        break;
      }
      case "dataHas":
        if ((data as Record<string, unknown>)[c.field] === undefined || (data as Record<string, unknown>)[c.field] === null) out.push(`data.${c.field}=null`);
        break;
      case "artifactRows":
        if (artifactRows < c.min) out.push(`artifact.rows=${artifactRows}<${c.min}`);
        break;
      case "goneOrHeld": {
        const id = c.pickup === "@outside-ammo" ? resolvedPickup : c.pickup;
        if (!id) { out.push(`pickup=unresolved`); break; }
        const held = ctx.world.keys().includes(id) || !ctx.world.pickups().includes(id);
        if (!held) out.push(`pickup=${id} still-present`);
        break;
      }
      case "statusTaskNull":
        if (!ctx.statusTaskNull) out.push(`status.task=${String((ctx.row.status_after_task ?? "?"))}`);
        break;
      default:
        out.push(`unknown-check:${(c as { kind: string }).kind}`);
    }
  }
  return out;
}
const evalDesign = evalDesignChecks;

// --- shell text parsing ---------------------------------------------------
const SHELL_HELP = [
  "<seat> arm",
  "<seat> goto <place>",
  "<seat> stand <x,y,z[,yaw]>",
  "<seat> path <x,y,z[,yaw]>",
  "<seat> goto-at <x,y,z>            (y parsed, ignored)",
  "<seat> walk <x,z> [<x,z> ...]",
  "<seat> reload [crate]",
  "<seat> hunt [minutes]",
  "<seat> patrol <place,place,...> [minutes]",
  "<seat> retrieve <pickup|@outside-ammo> [@place]",
  "<seat> getkey",
  "<seat> projectile [bands] [throws] [seconds]",
  "<seat> seek-health <crate>         (combat; needs --surface proto)",
  "<seat> take-cover                  (combat; needs --surface proto)",
  "<seat> return-fire <pawnId>        (combat; needs --surface proto)",
  "<seat> retreat <place>             (combat; needs --surface proto)",
  "<seat> reload                      (combat rearm; legacy: legacy reload)",
  "<seat> survive | defend            (combat goals; defend takes [minutes] [radius] as a posture)",
  "<seat> regroup <place>            (anchor at 45, not forced; needs --surface proto)",
  "<seat> assault <pawnId>            (combat goal; needs --surface proto)",
  "team <id> <verb> [args]          (the probe seats whose pawn is on the host roster's team; needs --tree proto)",
  "help | seats | status [seat] | abort|stop <seat|all> | q/quit/exit | Ctrl-C | Ctrl-D",
];

type ShellAction =
  | { kind: "dispatch"; name: string; args: Record<string, unknown>; combat?: boolean; legacy?: boolean }
  | { kind: "builtin"; name: "help" | "status" | "abort" | "quit" }
  | { kind: "unknown" }
  | { kind: "error"; name: string; why: string };

/**
 * The combat vocabulary, checked before the legacy switch: the one place the
 * override lives (184). A verb maps to the surface name and its args; `null`
 * means bad args (the surface still validates).
 */
const COMBAT_VERBS: Record<string, { surface: string; args: (tokens: string[]) => Record<string, unknown> | null }> = {
  "seek-health": { surface: "seekHealth", args: (tokens) => (tokens[1] ? { crate: tokens[1] } : null) },
  "take-cover": { surface: "takeCover", args: () => ({}) },
  "return-fire": {
    surface: "returnFire",
    args: (tokens) => {
      const pawnId = Number(tokens[1]);
      return Number.isInteger(pawnId) && pawnId > 0 ? { pawnId } : null;
    },
  },
  retreat: { surface: "retreat", args: (tokens) => (tokens[1] ? { place: tokens[1] } : null) },
  reload: { surface: "rearm", args: () => ({}) },
  survive: { surface: "survive", args: () => ({}) },
  defend: { surface: "defend", args: (tokens) => ({ minutes: tokens[1] ? Number(tokens[1]) : undefined, radius: tokens[2] ? Number(tokens[2]) : undefined }) },
  assault: {
    surface: "assault",
    args: (tokens) => {
      const pawnId = Number(tokens[1]);
      return Number.isInteger(pawnId) && pawnId > 0 ? { pawnId } : null;
    },
  },
};

/** Map one text line to a command request; the handler does the validation. */
function parseShellLine(line: string, world: BotSession["world"], skipCombat = false): ShellAction {
  const tokens = line.trim().split(/\s+/);
  const verb = (tokens[0] ?? "").toLowerCase();
  const nums = (spec: string | undefined): number[] => (spec ?? "").split(",").map((part) => Number(part));
  // `legacy <verb>` reaches the shadowed legacy command through the same switch,
  // with the combat table skipped (else `reload` maps straight back to `rearm`).
  if (verb === "legacy") {
    const inner = parseShellLine(tokens.slice(1).join(" "), world, true);
    return inner.kind === "dispatch" ? { ...inner, legacy: true } : inner;
  }
  const combat = skipCombat ? undefined : COMBAT_VERBS[verb];
  if (combat) {
    const args = combat.args(tokens);
    return args === null
      ? { kind: "error", name: combat.surface, why: "bad-args" }
      : { kind: "dispatch", name: combat.surface, args, combat: true };
  }
  switch (verb) {
    case "help":
      return { kind: "builtin", name: "help" };
    case "status":
      return { kind: "builtin", name: "status" };
    case "abort":
      return { kind: "builtin", name: "abort" };
    case "q":
    case "quit":
    case "exit":
      return { kind: "builtin", name: "quit" };
    case "arm":
      return { kind: "dispatch", name: "arm", args: {} };
    case "getkey":
      return { kind: "dispatch", name: "getkey", args: {} };
    case "goto":
      return { kind: "dispatch", name: "goto", args: { place: tokens[1] ?? "" } };
    case "regroup":
      // 200: an anchor order at 45 (not forced); the place must be a graph id.
      return { kind: "dispatch", name: "regroup", args: { place: tokens[1] ?? "" } };
    case "stand":
    case "path": {
      const [x, y, z, yaw] = nums(tokens[1]);
      return { kind: "dispatch", name: verb, args: { x, y, z, ...(Number.isFinite(yaw) ? { yaw } : {}) } };
    }
    case "goto-at": {
      const [x, , z] = nums(tokens[1]);
      return { kind: "dispatch", name: "gotoAt", args: { x, z } };
    }
    case "walk": {
      const points = tokens.slice(1).map((point) => {
        const [x, z] = nums(point);
        return { x, z };
      });
      return { kind: "dispatch", name: "walk", args: { points } };
    }
    case "reload":
      return { kind: "dispatch", name: "reload", args: tokens[1] ? { crate: tokens[1] } : {} };
    case "hunt":
      return { kind: "dispatch", name: "hunt", args: { minutes: tokens[1] ? Number(tokens[1]) : 2, weapon: "laser" } };
    case "patrol": {
      const places = (tokens[1] ?? "").split(",").filter((place) => place.length > 0);
      return { kind: "dispatch", name: "patrol", args: { places, minutes: tokens[2] ? Number(tokens[2]) : 3 } };
    }
    case "retrieve": {
      let pickup = tokens[1] ?? "";
      if (pickup === "@outside-ammo") {
        const id = outsideAmmo(world);
        if (!id) return { kind: "error", name: "retrieve", why: "no-outside-ammo" };
        pickup = id;
      }
      const place = tokens[2]?.replace(/^@/, "");
      return { kind: "dispatch", name: "retrieve", args: { pickup, ...(place ? { place } : {}) } };
    }
    case "projectile": {
      const args: Record<string, unknown> = {};
      if (tokens[1]) args.bands = tokens[1].split(",").map(Number);
      if (tokens[2]) args.throws = Number(tokens[2]);
      if (tokens[3]) args.seconds = Number(tokens[3]);
      return { kind: "dispatch", name: "projectile", args };
    }
    default:
      return { kind: "unknown" };
  }
}

// --- modes ----------------------------------------------------------------
function printMenu(): void {
  record(`MENU question tests=${TRIALS.length} suite=1`);
  for (const t of TRIALS) {
    record(`MENU test id=${t.id} title="${t.title}" timeout=${Math.round(t.timeoutMs / 1000)}s${t.negative ? ` negative=${t.negative}` : ""}`);
  }
  record(`MENU suite id=suite title="the whole suite: ${PASSES} passes of the ${PASS_TRIALS.length} positives + both controls" hosts=${PASS_TRIALS.length * PASSES + TRIALS.filter((t) => t.negative).length}`);
}

// --- suite ----------------------------------------------------------------
async function main(): Promise<void> {
  if (MODE === "none") {
    console.error(USAGE);
    process.exit(2);
  }
  mkdirSync(LOG_DIR, { recursive: true });
  // Validate the surface name before `--list` too: a bad flag never gets to
  // print a menu and exit 0.
  if (SURFACE_NAME !== "proto" && SURFACE_NAME !== "probe") {
    console.error(USAGE);
    abortSuite(2, `unknown surface: ${SURFACE_NAME} (proto|probe)`);
  }
  if (!Number.isInteger(SEATS) || SEATS < 1 || SEATS > 16) {
    console.error(USAGE);
    abortSuite(2, `--seats must be an integer 1..16 (got ${args.get("seats") ?? "?"})`);
  }
  if (MODE === "list") {
    printMenu();
    process.exit(0);
  }
  if (MODE === "test" && !TEST_ID) abortSuite(2, "--test needs a test id");
  if (MODE === "test" && !TRIALS.some((t) => t.id === TEST_ID)) abortSuite(2, `unknown test id: ${TEST_ID} (see --list)`);
  // `--goto-at` is one ad-hoc trial: it owns no table row and no menu entry.
  // The guard tests GOTO_AT itself, not MODE: `--test` outranks `--goto-at` in
  // the mode order, so a MODE === "goto" check would miss the conflict.
  const gotoConflict = GOTO_AT.length > 0 && (args.has("test") || args.has("suite") || args.has("shell"));
  if (gotoConflict) {
    console.error(USAGE);
    abortSuite(2, "--goto-at is one trial; it conflicts with --test/--suite/--shell");
  }
  if (args.has("shell") && (args.has("test") || args.has("suite"))) {
    console.error(USAGE);
    abortSuite(2, "--shell is one session; it conflicts with --test/--suite");
  }
  let gx = Number.NaN;
  let gy = Number.NaN;
  let gz = Number.NaN;
  if (MODE === "goto") {
    const parts = GOTO_AT.split(",");
    if (parts.length !== 3 || parts.some((p) => p.trim() === "")) {
      console.error(USAGE);
      abortSuite(2, "--goto-at needs x,y,z (three numbers; y is ignored)");
    }
    [gx, gy, gz] = parts.map(Number) as [number, number, number];
    if (![gx, gy, gz].every(Number.isFinite)) {
      console.error(USAGE);
      abortSuite(2, "--goto-at needs x,y,z (three numbers; y is ignored)");
    }
  }
  if (!existsSync("package.json") || !existsSync(TRIALS_FILE)) abortSuite(2, "not the repo root");
  // Load the selected command module lazily; the menu never needs it and the
  // module is a flag choice, independent of the plumbing tree.
  const { path: surfacePath, mod: surfaceMod } = await loadSurface(SURFACE_NAME);
  selectedSurface = surfaceMod;
  if (!existsSync(surfacePath)) abortSuite(2, `surface missing: ${surfacePath}`);
  // Surface guard (D16): the harness must never import src/commands.ts.
  const surfaceHash = sha256File(surfacePath);
  const ownSrc = readFileSync("packages/bot-client/probe/command-suite.ts", "utf8");
  if (/from\s+["']\.\.\/src\/commands\.ts["']/.test(ownSrc)) abortSuite(2, "surface guard: this harness imports src/commands.ts");
  if (MODE === "goto") {
    record(`MENU choice=goto-at mode=goto x=${gx} y=${gy} z=${gz} y_ignored=1 command="${process.argv.slice(2).join(" ")}"`);
  } else {
    record(`MENU choice=${MODE === "test" ? TEST_ID : MODE === "shell" ? "shell" : "suite"} mode=${MODE} command="${process.argv.slice(2).join(" ")}"`);
  }
  record(`SURFACE file=${surfacePath} sha256=${surfaceHash} surface=${SURFACE_NAME}`);
  if (!ATTACH) {
    if (await portAnswers(PORT)) {
      // The operator runs this host: adopt it, never build, spawn, or kill it.
      ATTACH = URL;
      BUILD = false;
      record(`HOST adopt port=${PORT} url=${URL} (already answering; not spawned or killed)`);
    } else {
      if (process.env.ARENA_AUTH !== "required") abortSuite(2, "ARENA_AUTH !== required");
      if (!VERIFY_KEY || !existsSync(VERIFY_KEY.replace(/^~\//, `${homedir()}/`))) abortSuite(2, `ARENA_VERIFY_KEY_FILE missing: ${VERIFY_KEY}`);
    }
  }
  record(ATTACH ? `HOST attach url=${ATTACH} owner=operator (suite does not spawn or kill it)` : `HOST mode=spawn port=${PORT}`);
  record(`SUITE trials=${TRIALS.length} hash=${TRIALS_HASH.slice(0, 12)} node=${process.version}`);

  const id = buildIdentity();
  if (!ATTACH && !existsSync("dist/server/main.js")) abortSuite(2, "no dist/server/main.js after the build");
  record(`BUILD head=${id.head.slice(0, 12)} dist=${id.dist} server=${id.server} dirty=[${id.status.split("\n").filter(Boolean).join(" | ")}]`);
  const buildBlock = [
    `# ${LABEL ?? (MODE === "goto" ? "168" : "158")} ${MODE} run ${STAMP}`,
    "",
    `- head: \`${id.head}\``,
    `- dirty: \`${id.status.split("\n").filter(Boolean).join("; ") || "clean"}\``,
    `- dist/server/main.js: \`${id.dist}\``,
    `- bot bundle: \`${id.bot}\``,
    `- trials: \`${TRIALS_FILE}\` sha256 \`${TRIALS_HASH}\``,
    `- surface: \`${surfacePath}\` sha256 \`${surfaceHash}\` surface \`${SURFACE_NAME}\``,
    `- mode: ${MODE}${MODE === "test" ? ` test: ${TEST_ID}` : MODE === "goto" ? ` goto-at: ${GOTO_AT}` : ` passes: ${PASSES}`}; host: ${ATTACH ? `attached ${ATTACH}` : `spawned port ${PORT}`}; auth: required; token role: qa; samples: ${SAMPLE_MS}ms`,
    "",
  ].join("\n");

  // --- shell: held-open seats, one host, one prompt -------------------------
  if (MODE === "shell") {
    const tree = process.env.BOT_CLIENT_TREE === "proto" ? "proto" : "src";
    const shownPort = ATTACH ? new globalThis.URL(URL).port || String(PORT) : String(PORT);
    let host: HostHandle | undefined;
    if (!ATTACH) {
      record(`HOST spawn shell port=${PORT}`);
      host = startHost(PORT, "shell", `${LOG_DIR}/171-host-shell-${STAMP}.log`);
      const spawnAt = Date.now();
      await host.ready;
      record(`HOST ready shell ms=${Date.now() - spawnAt}`);
    } else {
      record(`HOST attach url=${URL} owner=operator (suite does not spawn or kill it)`);
    }
    record(`SHELL start host=${ATTACH ? "attach" : "spawn"} port=${shownPort} seats=${SEATS} surface=${SURFACE_NAME} tree=${tree}`);
    if (!SURFACE_EXPLICIT) record(`SHELL surface=${SURFACE_NAME} (default: proto when proto/combat.ts exists; --surface probe runs the legacy copy)`);
    if (SURFACE_NAME !== "proto") record("SHELL surface=probe: combat verbs unavailable, arm/getkey are the legacy pinned-pad handlers (use --surface proto)");
    type Seat = { index: number; session: BotSession; cmdHost: CommandHost; world: BotSession["world"]; name: string; closed: boolean };
    const seats = new Map<number, Seat>();
    /** Abort the seat's running command and stop its pawn where it stands. */
    const haltSeat = (seat: Seat): void => {
      try {
        seat.cmdHost.abort();
      } catch {
        // idle
      }
      const me = seat.world.self();
      if (me) seat.session.input.sendInput({ moveX: 0, moveZ: 0, yaw: me.yaw });
    };
    const pending = new Set<Promise<unknown>>();
    // Wall-contact logging: the suite's one-shot sampler, per seat. A new
    // continuous contact per box logs once (the suite's episode rule); the
    // counts print on `status` and at exit.
    const seatCollisions = new Map<number, number>();
    const seatPens = new Map<number, number>();
    /** The last `attack:` phase line per seat (pursue/retreat/standoff/…). */
    const seatPhase = new Map<number, string>();
    /** Per-seat, per-box phase at the last logged contact; a phase change re-logs. */
    const seatContactPhase = new Map<number, Map<string, string>>();
    const seatPhaseCounts = new Map<number, Map<string, number>>();
    const seatLastPose = new Map<number, { x: number; z: number }>();
    let collisionSampler: ReturnType<typeof setInterval> | undefined;
    const logCollisionCounts = (): void => {
      for (const seat of seats.values()) {
        const counts = seatPhaseCounts.get(seat.index);
        const phases = counts ? [...counts.entries()].map(([phase, n]) => `${phase}:${n}`).join(",") : "-";
        record(`SHELL collisions seat=${seat.index} count=${seatCollisions.get(seat.index) ?? 0} pen=${seatPens.get(seat.index) ?? 0} phases=${phases}`);
      }
    };
    const sampleCollisions = (): void => {
      for (const seat of seats.values()) {
        if (seat.closed) continue;
        const me = seat.world.self();
        if (!me) continue;
        const last = seatLastPose.get(seat.index);
        const dx = last ? me.x - last.x : 0;
        const dz = last ? me.z - last.z : 0;
        const speed = Math.hypot(dx, dz) * 4; // 250 ms samples
        const forward = dx * Math.sin(me.yaw) + dz * Math.cos(me.yaw);
        const ratio = speed > 0.15 ? forward / Math.hypot(dx, dz) : 0;
        const move = !last || speed < 0.15 ? "still" : ratio > 0.5 ? "forward" : ratio < -0.5 ? "back" : "side";
        const phase = seatPhase.get(seat.index) ?? "-";
        const hits: Array<{ id: number | null; source: string }> = [];
        let pen = 0;
        for (const b of seat.world.aabbs) {
          const maxY = b.maxY ?? 0;
          if (maxY <= me.y + 0.35) continue;
          const source = (b as { source?: string }).source ?? "";
          if (source.endsWith("-box") || source === "aabb") continue;
          const box = { minX: b.minX, maxX: b.maxX, minY: b.minY ?? 0, maxY, minZ: b.minZ, maxZ: b.maxZ };
          if (capsuleOverlapsAabb(me.x, me.y, me.z, seat.world.pawnRadius - 0.05, seat.world.pawnHeight, box)) pen += 1;
          if (capsuleOverlapsAabb(me.x, me.y, me.z, seat.world.pawnRadius, seat.world.pawnHeight, box)) {
            hits.push({ id: (b as { id?: number }).id ?? null, source });
          }
        }
        const touching = seatContactPhase.get(seat.index) ?? new Map<string, string>();
        const seen = new Set<string>();
        for (const h of hits) {
          const key = `${h.id ?? "?"}:${h.source}`;
          seen.add(key);
          const prev = touching.get(key);
          if (prev === phase) continue;
          touching.set(key, phase);
          const at = `${me.x.toFixed(2)},${me.y.toFixed(2)},${me.z.toFixed(2)}`;
          if (prev === undefined) {
            // A new box contact: the collision count.
            seatCollisions.set(seat.index, (seatCollisions.get(seat.index) ?? 0) + 1);
            const counts = seatPhaseCounts.get(seat.index) ?? new Map<string, number>();
            counts.set(phase, (counts.get(phase) ?? 0) + 1);
            seatPhaseCounts.set(seat.index, counts);
            record(`COLLIDE seat=${seat.index} t=${secs().toFixed(1)}s box=${h.id ?? "?"} src=${h.source} at=${at} phase=${phase} move=${move} speed=${speed.toFixed(1)}`);
          } else {
            // Still touching the same box, the attack phase changed: a CONTACT
            // line, not a second collision.
            record(`CONTACT seat=${seat.index} t=${secs().toFixed(1)}s box=${h.id ?? "?"} src=${h.source} at=${at} from=${prev} to=${phase} move=${move} speed=${speed.toFixed(1)}`);
          }
        }
        for (const key of [...touching.keys()]) if (!seen.has(key)) touching.delete(key);
        seatContactPhase.set(seat.index, touching);
        seatLastPose.set(seat.index, { x: me.x, z: me.z });
        if (pen > 0) seatPens.set(seat.index, (seatPens.get(seat.index) ?? 0) + 1);
      }
    };
    let done = false;
    let closing = false;
    let rl: ReturnType<typeof createInterface> | undefined;
    const finish = async (reason: string, code: number, drain = false): Promise<void> => {
      if (done || closing) return;
      closing = true;
      // q/eof drain in-flight commands so a scripted pass prints its results;
      // ctrl-c, a closed seat and host death abort immediately.
      if (drain && pending.size > 0) {
        await Promise.race([Promise.allSettled([...pending]), sleep(15_000)]);
      }
      done = true;
      shellReprompt = undefined;
      shellShutdown = undefined;
      if (collisionSampler) clearInterval(collisionSampler);
      record(`SHELL exit reason=${reason} code=${code}`);
      logCollisionCounts();
      for (const seat of seats.values()) {
        try {
          seat.cmdHost.abort();
        } catch {
          // idle
        }
      }
      try {
        rl?.close();
      } catch {
        // already closed
      }
      for (const seat of seats.values()) {
        record(`SESSION close seat=${seat.index}`);
        try {
          seat.session.close();
        } catch {
          // already closed
        }
      }
      await sleep(400);
      if (host) {
        const kill = await stopHost(host);
        record(`HOST kill pid=${host.child.pid} exit=${kill.exit} free_ms=${kill.free_ms}${kill.freed ? "" : " NOT-FREE"}`);
      } else {
        record(`HOST leave url=${URL} (operator-owned, not touched)`);
      }
      process.exit(code);
    };
    shellShutdown = (reason, code) => {
      void finish(reason, code);
    };
    let seatClosed: (index: number) => void = () => {};
    seatClosed = (index: number) => {
      if (done || closing) return;
      const seat = seats.get(index);
      if (!seat || seat.closed) return;
      seat.closed = true;
      record(`SHELL seat ${index} closed`);
      seats.delete(index);
      if (seats.size === 0 && !done) void finish("session-closed", 1);
    };
    for (let i = 1; i <= SEATS; i += 1) {
      try {
        const session = await connectBot({
          url: URL,
          token: TOKEN,
          name: `${NAME}-${i}`,
          role: "qa",
          openSocket: trackSocket,
          onLog: (line) => {
            record(`[conn] seat=${i} ${line}`);
            if (line.startsWith("close code=") || line.includes("connection lost") || line.includes("session abort")) seatClosed(i);
          },
        });
        const world = session.world;
        const joinAt = Date.now();
        while ((!world.self() || !world.sceneGraph()) && Date.now() - joinAt < 15_000) await sleep(50);
        const me = world.self();
        if (!me || !world.sceneGraph()) throw new Error("no self or scene graph");
        const cmdHost = selectedSurface!.createCommandHost({
          session,
          log: (line) => {
            recordFile(`  shell[${i}] ${line}`);
            const m = /attack: ([a-z-]+)/.exec(line);
            if (m) seatPhase.set(i, m[1]!);
          },
        });
        seats.set(i, { index: i, session, cmdHost, world, name: `${NAME}-${i}`, closed: false });
        record(`SHELL seat ${i} self=${me.id} client=unknown place=${world.placeOf(me)?.id ?? "?"} players=[${[...world.playerIds()].join(",")}] weapon=${world.weapon() ?? "none"} keys=[${world.keys().join(",")}]`);
      } catch (err) {
        record(`SHELL seat ${i} failed why=${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (seats.size === 0) {
      await finish("no-seats", 2);
      return;
    }
    const first = [...seats.values()][0]!;
    const selfs = [...seats.values()].map((seat) => seat.world.self()?.id ?? "?");
    record(`SHELL seats=[${[...seats.keys()].join(",")}] selfs=[${selfs.join(",")}] players=[${[...first.world.playerIds()].join(",")}]`);
    for (const seat of seats.values()) {
      const team = (seat.world as { teamOf?: (id: number) => string | undefined }).teamOf?.(seat.world.self()?.id ?? -1) ?? "-";
      record(`SHELL team-seat=${seat.index} self=${seat.world.self()?.id ?? "?"} team=${team}`);
    }
    collisionSampler = setInterval(sampleCollisions, 250);
    const terminal = process.stdin.isTTY === true;
    rl = createInterface({ input: process.stdin, output: process.stdout, terminal });
    if (terminal) rl.setPrompt("bot> ");
    // One console write can land long after the prompt (a result, a status row);
    // the record hook re-prompts on the next tick, coalesced per burst. Only on a
    // TTY: a piped stdin run keeps its console clean (no `> ` from readline).
    if (terminal) {
      shellReprompt = () => {
        if (!done && !closing) rl?.prompt();
      };
    }
    let cmdNo = 0;
    /** The `goto-at x,z` target of a team line, for the 4 Hz `TEAM` sampler. */
    const teamTarget = (text: string): { x: number; z: number } | undefined => {
      const parts = text.split(/\s+/);
      const verb = (parts[0] ?? "").toLowerCase();
      if (verb !== "goto-at" && verb !== "gotoat") return undefined;
      const pair = (parts[1] ?? "").split(",");
      const x = Number(pair[0]);
      const z = Number(pair[1]);
      return Number.isFinite(x) && Number.isFinite(z) ? { x, z } : undefined;
    };
    /**
     * The one numeric-seat dispatch path: parse the verb+args and run it on one
     * seat. The numeric branch and `team` both call it, so a team line produces
     * exactly the per-seat records a hand-typed `<seat> <verb>` does.
     * @post `shown` is the command text for the unknown-verb record (numeric
     *       keeps its full `1 foo` line).
     */
    const dispatchTo = (seat: Seat, text: string, shown = text, opts?: { claim?: "goal" | "advisory" }): Promise<void> | undefined => {
      const tokens = text.split(/\s+/);
      const sub = (tokens[0] ?? "").toLowerCase();
      if (sub === "abort" || sub === "stop") {
        haltSeat(seat);
        record(`SHELL ${sub} seat=${seat.index}`);
        return;
      }
      const action = parseShellLine(text, seat.world);
      if (action.kind !== "dispatch") {
        if (action.kind === "builtin" && action.name === "status") {
          record(`SHELL status seat=${seat.index} ${JSON.stringify(seat.cmdHost.status())}`);
        } else if (action.kind === "error") {
          record(`SHELL rejected seat=${seat.index} name=${action.name} why=${action.why}`);
          record(`SHELL result seat=${seat.index} name=${action.name} ok=0 code=1 why=${action.why} ms=0`);
        } else {
          record(`SHELL rejected seat=${seat.index} why=unknown-verb`);
          record(`SHELL unknown cmd="${shown}"`);
        }
        return;
      }
      if (action.legacy) record(`SHELL legacy ${action.name}`);
      if (action.combat && SURFACE_NAME !== "proto") {
        record(`SHELL rejected seat=${seat.index} name=${action.name} why=surface-probe`);
        record(`SHELL result seat=${seat.index} name=${action.name} ok=0 code=1 why=surface-probe ms=0`);
        return;
      }
      if (seat.cmdHost.busy) {
        record(`SHELL rejected seat=${seat.index} name=${action.name} why=busy`);
        record(`SHELL result seat=${seat.index} name=${action.name} ok=0 code=1 why=busy ms=0`);
        return;
      }
      record(`SHELL accepted seat=${seat.index} name=${action.name} args=${JSON.stringify(action.args)}`);
      const at = Date.now();
      const promise = seat.cmdHost.dispatch({ id: `shell-${seat.index}-${++cmdNo}`, name: action.name, args: action.args }, opts).then((result) => {
        if (done) return;
        record(`SHELL result seat=${seat.index} name=${action.name} ok=${result.ok ? 1 : 0} code=${result.ok ? (result.code ?? 0) : result.code} why=${result.ok ? "-" : result.why} ms=${Date.now() - at}`);
      }).catch((err: unknown) => {
        record(`SHELL result seat=${seat.index} name=${action.name} ok=0 code=1 why=error:${err instanceof Error ? err.message : String(err)} ms=${Date.now() - at}`);
      });
      pending.add(promise);
      void promise.finally(() => pending.delete(promise));
      return promise;
    };
    const handle = (raw: string): void => {
      if (done || closing) return;
      const line = raw.trim();
      if (line.length === 0) {
        // No record row, so no queued reprompt: a blank Enter must not eat the prompt.
        shellReprompt?.();
        return;
      }
      const tokens = line.split(/\s+/);
      const verb = (tokens[0] ?? "").toLowerCase();
      const numeric = /^\d+$/.test(tokens[0] ?? "");
      const seatIndex = numeric ? Number(tokens[0]) : null;
      if (!numeric) {
        record(`SHELL line="${line}" seat=-`);
        if (verb === "q" || verb === "quit" || verb === "exit") {
          void finish("q", 0, true);
          return;
        }
        if (verb === "help") {
          for (const row of SHELL_HELP) record(`SHELL help ${row}`);
          record("SHELL help shadowed: reload (legacy: legacy reload)");
          return;
        }
        if (verb === "seats") {
          const now = [...seats.values()].map((seat) => seat.world.self()?.id ?? "?");
          record(`SHELL seats=[${[...seats.keys()].join(",")}] selfs=[${now.join(",")}] players=[${[...first.world.playerIds()].join(",")}]`);
          return;
        }
        if (verb === "team") {
          const teamId = tokens[1] ?? "";
          const rest = tokens.slice(2).join(" ");
          if (teamId.length === 0 || rest.length === 0) {
            record("SHELL rejected team why=usage");
            record("SHELL team usage: team <id> <verb> [args]");
            return;
          }
          const teamOf = (seat: Seat): string | undefined =>
            (seat.world as { teamOf?: (id: number) => string | undefined }).teamOf?.(seat.world.self()?.id ?? -1);
          if (![...seats.values()].some((seat) => typeof (seat.world as { teamOf?: unknown }).teamOf === "function")) {
            record(`SHELL team=${teamId} why=no-teamof tree=${tree}`);
            return;
          }
          const members = [...seats.values()].filter((seat) => teamOf(seat) === teamId);
          record(`SHELL team=${teamId} seats=[${members.map((seat) => seat.index).join(",")}] count=${members.length}`);
          if (members.length === 0) {
            record(`SHELL rejected team=${teamId} why=no-seat`);
            return;
          }
          const memberVerb = (rest.split(/\s+/)[0] ?? "").toLowerCase();
          if (memberVerb === "help" || memberVerb === "seats" || memberVerb === "q" || memberVerb === "quit" || memberVerb === "exit") {
            record(`SHELL rejected team=${teamId} why=builtin`);
            return;
          }
          // A team order is advisory (D10): each member acquires and acts; no
          // member waits for another member's goal claim.
          const advisory = { claim: "advisory" as const };
          const promises: Promise<void>[] = [];
          for (const seat of members) {
            const p = dispatchTo(seat, rest, `team ${teamId} ${rest}`, advisory);
            if (p) promises.push(p);
          }
          const target = teamTarget(rest);
          if (target && promises.length > 0) {
            const started = Date.now();
            const timer = setInterval(() => {
              const rows = members
                .map((seat) => {
                  const me = seat.world.self();
                  const d = me ? Math.hypot(me.x - target.x, me.z - target.z) : Infinity;
                  return `seat=${seat.index} d=${Number.isFinite(d) ? d.toFixed(1) : "?"}`;
                })
                .join(" ");
              record(`TEAM t=${((Date.now() - started) / 1000).toFixed(1)}s ${rows}`);
            }, 250);
            timer.unref?.();
            void Promise.allSettled(promises).then(() => clearInterval(timer));
          }
          return;
        }
        if (verb === "status") {
          const wanted = tokens[1] !== undefined ? Number(tokens[1]) : undefined;
          void (async () => {
            // Direct race (not a helper) so this continuation is queued ahead of
            // the q/eof finish on the same pending set.
            if (pending.size > 0) await Promise.race([Promise.allSettled([...pending]), sleep(10_000)]);
            if (done) return;
            for (const seat of seats.values()) {
              if (wanted !== undefined && seat.index !== wanted) continue;
              record(`SHELL status seat=${seat.index} ${JSON.stringify(seat.cmdHost.status())}`);
            }
            logCollisionCounts();
          })();
          return;
        }
        if (verb === "abort" || verb === "stop") {
          const arg = (tokens[1] ?? "").toLowerCase();
          if (arg === "all") {
            for (const seat of seats.values()) haltSeat(seat);
            record(`SHELL ${verb} seat=all`);
          } else {
            const index = Number(arg);
            const seat = seats.get(index);
            if (seat) {
              haltSeat(seat);
              record(`SHELL ${verb} seat=${index}`);
            } else {
              record(`SHELL unknown cmd="${line}"`);
            }
          }
          return;
        }
        record(`SHELL rejected seat=- why=no-seat`);
        record(`SHELL unknown cmd="${line}" (commands need a seat id: ${[...seats.keys()].join(",")})`);
        return;
      }
      record(`SHELL line="${line}" seat=${seatIndex}`);
      const target = seats.get(seatIndex!);
      if (!target) {
        record(`SHELL rejected seat=${seatIndex} why=no-seat`);
        record(`SHELL unknown seat=${seatIndex} cmd="${line}" (seats ${[...seats.keys()].join(",")})`);
        return;
      }
      const sub = (tokens[1] ?? "").toLowerCase();
      if (sub === "abort" || sub === "stop") {
        haltSeat(target);
        record(`SHELL ${sub} seat=${seatIndex}`);
        return;
      }
      dispatchTo(target, tokens.slice(1).join(" "), line);
    };
    rl.on("line", (line) => {
      handle(line);
    });
    rl.on("SIGINT", () => {
      void finish("ctrl-c", 130);
    });
    rl.on("close", () => {
      if (!done) void finish("eof", 0, true);
    });
    if (terminal) rl.prompt();
    return;
  }

  // A suite on a shared host keeps ONE session: closing per trial makes the
  // host forget the pawn's kit (arena-host close → kit.forget), so reload/hunt/
  // abort could never run. One seat, teleported to the pad before each trial.
  let shared: BotSession | undefined;
  if (ATTACH && MODE === "suite") {
    record(`SESSION shared connect name=${NAME}`);
    shared = await connectBot({
      url: URL,
      token: TOKEN,
      name: NAME,
      role: "qa",
      openSocket: trackSocket,
      onLog: (l) => {
        record(`[conn] ${l}`);
        if (l.startsWith("close code=")) {
          const cm = /^close code=(\S+) reason=(.*?) rs=/.exec(l);
          if (cm) sock.close = { code: cm[1] === "none" ? undefined : Number(cm[1]), reason: cm[2] === "-" ? "" : cm[2] };
        }
        if (l.includes("connection lost") || l.includes("SERVER_FULL") || l.includes("session abort")) sharedConnLost = l;
      },
    });
    const w = shared.world;
    const waitAt = nowMs();
    while ((!w.self() || !w.sceneGraph()) && nowMs() - waitAt < 15_000) await sleep(50);
    record(`SESSION shared self=${w.self()?.id ?? "?"} players=[${[...w.playerIds()].join(",")}] weapon=${w.weapon() ?? "none"} keys=[${w.keys().join(",")}]`);
    if (!w.self()) abortSuite(2, "shared session has no pawn");
    if (sharedConnLost) abortSuite(2, `shared session closed: ${sharedConnLost}`);
  }

  const suiteTimer = MODE === "suite"
    ? setTimeout(() => abortSuite(2, `suite exceeded ${MAX_MIN} min — aborting (stuck or too slow)`), MAX_MIN * 60_000)
    : undefined;

  const allRows: TrialRow[] = [];
  const runs: Array<Record<string, unknown>> = [];
  const startedAll = Date.now();

  // --- one ad-hoc coordinate: one host, one bot, one verdict ---------------
  if (MODE === "goto") {
    const adhoc: TrialDef = {
      id: "goto-at",
      title: `goto an ad-hoc x,z point (${gx},${gz}; y ${gy} ignored)`,
      name: "gotoAt",
      args: { x: gx, z: gz },
      moving: true,
      timeoutMs: 120_000,
      expect: { ok: [true] },
      design: [{ kind: "dist", at: { x: gx, z: gz }, max: 0.75 }],
      progress: true,
    };
    let outcome = await oneTrial(1, adhoc, 0);
    if (outcome.verdict === "INVALID") {
      record(`RETRY trial=${adhoc.id} reason=${outcome.reasons.join(";")}`);
      const retry = await oneTrial(1, adhoc, 1);
      allRows.push(outcome.row);
      appendFileSync(NDJSON, `${JSON.stringify(outcome.row)}\n`);
      outcome = retry;
    }
    allRows.push(outcome.row);
    appendFileSync(NDJSON, `${JSON.stringify(outcome.row)}\n`);
    record(`VERDICT trial=${adhoc.id} ${outcome.verdict} reasons=[${outcome.reasons.join(",")}]`);
    const skipped = outcome.verdict === "SKIP";
    const passed = !skipped && (outcome.verdict === "PASS" || outcome.verdict === "WARN");
    const code = skipped ? 2 : passed ? 0 : 1;
    const tally = {
      positives: 1,
      pPass: outcome.verdict === "PASS" ? 1 : 0,
      pFail: outcome.verdict === "FAIL" ? 1 : 0,
      pWarn: outcome.verdict === "WARN" ? 1 : 0,
      pInvalid: outcome.verdict === "INVALID" ? 1 : 0,
      skips: skipped ? 1 : 0,
      controls: 0,
      controlsTripped: 0,
      code,
    };
    runs.push({ pass: 1, start: new Date(startedAll).toISOString(), elapsed_s: round2((Date.now() - startedAll) / 1000), trials: skipped ? 0 : 1, pass_n: tally.pPass, fail: tally.pFail, warn: tally.pWarn, invalid: tally.pInvalid, skip: tally.skips });
    writeOut(SUMMARY, buildBlock + "\n" + summaryMarkdown(id, allRows, runs, tally));
    record(`SUITE mode=goto trial=goto-at x=${gx} z=${gz} y_ignored=1 exit=${code}`);
    record(`SUITE elapsed=${round2((Date.now() - startedAll) / 1000)}s summary=${SUMMARY}`);
    process.exit(code);
  }

  // --- one named test: one host, one bot, one verdict ----------------------
  if (MODE === "test") {
    const def = TRIALS.find((t) => t.id === TEST_ID)!;
    let outcome = await oneTrial(1, def, 0);
    if (outcome.verdict === "INVALID") {
      record(`RETRY trial=${def.id} reason=${outcome.reasons.join(";")}`);
      const retry = await oneTrial(1, def, 1);
      allRows.push(outcome.row);
      appendFileSync(NDJSON, `${JSON.stringify(outcome.row)}\n`);
      outcome = retry;
    }
    allRows.push(outcome.row);
    appendFileSync(NDJSON, `${JSON.stringify(outcome.row)}\n`);
    const tripped = def.negative ? outcome.row.negative_tripped === true : null;
    if (def.negative) record(`CONTROL ${def.id} ${tripped ? "FAILED-AS-EXPECTED" : "PASSED"} reasons=[${outcome.reasons.join(",")}]`);
    record(`VERDICT trial=${def.id} ${outcome.verdict} reasons=[${outcome.reasons.join(",")}]`);
    // A negative control PASSes when the command fails for the expected reason.
    const skipped = outcome.verdict === "SKIP";
    const passed = !skipped && (def.negative ? tripped === true : outcome.verdict === "PASS" || outcome.verdict === "WARN");
    const code = skipped ? 2 : passed ? 0 : 1;
    const tally = def.negative
      ? { positives: 0, pPass: 0, pFail: passed ? 0 : 1, pWarn: 0, pInvalid: 0, controls: 1, controlsTripped: tripped ? 1 : 0, code }
      : {
          positives: 1,
          pPass: outcome.verdict === "PASS" ? 1 : 0,
          pFail: outcome.verdict === "FAIL" ? 1 : 0,
          pWarn: outcome.verdict === "WARN" ? 1 : 0,
          pInvalid: outcome.verdict === "INVALID" ? 1 : 0,
          skips: skipped ? 1 : 0,
          controls: 0,
          controlsTripped: 0,
          code,
        };
    runs.push({ pass: 1, start: new Date(startedAll).toISOString(), elapsed_s: round2((Date.now() - startedAll) / 1000), trials: skipped ? 0 : 1, pass_n: tally.pPass, fail: tally.pFail, warn: tally.pWarn, invalid: tally.pInvalid, skip: tally.skips });
    writeOut(SUMMARY, buildBlock + "\n" + summaryMarkdown(id, allRows, runs, tally));
    record(`SUITE mode=test test=${def.id} verdict=${outcome.verdict} exit=${code}`);
    record(`SUITE elapsed=${round2((Date.now() - startedAll) / 1000)}s summary=${SUMMARY}`);
    process.exit(code);
  }

  // --- the whole suite: PASSES passes of the positives, then the controls --
  for (let pass = 1; pass <= PASSES; pass += 1) {
    const passAt = Date.now();
    let pPass = 0;
    let pFail = 0;
    let pWarn = 0;
    let pInvalid = 0;
    let pSkip = 0;
    let n = 0;
    record(`SUITE pass=${pass} start trials=${PASS_TRIALS.length}`);
    for (const def of PASS_TRIALS) {
      n += 1;
      let outcome = await oneTrial(pass, def, 0, shared);
      if (outcome.verdict === "INVALID") {
        record(`RETRY pass=${pass} trial=${def.id} reason=${outcome.reasons.join(";")}`);
        const retry = await oneTrial(pass, def, 1, shared);
        allRows.push(outcome.row);
        appendFileSync(NDJSON, `${JSON.stringify(outcome.row)}\n`);
        outcome = retry;
      }
      allRows.push(outcome.row);
      appendFileSync(NDJSON, `${JSON.stringify(outcome.row)}\n`);
      if (outcome.verdict === "PASS") pPass += 1;
      else if (outcome.verdict === "WARN") pWarn += 1;
      else if (outcome.verdict === "SKIP") pSkip += 1;
      else if (outcome.verdict === "INVALID") pInvalid += 1;
      else pFail += 1;
      record(`VERDICT pass=${pass} trial=${def.id} ${outcome.verdict} reasons=[${outcome.reasons.join(",")}]`);
    }
    runs.push({ pass, start: new Date(passAt).toISOString(), elapsed_s: round2((Date.now() - passAt) / 1000), trials: n, pass_n: pPass, fail: pFail, warn: pWarn, invalid: pInvalid, skip: pSkip });
    record(`SUITE pass=${pass} trials=${n} pass=${pPass} fail=${pFail} invalid=${pInvalid} warn=${pWarn} skip=${pSkip}`);
  }

  record("SUITE negatives start");
  for (const def of TRIALS.filter((t) => t.negative)) {
    let outcome = await oneTrial(0, def, 0, shared);
    if (outcome.verdict === "INVALID") {
      record(`RETRY trial=${def.id} reason=${outcome.reasons.join(";")}`);
      const retry = await oneTrial(0, def, 1, shared);
      allRows.push(outcome.row);
      appendFileSync(NDJSON, `${JSON.stringify(outcome.row)}\n`);
      outcome = retry;
    }
    allRows.push(outcome.row);
    appendFileSync(NDJSON, `${JSON.stringify(outcome.row)}\n`);
    const tripped = outcome.row.negative_tripped === true;
    record(`CONTROL ${def.id} ${tripped ? "FAILED-AS-EXPECTED" : "PASSED"} reasons=[${outcome.reasons.join(",")}]`);
    record(`VERDICT pass=0 trial=${def.id} ${outcome.verdict} reasons=[${outcome.reasons.join(",")}]`);
  }

  // --- verdict tally ------------------------------------------------------
  let positives = 0;
  let pPass = 0;
  let pFail = 0;
  let pWarn = 0;
  let pInvalid = 0;
  let controls = 0;
  let controlsTripped = 0;
  let pSkip = 0;
  for (const r of allRows) {
    if (r.negative) {
      controls += 1;
      if (r.negative_tripped === true) controlsTripped += 1;
      continue;
    }
    if (r.verdict === "SKIP") {
      pSkip += 1;
      continue;
    }
    positives += 1;
    if (r.verdict === "PASS") pPass += 1;
    else if (r.verdict === "WARN") pWarn += 1;
    else if (r.verdict === "INVALID") pInvalid += 1;
    else pFail += 1;
  }
  const controlsOk = controlsTripped === controls && controls > 0;
  const code = pFail === 0 && pInvalid === 0 && controlsOk ? 0 : 1;
  const summary = summaryMarkdown(id, allRows, runs, { positives, pPass, pFail, pWarn, pInvalid, skips: pSkip, controls, controlsTripped, code });
  writeOut(SUMMARY, buildBlock + "\n" + summary);
  record(`SUITE mode=suite pass=${PASSES} trials=${positives} pass=${pPass} fail=${pFail} invalid=${pInvalid} warn=${pWarn} skip=${pSkip} controls=${controlsTripped}/${controls} exit=${code}`);
  if (suiteTimer) clearTimeout(suiteTimer);
  record(`SUITE elapsed=${round2((Date.now() - startedAll) / 1000)}s summary=${SUMMARY}`);
  try {
    shared?.close();
    await sleep(400);
  } catch {
    // already closed
  }
  process.exit(code);
}

function summaryMarkdown(
  id: BuildId,
  rows: TrialRow[],
  runs: Array<Record<string, unknown>>,
  t: { positives: number; pPass: number; pFail: number; pWarn: number; pInvalid: number; skips?: number; controls: number; controlsTripped: number; code: number },
): string {
  const cols = [...new Set(rows.map((r) => r.pass as number))].sort((a, b) => a - b);
  const order = TRIALS.map((d) => d.id).filter((id2) => rows.some((r) => r.trial === id2));
  const out: string[] = [];
  out.push(`# 158 command suite — ${STAMP}`, "");
  out.push(`- head \`${id.head}\`; dist \`${id.dist}\``);
  out.push(`- trials \`${TRIALS_FILE}\` sha256 \`${TRIALS_HASH}\``);
  out.push(`- ${t.positives} positive rows: ${t.pPass} PASS, ${t.pWarn} WARN, ${t.pFail} FAIL, ${t.pInvalid} INVALID, ${t.skips ?? 0} SKIP; controls ${t.controlsTripped}/${t.controls}; exit ${t.code}`, "");
  out.push("## Runs", "", "| pass | trials | PASS | FAIL | INVALID | WARN | elapsed |", "|---|---|---|---|---|---|---|");
  for (const r of runs) out.push(`| ${r.pass} | ${r.trials ?? rows.length} | ${r.pass_n} | ${r.fail} | ${r.invalid} | ${r.warn} | ${r.elapsed_s}s |`);
  out.push("", "## Trial × pass", "");
  out.push(`| trial | ${cols.map((c) => (c === 0 ? "control" : `pass${c}`)).join(" | ")} |`);
  out.push(`|---|${cols.map(() => "---").join("|")}|`);
  for (const trial of order) {
    const cells = cols.map((c) => {
      const r = rows.find((q) => q.trial === trial && q.pass === c);
      return r ? `${r.verdict}${r.negative ? (r.negative_tripped ? "*" : "!") : ""}` : "-";
    });
    out.push(`| ${trial} | ${cells.join(" | ")} |`);
  }
  out.push("", "`*` = control failed as expected; `!` = control passed (suite failure).", "");
  out.push("## Per-trial counters", "", "| trial | pass | verdict | ms | stall s | replans | pen | net-freeze s | before place/hp | after place/hp | why |", "|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of rows) {
    const b = (r.before ?? {}) as Record<string, unknown>;
    const a = (r.after ?? {}) as Record<string, unknown>;
    out.push(`| ${r.trial} | ${r.pass} | ${r.verdict} | ${r.ms ?? "-"} | ${r.stall_s ?? 0} | ${r.replans ?? 0} | ${((r.pen as unknown[]) ?? []).length} | ${r.net_freeze_s ?? 0} | ${b.place ?? "-"}/${b.hp ?? "-"} | ${a.place ?? "-"}/${a.hp ?? "-"} | ${r.why ?? "-"} |`);
  }
  out.push("", `Host logs: \`${LOG_DIR}/158-host-<trial>-${STAMP}.log\`. Human log: \`${LOG}\`. Rows: \`${NDJSON}\`. Trace: \`${TRACE}\`.`, "");
  return out.join("\n");
}

process.on("SIGINT", () => {
  if (shellShutdown) {
    shellShutdown("ctrl-c", 130);
    return;
  }
  killCurrentHostSync();
  process.exit(130);
});
process.on("SIGTERM", () => {
  if (shellShutdown) {
    shellShutdown("sigterm", 143);
    return;
  }
  killCurrentHostSync();
  process.exit(143);
});
process.on("exit", killCurrentHostSync);
process.on("uncaughtException", (err) => {
  record(`UNCAUGHT ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  killCurrentHostSync();
  process.exit(1);
});

await main();
