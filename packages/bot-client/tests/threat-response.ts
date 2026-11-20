// Threat-response driver (tasks 114/118): throw one grenade into a >=2-NPC cluster (114)
// or a pawn-only throw at >=20 m (118), then on the stop/first hit either do
// nothing (control) or start a LOS-breaking cover move (cover). Rough probe.
// Run: CE_TOKEN=… node --import ./scripts/ts-ext-register.mjs \
//   packages/bot-client/tests/threat-response.ts --url ws://127.0.0.1:4173 \
//   --modes cover --stand 23.49,20.02 --band 20 --for-s 300
// One grenade per trial; `--for-s <seconds>` repeats the throw+cover cycle.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { connectBot } from "../src/connection.ts";
import { openNodeSocket } from "../src/node-socket.ts";
import { runAttack, runMission } from "../src/brain.ts";
import { parseMission } from "../src/missions.ts";
import { hasLineOfSight } from "../../../src/shared/hitscan.ts";
import { EYE_HEIGHT, PITCH_LIMIT } from "../../../src/shared/look.ts";
import { GRENADE_GRAVITY, GRENADE_SPEED, type GrenadePose } from "../../../src/shared/grenade.ts";
import { wishTo } from "../../../src/shared/nav/follow.ts";
import { createNavCache } from "../../../src/shared/nav/legs.ts";
import { planPath } from "../../../src/shared/nav/path.ts";

const args = new Map<string, string>();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) if (argv[i]!.startsWith("--")) args.set(argv[i]!.slice(2), argv[i + 1] ?? "");
const token = (process.env.CE_TOKEN ?? "").trim() || readFileSync(`${homedir()}/.config/ce-arena/qa-token.pem`, "utf8").trim();
const MODES = (args.get("modes") ?? "control,attack,cover").split(",").map((m) => m.trim()).filter(Boolean);
const MAX_TRIALS = Math.max(1, Number(args.get("trials") ?? 3));
const STAMP = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const LOG = `plan/dsh-tasks/logs/118b-cover-${STAMP}.log`;
const JSON_OUT = `plan/dsh-tasks/logs/118b-cover-${STAMP}.json`;
const REPEAT_MS = Number(args.get("for-s") ?? 0) * 1000; // >0 = keep throwing for this long
const MAX_TRIALS_REPEAT = Number(args.get("max-trials") ?? 60);
const BAND = Number(args.get("band") ?? 20); // stand distance from the frozen aim pawn (task 118 v2: >=20 m)
const BAND_MAX = Number(args.get("band-max") ?? 28); // upper acceptance: v2's 24 is tight; the operator wants >=20
const CONTROL_BAND = Number(args.get("control-band") ?? 0); // fresh 13 m control (0 = use the 114 baseline)
const THREAT_RANGE = Number(args.get("threat") ?? 30); // cover LOS is tested to every visible NPC this close
// v2: the operator's building-corner stand. The probe walks there; the cover
// point is pre-checked from it before the throw.
// v2b: a plain stand point. The operator's "crate location" is just the
// coordinates `23.49,20.02`; `stand:`/`planPath` snaps to the nearest free cell.
// No crate/pickup resolution, no adjacency offset.
const standArg = (args.get("stand") ?? "23.49,20.02").trim();
const STAND = (() => {
  const [x, z] = standArg.split(",").map(Number);
  return Number.isFinite(x) && Number.isFinite(z) && x !== undefined && z !== undefined ? { x, z } : undefined;
})();
let STAND_POINT: { x: number; z: number } | undefined;

const t0 = Date.now();
const secs = (): number => Math.round((Date.now() - t0) / 100) / 10;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const lines: string[] = [];
const record = (line: string): void => {
  const row = `t=${secs().toFixed(1)}s ${line}`;
  lines.push(row);
  console.log(row);
};

const session = await connectBot({
  url: args.get("url") ?? "ws://localhost:4173",
  token,
  name: `bot-threat-${STAMP.slice(11, 19).replace(/:/g, "")}`,
  role: "qa",
  openSocket: openNodeSocket,
  onLog: (l) => record(`[conn] ${l}`),
});
const world = session.world;
const started = Date.now();
while ((!world.self() || !world.sceneGraph()) && Date.now() - started < 15_000) await sleep(50);
const me0 = world.self();
if (!me0) {
  record("FATAL no owned pawn");
  session.close();
  process.exit(2);
}
const selfId = me0!.id;
const players = new Set(world.playerIds());
const SPAWN = { x: me0!.x, z: me0!.z };

// --- arm-up (operator-directed: the attack-run.ts plan) --------------------
// East approach → climb to the alien weapon, then the nearest outside ammo
// crate via `retrieve:<id>@outside`. Copied rough from attack-run.ts.
const armed = (): boolean => (world.weapon() ?? "") !== "" && world.ammo() > 0;
// Copied from attack-run.ts: straight wishTo with a stuck sidestep. The
// planner `stand:` arm-up churned (replan stuck/safety) and failed; this is the
// path attack-run uses to collect the weapon without glitches.
const walkRecover = async (target: { x: number; z: number }, ms: number, label: string): Promise<boolean> => {
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

const armUp = async (): Promise<boolean> => {
  if (![...world.pickups()].includes("alien-weapon-1")) {
    record("arm-up: alien-weapon-1 is not on the map");
    return false;
  }
  record("arm-up: east approach");
  await walkRecover({ x: -13.9, z: 16.5 }, 60_000, "east");
  record("arm-up: climb");
  const climbed = await walkRecover({ x: -23.9, z: 16.5 }, 60_000, "climb");
  record(`arm-up climb=${climbed} weapon=${world.weapon() ?? "none"} ammo=${world.ammo()}`);
  const me = world.self();
  if (me && me.y > 0.6) await walkRecover({ x: -14.0, z: 16.5 }, 30_000, "step-off");
  return armed();
};
const reload = async (): Promise<boolean> => {
  const avail = new Set(world.pickups());
  const crates = (world.pickupPlacements() as Array<{ id: string; kind?: string; minX: number; maxX: number; minZ: number; maxZ: number; minY?: number; maxY?: number }>)
    .filter((p) => p.kind === "ammo" && avail.has(p.id) && (world.placeOf({ x: (p.minX + p.maxX) / 2, y: (p.minY ?? 0) + 0.2, z: (p.minZ + p.maxZ) / 2 })?.id ?? "") === "outside")
    .map((p) => ({ id: p.id, d: Math.hypot((p.minX + p.maxX) / 2 - SPAWN.x, (p.minZ + p.maxZ) / 2 - SPAWN.z) }))
    .sort((a, b) => a.d - b.d);
  const crate = crates[0];
  record(`reload: candidates ${crates.slice(0, 4).map((c) => `${c.id}(${c.d.toFixed(0)}m)`).join(" ") || "none"}`);
  if (!crate) return false;
  const mission = parseMission(`retrieve:${crate.id}@outside`);
  const code = mission ? await runMission(session, mission, { timeoutMs: 90_000, log: (l) => record(`  ammo ${l}`), error: (l) => record(`  ammo ERROR ${l}`) }) : 1;
  record(`reload code=${code} ammo=${world.ammo()}`);
  return world.ammo() > 0;
};
const ensureWeapon = async (): Promise<boolean> => {
  if ((world.weapon() ?? "") !== "") return true;
  record("ensure-weapon: no weapon; arm-up");
  await armUp();
  record(`ensure-weapon: weapon=${world.weapon() ?? "none"} ammo=${world.ammo()}`);
  return (world.weapon() ?? "") !== "";
};
const ensureArmed = async (): Promise<boolean> => {
  if (armed()) return true;
  if ((world.weapon() ?? "") === "") {
    record("ensure-armed: no weapon; arm-up");
    await armUp();
  }
  if ((world.weapon() ?? "") !== "" && world.ammo() <= 0) {
    record("ensure-armed: no ammo; reload");
    await reload();
  }
  record(`ensure-armed: weapon=${world.weapon() ?? "none"} ammo=${world.ammo()}`);
  return armed();
};
// 118: a reused/stale pawn can join at low hp (the 19:10 run started at 3 hp);
// heal to >=70 from an outside health crate before the trials.
const healUp = async (): Promise<number> => {
  let hp = world.health()?.hp ?? 100;
  for (let attempt = 0; attempt < 2 && hp < 70; attempt += 1) {
    const avail = new Set(world.pickups());
    const crates = (world.pickupPlacements() as Array<{ id: string; kind?: string; minX: number; maxX: number; minZ: number; maxZ: number; minY?: number; maxY?: number }>)
      .filter((p) => p.kind === "health" && avail.has(p.id) && (world.placeOf({ x: (p.minX + p.maxX) / 2, y: (p.minY ?? 0) + 0.2, z: (p.minZ + p.maxZ) / 2 })?.id ?? "") === "outside")
      .map((p) => ({ id: p.id, d: Math.hypot((p.minX + p.maxX) / 2 - SPAWN.x, (p.minZ + p.maxZ) / 2 - SPAWN.z) }))
      .sort((a, b) => a.d - b.d);
    const crate = crates[0];
    record(`heal: hp=${hp} candidates=${crates.slice(0, 3).map((c) => `${c.id}(${c.d.toFixed(0)}m)`).join(" ") || "none"}`);
    if (!crate) break;
    const mission = parseMission(`retrieve:${crate.id}@outside`);
    if (!mission) break;
    const code = await runMission(session, mission, { timeoutMs: 60_000, log: (l) => record(`  heal ${l}`), error: (l) => record(`  heal ERROR ${l}`) });
    record(`heal code=${code} hp=${world.health()?.hp ?? "?"}`);
    hp = world.health()?.hp ?? hp;
  }
  return hp;
};

// --- trace / trial state ---------------------------------------------------
type NpcRow = { id: number; d: number; los: boolean; hp: number | null; x: number; y: number; z: number };
type TraceRow = { t: number; mode: string; trial: number; hp: number | null; x: number; y: number; z: number; place: string; weapon: string | null; ammo: number; npcs: NpcRow[]; trigger: boolean; response: string | null; latency: number | null };
type TrialRow = { t: number; mode: string; attackers: number; weapon: string | null; ammo: number; hp0: number | null; hp3: number | null; hp5: number | null; hp8: number | null; kills: number; died: boolean; latency: number | null; cover: string | null; d: number | null; surface: string | null; outcome: string };
const trace: TraceRow[] = [];
const trials: TrialRow[] = [];
let trialNo = 0;
let modeNow = "idle";
let triggerAt: number | null = null;
let responseNow: string | null = null;
let latencyNow: number | null = null;
let responseStart: number | null = null;
let firstMoveAt: number | null = null;

const rawSend = session.input.sendInput.bind(session.input);
session.input.sendInput = (cmd: { moveX: number; moveZ: number; yaw: number }) => {
  if ((Math.abs(cmd.moveX) > 0.01 || Math.abs(cmd.moveZ) > 0.01) && responseStart !== null && firstMoveAt === null) firstMoveAt = Date.now();
  rawSend(cmd);
};

const isNpc = (id: number): boolean => !players.has(id) && id !== selfId && world.healthOf(id)?.dead !== true;
const eyeNow = () => {
  const me = world.self();
  return me ? { x: me.x, y: me.y + EYE_HEIGHT, z: me.z } : undefined;
};
const visibleAttackers = (): NpcRow[] => {
  const me = world.self();
  const eye = eyeNow();
  if (!me || !eye) return [];
  const rows: NpcRow[] = [];
  for (const p of world.others()) {
    if (!isNpc(p.id)) continue;
    const d = Math.hypot(p.x - me.x, p.z - me.z);
    if (d > THREAT_RANGE) continue;
    rows.push({ id: p.id, d: Math.round(d * 100) / 100, los: hasLineOfSight(eye, { x: p.x, y: p.y + 1, z: p.z }, world.aabbs), hp: world.healthOf(p.id)?.hp ?? null, x: p.x, y: p.y, z: p.z });
  }
  return rows.sort((a, b) => a.d - b.d);
};

const sampler = setInterval(() => {
  const me = world.self();
  if (!me) return;
  trace.push({
    t: secs(),
    mode: modeNow,
    trial: trialNo,
    hp: world.health()?.hp ?? null,
    x: me.x,
    y: me.y,
    z: me.z,
    place: world.placeOf(me)?.id ?? "?",
    weapon: world.weapon() ?? null,
    ammo: world.ammo(),
    npcs: visibleAttackers(),
    trigger: triggerAt !== null,
    response: responseNow,
    latency: latencyNow,
  });
}, 50);

// --- aim (the 110 throw) ---------------------------------------------------
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
const aimAtPoint = (point: { x: number; y: number; z: number }): { yaw: number; pitch: number; d: number; pred: { x: number; y: number; z: number } } | undefined => {
  const me = world.self();
  if (!me) return undefined;
  const eye = { x: me.x, y: me.y + EYE_HEIGHT, z: me.z };
  const dx = point.x - eye.x;
  const dz = point.z - eye.z;
  const d = Math.hypot(dx, dz);
  const sol = solvePitch(d, point.y - eye.y);
  if (!sol) return undefined;
  return { yaw: Math.atan2(dx, dz), pitch: sol.pitch, d, pred: point };
};
// 118: a 20 m flight is ~0.85 s — a 1.6 m/s NPC moves ~1.4 m; the static aim
// overshoots. Track the pawn for ~400 ms and solve against the lead point.
const pawnHistory = new Map<number, Array<{ t: number; x: number; z: number }>>();
const samplePawn = (id: number): void => {
  const p = world.others().find((row) => row.id === id);
  if (!p) return;
  const list = pawnHistory.get(id) ?? [];
  list.push({ t: Date.now(), x: p.x, z: p.z });
  while (list.length > 20) list.shift();
  pawnHistory.set(id, list);
};
const pawnVelocity = (id: number): { x: number; z: number } => {
  const list = pawnHistory.get(id) ?? [];
  if (list.length < 2) return { x: 0, z: 0 };
  const last = list[list.length - 1]!;
  let first = list[0]!;
  for (let i = list.length - 2; i >= 0; i -= 1) {
    if (last.t - list[i]!.t <= 400) first = list[i]!;
    else break;
  }
  const dt = (last.t - first.t) / 1000;
  if (!(dt > 0.1)) return { x: 0, z: 0 };
  return { x: (last.x - first.x) / dt, z: (last.z - first.z) / dt };
};
const aimAtPawn = (id: number): { yaw: number; pitch: number; d: number; pred: { x: number; y: number; z: number } } | undefined => {
  const me = world.self();
  const tgt = world.others().find((row) => row.id === id);
  if (!me || !tgt) return undefined;
  const eye = { x: me.x, y: me.y + EYE_HEIGHT, z: me.z };
  const vt = pawnVelocity(id);
  let pred = { x: tgt.x, y: tgt.y + 1, z: tgt.z };
  let sol: { pitch: number; tFlight: number } | undefined;
  for (let i = 0; i < 3; i += 1) {
    const dx = pred.x - eye.x;
    const dz = pred.z - eye.z;
    sol = solvePitch(Math.hypot(dx, dz), pred.y - eye.y);
    if (!sol) return undefined;
    pred = { x: tgt.x + vt.x * sol.tFlight, y: tgt.y + 1, z: tgt.z + vt.z * sol.tFlight };
  }
  const dx = pred.x - eye.x;
  const dz = pred.z - eye.z;
  const d = Math.hypot(dx, dz);
  if (!sol) return undefined;
  return { yaw: Math.atan2(dx, dz), pitch: sol.pitch, d, pred };
};

// --- cluster / stand / cover ----------------------------------------------
type Point = { x: number; y: number; z: number };
const findCluster = (ref?: { x: number; z: number }): { a: { id: number; x: number; y: number; z: number }; b: { id: number; x: number; y: number; z: number }; mid: Point } | undefined => {
  const npcs = world.others().filter((p) => isNpc(p.id) && (world.placeOf(p)?.id ?? "") === "outside");
  const origin = ref ?? (world.self() ? { x: world.self()!.x, z: world.self()!.z } : { x: 0, z: 0 });
  // v2b: rank by the pair's nearer member to `ref` (the crate stand), not the
  // bot's arm position; the v2 run picked a pair 49.6 m from the stand.
  const score = (a: { x: number; z: number }, b: { x: number; z: number }): number =>
    Math.min(Math.hypot(a.x - origin.x, a.z - origin.z), Math.hypot(b.x - origin.x, b.z - origin.z));
  let best: { a: (typeof npcs)[number]; b: (typeof npcs)[number] } | undefined;
  let bestD = Infinity;
  for (let i = 0; i < npcs.length; i += 1) {
    for (let j = i + 1; j < npcs.length; j += 1) {
      const a = npcs[i]!;
      const b = npcs[j]!;
      const d = Math.hypot(a.x - b.x, a.z - b.z);
      const s = score(a, b);
      if (d >= 6 || s >= bestD) continue;
      best = { a, b };
      bestD = s;
    }
  }
  if (!best) return undefined;
  return { a: best.a, b: best.b, mid: { x: (best.a.x + best.b.x) / 2, y: (best.a.y + best.b.y) / 2, z: (best.a.z + best.b.z) / 2 } };
};
const pickStand = (target: { x: number; y: number; z: number }, band = BAND): Point | undefined => {
  const me = world.self();
  if (!me) return undefined;
  const base = Math.atan2(me.x - target.x, me.z - target.z);
  for (const off of [0, 20, -20, 40, -40, 60, -60, 90, -90, 120, -120, 150, -150, 180]) {
    const angle = base + (off * Math.PI) / 180;
    const x = target.x + Math.sin(angle) * band;
    const z = target.z + Math.cos(angle) * band;
    const place = world.placeOf({ x, y: 0, z });
    if (!place || place.id !== "outside") continue;
    const eye = { x, y: EYE_HEIGHT, z };
    if (!hasLineOfSight(eye, { x: target.x, y: target.y + 1, z: target.z }, world.aabbs)) continue;
    return { x, y: 0, z };
  }
  return undefined;
};
const findCover = (attackers: NpcRow[], radii: readonly number[] = [3, 5, 8, 11]): Point | undefined => {
  const me = world.self();
  if (!me) return undefined;
  for (const r of radii) {
    for (let deg = 0; deg < 360; deg += 30) {
      const angle = (deg * Math.PI) / 180;
      const x = me.x + Math.sin(angle) * r;
      const z = me.z + Math.cos(angle) * r;
      const place = world.placeOf({ x, y: 0, z });
      if (!place || place.id !== "outside") continue;
      const eye = { x, y: EYE_HEIGHT, z };
      if (attackers.some((a) => hasLineOfSight(eye, { x: a.x, y: a.y + 1, z: a.z }, world.aabbs))) continue;
      return { x, y: 0, z };
    }
  }
  return undefined;
};
const walkTo = async (point: Point, timeoutMs: number, label: string): Promise<number> => {
  const mission = parseMission(`stand:${point.x.toFixed(2)},0,${point.z.toFixed(2)}`);
  if (!mission) return 1;
  return runMission(session, mission, {
    timeoutMs,
    log: (l) => record(`  ${label} ${l}`),
    error: (l) => record(`  ${label} ERROR ${l}`),
  });
};
// v2: pre-check the cover point with the same planPath the brain's `stand:`
// uses, without moving. A no-plan here is the 112 dependency.
const planCache = createNavCache();
const probePath = (point: { x: number; z: number }): { ok: boolean; reason: string | null; end?: { x: number; z: number } } => {
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
  if (!plan.ok) return { ok: false, reason: plan.reason };
  const last = plan.points[plan.points.length - 1];
  return { ok: true, reason: null, end: last ? { x: last[0], z: last[2] } : point };
};
// v2c: the requested stand can be inside a prop (the crate). `stand:` then
// never reports arrival; walk it with the planner, then drive the last metre
// straight and accept the closest reachable point within ~1.6 m.
// 118b: the crate stand is fixed; wait for a pair to wander into the band
// instead of failing the trial at the moment of arrival.
type PairHit = { c: NonNullable<ReturnType<typeof findCluster>>; p: { id: number; x: number; y: number; z: number }; d: number };
const waitPair = async (ref: { x: number; z: number }, min: number, max: number, ms: number): Promise<PairHit | undefined> => {
  const until = Date.now() + ms;
  for (;;) {
    const c = findCluster(ref);
    if (c) {
      const p = nearerTo(c, ref);
      const d = Math.hypot(p.x - ref.x, p.z - ref.z);
      const eye = eyeNow();
      const los = eye ? hasLineOfSight(eye, { x: p.x, y: p.y + 1, z: p.z }, world.aabbs) : false;
      if (d >= min && d <= max && los) return { c, p, d };
    }
    if (Date.now() >= until) return undefined;
    await sleep(500);
  }
};
const walkToStand = async (point: Point, label: string): Promise<{ ok: boolean; d: number; how: string }> => {
  const code = await walkTo(point, 8_000, label);
  if (code === 0) return { ok: true, d: 0, how: "plan" };
  let last = { x: Number.NaN, z: Number.NaN };
  let lastMove = Date.now();
  const until = Date.now() + 3_500;
  while (Date.now() < until) {
    const me = world.self();
    if (!me) break;
    const d = Math.hypot(me.x - point.x, me.z - point.z);
    if (d <= 1.6) return { ok: true, d, how: "straight" };
    if (Number.isFinite(last.x) && Math.hypot(me.x - last.x, me.z - last.z) > 0.05) lastMove = Date.now();
    last = { x: me.x, z: me.z };
    if (Date.now() - lastMove > 900) return { ok: d <= 1.8, d, how: "wedged" };
    session.input.sendInput(wishTo({ x: me.x, y: me.y, z: me.z, vx: 0, vz: 0, yaw: me.yaw }, { x: point.x, z: point.z }, 1));
    await sleep(80);
  }
  const me = world.self();
  const d = me ? Math.hypot(me.x - point.x, me.z - point.z) : Infinity;
  return { ok: d <= 1.8, d, how: "timeout" };
};
const aliveOk = (): boolean => {
  const me = world.self();
  const h = me ? world.healthOf(me.id) : undefined;
  return me !== undefined && h?.dead !== true && (h?.hp ?? 1) > 0;
};

// --- one trial (task 118: pawn-only stop at the band, then cover-first) -----
const STOP_WAIT_MS = 6_000;
type StopInfo = { pose: GrenadePose; at: number; surface: string; d: number };
const stopSurface = (g: GrenadePose): string => (!g.n ? "pawn" : g.n[1] !== 0 ? "ground" : "prop");
const nearerPawn = (c: NonNullable<ReturnType<typeof findCluster>>): { id: number; x: number; y: number; z: number } => {
  const me = world.self();
  if (!me) return c.a;
  return Math.hypot(c.a.x - me.x, c.a.z - me.z) <= Math.hypot(c.b.x - me.x, c.b.z - me.z) ? c.a : c.b;
};
const nearerTo = (c: NonNullable<ReturnType<typeof findCluster>>, ref: { x: number; z: number }): { id: number; x: number; y: number; z: number } =>
  Math.hypot(c.a.x - ref.x, c.a.z - ref.z) <= Math.hypot(c.b.x - ref.x, c.b.z - ref.z) ? c.a : c.b;
const hpAt = (): number | null => world.health()?.hp ?? null;
const rowNow = (mode: string, extra: Partial<TrialRow>): TrialRow => ({
  t: secs(),
  mode,
  attackers: 0,
  weapon: world.weapon() ?? null,
  ammo: world.ammo(),
  hp0: null,
  hp3: null,
  hp5: null,
  hp8: null,
  kills: 0,
  died: false,
  latency: null,
  cover: null,
  d: null,
  surface: null,
  outcome: "unknown",
  ...extra,
});

async function runTrial(modeName: string): Promise<void> {
  trialNo += 1;
  modeNow = modeName;
  triggerAt = null;
  responseNow = null;
  latencyNow = null;
  responseStart = null;
  firstMoveAt = null;
  const noRun = (outcome: string, extra: Partial<TrialRow> = {}): void => {
    const row = rowNow(modeName, { outcome, ...extra });
    trials.push(row);
    record(`TRIAL mode=${modeName} attackers=- d=${row.d === null ? "-" : row.d.toFixed(2)} surface=${row.surface ?? "-"} hp0=- hp3=- hp5=- hp8=- kills=0 died=0 latency=- outcome=${outcome}`);
  };
  for (let i = 0; i < 50 && !aliveOk(); i += 1) await sleep(200);
  if (!aliveOk()) {
    noRun("no-run-dead", { died: true });
    return;
  }
  record(`ARM weapon=${world.weapon() ?? "none"} ammo=${world.ammo()} hp=${hpAt() ?? "?"}`);
  const controlBand = modeName === "control" && CONTROL_BAND > 0;
  let stand: Point;
  let aimPawn: { id: number; x: number; y: number; z: number };
  if (STAND_POINT && !controlBand) {
    // 118b: walk to the coordinates first, then pick the pair at the stand.
    stand = { x: STAND_POINT.x, y: 0, z: STAND_POINT.z };
    const reached = await walkToStand(stand, `stand${trialNo}`);
    record(`STAND-REACH point=${stand.x.toFixed(2)},${stand.z.toFixed(2)} d=${reached.d.toFixed(2)} how=${reached.how} ok=${reached.ok ? 1 : 0}`);
    if (!reached.ok) {
      noRun(`no-run-stand-${reached.how}-${reached.d.toFixed(1)}`);
      return;
    }
    const pair = await waitPair(stand, 20, BAND_MAX, 25_000);
    if (!pair) {
      noRun(`no-run-band wait`);
      return;
    }
    aimPawn = pair.p;
    record(`PAIR pair=${pair.c.a.id},${pair.c.b.id} aimPawn=${aimPawn.id} stand=${stand.x.toFixed(2)},${stand.z.toFixed(2)} d=${pair.d.toFixed(2)} band=20-${BAND_MAX}`);
  } else {
    const cluster = findCluster();
    if (!cluster) {
      noRun("no-run-no-cluster");
      return;
    }
    aimPawn = nearerPawn(cluster);
    const standPick = pickStand(aimPawn, controlBand ? CONTROL_BAND : BAND);
    if (!standPick) {
      noRun("no-run-no-stand");
      return;
    }
    stand = standPick;
    const reached = await walkToStand(stand, `stand${trialNo}`);
    record(`STAND-REACH point=${stand.x.toFixed(2)},${stand.z.toFixed(2)} d=${reached.d.toFixed(2)} how=${reached.how} ok=${reached.ok ? 1 : 0}`);
    if (!reached.ok) {
      noRun(`no-run-stand-${reached.how}-${reached.d.toFixed(1)}`);
      return;
    }
    const meW = world.self();
    const d = meW ? Math.hypot(aimPawn.x - meW.x, aimPawn.z - meW.z) : Infinity;
    if (!(controlBand ? Math.abs(d - CONTROL_BAND) <= 1.5 : d >= 20 && d <= BAND_MAX)) {
      noRun(`no-run-band d=${d.toFixed(2)}`);
      return;
    }
    record(`PAIR pair=${cluster.a.id},${cluster.b.id} aimPawn=${aimPawn.id} stand=${stand.x.toFixed(2)},${stand.z.toFixed(2)} d=${d.toFixed(2)} band=${controlBand ? CONTROL_BAND : `${BAND}-${BAND_MAX}`}`);
  }
  // Cover pre-check (cover only): a blocked point within 3 m, walkable with the
  // same planPath the brain's `stand:` uses. A no-plan here is the 112 dependency.
  let coverPre: Point | undefined;
  let coverPreLos = "visible";
  let coverPreCode: number | null = null;
  let coverPreReason: string | null = null;
  if (modeName === "cover") {
    const threatsPre = visibleAttackers();
    coverPre = findCover(threatsPre, [3]);
    if (coverPre) {
      const eyePre = { x: coverPre.x, y: EYE_HEIGHT, z: coverPre.z };
      coverPreLos = threatsPre.every((a) => !hasLineOfSight(eyePre, { x: a.x, y: a.y + 1, z: a.z }, world.aabbs)) ? "blocked" : "visible";
      const probe = probePath(coverPre);
      coverPreCode = probe.ok ? 0 : 2;
      coverPreReason = probe.reason;
    }
  }
  const meNow = world.self();
  const dNow = meNow ? Math.hypot(aimPawn.x - meNow.x, aimPawn.z - meNow.z) : Infinity;
  record(`SITE stand=${stand.x.toFixed(2)},${stand.z.toFixed(2)} aimPawn=${aimPawn.id} d=${dNow.toFixed(2)} coverPre=${coverPre ? `${coverPre.x.toFixed(2)},${coverPre.z.toFixed(2)}` : "none"} coverPreLos=${coverPreLos} coverPreCode=${coverPreCode ?? "-"}${coverPreReason ? ` reason=${coverPreReason}` : ""}`);
  if (modeName === "cover" && (!coverPre || coverPreCode !== 0)) {
    noRun(`no-run-no-cover${coverPreReason ? `-${coverPreReason}` : ""}`);
    return;
  }
  let stopInfo: StopInfo | undefined;
  for (let attempt = 0; attempt < 2 && !stopInfo; attempt += 1) {
    const me = world.self();
    if (!me) {
      noRun("no-run-self-lost");
      return;
    }
    for (let i = 0; i < 8; i += 1) {
      samplePawn(aimPawn.id);
      await sleep(50);
    }
    const aim = aimAtPawn(aimPawn.id);
    if (!aim) {
      noRun("no-run-no-aim");
      return;
    }
    const eye = eyeNow();
    if (eye && !hasLineOfSight(eye, aim.pred, world.aabbs)) {
      noRun("no-run-no-los");
      return;
    }
    const before = new Set(world.landed().map((g) => g.id));
    const sent = session.input.grenade(aim.yaw, aim.pitch);
    record(`THROW t=${secs()} target=${aimPawn.id} d=${aim.d.toFixed(2)} aim=(${aim.yaw.toFixed(2)},${aim.pitch.toFixed(2)}) sent=${sent} hp0=${hpAt() ?? "?"}`);
    if (!sent) {
      noRun("no-run-no-send");
      return;
    }
    const thrownAt = Date.now();
    let pose: GrenadePose | undefined;
    while (Date.now() - thrownAt < STOP_WAIT_MS) {
      if (!world.self()) break;
      const fresh = world.landed().find((g) => !before.has(g.id));
      if (fresh) {
        pose = fresh;
        break;
      }
      await sleep(50);
    }
    if (!pose) {
      record(`STOP t=${secs()} none`);
      continue;
    }
    const surface = stopSurface(pose);
    const me2 = world.self();
    const d = me2 ? Math.hypot(pose.x - me2.x, pose.y - me2.y, pose.z - me2.z) : 0;
    record(`STOP t=${secs()} at=${pose.x.toFixed(2)},${pose.y.toFixed(2)},${pose.z.toFixed(2)} surface=${surface} d=${d.toFixed(2)}`);
    if (surface !== "pawn" && attempt === 0) {
      record(`STOP skip surface=${surface}; retry the throw once`);
      continue;
    }
    if (surface !== "pawn") {
      noRun(`no-run-surface-${surface}`, { surface, d });
      return;
    }
    stopInfo = { pose, at: Date.now(), surface, d };
  }
  if (!stopInfo) {
    noRun("no-run-no-stop");
    return;
  }
  const stopAt = stopInfo.at;
  const hp0 = hpAt();
  const attackers = visibleAttackers();
  const eye = eyeNow();
  const losBefore = eye ? attackers.every((a) => !hasLineOfSight(eye, { x: a.x, y: a.y + 1, z: a.z }, world.aabbs)) : false;
  triggerAt = stopAt;
  responseStart = stopAt;
  let hp3: number | null = null;
  let hp5: number | null = null;
  let hp8: number | null = null;
  let firstHitAt: number | null = null;
  let coverPoint: Point | undefined;
  let walkCode: number | null = null;
  let walkHow = "none";
  let walkPromise: Promise<number> | undefined;
  if (modeName === "cover") {
    // Keep the pre-checked point when the fresh pick is not walkable; the
    // at-stop findCover otherwise re-picks a point `planPath` rejects.
    let candidate = findCover(attackers, [3]);
    if (candidate && !probePath(candidate).ok) candidate = coverPre;
    coverPoint = candidate ?? coverPre;
    if (coverPoint) {
      responseNow = `cover:${coverPoint.x.toFixed(2)},${coverPoint.z.toFixed(2)}`;
      walkPromise = walkToStand(coverPoint, `cover${trialNo}`).then((r) => {
        walkHow = r.how;
        walkCode = r.ok ? 0 : 3;
        return walkCode;
      });
    } else {
      responseNow = "cover:none";
    }
  }
  while (Date.now() - stopAt < 8000) {
    const hp = hpAt();
    if (hp !== null && hp0 !== null && hp < hp0 && firstHitAt === null) firstHitAt = Date.now();
    if (hp3 === null && Date.now() - stopAt >= 3000) hp3 = hp;
    if (hp5 === null && Date.now() - stopAt >= 5000) hp5 = hp;
    await sleep(50);
  }
  hp8 = hpAt();
  if (walkPromise) walkCode = await walkPromise;
  const died = world.health()?.dead === true;
  const eye2 = eyeNow();
  const losAfter = eye2 ? attackers.every((a) => !hasLineOfSight(eye2, { x: a.x, y: a.y + 1, z: a.z }, world.aabbs)) : false;
  latencyNow = firstMoveAt !== null ? (firstMoveAt - stopAt) / 1000 : null;
  record(`TRIGGER t=${secs()} stopT=${((stopAt - t0) / 1000).toFixed(1)} firstHitT=${firstHitAt === null ? "-" : ((firstHitAt - t0) / 1000).toFixed(1)} hp=${hp0 ?? "?"} threats=[${attackers.map((a) => a.id).join(",")}]`);
  record(`RESPONSE t=${secs()} mode=${modeName === "cover" ? "cover" : "none"} point=${coverPoint ? `${coverPoint.x.toFixed(2)},${coverPoint.z.toFixed(2)}` : "none"} firstMove=${latencyNow === null ? "-" : latencyNow.toFixed(2)}`);
  record(`COVER t=${secs()} losBefore=${losBefore ? "blocked" : "visible"} losAfter=${losAfter ? "blocked" : "visible"} standCode=${walkCode ?? "none"} how=${walkHow} threats=${attackers.length}`);
  record(`HP t=${secs()} hp3=${hp3 ?? "?"} hp5=${hp5 ?? "?"} hp8=${hp8 ?? "?"} died=${died ? 1 : 0}`);
  const kills = attackers.filter((a) => world.healthOf(a.id)?.dead === true).length;
  const row: TrialRow = { t: secs(), mode: modeName, attackers: attackers.length, weapon: world.weapon() ?? null, ammo: world.ammo(), hp0, hp3, hp5, hp8, kills, died, latency: latencyNow, cover: coverPoint ? `${coverPoint.x.toFixed(2)},${coverPoint.z.toFixed(2)}` : null, d: stopInfo.d, surface: stopInfo.surface, outcome: modeName === "cover" ? `cover-stand-${walkCode ?? "none"}-los-${losAfter ? "blocked" : "visible"}` : "control" };
  trials.push(row);
  record(`TRIAL mode=${modeName} attackers=${row.attackers} d=${row.d === null ? "-" : row.d.toFixed(2)} surface=${row.surface} weapon=${row.weapon ?? "none"} ammo=${row.ammo} hp0=${row.hp0 ?? "?"} hp3=${row.hp3 ?? "?"} hp5=${row.hp5 ?? "?"} hp8=${row.hp8 ?? "?"} kills=${kills} died=${row.died ? 1 : 0} latency=${row.latency === null ? "-" : row.latency.toFixed(2)}s outcome=${row.outcome}`);
}

// --- run -------------------------------------------------------------------
try {
  record(`joined self=${selfId} at ${me0!.x.toFixed(2)},${me0!.y.toFixed(2)},${me0!.z.toFixed(2)} players=[${[...players].join(",")}]`);
  record(`START weapon=${world.weapon() ?? "none"} ammo=${world.ammo()} hp=${world.health()?.hp ?? "?"}`);
  // Cover-first does not fire: the ammo crate is optional here. The laser arm
  // (not in this mode list) is the only one that needs `ensureArmed`.
  await ensureWeapon();
  record(`ARMED weapon=${world.weapon() ?? "none"} ammo=${world.ammo()}`);
  record(`HEAL before hp=${await healUp()}`);
  STAND_POINT = STAND ? (probePath(STAND).end ?? STAND) : undefined;
  record(`STAND point=${STAND ? `${STAND.x.toFixed(2)},${STAND.z.toFixed(2)}` : "none"} snapped=${STAND_POINT ? `${STAND_POINT.x.toFixed(2)},${STAND_POINT.z.toFixed(2)}` : "none"}`);
  // Repeat mode (`--for-s N`): keep the one-grenade-per-trial cycle (walk,
  // wait, pre-check, one throw, cover) until the timer or the max-trials cap.
  // Without it, run the `--modes` list once, `--trials` each.
  const repeatEnd = REPEAT_MS > 0 ? Date.now() + REPEAT_MS : 0;
  const modes = MODES.slice(0, MAX_TRIALS);
  const maxCount = repeatEnd > 0 ? MAX_TRIALS_REPEAT : modes.length;
  record(`LOOP repeat=${repeatEnd > 0 ? `${REPEAT_MS / 1000}s` : "off"} maxTrials=${maxCount} modes=${modes.join(",")}`);
  let count = 0;
  while (count < maxCount && (repeatEnd === 0 || Date.now() < repeatEnd)) {
    const mode = repeatEnd > 0 ? modes[count % modes.length]! : modes[count]!;
    count += 1;
    if (!aliveOk()) for (let i = 0; i < 50 && !aliveOk(); i += 1) await sleep(200);
    if (mode === "attack") await ensureWeapon();
    record(`HEAL trial hp=${await healUp()}`);
    await runTrial(mode);
    await sleep(1500);
  }
} catch (err) {
  record(`ERROR ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
} finally {
  clearInterval(sampler);
  mkdirSync("plan/dsh-tasks/logs", { recursive: true });
  writeFileSync(LOG, `${lines.join("\n")}\n`);
  writeFileSync(JSON_OUT, `${JSON.stringify({ trials, trace }, null, 1)}\n`);
  record(`EXIT trials=${trials.length} outcomes=${trials.map((t) => t.outcome).join("|")}`);
  session.close();
  process.exit(0);
}
