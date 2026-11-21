// Task 120 POC: a DAG-scored position search — candidates around the target,
// scored by target LOS x cover from every visible threat x reachability x lane,
// moving to the next-best position after each throw. One grenade per position.
// Run: CE_TOKEN=… node --import ./scripts/ts-ext-register.mjs \
//   packages/bot-client/tests/dag-cover.ts --url ws://127.0.0.1:4173 --for-s 300
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Vector3 } from "three";
import { connectBot } from "../src/connection.ts";
import { openNodeSocket } from "../src/node-socket.ts";
import { runMission } from "../src/brain.ts";
import { parseMission } from "../src/missions.ts";
import { hasLineOfSight } from "../../../src/shared/hitscan.ts";
import { closestPointToPoint, type SpatialDAG } from "../../../src/shared/spatial-dag.ts";
import { shutDoorBoxes } from "../../../src/shared/bots/cover.ts";
import { EYE_HEIGHT, PITCH_LIMIT } from "../../../src/shared/look.ts";
import { GRENADE_GRAVITY, GRENADE_SPEED, type GrenadePose } from "../../../src/shared/grenade.ts";
import { wishTo } from "../../../src/shared/nav/follow.ts";
import { createNavCache } from "../../../src/shared/nav/legs.ts";
import { planPath } from "../../../src/shared/nav/path.ts";

const args = new Map<string, string>();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) if (argv[i]!.startsWith("--")) args.set(argv[i]!.slice(2), argv[i + 1] ?? "");
const token = (process.env.CE_TOKEN ?? "").trim() || readFileSync(join(homedir(), ".config/ce-arena/qa-token.pem"), "utf8").trim();
const RUN_MS = Number(args.get("for-s") ?? 300) * 1000;
const ARM = args.get("arm") === "1"; // the 110 grenade needs no weapon: pickup is optional
const MAX_CYCLES = Math.max(1, Number(args.get("max-cycles") ?? 200));
const STAMP = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const LOG = `plan/dsh-tasks/logs/120-dag-${STAMP}.log`;
const JSON_OUT = `plan/dsh-tasks/logs/120-dag-${STAMP}.json`;

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
  name: `bot-dag-${STAMP.slice(11, 19).replace(/:/g, "")}`,
  role: "qa",
  openSocket: openNodeSocket,
  onLog: (l) => record(`[conn] ${l}`),
});
const world = session.world;
// Diagnostic: the first frames this driver actually sends. If the pawn never
// moves, this says whether the wishes left the client at all and with what
// owned id (the 2026-11-21 pin had self() defined but no displacement).
let inputFrames = 0;
const rawSendInput = session.input.sendInput.bind(session.input);
session.input.sendInput = (cmd) => {
  if (inputFrames < 5) {
    inputFrames += 1;
    record(`INPUT#${inputFrames} self=${world.self()?.id ?? "-"} move=${cmd.moveX.toFixed(2)},${cmd.moveZ.toFixed(2)} yaw=${cmd.yaw.toFixed(2)}`);
  }
  rawSendInput(cmd);
};
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
const hpAt = (): number | null => world.health()?.hp ?? null;
const eyeNow = () => {
  const me = world.self();
  return me ? { x: me.x, y: me.y + EYE_HEIGHT, z: me.z } : undefined;
};
const isNpc = (id: number): boolean => !players.has(id) && id !== selfId && world.healthOf(id)?.dead !== true;
type NpcRow = { id: number; d: number; los: boolean; hp: number | null; x: number; y: number; z: number };
const visibleAttackers = (): NpcRow[] => {
  const me = world.self();
  const eye = eyeNow();
  if (!me || !eye) return [];
  const rows: NpcRow[] = [];
  for (const p of world.others()) {
    if (!isNpc(p.id)) continue;
    const d = Math.hypot(p.x - me.x, p.z - me.z);
    if (d > 30) continue;
    rows.push({ id: p.id, d: Math.round(d * 100) / 100, los: hasLineOfSight(eye, { x: p.x, y: p.y + 1, z: p.z }, world.aabbs), hp: world.healthOf(p.id)?.hp ?? null, x: p.x, y: p.y, z: p.z });
  }
  return rows.sort((a, b) => a.d - b.d);
};

// --- trace -----------------------------------------------------------------
type TraceRow = { t: number; hp: number | null; x: number; y: number; z: number; place: string; weapon: string | null; ammo: number; npcs: NpcRow[]; cycle: number; candidate: string | null; score: number | null; throw: number; hp0: number | null; hp1: number | null; coverS: number | null; losBroken: boolean | null; nextMs: number | null };
const trace: TraceRow[] = [];
type PosRow = { t: number; idx: number; x: number; z: number; dist: number; losTarget: boolean; coverRatio: number; lane: number; score: number; reach: boolean; reason: string | null; walked: boolean; how: string; walkD: number; throw: boolean; surface: string; hit: boolean; hp0: number | null; hp1: number | null; coverS: number; losBroken: boolean; nextMs: number };
const positions: PosRow[] = [];
let cycleNo = 0;
let lastCandidate: string | null = null;
let lastScore: number | null = null;
let lastThrow = 0;
let lastHp0: number | null = null;
let lastHp1: number | null = null;
let lastCoverS: number | null = null;
let lastLosBroken: boolean | null = null;
let lastNextMs: number | null = null;
const sampler = setInterval(() => {
  const me = world.self();
  if (!me) return;
  trace.push({ t: secs(), hp: hpAt(), x: me.x, y: me.y, z: me.z, place: world.placeOf(me)?.id ?? "?", weapon: world.weapon() ?? null, ammo: world.ammo(), npcs: visibleAttackers(), cycle: cycleNo, candidate: lastCandidate, score: lastScore, throw: lastThrow, hp0: lastHp0, hp1: lastHp1, coverS: lastCoverS, losBroken: lastLosBroken, nextMs: lastNextMs });
}, 50);

// --- arm-up / heal (straight wishTo + sidestep, from attack-run.ts) --------
const walkRecover = async (target: { x: number; z: number }, ms: number, label: string): Promise<boolean> => {
  const deadline = Date.now() + ms;
  let lastX = Number.NaN;
  let lastZ = Number.NaN;
  let lastProgress = Date.now();
  let attempts = 0;
  while (Date.now() < deadline) {
    const me = world.self();
    if (!me || !aliveNow()) return false;
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
  return (world.weapon() ?? "") !== "";
};
const ensureWeapon = async (): Promise<boolean> => {
  if ((world.weapon() ?? "") !== "") return true;
  record("ensure-weapon: no weapon; arm-up");
  await armUp();
  record(`ensure-weapon: weapon=${world.weapon() ?? "none"} ammo=${world.ammo()}`);
  return (world.weapon() ?? "") !== "";
};
const healUp = async (): Promise<number> => {
  let hp = hpAt() ?? 100;
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
    const code = await runMission(session, mission, { timeoutMs: 45_000, log: (l) => record(`  heal ${l}`), error: (l) => record(`  heal ERROR ${l}`) });
    record(`heal code=${code} hp=${hpAt() ?? "?"}`);
    hp = hpAt() ?? hp;
  }
  return hp;
};

// --- aim (the 110 throw + 400 ms lead) -------------------------------------
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
  if (!sol) return undefined;
  return { yaw: Math.atan2(dx, dz), pitch: sol.pitch, d: Math.hypot(dx, dz), pred };
};

// --- cluster / stand -------------------------------------------------------
type Point = { x: number; y: number; z: number };
const findCluster = (): { a: { id: number; x: number; y: number; z: number }; b: { id: number; x: number; y: number; z: number } } | undefined => {
  const npcs = world.others().filter((p) => isNpc(p.id) && (world.placeOf(p)?.id ?? "") === "outside");
  const me = world.self();
  const origin = me ? { x: me.x, z: me.z } : { x: 0, z: 0 };
  let best: { a: (typeof npcs)[number]; b: (typeof npcs)[number] } | undefined;
  let bestD = Infinity;
  for (let i = 0; i < npcs.length; i += 1) {
    for (let j = i + 1; j < npcs.length; j += 1) {
      const a = npcs[i]!;
      const b = npcs[j]!;
      const d = Math.hypot(a.x - b.x, a.z - b.z);
      const s = Math.min(Math.hypot(a.x - origin.x, a.z - origin.z), Math.hypot(b.x - origin.x, b.z - origin.z));
      if (d >= 6 || s >= bestD) continue;
      best = { a, b };
      bestD = s;
    }
  }
  return best;
};
const nearerTo = (c: NonNullable<ReturnType<typeof findCluster>>, ref: { x: number; z: number }): { id: number; x: number; y: number; z: number } =>
  Math.hypot(c.a.x - ref.x, c.a.z - ref.z) <= Math.hypot(c.b.x - ref.x, c.b.z - ref.z) ? c.a : c.b;
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
// wishTo-first: the arm-up proves the straight wish moves the pawn; the
// `stand:` planner wedged at the start and burned 8 s before the fallback.
// No routing here — wishTo aims at x,z and walkRecover sidesteps when stuck.
const walkToStand = async (point: Point, label: string): Promise<{ ok: boolean; d: number; how: string }> => {
  const ok = await walkRecover({ x: point.x, z: point.z }, 20_000, label);
  const me = world.self();
  const d = me ? Math.hypot(me.x - point.x, me.z - point.z) : Infinity;
  return { ok: ok && d <= 1.6, d, how: ok ? "wish" : "wish-wedged" };
};

// Diagnostic heartbeat: the pickup/ownership loss showed as a silent stop. Log
// self id, hp, dead, weapon and pose every 2 s so the transition is captured.
setInterval(() => {
  const me = world.self();
  const h = me ? world.healthOf(me.id) : undefined;
  record(`SELF id=${me?.id ?? "-"} hp=${h?.hp ?? "?"} dead=${h?.dead ? 1 : 0} weapon=${world.weapon() ?? "none"} pos=${me ? `${me.x.toFixed(2)},${me.z.toFixed(2)}` : "-"}`);
}, 2_000);

// --- DAG position search (task 120) ---------------------------------------
const dynBoxes = () =>
  shutDoorBoxes(
    world.doors().map((d) => {
      const body = world.doorBody(d.id);
      return { open: d.open, position: (body?.position ?? [0, 0, 0]) as [number, number, number], size: (body?.size ?? [0, 0, 0]) as [number, number, number] };
    }),
  );
type Candidate = { key: string; x: number; y: number; z: number; dist: number; losTarget: boolean; coverRatio: number; coverAll: boolean; lane: number; score: number; reach: boolean; reason: string | null };
const chestAt = (p: { x: number; y: number; z: number }) => ({ x: p.x, y: p.y + 1.0, z: p.z });
const eyeOf = (p: { x: number; y: number; z: number }) => ({ x: p.x, y: p.y + EYE_HEIGHT, z: p.z });
const buildCandidates = (dag: SpatialDAG, target: { x: number; y: number; z: number }): { all: Candidate[]; rejected: { band: number; los: number; cover: number; lane: number; landing: number } } => {
  const dyn = dynBoxes();
  const rejected = { band: 0, los: 0, cover: 0, lane: 0, landing: 0 };
  const seen = new Map<string, Candidate>();
  const consider = (x: number, z: number): void => {
    const key = `${Math.round(x * 2) / 2}:${Math.round(z * 2) / 2}`;
    if (seen.has(key)) return;
    const place = world.placeOf({ x, y: 0, z });
    if (!place || place.id !== "outside") return;
    const dist = Math.hypot(x - target.x, z - target.z);
    if (dist < 20 || dist > 30) {
      rejected.band += 1;
      return;
    }
    const eye = eyeOf({ x, y: 0, z });
    if (!hasLineOfSight(eye, chestAt(target), world.aabbs)) {
      rejected.los += 1;
      return;
    }
    // Cover is scored against the threats visible from *this candidate*, not
    // the bot's pre-move list; and the candidate needs launch clearance so the
    // grenade does not spawn inside the prop it hides behind (the 120 v1 prop
    // stops all had lane < 1.2 m).
    const threats = world.others().filter((n) => isNpc(n.id) && Math.hypot(n.x - x, n.z - z) <= 30);
    let blocked = 0;
    for (const t of threats) if (!hasLineOfSight(eye, chestAt(t), world.aabbs)) blocked += 1;
    const coverRatio = threats.length > 0 ? blocked / threats.length : 1;
    // Graded: all-or-nothing cover excluded the whole arena once props counted.
    if (coverRatio < 0.5) {
      rejected.cover += 1;
      return;
    }
    const near = closestPointToPoint(dag, new Vector3(x, 1, z));
    const lane = near ? near.distance : 8;
    if (lane < 1.5) {
      rejected.lane += 1;
      return;
    }
    // The lobbed grenade must also land at the target: a clear chest line can
    // still clip the target's own cover (the 120 v2 prop stops were target-side).
    if (!hasLineOfSight(eye, { x: target.x, y: 0.2, z: target.z }, world.aabbs)) {
      rejected.landing += 1;
      return;
    }
    const score = 3 + 2 * coverRatio + (0.5 * Math.min(lane, 4)) / 4 + 0.5 * (1 - Math.abs(dist - 25) / 10);
    seen.set(key, { key, x, y: 0, z, dist, losTarget: true, coverRatio, coverAll: true, lane, score, reach: false, reason: null });
  };
  for (const box of world.aabbs) {
    const cx = (box.minX + box.maxX) / 2;
    const cz = (box.minZ + box.maxZ) / 2;
    if (Math.hypot(cx - target.x, cz - target.z) > 32) continue;
    const r = Math.max(box.maxX - box.minX, box.maxZ - box.minZ) / 2 + world.pawnRadius + 0.55;
    for (let deg = 0; deg < 360; deg += 45) {
      const a = (deg * Math.PI) / 180;
      consider(cx + Math.sin(a) * r, cz + Math.cos(a) * r);
    }
  }
  // Grid fallback: the occluder ring can leave zero reachable candidates; a
  // coarse grid over the arena bounds guarantees positions in the band.
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const box of world.aabbs) {
    if (box.minX < minX) minX = box.minX;
    if (box.maxX > maxX) maxX = box.maxX;
    if (box.minZ < minZ) minZ = box.minZ;
    if (box.maxZ > maxZ) maxZ = box.maxZ;
  }
  if (Number.isFinite(minX)) {
    for (let x = minX; x <= maxX; x += 5) {
      for (let z = minZ; z <= maxZ; z += 5) {
        if (Math.hypot(x - target.x, z - target.z) < 20 || Math.hypot(x - target.x, z - target.z) > 30) continue;
        consider(x, z);
      }
    }
  }
  return { all: [...seen.values()].sort((a, b) => b.score - a.score), rejected };
};
const stopSurface = (g: GrenadePose): string => (!g.n ? "pawn" : g.n[1] !== 0 ? "ground" : "prop");

let aimPawn: { id: number; x: number; y: number; z: number } | undefined;
const usedPositions = new Set<string>();
const failedPositions = new Set<string>();
async function runCycle(): Promise<boolean> {
  cycleNo += 1;
  if (!world.self()) {
    record(`PAWN-LOST at cycle ${cycleNo}; closing`);
    return false;
  }
  const dag = world.spatialDag();
  if (!dag) {
    record("DAG absent; stop");
    return false;
  }
  if (!aimPawn || world.healthOf(aimPawn.id)?.dead === true || !world.others().some((p) => p.id === aimPawn!.id)) {
    const cluster = findCluster();
    if (!cluster) {
      record("no cluster; scan");
      return true;
    }
    aimPawn = nearerTo(cluster, cluster.a);
    usedPositions.clear();
    record(`TARGET pair=${cluster.a.id},${cluster.b.id} aimPawn=${aimPawn.id}`);
  }
  const target = aimPawn;
  const { all, rejected } = buildCandidates(dag, target);
  record(`CANDIDATES n=${all.length} rejected band=${rejected.band} no-los=${rejected.los} no-cover=${rejected.cover} no-lane=${rejected.lane} no-landing=${rejected.landing} threats=${visibleAttackers().length}`);
  let pool = all.filter((c) => !usedPositions.has(c.key) && !failedPositions.has(c.key));
  if (pool.length === 0) {
    usedPositions.clear();
    pool = all.filter((c) => !failedPositions.has(c.key));
  }
  if (pool.length === 0) {
    failedPositions.clear();
    pool = all;
  }
  const top = pool.slice(0, 25);
  let reachable = 0;
  for (const c of top) {
    const probe = probePath({ x: c.x, z: c.z });
    c.reach = probe.ok;
    c.reason = probe.reason;
    if (probe.ok) reachable += 1;
  }
  // Prefer a plan-ok candidate, but the straight walk decides; a plan-ok point
  // that wedges is caught by the failed-position memory.
  const chosen: Candidate | undefined = top.find((c) => c.reach) ?? top[0];
  record(`CANDIDATES reachable=${reachable} chosen=${chosen ? `${chosen.x.toFixed(2)},${chosen.z.toFixed(2)}` : "none"}`);
  if (!chosen) {
    record("CANDIDATES none within 25");
    return true;
  }
  usedPositions.add(chosen.key);
  lastCandidate = `${chosen.x.toFixed(2)},${chosen.z.toFixed(2)}`;
  lastScore = chosen.score;
  const walkStart = Date.now();
  const walk = await walkToStand({ x: chosen.x, y: 0, z: chosen.z }, `pos${cycleNo}`);
  if (!walk.ok) failedPositions.add(chosen.key);
  const arriveAt = Date.now();
  const eye = eyeNow();
  const losBroken = eye ? visibleAttackers().every((t) => !hasLineOfSight(eye, chestAt(t), world.aabbs)) : false;
  let coverS = 0;
  let throwOk = false;
  let surface = "none";
  let hit = false;
  const hp0 = hpAt();
  let hp1 = hp0;
  let nextMs = 0;
  if (walk.ok && losBroken) {
    coverS = (Date.now() - arriveAt) / 1000;
    for (let i = 0; i < 8; i += 1) {
      samplePawn(target.id);
      await sleep(50);
    }
    const aim = aimAtPawn(target.id);
    const aimEye = eyeNow();
    const losAim = aim && aimEye ? hasLineOfSight(aimEye, aim.pred, world.aabbs) : false;
    if (aim && !losAim) {
      // The final gate (the 110 NO-FIRE): the lead point moved behind static
      // geometry between scoring and the throw; firing would hit the prop.
      record(`NO-FIRE idx=${cycleNo} los=0 d=${aim.d.toFixed(2)}; re-position`);
    } else if (aim) {
      const before = new Set(world.landed().map((g) => g.id));
      throwOk = session.input.grenade(aim.yaw, aim.pitch);
      const thrownAt = Date.now();
      while (Date.now() - thrownAt < 5_000) {
        const fresh = world.landed().find((g) => !before.has(g.id));
        if (fresh) {
          surface = stopSurface(fresh);
          const dTarget = Math.hypot(fresh.x - target.x, fresh.z - target.z);
          hit = !fresh.n && dTarget < 2.5;
          break;
        }
        await sleep(50);
      }
      nextMs = Date.now() - thrownAt;
    }
  } else if (walk.ok) {
    record(`POS idx=${cycleNo} pos=${chosen.x.toFixed(2)},${chosen.z.toFixed(2)} coverLost=1; re-position`);
  }
  hp1 = hpAt();
  lastThrow = throwOk ? 1 : 0;
  lastHp0 = hp0;
  lastHp1 = hp1;
  lastCoverS = coverS;
  lastLosBroken = losBroken;
  lastNextMs = nextMs;
  const row: PosRow = { t: secs(), idx: cycleNo, x: chosen.x, z: chosen.z, dist: chosen.dist, losTarget: true, coverRatio: chosen.coverRatio, lane: chosen.lane, score: chosen.score, reach: chosen.reach, reason: chosen.reason, walked: walk.ok, how: walk.how, walkD: walk.d, throw: throwOk, surface, hit, hp0, hp1, coverS, losBroken, nextMs };
  positions.push(row);
  record(`POS idx=${cycleNo} pos=${chosen.x.toFixed(2)},${chosen.z.toFixed(2)} score=${chosen.score.toFixed(2)},los=1,cover=${chosen.coverRatio.toFixed(2)},reach=${chosen.reach ? 1 : 0},lane=${chosen.lane.toFixed(2)} walk=${walk.ok ? 1 : 0}(${walk.how}) throw=${throwOk ? 1 : 0} surface=${surface} hit=${hit ? 1 : 0} hp0=${hp0 ?? "?"} hp1=${hp1 ?? "?"} coverS=${coverS.toFixed(1)} losBroken=${losBroken ? 1 : 0} nextMs=${nextMs}`);
  return true;
}

// A killed or crashed run still leaves its evidence: write the log/trace from
// a signal or an uncaught error (the normal path is `finish`).
const emergency = (why: string): void => {
  try {
    clearInterval(sampler);
    record(`ABORT ${why} positions=${positions.length} throws=${positions.filter((p) => p.throw).length}`);
    mkdirSync("plan/dsh-tasks/logs", { recursive: true });
    writeFileSync(LOG, `${lines.join("\n")}\n`);
    writeFileSync(JSON_OUT, `${JSON.stringify({ positions, trace, trials: [], aborted: why }, null, 1)}\n`);
  } catch {
    // best effort
  }
};
process.on("SIGINT", () => {
  emergency("SIGINT");
  process.exit(130);
});
process.on("SIGTERM", () => {
  emergency("SIGTERM");
  process.exit(143);
});
process.on("uncaughtException", (err) => {
  record(`UNCAUGHT ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  emergency("uncaught");
  process.exit(1);
});
process.on("unhandledRejection", (err) => {
  record(`UNHANDLED ${String(err)}`);
  emergency("unhandled");
  process.exit(1);
});

// A dead/despawned pawn still leaves its last pose in the client world, so
// `self()` is not enough: the movement wishes are dropped and the POC loops.
// Alive means an owned pawn with a live health frame (missing frame = alive).
const aliveNow = (): boolean => {
  const me = world.self();
  if (!me) return false;
  const h = world.healthOf(me.id);
  return h?.dead !== true && (h?.hp ?? 1) > 0;
};
const waitForSelf = async (ms: number): Promise<boolean> => {
  const until = Date.now() + ms;
  for (;;) {
    if (aliveNow()) return true;
    if (Date.now() >= until) return false;
    await sleep(200);
  }
};
const waitAlive = async (ms: number, label: string): Promise<boolean> => {
  const until = Date.now() + ms;
  for (;;) {
    if (aliveNow()) return true;
    if (Date.now() >= until) return false;
    const h = world.self() ? world.healthOf(world.self()!.id) : undefined;
    record(`${label} not-owned/dead hp=${h?.hp ?? "?"} dead=${h?.dead ? 1 : 0}; waiting for respawn`);
    await sleep(500);
  }
};

// --- run -------------------------------------------------------------------
const trials: Array<Record<string, unknown>> = [];
try {
  record(`joined self=${selfId} at ${me0!.x.toFixed(2)},${me0!.y.toFixed(2)},${me0!.z.toFixed(2)} players=[${[...players].join(",")}]`);
  record(`START weapon=${world.weapon() ?? "none"} ammo=${world.ammo()} hp=${hpAt() ?? "?"}`);
  if (ARM) {
    await ensureWeapon();
    record(`ARMED weapon=${world.weapon() ?? "none"} ammo=${world.ammo()}`);
    // The step-off point is wedged against the climb geometry; walk to open
    // ground away from the spawn pad.
    let left = await walkRecover({ x: 2.0, z: 6.0 }, 30_000, "leave-climb");
    if (!left) left = await walkRecover({ x: 6.0, z: 10.0 }, 20_000, "leave-spawn");
    record(`LEAVE-CLIMB ok=${left ? 1 : 0} pos=${world.self()?.x.toFixed(2) ?? "?"},${world.self()?.z.toFixed(2) ?? "?"}`);
  } else {
    record("ARM off: skipping the weapon pickup and the leave walk; search starts at spawn");
  }
  const dag = world.spatialDag();
  record(`DAG hash=${world.spatialDagHash() ?? "none"} dag=${dag ? "present" : "none"} nodes=${dag?.nodes.length ?? 0} chunks=${dag?.chunks.length ?? 0} aabbs=${world.aabbs.length}`);
  if (!dag) {
    record("DAG absent: no run");
  } else {
    const end = Date.now() + RUN_MS;
    let cycles = 0;
    while (cycles < MAX_CYCLES && Date.now() < end) {
      cycles += 1;
      if (!(await waitForSelf(10_000))) {
        record("PAWN-LOST no owned living pawn for 10 s; closing");
        break;
      }
      if (!(await waitAlive(10_000, "PRE-CYCLE"))) {
        record("PAWN-LOST not alive after respawn wait; closing");
        break;
      }
      if ((hpAt() ?? 100) < 70) record(`HEAL hp=${await healUp()}`);
      // --arm 0 is the no-pickup diagnostic: the 110 grenade needs no weapon,
      // so never arm up here either (the pickup path is the suspected
      // ownership/movement trigger). The old unconditional call re-armed on
      // cycle 1 and made --arm 0 a no-op.
      if (ARM && !(await ensureWeapon())) {
        record("no weapon; stop");
        break;
      }
      const alive = await runCycle();
      if (!alive) break;
      await sleep(800);
    }
    const throws = positions.filter((p) => p.throw).length;
    const hits = positions.filter((p) => p.hit).length;
    const deaths = world.health()?.dead === true ? 1 : 0;
    record(`TRIAL throws=${throws} deaths=${deaths} positions=${positions.length} hp0=${hpAt() ?? "?"} hp5=${hpAt() ?? "?"} coverMoves=${positions.filter((p) => p.losBroken).length} outcome=${throws > 0 ? "ran" : "no-throws"}`);
    trials.push({ throws, hits, positions: positions.length, deaths, endHp: hpAt() });
  }
} catch (err) {
  record(`ERROR ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
} finally {
  clearInterval(sampler);
  mkdirSync("plan/dsh-tasks/logs", { recursive: true });
  writeFileSync(LOG, `${lines.join("\n")}\n`);
  writeFileSync(JSON_OUT, `${JSON.stringify({ positions, trace, trials }, null, 1)}\n`);
  record(`EXIT positions=${positions.length} throws=${positions.filter((p) => p.throw).length} elapsed=${secs()}s`);
  session.close();
  process.exit(0);
}
