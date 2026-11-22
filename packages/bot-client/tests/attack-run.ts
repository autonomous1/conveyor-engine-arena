// Scratch: 5-minute attack run. Arm, reload as needed, return to the arena centre,
// attack the nearest wander bot one at a time, clean close at the end.
// Run: CE_TOKEN=<jwt> node --import ./scripts/ts-ext-register.mjs packages/bot-client/tests/attack-run.ts [--for-s 300]
import { writeFileSync } from "node:fs";
import { connectBot } from "../../../packages/bot-client/src/connection.ts";
import { openNodeSocket } from "../../../packages/bot-client/src/node-socket.ts";
import { runMission } from "../../../packages/bot-client/src/brain.ts";
import { parseMission } from "../../../packages/bot-client/src/missions.ts";
import { hasLineOfSight } from "../../../src/shared/hitscan.ts";
import { MOVE_SPEED } from "../../../src/shared/movements.ts";
import { pickDoorForUse, type DoorRuntime } from "../../../src/shared/doors.ts";
import { planPath } from "../../../src/shared/nav/path.ts";
import { planRoute } from "../../../src/shared/nav/route.ts";
import { doorStand } from "../../../src/shared/nav/follow.ts";
import { createNavCache } from "../../../src/shared/nav/legs.ts";
import { wishTo, type FollowInput, type Pose } from "../../../src/shared/nav/follow.ts";

const DEFAULT_URL = "ws://localhost:4173";
const STAMP = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const LOG = `plan/dsh-tasks/logs/108-pursuit-${STAMP}.log`;
const TRACE = `plan/dsh-tasks/logs/108-pursuit-${STAMP}.json`;
const token = (process.env.CE_TOKEN ?? "").trim();
const args = new Map<string, string>();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) if (argv[i]!.startsWith("--")) args.set(argv[i]!.slice(2), argv[i + 1] ?? "");
const URL_ = args.get("url") ?? process.env.CE_URL ?? DEFAULT_URL;
const RUN_MS = Number(args.get("for-s") ?? 300) * 1000;
// The spawn point is a real pad the host placed us on, not an arbitrary centre point.
let SPAWN = { x: -2.40, z: 3.00 };
// This run refuses targets inside 35 m of the spawn and pursues outside it.
const NO_FIRE_RING_M = 35;
const t0 = Date.now();
const secs = () => ((Date.now() - t0) / 1000).toFixed(2);
const lines: string[] = [];
let pauses = 0;
let fallbacks = 0;
const engagements: Array<Record<string, unknown>> = [];
const record = (line: string) => {
  if (/replan standAt/.test(line) && /finished/.test(line)) pauses += 1;
  const row = `t=${secs()}s ${line}`;
  lines.push(row);
  console.log(row);
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const session = await connectBot({ url: URL_, token, name: "bot-attack", role: "qa", openSocket: openNodeSocket, onLog: (l) => record(`[conn] ${l}`) });
const world = session.world;
const selfId = () => world.self()?.id;
const players = () => new Set([...(world.playerIds?.() ?? [])]);
const losNow = (targetId: number): boolean => {
  const me = world.self();
  const tg = world.others().find((p) => p.id === targetId);
  if (!me || !tg) return false;
  return hasLineOfSight(
    { x: me.x, y: me.y + world.pawnHeight * 0.8, z: me.z },
    { x: tg.x, y: tg.y + world.pawnHeight * 0.75, z: tg.z },
    world.aabbs,
  );
};
const walkToPoint = async (target: { x: number; z: number }, ms: number, label: string): Promise<boolean> => {
  const deadline = Date.now() + ms;
  let last = Infinity;
  let lastProgress = Date.now();
  while (Date.now() < deadline) {
    const me = world.self();
    if (!me) return false;
    const d = Math.hypot(me.x - target.x, me.z - target.z);
    if (d <= 0.6) {
      session.input.sendInput({ moveX: 0, moveZ: 0, yaw: me.yaw });
      await sleep(120);
      return true;
    }
    if (d < last - 0.2) { last = d; lastProgress = Date.now(); }
    if (Date.now() - lastProgress > 3000) {
      record(`${label}: no progress at ${me.x.toFixed(2)},${me.y.toFixed(2)},${me.z.toFixed(2)} d=${d.toFixed(2)}`);
      return false;
    }
    session.input.sendInput(wishTo({ x: me.x, y: me.y, z: me.z, vx: 0, vz: 0, yaw: me.yaw }, target, 1));
    await sleep(50);
  }
  return false;
};
// Stuck-aware walker: sidesteps/reverses when the capsule stops making progress.
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

// Hitscan opportunity: a valid pawn inside the fire band with a clear line of sight.
// This is the "computer vision sees a shot, take it" rule — checked every tick while
// moving, so the bot fires as soon as a target presents a shot instead of running
// past it to a stale plan point.
const navCache = createNavCache();
const gateNow = (portal: { kind?: string; door?: string; id?: string; locked?: boolean }): "open" | "locked" | "closed-unlocked" => {
  if (portal.kind !== "door") return "open";
  const d = world.door(portal.door ?? portal.id ?? "");
  if (!d) return portal.locked === true ? "locked" : "closed-unlocked";
  if (d.open) return "open";
  if (d.locked) return "locked";
  return "closed-unlocked";
};
// The nav view needs full door bodies (position/yaw/hinge/size), not just live state.
const doorsNow = () => {
  const out: Array<Record<string, unknown>> = [];
  for (const state of world.doors()) {
    const body = world.doorBody(state.id);
    if (body) out.push({ ...(body as Record<string, unknown>), open: state.open, locked: state.locked });
  }
  return out;
};
const viewNow = () => ({ aabbs: world.aabbs, doors: doorsNow(), pawnRadius: world.pawnRadius, pawnHeight: world.pawnHeight });
// Door bodies in the shape pickDoorForUse reads (task 86: the press needs the pawn in the volume).
const liveDoors = (): DoorRuntime[] => {
  const out: DoorRuntime[] = [];
  for (const state of world.doors()) {
    const body = world.doorBody(state.id);
    if (body) out.push({ ...body, open: state.open, locked: state.locked });
  }
  return out;
};
const inDoorVolume = (doorId: string): boolean => {
  const me = world.self();
  if (!me) return false;
  const picked = pickDoorForUse(liveDoors(), { id: me.id, alive: true, x: me.x, y: me.y, z: me.z, radius: world.pawnRadius, height: world.pawnHeight });
  return picked?.id === doorId;
};
const poseNow = () => {
  const s = world.self();
  return s ? { x: s.x, y: s.y, z: s.z, vx: 0, vz: 0, yaw: s.yaw } : undefined;
};
// Outside the spawn ring is only excused for pawns inside a building; those are pursued
// wherever they are.
const allowedTarget = (p: { x: number; y: number; z: number }, ringM: number): boolean => {
  const place = world.placeOf({ x: p.x, y: p.y, z: p.z })?.id ?? "outside";
  if (place !== "outside") return true;
  return ringM <= 0 || Math.hypot(p.x - SPAWN.x, p.z - SPAWN.z) > ringM;
};
const opportunity = (ringM: number): number | undefined => {
  const me = world.self();
  if (!me) return undefined;
  const skip = players();
  skip.add(me.id);
  const eye = { x: me.x, y: me.y + world.pawnHeight * 0.8, z: me.z };
  let best: { id: number; d: number } | undefined;
  for (const p of world.others()) {
    if (skip.has(p.id) || world.healthOf?.(p.id)?.dead === true) continue;
    if (!allowedTarget(p, ringM)) continue;
    const d = Math.hypot(p.x - me.x, p.z - me.z);
    if (d > 18) continue;
    if (!hasLineOfSight(eye, { x: p.x, y: p.y + world.pawnHeight * 0.75, z: p.z }, world.aabbs)) continue;
    if (!best || d < best.d) best = { id: p.id, d };
  }
  return best?.id;
};
// Avoid other bodies (the operator included): a repulsion in world XZ, clamped
// with the forward wish. The brain's follower does the same; wishTo does not.
const avoidPawns = (me: Pose, wish: FollowInput): FollowInput => {
  let ax = 0;
  let az = 0;
  for (const p of world.others()) {
    const dx = me.x - p.x;
    const dz = me.z - p.z;
    const d = Math.hypot(dx, dz);
    const gap = d - 2 * world.pawnRadius;
    if (gap > 1.5 || d < 1e-6) continue;
    const w = (1 - gap / 1.5) * 0.8;
    ax += (dx / d) * w;
    az += (dz / d) * w;
  }
  if (ax === 0 && az === 0) return wish;
  let mx = wish.moveX + ax;
  let mz = wish.moveZ + az;
  const len = Math.hypot(mx, mz);
  if (len > 1) { mx /= len; mz /= len; }
  return { ...wish, moveX: mx, moveZ: mz };
};
const followPlan = async (points: readonly (readonly number[])[], deadline: number, tolerance = 0.5): Promise<"done" | "stuck" | "timeout"> => {
  for (const point of points) {
    let last = Infinity;
    let lastProgress = Date.now();
    for (;;) {
      if (Date.now() > deadline) return "timeout";
      const me = poseNow();
      if (!me) return "stuck";
      const d = Math.hypot(me.x - point[0]!, me.z - point[2]!);
      if (d <= tolerance) break;
      if (d < last - 0.2) { last = d; lastProgress = Date.now(); }
      if (Date.now() - lastProgress > 1200) return "stuck";
      session.input.sendInput(avoidPawns(me, wishTo(me, { x: point[0]!, z: point[2]! }, d < 1.2 ? 0.4 : 1)));
      await sleep(50);
    }
  }
  return "done";
};

// Door entry, same technique as the elevator/through-doors test: centre on the near
// stand, face the leaf, open it, then walk straight along the door axis to the far
// stand. The 0.5 m capsule cannot use the grid across a 1.05 m doorway, so the
// crossing must be the straight portal segment.
const doorOnRoute = (toPlace: string): { id: string; locked: boolean } | undefined => {
  const graph = world.sceneGraph();
  const pose = poseNow();
  if (!graph || !pose) return undefined;
  const route = planRoute(graph, pose, toPlace, gateNow as never, {});
  if (!route.ok) return undefined;
  for (const step of route.steps) {
    if (step.portal.kind !== "door") continue;
    const id = step.portal.door ?? step.portal.id;
    const door = world.door(id);
    if (!door?.open) {
      if (blacklisted(doorBlacklist, id)) continue;
      return { id, locked: door?.locked === true };
    }
  }
  return undefined;
};

const enterDoor = async (doorId: string): Promise<boolean> => {
  if (blacklisted(doorBlacklist, doorId)) return false;
  const body = world.doorBody(doorId);
  // An already-open door (e.g. the operator opened it with their key) needs no press.
  // A locked, shut door needs the key, which the bot may not hold — report it and skip.
  if (world.door(doorId)?.open !== true) {
    const lockedRow = world.door(doorId);
    if (lockedRow?.locked === true) {
      const key = (body as { key?: string } | undefined)?.key ?? (lockedRow as { key?: string }).key ?? "?";
      record(`door ${doorId} is LOCKED (key=${key}); the bot does not hold it, skipping`);
      return false;
    }
  }
  const graph = world.sceneGraph();
  if (!body || !graph) return false;
  const pose = poseNow();
  if (!pose) return false;
  const outStand = doorStand(body, "out");
  const inStand = doorStand(body, "in");
  const nowPlace = world.placeOf({ x: pose.x, y: pose.y, z: pose.z })?.id ?? "outside";
  const outPlace = world.placeOf(outStand)?.id ?? "outside";
  const nearIsOut = outPlace === nowPlace;
  const near = nearIsOut ? outStand : inStand;
  const far = nearIsOut ? inStand : outStand;
  record(`door ${doorId}: approaching ${nearIsOut ? "out" : "in"} stand (${near.x.toFixed(2)},${near.z.toFixed(2)})`);
  const plan = planPath(graph, pose, near, gateNow as never, { view: viewNow(), cache: navCache });
  if (plan.ok) {
    await followPlan(plan.points, Date.now() + 15_000, 0.2);
  } else {
    record(`door ${doorId}: approach plan ${plan.reason}; straight fallback`);
    const until = Date.now() + 3_000;
    while (Date.now() < until) {
      const me = poseNow();
      if (!me) return false;
      const d = Math.hypot(me.x - near.x, me.z - near.z);
      if (d <= 0.2) break;
      session.input.sendInput(wishTo(me, { x: near.x, z: near.z }, d < 1.2 ? 0.4 : 1));
      await sleep(50);
    }
  }
  // Task 86: the press only lands with the capsule inside useVolume. The stand is
  // already ~0.3 m outside it, so a short stop leaves `use` hitting nothing. Nudge
  // until pickDoorForUse names this door before the first press.
  for (let i = 0; i < 8 && !inDoorVolume(doorId); i += 1) {
    const p = poseNow();
    if (!p) break;
    record(`door ${doorId}: not in the use volume yet; nudging`);
    session.input.sendInput(wishTo(p, { x: body.position[0], z: body.position[2] }, 0.7));
    await sleep(80);
  }
  record(`door ${doorId}: in volume=${inDoorVolume(doorId)}`);
  for (let i = 0; i < 10; i += 1) {
    const p = poseNow();
    if (p) session.input.sendInput(wishTo(p, { x: body.position[0], z: body.position[2] }, 0));
    await sleep(50);
  }
  // Press once and wait for the state to settle before pressing again — pressing while
  // the local view still says "closed" toggles the leaf back shut (the open/close loop).
  let presses = 0;
  while (world.door(doorId)?.open !== true) {
    if (world.door(doorId)?.locked === true) {
      const b = world.doorBody(doorId) as { key?: string } | undefined;
      record(`door ${doorId} is LOCKED (key=${b?.key ?? "?"}); a key is needed`);
      return false;
    }
    if (presses >= 3) {
      record(`door ${doorId} still closed after ${presses} presses`);
      return false;
    }
    session.input.use();
    presses += 1;
    const wait = Date.now() + 1500;
    while (Date.now() < wait && world.door(doorId)?.open !== true) await sleep(50);
  }
  record(`door ${doorId} open; crossing to (${far.x.toFixed(2)},${far.z.toFixed(2)})`);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const me = poseNow();
    if (!me) return false;
    const d = Math.hypot(me.x - far.x, me.z - far.z);
    if (d <= 0.4) {
      record(`door ${doorId} crossed; place=${world.placeOf({ x: me.x, y: me.y, z: me.z })?.id}`);
      return true;
    }
    if (world.door(doorId)?.open !== true) {
      record(`door ${doorId} closed mid-crossing`);
      return false;
    }
    session.input.sendInput(wishTo(me, { x: far.x, z: far.z }, d < 1.2 ? 0.4 : 1));
    await sleep(50);
  }
  return false;
};

// Leave a building the same way we enter: plan to outside, open the door on the route,
// cross it, and carry on. Used when a mission is stuck indoors.
const exitBuilding = async (): Promise<boolean> => {
  const me = poseNow();
  if (!me) return false;
  const here = world.placeOf({ x: me.x, y: me.y, z: me.z })?.id ?? "outside";
  if (here === "outside") return true;
  const door = doorOnRoute("outside");
  if (!door) {
    record(`exit: no door found on the route from ${here} to outside`);
    return false;
  }
  record(`exit: leaving ${here} through ${door.id}`);
  const crossed = await enterDoor(door.id);
  if (!crossed) doorBlacklist.set(door.id, Date.now() + 30_000);
  const after = poseNow();
  record(`exit: crossed=${crossed} self=${after?.x.toFixed(2)},${after?.z.toFixed(2)} place=${after ? world.placeOf(after)?.id : "?"}`);
  return crossed;
};

const armed = () => (world.weapon() ?? "") !== "" && world.ammo() > 0;

const armUp = async (): Promise<boolean> => {
  if (![...world.pickups()].includes("alien-weapon-1")) {
    record("arm-up: alien-weapon-1 is not on the map");
    return false;
  }
  record("arm-up: east approach");
  await walkWithRecovery({ x: -13.90, z: 16.50 }, 60_000, "east");
  record("arm-up: climb");
  const climbed = await walkWithRecovery({ x: -23.90, z: 16.50 }, 60_000, "climb");
  record(`arm-up climb=${climbed} weapon=${world.weapon() ?? "none"} ammo=${world.ammo()}`);
  if (world.self() && world.self()!.y > 0.6) await walkWithRecovery({ x: -14.00, z: 16.50 }, 30_000, "step-off");
  return armed();
};

const reload = async (): Promise<boolean> => {
  const me = world.self();
  if (!me) return false;
  const avail = new Set(world.pickups());
  const crates = (world.pickupPlacements() as Array<{ id: string; kind?: string; minX: number; maxX: number; minZ: number; maxZ: number; minY?: number; maxY?: number }>)
    .filter((p) => {
      if (p.kind !== "ammo" || !avail.has(p.id)) return false;
      const cx = (p.minX + p.maxX) / 2;
      const cy = (p.minY ?? 0) + 0.2;
      const cz = (p.minZ + p.maxZ) / 2;
      return (world.placeOf({ x: cx, y: cy, z: cz })?.id ?? "") === "outside";
    })
    .map((p) => {
      const x = (p.minX + p.maxX) / 2;
      const z = (p.minZ + p.maxZ) / 2;
      return { id: p.id, d: Math.hypot(x - SPAWN.x, z - SPAWN.z) };
    })
    .sort((a, b) => a.d - b.d);
  const crate = crates[0];
  record(`reload: candidates ${crates.slice(0, 4).map((c) => `${c.id}(${c.d.toFixed(0)}m)`).join(" ") || "none"}`);
  if (!crate) return false;
  const mission = parseMission(`retrieve:${crate.id}@outside`);
  const code = mission ? await runMission(session, mission, { timeoutMs: 90_000, log: (l) => record(`  ammo ${l}`), error: (l) => record(`  ammo ERROR ${l}`) }) : 1;
  record(`reload code=${code} ammo=${world.ammo()}`);
  return world.ammo() > 0;
};

let missionStalls = 0;
const monitorMission = (label: string): (() => void) => {
  let lastX = Number.NaN;
  let lastZ = Number.NaN;
  let lastProgress = Date.now();
  const timer = setInterval(() => {
    const me = world.self();
    if (!me) return;
    if (Number.isFinite(lastX) && Math.hypot(me.x - lastX, me.z - lastZ) < 0.12) {
      if (Date.now() - lastProgress > 2500) {
        missionStalls += 1;
        record(`${label}: MISSION STALL at ${me.x.toFixed(2)},${me.y.toFixed(2)},${me.z.toFixed(2)}`);
        lastProgress = Date.now();
      }
    } else {
      lastX = me.x;
      lastZ = me.z;
      lastProgress = Date.now();
    }
  }, 250);
  return () => clearInterval(timer);
};

const goCentre = async (): Promise<void> => {
  const stop = monitorMission("centre");
  let ok = await walkWithRecovery(SPAWN, 30_000, "spawn");
  if (!ok) {
    record("spawn: wishTo retry");
    ok = await walkWithRecovery(SPAWN, 20_000, "spawn-retry");
  }
  stop();
  const me = world.self();
  record(`spawn walk ok=${ok} self=${me?.x.toFixed(2)},${me?.y.toFixed(2)},${me?.z.toFixed(2)}`);
  if (!ok) record("did not reach the spawn point (not sliding; the loop will try the next step)");
  record(`spawn done self=${me?.x.toFixed(2)},${me?.y.toFixed(2)},${me?.z.toFixed(2)} stalls=${missionStalls}`);
};

const pickTarget = (): number | undefined => {
  const me = world.self();
  if (!me) return undefined;
  const skip = players();
  skip.add(me.id);
  const rows = world.others()
    .filter((p) => {
      if (skip.has(p.id) || targetBlocked(p.id) || world.healthOf?.(p.id)?.dead === true) return false;
      return allowedTarget(p, NO_FIRE_RING_M);
    })
    .map((p) => ({ id: p.id, d: Math.hypot(p.x - me.x, p.z - me.z), x: p.x, z: p.z, s: Math.hypot(p.x - SPAWN.x, p.z - SPAWN.z) }))
    .sort((a, b) => a.d - b.d);
  return rows[0]?.id;
};

// Doors that would not open and targets behind them: skip briefly instead of retrying.
const doorBlacklist = new Map<string, number>();
const targetBlacklist = new Map<number, number>();
const blacklisted = (map: Map<string, number>, key: string) => (map.get(key) ?? 0) > Date.now();
const targetBlocked = (id: number) => (targetBlacklist.get(id) ?? 0) > Date.now();

// Health recovery: below 50 hp, drop the attack goal and fetch health crates to 100.
const heal = async (): Promise<boolean> => {
  record(`heal: hp=${world.health()?.hp ?? "?"} -> seeking health crates`);
  const deadline = Date.now() + 120_000;
  const failed = new Map<string, number>();
  let attempts = 0;
  while (Date.now() < deadline) {
    if ((world.health()?.hp ?? 0) >= 100) {
      record("heal: restored to 100");
      return true;
    }
    if (attempts >= 8) {
      record(`heal: ${attempts} crates tried without reaching 100; giving up the heal loop`);
      return false;
    }
    const me = world.self();
    if (!me) return false;
    const avail = new Set(world.pickups());
    const crates = (world.pickupPlacements() as Array<{ id: string; kind?: string; minX: number; maxX: number; minZ: number; maxZ: number }>)
      .filter((p) => p.kind === "health" && avail.has(p.id) && (failed.get(p.id) ?? 0) < Date.now())
      .map((p) => {
        const x = (p.minX + p.maxX) / 2;
        const z = (p.minZ + p.maxZ) / 2;
        const place = world.placeOf({ x, y: 0.3, z })?.id ?? "outside";
        return { id: p.id, d: Math.hypot(x - me.x, z - me.z), outside: place === "outside" };
      })
      .sort((a, b) => (a.outside === b.outside ? a.d - b.d : a.outside ? -1 : 1));
    const crate = crates[0];
    if (!crate) {
      record("heal: no health crates available; waiting");
      await sleep(1000);
      continue;
    }
    if (!avail.has(crate.id)) {
      // Taken by someone else between the scan and the attempt: find another, no penalty.
      record(`heal: ${crate.id} is gone; finding another`);
      continue;
    }
    record(`heal: retrieve:${crate.id} d=${crate.d.toFixed(0)}`);
    const crateRow = (world.pickupPlacements() as Array<{ id: string; minX: number; maxX: number; minZ: number; maxZ: number }>).find((c) => c.id === crate.id);
    if (crateRow) {
      const cratePlace = world.placeOf({ x: (crateRow.minX + crateRow.maxX) / 2, y: 0.3, z: (crateRow.minZ + crateRow.maxZ) / 2 })?.id ?? "outside";
      const here = world.self() ? (world.placeOf(world.self()!)?.id ?? "outside") : "outside";
      if (cratePlace !== "outside" && cratePlace !== here) {
        const door = doorOnRoute(cratePlace);
        if (door) {
          record(`heal: door ${door.id} on the route to ${cratePlace}`);
          await enterDoor(door.id);
        }
      }
    }
    const mission = parseMission(`retrieve:${crate.id}@outside`);
    const hpBefore = world.health()?.hp ?? 0;
    if (mission) {
      await runMission(session, mission, { timeoutMs: 60_000, log: (l) => record(`  heal ${l}`), error: (l) => record(`  heal ERROR ${l}`) });
    }
    const hpAfter = world.health()?.hp ?? 0;
    if (hpAfter >= 100) return true;
    if (hpAfter <= hpBefore) {
      // Unreachable crate (a room behind a door, a taken crate, a stuck route):
      // blacklist it for a minute and try the next one instead of looping forever.
      attempts += 1;
      failed.set(crate.id, Date.now() + 60_000);
      record(`heal: ${crate.id} did not restore hp (${hpBefore} -> ${hpAfter}); blacklisted 60s`);
    }
    await sleep(400);
  }
  // Give up healing but do not stay trapped indoors: leave the building and carry on.
  const me2 = poseNow();
  const here2 = me2 ? (world.placeOf({ x: me2.x, y: me2.y, z: me2.z })?.id ?? "outside") : "outside";
  if (here2 !== "outside") await exitBuilding();
  return (world.health()?.hp ?? 0) >= 100;
};

let kills = 0;
let shots = 0;
let deaths = 0;
let wasDead = false;
const attacks: Array<Record<string, unknown>> = [];
try {
  const started = Date.now();
  while (!world.self() && Date.now() - started < 10_000) await sleep(20);
  while (!world.sceneGraph() && Date.now() - started < 10_000) await sleep(20);
  const me0 = world.self();
  if (me0) SPAWN = { x: me0.x, z: me0.z };
  record(`joined self=${me0?.id} at ${SPAWN.x.toFixed(2)},${SPAWN.z.toFixed(2)} (spawn point) pickups=${world.pickups().length} weapon=${world.weapon() ?? "none"} ammo=${world.ammo()}`);

  // Loadout check: a session that inherits the previous kit must not re-run the
  // arm-up or the ammo crate; only an unarmed/empty pawn does.
  const loadWeapon = world.weapon() ?? "none";
  const loadAmmo = world.ammo();
  record(`loadout check: weapon=${loadWeapon} ammo=${loadAmmo} armed=${armed() ? 1 : 0}`);
  if (armed()) {
    record("loadout: already armed (weapon + ammo); skipping arm/reload");
  } else {
    if (loadWeapon === "none" || loadAmmo <= 0) await armUp();
    if (world.weapon() && world.ammo() <= 0) await reload();
  }
  record(`armed weapon=${world.weapon() ?? "none"} ammo=${world.ammo()}`);
  await goCentre();
  // Health check: at the spawn, below 100 hp means health crates before the run.
  const hpStart = world.health()?.hp ?? null;
  record(`health check: hp=${hpStart ?? "?"} dead=${world.health()?.dead ?? "?"}`);
  if (hpStart !== null && hpStart < 100) {
    record(`health: ${hpStart} < 100 at start; acquiring health crates`);
    await heal();
    record(`health: after crates hp=${world.health()?.hp ?? "?"}`);
  }

  const end = t0 + RUN_MS;
  while (Date.now() < end) {
    await sleep(150);
    const deadNow = world.health()?.dead === true;
    if (deadNow && !wasDead) deaths += 1;
    wasDead = deadNow;
    if ((world.health()?.hp ?? 100) <= 50) {
      record(`health: hp=${world.health()?.hp ?? "?"} <= 50; acquiring health crates`);
      await heal();
      continue;
    }
    if (!armed()) {
      if ((world.weapon() ?? "") === "") { record("no weapon (map pickup gone and the pawn is unarmed); stopping"); break; }
      if (!(await reload())) { record("no ammo available; stopping"); break; }
      await goCentre();
    }
    let targetId = opportunity(NO_FIRE_RING_M) ?? pickTarget();
    if (targetId === undefined) {
      record("no target outside the 35 m spawn ring; scanning");
      const angle = Math.random() * Math.PI * 2;
      const scan = { x: SPAWN.x + Math.cos(angle) * (NO_FIRE_RING_M + 8), z: SPAWN.z + Math.sin(angle) * (NO_FIRE_RING_M + 8) };
      await walkWithRecovery(scan, 20_000, "scan");
      continue;
    }
    const tg = world.others().find((p) => p.id === targetId);
    const me = world.self()!;
    record(`target id=${targetId} d=${tg ? Math.hypot(tg.x - me.x, tg.z - me.z).toFixed(1) : "?"} spawnD=${tg ? Math.hypot(tg.x - SPAWN.x, tg.z - SPAWN.z).toFixed(1) : "?"} hp=${JSON.stringify(world.healthOf?.(targetId))}`);
    // Pursue with a planned path, but every tick first look for a line-of-sight shot:
    // if any valid pawn is inside the band with a clear lane, take the shot now.
    const graphNow = world.sceneGraph();
    const pursueEnd = Date.now() + 25_000;
    const acquireAt = Date.now();
    const engagePauses = pauses;
    const engageFallbacks = fallbacks;
    let planTarget: { x: number; z: number } | undefined;
    let planPlace: string | undefined;
    let planAt = 0;
    let lastPlanGap = 0;
    let firstShotMs: number | undefined;
    let minRange = Infinity;
    let runPast = false;
    let pursuits = 0;
    let stuckSlices = 0;
    const hist: Array<{ x: number; z: number; at: number }> = [];
    while (Date.now() < pursueEnd && Date.now() < end) {
      if ((world.health()?.hp ?? 100) <= 50) { record("heal: hit during pursuit"); break; }
      const shot = opportunity(NO_FIRE_RING_M);
      if (shot !== undefined) {
        if (shot !== targetId) record(`opportunity: id=${shot} (shot in view, engaging now)`);
        targetId = shot;
        break;
      }
      const blackUntil = targetBlacklist.get(targetId);
      if (blackUntil !== undefined && Date.now() < blackUntil) {
        record(`pursuit: target ${targetId} is blacklisted; switching`);
        break;
      }
      const p = poseNow();
      const t2 = world.others().find((q) => q.id === targetId);
      if (!p || !t2 || !graphNow) break;
      const d = Math.hypot(t2.x - p.x, t2.z - p.z);
      if (d < minRange) minRange = d;
      if (!runPast && minRange < 18 && d > minRange + 2) {
        runPast = true;
        record(`pursuit: RUN-PAST id=${targetId} min=${minRange.toFixed(1)} now=${d.toFixed(1)}`);
      }
      if (d <= 18 && losNow(targetId)) break;
      // 20 Hz target sampling -> a 400 ms velocity for the intercept.
      const sampleAt = Date.now();
      hist.push({ x: t2.x, z: t2.z, at: sampleAt });
      while (hist.length > 1 && sampleAt - hist[0]!.at > 400) hist.shift();
      const oldest = hist[0]!;
      const span = sampleAt - oldest.at;
      const vt = span > 0
        ? { x: ((t2.x - oldest.x) * 1000) / span, z: ((t2.z - oldest.z) * 1000) / span }
        : { x: 0, z: 0 };
      let tFlight = d / MOVE_SPEED;
      let pred = { x: t2.x, z: t2.z };
      for (let i = 0; i < 3; i += 1) {
        pred = { x: t2.x + vt.x * tFlight, z: t2.z + vt.z * tFlight };
        tFlight = Math.hypot(pred.x - p.x, pred.z - p.z) / MOVE_SPEED;
      }
      const place = world.placeOf(t2)?.id ?? "";
      const drifted = planTarget === undefined ? Infinity : Math.hypot(t2.x - planTarget.x, t2.z - planTarget.z);
      if (planTarget === undefined || place !== planPlace || drifted > 1 || Date.now() - planAt >= 200) {
        if (planAt > 0) lastPlanGap = Date.now() - planAt;
        planAt = Date.now();
        pursuits += 1;
        planTarget = { x: t2.x, z: t2.z };
        planPlace = place;
        record(`pursuit plan: id=${targetId} place=${place} d=${d.toFixed(1)} intercept=${pred.x.toFixed(2)},${pred.z.toFixed(2)} vt=${vt.x.toFixed(2)},${vt.z.toFixed(2)} planMs=${pursuits > 1 ? lastPlanGap : 0}`);
        const plan = planPath(graphNow, p, { x: pred.x, y: t2.y, z: pred.z }, gateNow, { view: viewNow(), cache: navCache });
        if (!plan.ok) {
          // No path to this target: discard it at once and let the outer loop pick
          // another. A door detour for an unreachable target only burns the window
          // (the 2026-11-22 5-minute run: one indoor pawn, 24 door nudges, 0 shots).
          record(`pursuit no plan: ${plan.reason}`);
          targetBlacklist.set(targetId, Date.now() + 60_000);
          record(`pursuit: no path to target ${targetId} (${plan.reason}); blacklisted 60s, selecting another`);
          targetId = undefined;
          break;
        }
        // A 100 ms slice of the walk; the next plan starts from the live pose.
        const beforePose = poseNow();
        const followed = await followPlan(plan.points, Math.min(pursueEnd, Date.now() + 100));
        if (followed !== "timeout") record(`pursuit follow: ${followed} self=${world.self()?.x.toFixed(1)},${world.self()?.z.toFixed(1)}`);
        // The slice is shorter than followPlan's 1.2 s stuck detector, so watch the
        // pose across slices: no movement over four slices is a wedge.
        if (followed === "timeout" && beforePose) {
          const after = poseNow();
          const moved = after ? Math.hypot(after.x - beforePose.x, after.z - beforePose.z) : 0;
          if (moved < 0.15) {
            stuckSlices += 1;
            if (stuckSlices >= 4) {
              record(`pursuit: NO-PROGRESS at ${after?.x.toFixed(1)},${after?.z.toFixed(1)}; blacklisting target ${targetId} and backing off`);
              targetBlacklist.set(targetId, Date.now() + 30_000);
              targetId = undefined;
              break;
            }
          } else {
            stuckSlices = 0;
          }
        }
        if (followed === "stuck") {
          const me = poseNow();
          const t3 = world.others().find((q) => q.id === targetId);
          if (me && t3) {
            const yaw = Math.atan2(t3.x - me.x, t3.z - me.z);
            const side = Math.random() < 0.5 ? 1 : -1;
            const aside = { x: me.x + Math.cos(yaw) * side * 1.1, z: me.z - Math.sin(yaw) * side * 1.1 };
            const until = Date.now() + 600;
            while (Date.now() < until) {
              const p2 = poseNow();
              if (!p2) break;
              session.input.sendInput(wishTo(p2, aside, 1));
              await sleep(50);
            }
          }
          planTarget = undefined;
        }
      } else {
        await sleep(50);
      }
    }
    if (targetId === undefined) continue;
    if ((world.health()?.hp ?? 100) <= 50) {
      record("heal: hit during pursuit");
      continue;
    }
    const bandCheck = (() => {
      const p = world.self();
      const t4 = world.others().find((q) => q.id === targetId);
      return p && t4 ? Math.hypot(t4.x - p.x, t4.z - p.z) : Infinity;
    })();
    if (bandCheck > 18 || !losNow(targetId)) {
      record(`target id=${targetId} not shootable (d=${bandCheck.toFixed(1)} los=${losNow(targetId)}); re-pursuing`);
      continue;
    }
    const mission = parseMission(`attack:${targetId}`);
    // Face the target while firing (product fix #10; the controller does not rotate the body).
    const face = setInterval(() => {
      const p = world.self();
      const t3 = world.others().find((q) => q.id === targetId);
      if (p && t3) session.input.sendInput({ moveX: 0, moveZ: 0, yaw: Math.atan2(t3.x - p.x, t3.z - p.z) });
    }, 100);
    const code = mission ? await runMission(session, mission, { timeoutMs: Math.min(20_000, Math.max(5000, end - Date.now())), log: (l) => {
      if (l.includes("attack: fire")) {
        shots += 1;
        if (firstShotMs === undefined) firstShotMs = Date.now() - acquireAt;
      }
      if (l.includes("attack: straight fallback")) fallbacks += 1;
      record(`  atk ${l}`);
    }, error: (l) => record(`  atk ERROR ${l}`) }) : 1;
    clearInterval(face);
    const hp = world.healthOf?.(targetId);
    if (code === 0 && hp?.dead === true) kills += 1;
    attacks.push({ t: Number(secs()), targetId, code, hp, shots });
    record(`attack done id=${targetId} code=${code} hp=${JSON.stringify(hp)} kills=${kills} shots=${shots}`);
    engagements.push({
      target: targetId,
      t: Number(secs()),
      acquiredMs: Date.now() - acquireAt,
      firstShotMs: firstShotMs ?? null,
      timeToEngageMs: firstShotMs ?? null,
      runPast,
      minRange: Number.isFinite(minRange) ? Number(minRange.toFixed(2)) : null,
      pursuits,
      lastPlanGapMs: lastPlanGap,
      pauses: pauses - engagePauses,
      fallbacks: fallbacks - engageFallbacks,
      code,
      killed: code === 0 && hp?.dead === true,
    });
    // No spawn return in this mode: keep pursuing outside the ring.
  }
} catch (err) {
  record(`ERROR ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
} finally {
  const engageTimes = engagements.map((e) => e.timeToEngageMs).filter((n): n is number => typeof n === "number").sort((a, b) => a - b);
  const medianEngageMs = engageTimes.length === 0 ? null : engageTimes[Math.floor(engageTimes.length / 2)];
  const summary = {
    url: URL_,
    runMs: RUN_MS,
    kills,
    shots,
    deaths,
    runPast: engagements.filter((e) => e.runPast === true).length,
    pauses,
    fallbacks,
    medianTimeToEngageMs: medianEngageMs,
    engagements,
    attacks,
    elapsed: secs(),
  };
  writeFileSync(TRACE, JSON.stringify({ summary, lines }, null, 1) + "\n");
  writeFileSync(LOG, lines.join("\n") + "\n");
  record(`EXIT kills=${kills} shots=${shots} deaths=${deaths} runPast=${summary.runPast} pauses=${pauses} fallbacks=${fallbacks} medianEngageMs=${medianEngageMs ?? "?"} elapsed=${secs()}s`);
  session.close();
  await sleep(400);
  record("closed");
}
