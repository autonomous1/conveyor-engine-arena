// Task 94 spike: throw grenades at wander NPCs at 5/10/20 m with a low-arc
// ballistic pitch, with and without velocity lead, then read the hp frames.
// Task 150: the approach is plan-only. `planTo` (planPath) gates the candidate;
// the walk is the product's `stand:` mission (walkToPoint -> planPath -> grid
// follower). There is no straight `wishTo` walker and no fallback: a failed plan
// rejects the candidate. A freeze (snap/processed flat for 5 s) ends the run with
// a FREEZE line instead of walking blind.
// Run: CE_TOKEN=… node --import ./scripts/ts-ext-register.mjs \
//   packages/bot-client/tests/projectile-run.ts --url ws://127.0.0.1:4173 --bands 5,10,20
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { connectBot } from "../../../packages/bot-client/src/connection.ts";
import { openNodeSocket } from "../../../packages/bot-client/src/node-socket.ts";
import { runMission } from "../../../packages/bot-client/src/brain.ts";
import { parseMission } from "../../../packages/bot-client/src/missions.ts";
import { hasLineOfSight } from "../../../src/shared/hitscan.ts";
import { EYE_HEIGHT, PITCH_LIMIT } from "../../../src/shared/look.ts";
import { GRENADE_BLAST_MIN_PERCENT, GRENADE_BLAST_RADIUS, GRENADE_GRAVITY, GRENADE_SPEED, type GrenadePose } from "../../../src/shared/grenade.ts";
import { MAX_HP } from "../../../src/shared/health.ts";
import { createNavCache } from "../../../src/shared/nav/legs.ts";
import { planPath } from "../../../src/shared/nav/path.ts";

// Task 110: the expected blast curve, re-derived from the constants rather than
// calling the host's `grenadeBlastDamage` — a stale host build must show up as
// a residual, not be hidden by the function under test.
const expectedLoss = (d: number): number => {
  if (!(d < GRENADE_BLAST_RADIUS)) return 0;
  const pct = Math.max(GRENADE_BLAST_MIN_PERCENT, Math.min(100, Math.round(100 * (1 - d / GRENADE_BLAST_RADIUS))));
  return (MAX_HP * pct) / 100;
};

const args = new Map<string, string>();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) if (argv[i]!.startsWith("--")) args.set(argv[i]!.slice(2), argv[i + 1] ?? "");
const token = (process.env.CE_TOKEN ?? "").trim() || readFileSync("/home/tim/.config/ce-arena/qa-token.pem", "utf8").trim();
const BANDS = (args.get("bands") ?? "5,10,20").split(",").map(Number).filter((n) => Number.isFinite(n) && n > 0);
const THROWS = Number(args.get("throws") ?? 4);
const RUN_MS = Number(args.get("for-s") ?? 300) * 1000;
// Task 112 trial config: C = --route place. Task 150 removed the
// `--filter`/`--fallback` flags: the approach is always plan-only.
const TRIAL = args.get("trial") ?? "control";
const ROUTE = args.get("route") ?? "point";
const SAMPLER_MS = 50;
const STAMP = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const LOG = `plan/dsh-tasks/logs/112-plan-${STAMP}.log`;
const JSON_OUT = `plan/dsh-tasks/logs/112-trace-${STAMP}.json`;

const t0 = Date.now();
const secs = (): number => Math.round((Date.now() - t0) / 100) / 10;
const lines: string[] = [];
const rows: Array<Record<string, unknown>> = [];
let noSend = 0;
// The trace/attempt state is declared before `record` because the plan-line
// parser inside `record` feeds the trace's `plan` column.
type TraceRow = { t: number; x: number; z: number; y: number; yaw: number; place: string; band: number | null; d: number | null; los: boolean; stand: string | null; plan: string; cmd: string; slide: boolean; stuck: boolean; snap: number; processed: number };
type AttemptRow = { t: number; band: number; offset: number; point: string; place: string; los: boolean; pathOk: boolean | null; pathReason: string | null; code: number | null; reason: string | null; fallback: string; slide: number; stuck: number; bandReached: number | null; timeToBand: number | null; dt: number };
const trace: TraceRow[] = [];
const attempts: AttemptRow[] = [];
let planNow = "none";
let lastNoPlan: string | null = null;
let bandNow: number | null = null;
let standNow: string | null = null;
let lastCmd = { moveX: 0, moveZ: 0, yaw: 0 };
let stopSampler: () => void = () => {};
const record = (line: string): void => {
  const row = `t=${secs().toFixed(1)}s ${line}`;
  lines.push(row);
  console.log(row);
  const trimmed = line.trim();
  if (/(plan start|plan done|no plan:|replan |start |finish )/.test(trimmed)) planNow = trimmed;
  const noPlan = /no plan: ([a-z-]+)/.exec(trimmed);
  if (noPlan) lastNoPlan = `no plan: ${noPlan[1]}`;
};
const summarize = (): Record<string, unknown> => {
  const planLines = lines.filter((l) => l.includes("plan done"));
  const steps = planLines.map((l) => Number(/steps=(\d+)/.exec(l)?.[1] ?? 0));
  const noPlan: Record<string, number> = {};
  for (const l of lines) {
    const m = /no plan: ([a-z-]+)/.exec(l);
    if (m) noPlan[m[1]!] = (noPlan[m[1]!] ?? 0) + 1;
  }
  return {
    plans: planLines.length,
    plansStepsGt1: steps.filter((n) => n > 1).length,
    noPlan,
    replanStuck: lines.filter((l) => l.includes("replan stuck")).length,
    bandMoveFailed: lines.filter((l) => l.includes("band move failed")).length,
    fallbacks: attempts.filter((a) => a.fallback === "straight").length,
    attempts: attempts.length,
    slideSeconds: Math.round((trace.filter((r) => r.slide).length * SAMPLER_MS) / 100) / 10,
    stuckSeconds: Math.round((trace.filter((r) => r.stuck).length * SAMPLER_MS) / 100) / 10,
    traceRows: trace.length,
  };
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const session = await connectBot({
  url: args.get("url") ?? "ws://localhost:4173",
  token,
  name: `bot-throw-${STAMP.slice(11, 19).replace(/:/g, "")}`,
  role: "qa",
  openSocket: openNodeSocket,
  onLog: (l) => record(`[conn] ${l}`),
});
const world = session.world;
// Task 112: capture the last input frame the brain sent (the trace `cmd`).
const rawSend = session.input.sendInput.bind(session.input);
session.input.sendInput = (cmd: { moveX: number; moveZ: number; yaw: number }) => {
  lastCmd = { moveX: cmd.moveX, moveZ: cmd.moveZ, yaw: cmd.yaw };
  rawSend(cmd);
};
const finish = (code: number): never => {
  stopSampler();
  mkdirSync("plan/dsh-tasks/logs", { recursive: true });
  const fired = rows.filter((r) => r.fired === true).length;
  const hits = rows.filter((r) => r.hit === true).length;
  const kills = rows.filter((r) => r.kill === true).length;
  const metrics = summarize();
  record(`PROJECTILE end rows=${rows.length} fired=${fired} hits=${hits} kills=${kills} attempts=${attempts.length} elapsed=${secs()}s`);
  writeFileSync(LOG, `${lines.join("\n")}\n`);
  writeFileSync(JSON_OUT, `${JSON.stringify({ trial: { name: TRIAL, route: ROUTE }, metrics, attempts, trace, throws: rows }, null, 1)}\n`);
  session.close();
  process.exit(code);
};

const started = Date.now();
while ((!world.self() || !world.sceneGraph()) && Date.now() - started < 15_000) await sleep(50);
const me0 = world.self();
if (!me0) {
  record("FATAL no owned pawn");
  finish(2);
}
const selfId = me0!.id;
const players = new Set(world.playerIds());
record(`joined self=${selfId} at ${me0!.x.toFixed(2)},${me0!.y.toFixed(2)},${me0!.z.toFixed(2)} place=${world.placeOf(me0!)?.id ?? "?"} players=[${[...players].join(",")}] others=${world.others().length}`);
record(`weapon=${world.weapon() ?? "none"} ammo=${world.ammo()} hp=${world.health()?.hp ?? "?"}`);

// --- blast snapshot (task 110) ---------------------------------------------
// Every pawn visible at the press/stop/after sample, with the host's latest
// health frame. `owner` is the thrower; `player` is a human (operator) pawn.
type PawnRow = { id: number; owner: boolean; player: boolean; hp: number | null; dead: boolean; x: number; y: number; z: number };
const snapshotPawns = (): PawnRow[] => {
  const me = world.self();
  if (!me) return [];
  const rows: PawnRow[] = [];
  const push = (p: { id: number; x: number; y: number; z: number }, owner: boolean): void => {
    const h = world.healthOf(p.id);
    rows.push({ id: p.id, owner, player: players.has(p.id), hp: h?.hp ?? null, dead: h?.dead === true, x: p.x, y: p.y, z: p.z });
  };
  push(me, true);
  for (const p of world.others()) push(p, false);
  return rows;
};
let throwNo = 0;

// --- target + velocity -----------------------------------------------------
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

// --- aim -------------------------------------------------------------------
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

// The approach is plan-only: the product's point stand (`stand:x,y,z`) plans the
// route and follows it with the grid follower. The straight `wishTo` walker that
// wedged on 2026-11-22 is removed (task 150); a candidate that does not plan is
// rejected, never walked.
const standAtPoint = async (point: { x: number; z: number }, ms: number): Promise<boolean> => {
  const mission = parseMission(`stand:${point.x.toFixed(2)},0,${point.z.toFixed(2)}`);
  if (!mission) return false;
  const code = await runMission(session, mission, {
    timeoutMs: ms,
    log: (l) => {
      if (/(plan done|no plan|replan|start )/.test(l)) record(`  stand ${l}`);
    },
    error: (l) => record(`  stand ERROR ${l}`),
  });
  return code === 0;
};
// --- trial trace + reachability probe (task 112) ---------------------------
const planCache = createNavCache();
// One 20 Hz pose/command row. `slide` is a commanded move whose observed
// displacement is >45° off the wish; `stuck` is <0.02 m per sample for >0.5 s
// with a non-zero wish. Both are proxies, computed only from the live pose.
const traceStart = (): void => {
  let prev: { x: number; z: number; t: number } | null = null;
  let stuckStart: number | null = null;
  // Task 147 freeze guard: the client sends but the snapshot stream dies, so
  // every world-derived value (pose, target, d) freezes while `t` advances. If
  // `snap` and `processed` are both unchanged for 5 s, end the run as a detected
  // freeze — never as minutes of blind stuck samples.
  let lastSnap = -1;
  let lastProc = -1;
  let lastNetChange = Date.now();
  const timer = setInterval(() => {
    const me = world.self();
    const snapNow = session.net.snapshots();
    const procNow = session.net.processedInput();
    if (snapNow !== lastSnap || procNow !== lastProc) {
      lastSnap = snapNow;
      lastProc = procNow;
      lastNetChange = Date.now();
    } else if (Date.now() - lastNetChange >= 5000) {
      record(`FREEZE stale=${((Date.now() - lastNetChange) / 1000).toFixed(0)}s snap=${snapNow} processed=${procNow} pose=${me ? `${me.x.toFixed(2)},${me.z.toFixed(2)}` : "?"} place=${me ? (world.placeOf(me)?.id ?? "?") : "?"} target=${targetId ?? "-"}`);
      finish(4);
    }
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
      slide = dot < Math.SQRT1_2; // 45°
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
      // The host's admitted input and the applied-snapshot count: a freeze shows
      // as `snap`/`processed` flat while `t` advances (task 147's signature).
      snap: session.net.snapshots(),
      processed: session.net.processedInput(),
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
// Same planPath the brain's `stand:` uses (navView + doorGate rebuilt here so
// the probe sees the same grid). The default (`--filter path`) rejects a
// candidate before the walk AND hands the walker the planned polyline, so the
// bot follows the route around a building instead of the straight line into it.
const planTo = (point: { x: number; z: number }): { ok: boolean; reason: string | null; points: readonly (readonly [number, number, number])[] } => {
  const graph = world.sceneGraph();
  const me = world.self();
  if (!graph || !me) return { ok: false, reason: "no-graph", points: [] };
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
  return plan.ok ? { ok: true, reason: null, points: plan.points } : { ok: false, reason: plan.reason, points: [] };
};
// C: the place route (`reach:<place>`) the point-only `stand:` never takes.
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
// Pick a point at `band` from the target that has line of sight to it, orbiting
// the target if the straight-away point is behind a wall. The planner walks
// there; a moved target is re-evaluated each attempt. `tried` skips offsets the
// caller has already rejected (A/B).
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
    // C: route to the candidate's place first when it differs from ours.
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
    // Plan-only (task 150): the candidate must plan or it is rejected; the walk
    // itself is the product's `stand:` mission (brain plan + grid follower).
    const probe = planTo(cand);
    const pathOk = probe.ok;
    const pathReason = probe.reason;
    if (!probe.ok) {
      record(`  ATTEMPT band=${band} point=${cand.x.toFixed(2)},${cand.z.toFixed(2)} place=${place} los=1 path=0 reason=${probe.reason}; next offset`);
      attempts.push({ t: secs(), band, offset: cand.offset, point: `${cand.x.toFixed(2)},${cand.z.toFixed(2)}`, place, los: true, pathOk, pathReason, code: null, reason: null, fallback: "none", slide: 0, stuck: 0, bandReached: null, timeToBand: null, dt: 0 });
      tried.add(cand.offset);
      continue;
    }
    const from = trace.length;
    const started = Date.now();
    bandNow = band;
    standNow = `${cand.x.toFixed(2)},${cand.z.toFixed(2)}`;
    record(`  move band=${band}: target=${targetId} d=${d.toFixed(2)} to (${cand.x.toFixed(2)},${cand.z.toFixed(2)}) los=${hasLosNow()} path=1`);
    sampleTarget();
    lastNoPlan = null;
    planNow = "plan";
    const budget = Math.min(15_000, Math.max(2000, deadline - Date.now()));
    const ok = await standAtPoint(cand, budget);
    const end = world.self();
    const endT = targetId === undefined ? undefined : poseOf(targetId);
    const fallback = "plan";
    const stats = spanStats(from);
    const endD = end && endT ? Math.hypot(endT.x - end.x, endT.z - end.z) : null;
    const reached = endD !== null && Math.abs(endD - band) <= 1.2 && hasLosNow() ? endD : null;
    const reason = lastNoPlan ? lastNoPlan.replace(/^no plan:\s*/, "") : ok ? null : "walk-failed";
    record(`  band move ${ok ? "done" : "failed"} d=${endD === null ? "?" : endD.toFixed(2)} los=${hasLosNow()} fallback=${fallback} slide=${stats.slide.toFixed(1)}s stuck=${stats.stuck.toFixed(1)}s`);
    attempts.push({ t: secs(), band, offset: cand.offset, point: `${cand.x.toFixed(2)},${cand.z.toFixed(2)}`, place, los: true, pathOk, pathReason, code: ok ? 0 : reason === "walk-failed" ? 3 : 2, reason, fallback, ...stats, bandReached: reached, timeToBand: reached === null ? null : (Date.now() - started) / 1000, dt: (Date.now() - started) / 1000 });
    if (!ok) tried.add(cand.offset);
  }
  const m = world.self();
  const t = targetId === undefined ? undefined : poseOf(targetId);
  return m && t ? Math.hypot(t.x - m.x, t.z - m.z) : Infinity;
}
traceStart();

// --- one throw ---// --- one throw -------------------------------------------------------------
// Fresh 10 Hz samples so the velocity (and the lead) is current, not from before
// the last planner walk.
async function track(ms = 700): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    sampleTarget();
    await sleep(50); // 20 Hz target sampling (task 108)
  }
}

async function throwOne(band: number, model: "flat" | "ballistic" | "ballistic+lead"): Promise<void> {
  if (targetId === undefined) return;
  // Task 110: the owner is inside its own band-5 blast. Never throw from a dead
  // pawn — wait for the respawn (up to 10 s), else close and report.
  const respawnBy = Date.now() + 10_000;
  for (;;) {
    const me = world.self();
    const hp = me ? world.healthOf(me.id) : undefined;
    if (me && hp?.dead !== true && (hp?.hp ?? 1) > 0) break;
    if (Date.now() >= respawnBy) {
      record("DEAD no respawn within 10 s; closing");
      finish(3);
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
  // Line-of-sight gate: never fire through geometry. Re-position (planner) and
  // re-aim up to twice; if still blocked, record a no-fire and do not throw.
  let losOk = hasLineOfSight(eyeNow() ?? { x: 0, y: 0, z: 0 }, aim.pred, world.aabbs);
  for (let attempt = 0; !losOk && attempt < 2; attempt += 1) {
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
    if (targetId !== undefined) { badTargets.set(targetId, Date.now() + 20_000); targetId = undefined; }
    return;
  }
  // Face the target at the throw yaw first (the operator watches the body), then
  // re-aim from the settled pose — the throw frame carries its own yaw.
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
  // Final synchronous check at the exact aim point, then fire in the same tick.
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
    if (noSend >= 2) finish(3);
    return;
  }
  // Telemetry (task 101): `world.landed()` holds the stop poses (newest last,
  // cap 16); a stop with no `n` is a pawn hit, `n=±y` ground, `n=±x/±z` a prop.
  // `world.grenades()` gives the latest in-flight pose per id (update counter).
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
  // --- blast measurement (task 110) ---------------------------------------
  // Every pawn at the press, by its 3-D feet distance from the stop point. The
  // stop point is the detonation; d uses the pose sampled when the stop frame
  // arrived, hp0/hp1 the health frames at the press and the 1600 ms read.
  const stopPos = stop ? { x: stop.x, y: stop.y, z: stop.z } : null;
  const atStopById = new Map((atStop ?? []).map((r) => [r.id, r] as const));
  const afterById = new Map((after ?? []).map((r) => [r.id, r] as const));
  type BlastRow = PawnRow & { hp1: number | null; d: number | null; loss: number | null; exp: number | null; res: number | null; match: boolean | null; exact: boolean | null; missing: boolean; inR: boolean; beyondWounded: boolean; wounded: boolean };
  const blastRows: BlastRow[] = [];
  for (const b of before) {
    const q = atStopById.get(b.id);
    if (!q || !stopPos) continue; // not visible at the stop: no distance to measure
    const d = Math.hypot(stopPos.x - q.x, stopPos.y - q.y, stopPos.z - q.z);
    const a = afterById.get(b.id);
    // A killed pawn despawns from `others()`; its hp 0 frame still exists.
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

// --- run -------------------------------------------------------------------
try {
  const end = t0 + RUN_MS;
  const controlBand = BANDS[BANDS.length - 1] ?? 20;
  for (let i = 0; i < 2 && Date.now() < end; i += 1) {
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
        if (targetId === undefined) targetId = selectTarget();
        if (targetId === undefined) {
          record(`no target for band ${band}; skipping`);
          await sleep(500);
          break;
        }
        const d = await reachBand(band, Math.min(end, Date.now() + 20_000));
        record(`positioned band=${band} d=${d.toFixed(2)} target=${targetId}`);
        if (!(Math.abs(d - band) <= 1.2 && hasLosNow())) {
          record(`NO-FIRE band=${band} model=${model}: approach did not reach the band (d=${d.toFixed(2)})`);
          await sleep(300);
          continue;
        }
        await throwOne(band, model);
        sampleTarget();
        await sleep(1100);
      }
    }
  }
} catch (err) {
  record(`ERROR ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
}
finish(0);
