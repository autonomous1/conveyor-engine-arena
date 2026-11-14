import type { AuthoritativeWorld } from "conveyor-engine-world";
import type { EngineWsServer } from "conveyor-engine-transport-ws";
import type { Audit } from "../shared/audit.js";
import type { ArenaView } from "../shared/arena-view.js";
import { propClipName, type Prop } from "../shared/arena-view.js";
import { doorLeafBox } from "../shared/doors.js";
import { pawnHitsBox, pickRespawnSpawn, type BlockPawn, type PawnHealth, type SpawnPick } from "../shared/health.js";
import { capsuleOverlapsAabb } from "../shared/pickups.js";
import { moveIntent, yawFromQuat } from "../shared/look.js";
import { approachYaw, commitShielded, enqueueOwnedMove, MOVE_DT, MOVEMENTS, movementIntent, yawQuaternion } from "../shared/movements.js";
import { createFollower, type FollowPawn, type Pose } from "../shared/nav/follow.js";
import { pullString } from "../shared/nav/funnel.js";
import { buildGrid, findLocalPath, navBoxes, specForPlace } from "../shared/nav/grid.js";
import { createNavCache, planLegs, type NavCache } from "../shared/nav/legs.js";
import {
  findRegionPath,
  indexRegions,
  overlayShutDoors,
  regionsOf,
  type BakedRegionsFile,
  type Region,
} from "../shared/nav/regions.js";
import { planRoute, type Gate } from "../shared/nav/route.js";
import { placeAt, type SceneGraph, type ScenePortal, type Vec3 } from "../shared/scene-graph.js";
import { deliverAuditFrame } from "./audit.js";
import { deliverHealthFrames } from "./health.js";
import { dispatchHostFrame, hostSnapPath } from "./host-path.js";
import type { WanderAgent } from "./world-loader.js";

/**
 * 20 Hz.
 * @why Measured later; not a competitive tick rate.
 */
export const TICK_MS = 50;

if (MOVE_DT !== TICK_MS / 1000) {
  throw new Error(`MOVE_DT ${MOVE_DT} is not the ${TICK_MS} ms host tick`);
}

/**
 * @why Kernel default interest is 48, and the authored floor's opposite corners
 *      are about 168 m apart. This host override covers that diagonal.
 */
export const ARENA_INTEREST_RADIUS = 192;

export type HeldInput = {
  moveX: number;
  moveZ: number;
  yaw: number;
  seq: number;
  /** From input `buttons`. Ignored unless the host was started with `ARENA_NOCLIP=1`. */
  noclip?: boolean;
  /** -1, 0, or 1. Applied only on the noclip step. */
  ascend?: number;
};

/** Latest command per entity. In memory, lost on restart. */
export interface HeldInputs {
  /** Stores `cmd` by reference, replacing any previous row for this entity. */
  admit(entity: number, cmd: HeldInput): void;
  /** The stored command, or undefined. Does not create a row. Mutating it changes the next read. */
  get(entity: number): HeldInput | undefined;
  /** Deletes the row. An unknown entity is a no-op. */
  drop(entity: number): void;
  /** Copy of the entity ids, in insertion order. */
  entities(): number[];
}

export function createHeldInputs(): HeldInputs {
  const latest = new Map<number, HeldInput>();
  return {
    admit(entity: number, cmd: HeldInput) {
      latest.set(entity, cmd);
    },
    get(entity: number) {
      return latest.get(entity);
    },
    drop(entity: number) {
      latest.delete(entity);
    },
    entities() {
      return [...latest.keys()];
    },
  };
}

export function noteArenaInterest(server: EngineWsServer): void {
  for (const clientId of server.connected) {
    const session = server.replicator.get(clientId);
    if (session) session.interestRadius = ARENA_INTEREST_RADIUS;
  }
}

function unit01(next: () => number): number {
  return next();
}

/**
 * SplitMix64.
 * @why Local so the production host does not import the simulator.
 */
export function splitMix(seed: number): () => number {
  let state = BigInt(seed) & 0xffffffffffffffffn;
  if (state === 0n) state = 1n;
  return () => {
    state = (state + 0x9e3779b97f4a7c15n) & 0xffffffffffffffffn;
    let z = state;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & 0xffffffffffffffffn;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & 0xffffffffffffffffn;
    z = z ^ (z >> 31n);
    return Number(z >> 11n) / 2 ** 53;
  };
}

export type PropClip = { id: string; clip: string };

/**
 * Props are string ids, not entities. The clip name is `animations[animation].clip`.
 * @why The host does not enqueue a world command and does not run the mixer.
 */
export function startPropAnimation(props: readonly Prop[]): PropClip[] {
  const clips: PropClip[] = [];
  for (const prop of props) {
    const clip = propClipName(prop);
    if (!clip) continue;
    clips.push({ id: prop.id, clip });
  }
  return clips;
}

/**
 * One unowned wander or hostile step. `agent.heading` is the wished heading
 * and may jump. The body turns toward it by at most one `PAWN_YAW_STEP`.
 * The velocity wish uses that capped yaw, then eases. The clip follows planar
 * speed and carries no position. Player input does not call this.
 */
export function stepUnownedWander(world: AuthoritativeWorld, agent: WanderAgent) {
  // A standing fight owns the yaw. A walk clip would replace angry, so the
  // close-in step applies the move and then puts angry back on last.
  if (agent.override?.stance === "angry" && !wanderWalks.has(agent)) {
    faceUnowned(world, agent);
    return;
  }
  const scale = movementIntent(agent.speeds[agent.gait] ?? 0, Object.values(agent.speeds));
  const view = world.store.view(agent.id);
  const facing = view ? yawFromQuat(view.rotation) : agent.heading;
  const yaw = approachYaw(facing, agent.heading);
  const wish = moveIntent(yaw, scale, 0);
  const moved = enqueueOwnedMove(world, agent.id, wish.moveX, wish.moveZ, yaw, MOVE_DT);
  if (agent.override?.stance === "angry") {
    world.enqueue({ kind: "setClip", entity: agent.id, clip: "angry", speed: 0 });
  }
  return moved;
}

/**
 * Stop and face. `clearInput` zeros the velocity and leaves the transform.
 * The angry clip has no reference speed, so speed 0 still plays it.
 */
function faceUnowned(world: AuthoritativeWorld, agent: WanderAgent): void {
  const view = world.store.view(agent.id);
  if (!view) return;
  const yaw = approachYaw(yawFromQuat(view.rotation), agent.heading);
  world.enqueue({ kind: "setVelocity", entity: agent.id, linear: { x: 0, y: 0, z: 0 } });
  world.enqueue({
    kind: "setTransform",
    entity: agent.id,
    position: { x: view.position.x, y: view.position.y, z: view.position.z },
    rotation: yawQuaternion(yaw),
    scale: { x: view.scale.x, y: view.scale.y, z: view.scale.z },
  });
  world.enqueue({ kind: "setClip", entity: agent.id, clip: "angry", speed: 0 });
  world.enqueue({ kind: "clearInput", entity: agent.id });
}

/** ~20 s at {@link TICK_MS}. A planned walk is not cut off by the old 1–2.5 s heading roll. */
const WANDER_GOAL_TICKS = 400;
/** A wander pick that found no walkable goal tries again after this long (2 s), not after a whole goal's time. */
const WANDER_RETRY_TICKS = 40;
/** Every other sample, from the second, is taken this close to the pawn, in its own place, so a pawn whose far goals are all shut off still has somewhere to walk. */
const WANDER_LOCAL_M = 15;
/** Stand samples and failed plans before the pawn waits for the next retarget. */
const WANDER_SAMPLE_TRIES = 8;
/** Close enough that the follower can finish. Farther, and the interior walk is missing. */
const WANDER_GOAL_XZ = 0.25;
const WANDER_GOAL_Y = 0.6;

export type WanderNav = {
  sceneGraph?: SceneGraph;
  regions?: BakedRegionsFile;
  aabbs: ArenaView["aabbs"];
  doors: ArenaView["doors"];
  pawnRadius: number;
  pawnHeight: number;
  /** Live open bits. Absent: `doors[].open` (tests, and a host with no door table). */
  liveDoors?: () => ReadonlyArray<{ id: string; open: boolean; locked?: boolean }>;
};

type WanderWalk = {
  follow: ReturnType<typeof createFollower>;
  watched: readonly string[];
  doorSig: string;
  /** The `override.goal` this walk was planned for. Absent for a sampled wander goal. */
  claim?: object;
};

type PlannedWalk = {
  points: Vec3[];
  goal: { x: number; y: number; z: number };
  claim?: object;
};

type NavView = Pick<ArenaView, "aabbs" | "doors" | "pawnRadius" | "pawnHeight">;

const wanderWalks = new WeakMap<WanderAgent, WanderWalk>();
/** The `override` the last steer saw, so a claim, a change of claim or a release replans at once. */
const lastClaims = new WeakMap<WanderAgent, object>();
/** A claimed goal that cannot be planned waits this long, then tries again. */
const CLAIM_RETRY_TICKS = 20;

/**
 * Follower installed by {@link steerUnownedWander}. Tests step this; the loop
 * does too.
 * @see steerUnownedWander
 */
export function wanderFollower(agent: WanderAgent): WanderWalk["follow"] | undefined {
  return wanderWalks.get(agent)?.follow;
}

/**
 * One unowned tick of goal choice or path following.
 * With a scene graph and baked regions, the pawn samples a region point and
 * walks `planRoute` / `planLegs` waypoints. Without them, the old heading roll runs.
 * Does not apply the wish — {@link stepUnownedWander} still does that.
 * @see stepUnownedWander
 */
export function steerUnownedWander(
  world: AuthoritativeWorld,
  agent: WanderAgent,
  tick: number,
  rng: () => number,
  nav?: WanderNav,
  cache: NavCache = createNavCache(),
  others: readonly FollowPawn[] = [],
): void {
  // A fight standing on its own feet must not roll a new heading or start a walk.
  if (holdAngry(world, agent, tick)) return;
  const sceneGraph = nav?.sceneGraph;
  const regions = nav?.regions;
  if (!nav || !sceneGraph || !regions) {
    if (tick >= agent.nextTurn) rollHeading(agent, tick, rng);
    return;
  }
  const loaded = { ...nav, sceneGraph, regions };
  const pose = wanderPose(world, agent);
  if (!pose) return;
  const flags = doorFlags(loaded, agent.override?.openDoors === true);
  const claim = agent.override?.goal;
  if (lastClaims.get(agent) !== agent.override) {
    if (agent.override) lastClaims.set(agent, agent.override);
    else lastClaims.delete(agent);
    clearWalk(agent);
    agent.nextTurn = tick;
  }
  const walk = wanderWalks.get(agent);
  const deadline = agent.nextTurn;
  if (walk && tick >= deadline) {
    clearWalk(agent);
  } else if (walk && agent.goal && doorSignature(walk.watched, flags) !== walk.doorSig) {
    const again = planWanderTo(pose, agent.goal, loaded, cache, flags);
    if (again) {
      const goal = agent.goal;
      installWalk(agent, { points: again, goal, claim: walk.claim }, pose, loaded, flags, tick, rng, others);
      if (wanderWalks.has(agent)) agent.nextTurn = deadline;
      return;
    }
    clearWalk(agent);
  } else if (walk) {
    const step = walk.follow.step(pose, others, tick);
    agent.heading = step.input.yaw;
    if (step.status === "running") return;
    if (agent.override && (step.status === "arrived" || step.status === "stuck")) {
      agent.followEnd = step.status;
      clearWalk(agent);
      agent.gait = "idle";
      agent.nextTurn = tick + 1;
      return;
    }
    clearWalk(agent);
  } else if (tick < deadline && agent.gait === "idle") {
    // A failed sample. A fresh pawn still has its spawn gait and plans now.
    return;
  }
  const chosen = claim ? planClaimed(pose, claim, loaded, cache, flags) : chooseWanderGoal(pose, loaded, rng, cache, flags);
  if (!chosen) {
    clearWalk(agent);
    // Evade claims run. A point the planner cannot walk still moves on the
    // heading the brain set (away from the threat). It does not sit idle.
    if (agent.override?.gait === "run") {
      agent.gait = "run";
      agent.nextTurn = tick + 1;
      return;
    }
    agent.gait = "idle";
    agent.nextTurn = tick + (claim ? CLAIM_RETRY_TICKS : WANDER_RETRY_TICKS);
    return;
  }
  installWalk(agent, chosen, pose, loaded, flags, tick, rng, others);
}

/** Metres. Inside this, an angry claim stands instead of following a path. */
const ANGRY_STAND_M = 1.25;

/**
 * FightBack standing still. The brain owns `agent.heading`. Returns true when
 * the pawn is close enough to its claim that this tick should not steer.
 */
function holdAngry(world: AuthoritativeWorld, agent: WanderAgent, tick: number): boolean {
  if (agent.override?.stance !== "angry") return false;
  const goal = agent.override.goal;
  const pose = wanderPose(world, agent);
  if (!pose || !goal) return false;
  if (Math.hypot(pose.x - goal.x, pose.z - goal.z) > ANGRY_STAND_M) return false;
  if (lastClaims.get(agent) !== agent.override) lastClaims.set(agent, agent.override);
  clearWalk(agent);
  agent.gait = "angry";
  agent.nextTurn = tick + 1;
  return true;
}

function rollHeading(agent: WanderAgent, tick: number, rng: () => number): void {
  clearWalk(agent);
  agent.heading += (unit01(rng) - 0.5) * Math.PI;
  let gait = MOVEMENTS[Math.floor(unit01(rng) * MOVEMENTS.length)] ?? "idle";
  if (gait === "fall") gait = "idle";
  agent.gait = gait;
  // TODO: remove this log, it is spammy
  //console.log("agent:",agent.id,gait);
  //world.triggerAction(agent.id, gait);
  agent.nextTurn = tick + 20 + Math.floor(unit01(rng) * 30);
}

function clearWalk(agent: WanderAgent): void {
  wanderWalks.delete(agent);
  agent.path = undefined;
  agent.goal = undefined;
}

function installWalk(
  agent: WanderAgent,
  planned: PlannedWalk,
  pose: Pose,
  nav: WanderNav,
  flags: ReadonlyMap<string, boolean>,
  tick: number,
  rng: () => number,
  others: readonly FollowPawn[],
): void {
  const graph = nav.sceneGraph;
  if (!graph) return;
  const view = navView(nav, flags);
  const shut = shutIds(flags);
  const grid = gridForPath(graph, view, shut, planned.points, pose.y);
  const follow = createFollower(planned.points, grid, { radius: nav.pawnRadius });
  const watched = doorsOnPath(view.doors, planned.points);
  const doorSig = doorSignature(watched, flags);
  const stepped = follow.step(pose, others, tick);
  agent.goal = planned.goal;
  agent.path = planned.points;
  const claimedGait = agent.override?.gait;
  agent.gait = claimedGait === "run" || claimedGait === "walk" ? claimedGait : unit01(rng) < 0.5 ? "walk" : "run";
  agent.nextTurn = tick + WANDER_GOAL_TICKS;
  agent.heading = stepped.input.yaw;
  if (stepped.status === "running") {
    wanderWalks.set(agent, { follow, watched, doorSig, claim: planned.claim });
    return;
  }
  if (agent.override && (stepped.status === "arrived" || stepped.status === "stuck")) agent.followEnd = stepped.status;
  clearWalk(agent);
  agent.gait = "idle";
  agent.nextTurn = tick + 20;
}

function chooseWanderGoal(
  pose: Pose,
  nav: WanderNav & { sceneGraph: SceneGraph; regions: BakedRegionsFile },
  rng: () => number,
  cache: NavCache,
  flags: ReadonlyMap<string, boolean>,
): PlannedWalk | undefined {
  for (let attempt = 0; attempt < WANDER_SAMPLE_TRIES; attempt += 1) {
    const sample = (attempt % 2 === 1 ? sampleLocalPoint(nav, pose, rng) : undefined) ?? sampleRegionPoint(nav.regions, rng);
    if (!sample) return undefined;
    if (!canStand(nav.regions, sample.placeId, sample.x, sample.y, sample.z)) continue;
    const goal = { x: sample.x, y: sample.y, z: sample.z };
    const points = planWanderTo(pose, goal, nav, cache, flags);
    if (!points) continue;
    return { points, goal };
  }
  return undefined;
}

function planClaimed(
  pose: Pose,
  goal: { x: number; y: number; z: number },
  nav: WanderNav & { sceneGraph: SceneGraph; regions: BakedRegionsFile },
  cache: NavCache,
  flags: ReadonlyMap<string, boolean>,
): PlannedWalk | undefined {
  const points = planWanderTo(pose, goal, nav, cache, flags);
  return points ? { points, goal, claim: goal } : undefined;
}

/** Exterior door landings, then nearest `outside` region centres, tried by {@link planEscapeGoal}. */
const LANDING_TRIES = 8;
const ESCAPE_TRIES = 6;

/**
 * Brain seam: a stand point in `outside` that `agent` can walk to now, or
 * `keep` while that still holds.
 * @post Shut doors stay unusable, as for wander.
 */
export function planEscapeGoal(
  world: AuthoritativeWorld,
  agent: WanderAgent,
  nav: WanderNav & { sceneGraph: SceneGraph; regions: BakedRegionsFile },
  cache: NavCache,
  keep?: { x: number; y: number; z: number },
  /** Plan through shut unlocked doors. The caller presses them. A locked door stays shut. */
  openDoors = false,
): { x: number; y: number; z: number } | undefined {
  const pose = wanderPose(world, agent);
  if (!pose) return undefined;
  const flags = doorFlags(nav, openDoors);
  if (keep && planWanderTo(pose, keep, nav, cache, flags)) return keep;
  const sortNear = (list: Array<{ d: number; x: number; y: number; z: number }>) => list.sort((a, b) => a.d - b.d);
  // First choice: the outside landing of an exterior door. The walk ends at the
  // door, so it cannot wander back in through another one.
  const landings: Array<{ d: number; x: number; y: number; z: number }> = [];
  for (const portal of nav.sceneGraph.portals) {
    if (portal.kind !== "door") continue;
    const at = portal.a === "outside" ? portal.at.a : portal.b === "outside" ? portal.at.b : undefined;
    if (at) landings.push({ d: Math.hypot(at[0] - pose.x, at[2] - pose.z), x: at[0], y: at[1], z: at[2] });
  }
  const centres: Array<{ d: number; x: number; y: number; z: number }> = [];
  for (const place of nav.regions.places) {
    if (place.placeId !== "outside") continue;
    for (const region of place.regions) {
      const x = (region.minX + region.maxX) / 2;
      const z = (region.minZ + region.maxZ) / 2;
      centres.push({ d: Math.hypot(x - pose.x, z - pose.z), x, y: region.y, z });
    }
  }
  const tiers: Array<[Array<{ d: number; x: number; y: number; z: number }>, number]> = [
    [sortNear(landings), LANDING_TRIES],
    [sortNear(centres), ESCAPE_TRIES],
  ];
  for (const [near, limit] of tiers) {
    let tries = 0;
    for (let i = 0; i < near.length && tries < limit; i += 1) {
      const goal = { x: near[i]!.x, y: near[i]!.y, z: near[i]!.z };
      // A region centre can sit inside a building footprint. That is not outside.
      if (placeAt(nav.sceneGraph, goal.x, goal.y, goal.z).id !== "outside") continue;
      if (!canStand(nav.regions, "outside", goal.x, goal.y, goal.z)) continue;
      tries += 1;
      if (planWanderTo(pose, goal, nav, cache, flags)) return goal;
    }
  }
  return undefined;
}

/**
 * Waypoints from the pawn to `goal` with shut doors unusable.
 * @why Evade claims a centre only when this finds a walk. It never opens a door.
 */
export function planWanderTarget(
  world: AuthoritativeWorld,
  agent: WanderAgent,
  nav: WanderNav & { sceneGraph: SceneGraph; regions: BakedRegionsFile },
  cache: NavCache,
  goal: { x: number; y: number; z: number },
): Vec3[] | undefined {
  const pose = wanderPose(world, agent);
  if (!pose) return undefined;
  return planWanderTo(pose, goal, nav, cache, doorFlags(nav, false));
}

/**
 * Waypoints from `pose` to `goal`. Shut doors are unusable: wander does not call `use()`.
 * Same-place goals walk the baked regions (grid fallback). Cross-place goals use `planLegs`.
 */
function planWanderTo(
  pose: Pose,
  goal: { x: number; y: number; z: number },
  nav: WanderNav & { sceneGraph: SceneGraph; regions: BakedRegionsFile },
  cache: NavCache,
  flags: ReadonlyMap<string, boolean>,
): Vec3[] | undefined {
  const view = navView(nav, flags);
  const shut = shutIds(flags);
  const gate = (portal: ScenePortal): Gate => {
    if (portal.kind !== "door") return "open";
    const id = portal.door ?? portal.id;
    return shut.has(id) ? "unusable" : "open";
  };
  const from = { x: pose.x, y: pose.y, z: pose.z };
  const route = planRoute(nav.sceneGraph, from, goal, gate);
  if (!route.ok) return undefined;
  if (route.steps.some((step) => step.portal.kind === "door" && gate(step.portal) !== "open")) return undefined;
  const legs = planLegs(nav.sceneGraph, view, route, from, { cache, regions: nav.regions, doorsShut: shut });
  if (!legs.ok) return undefined;
  const points = legs.points.map((point) => [point[0], point[1], point[2]] as Vec3);
  if (!nearGoal(points, goal) && !appendInterior(nav.sceneGraph, view, nav.regions, cache, shut, points, goal)) {
    return undefined;
  }
  if (points.length === 0) return undefined;
  // The baked outside regions also cover door gaps, and a shut leaf does not cut
  // them all. A walk that would cross a shut leaf is not a walk.
  if (shut.size > 0 && crossesShutLeaf(view.doors, shut, points)) return undefined;
  return points;
}

/** A walk may graze the end of a shut leaf (a string-pulled corner). It may not cross the panel. */
const LEAF_END_SLACK = 0.15;

function crossesShutLeaf(doors: ArenaView["doors"], shut: ReadonlySet<string>, points: readonly Vec3[]): boolean {
  for (const door of doors) {
    if (!shut.has(door.id)) continue;
    const leaf = { ...doorLeafBox(door) };
    if (leaf.maxX - leaf.minX > leaf.maxZ - leaf.minZ) {
      leaf.minX += LEAF_END_SLACK;
      leaf.maxX -= LEAF_END_SLACK;
    } else {
      leaf.minZ += LEAF_END_SLACK;
      leaf.maxZ -= LEAF_END_SLACK;
    }
    if (polylineHits(points, leaf)) return true;
  }
  return false;
}

function appendInterior(
  graph: SceneGraph,
  view: NavView,
  regions: BakedRegionsFile,
  cache: NavCache,
  shut: ReadonlySet<string>,
  points: Vec3[],
  goal: { x: number; y: number; z: number },
): boolean {
  const end = points[points.length - 1] ?? [goal.x, goal.y, goal.z];
  const place = placeAt(graph, goal.x, goal.y, goal.z);
  const fromPlace = placeAt(graph, end[0], end[1], end[2]);
  if (fromPlace.id !== place.id) return false;
  const base = indexRegions(regions).get(place.id);
  if (base && base.regions.length > 0) {
    const key = `${place.id}|${[...shut].sort().join(",")}`;
    let overlaid = cache.regions.get(key);
    if (!overlaid) {
      overlaid = overlayShutDoors(base, view.doors, shut);
      cache.regions.set(key, overlaid);
    }
    const found = findRegionPath(overlaid, [end[0], end[1], end[2]], [goal.x, goal.y, goal.z]);
    if (found) {
      const pulled = pullString(found);
      if (pulled.length > 0) {
        appendPoints(points, pulled);
        return nearGoal(points, goal);
      }
    }
  }
  const spec = specForPlace(graph, place.id);
  if (!spec) return false;
  const grid = buildGrid(spec.area, navBoxes(view, graph, shut), {
    cell: 0.25,
    radius: view.pawnRadius,
    height: view.pawnHeight,
    baseY: spec.baseY,
    block: spec.block,
  });
  const local = findLocalPath(grid, { x: end[0], z: end[2] }, { x: goal.x, z: goal.z });
  if (!local) return false;
  appendPoints(points, local);
  return nearGoal(points, goal);
}

/** A random point of `pose`'s own place within {@link WANDER_LOCAL_M}, weighted by area. */
function sampleLocalPoint(
  nav: { sceneGraph: SceneGraph; regions: BakedRegionsFile },
  pose: Pose,
  rng: () => number,
): { placeId: string; x: number; y: number; z: number } | undefined {
  const placeId = placeAt(nav.sceneGraph, pose.x, pose.y, pose.z).id;
  const graph = regionsOf(nav.regions, placeId);
  if (!graph) return undefined;
  const near: Array<{ region: Region; area: number }> = [];
  let total = 0;
  for (const region of graph.regions) {
    const dx = Math.max(region.minX - pose.x, 0, pose.x - region.maxX);
    const dz = Math.max(region.minZ - pose.z, 0, pose.z - region.maxZ);
    if (Math.hypot(dx, dz) > WANDER_LOCAL_M) continue;
    const area = Math.max(0, region.maxX - region.minX) * Math.max(0, region.maxZ - region.minZ);
    if (!(area > 0)) continue;
    near.push({ region, area });
    total += area;
  }
  if (!(total > 0)) return undefined;
  let pick = unit01(rng) * total;
  let chosen = near[near.length - 1]!;
  for (const item of near) {
    pick -= item.area;
    if (pick <= 0) {
      chosen = item;
      break;
    }
  }
  const region = chosen.region;
  return {
    placeId,
    x: region.minX + unit01(rng) * (region.maxX - region.minX),
    y: region.y,
    z: region.minZ + unit01(rng) * (region.maxZ - region.minZ),
  };
}

function sampleRegionPoint(
  file: BakedRegionsFile,
  rng: () => number,
): { placeId: string; x: number; y: number; z: number } | undefined {
  const weighted: Array<{ placeId: string; region: Region; area: number }> = [];
  let total = 0;
  for (const place of file.places) {
    for (const region of place.regions) {
      const area = Math.max(0, region.maxX - region.minX) * Math.max(0, region.maxZ - region.minZ);
      if (!(area > 0)) continue;
      weighted.push({ placeId: place.placeId, region, area });
      total += area;
    }
  }
  if (!(total > 0)) return undefined;
  let pick = unit01(rng) * total;
  let chosen = weighted[weighted.length - 1]!;
  for (const item of weighted) {
    pick -= item.area;
    if (pick <= 0) {
      chosen = item;
      break;
    }
  }
  const region = chosen.region;
  const x = region.minX + unit01(rng) * (region.maxX - region.minX);
  const z = region.minZ + unit01(rng) * (region.maxZ - region.minZ);
  return { placeId: chosen.placeId, x, y: region.y, z };
}

function canStand(file: BakedRegionsFile, placeId: string, x: number, y: number, z: number): boolean {
  const graph = regionsOf(file, placeId);
  if (!graph) return false;
  return findRegionPath(graph, [x, y, z], [x, y, z]) !== undefined;
}

function nearGoal(points: readonly Vec3[], goal: { x: number; y: number; z: number }): boolean {
  const end = points[points.length - 1];
  if (!end) return false;
  return Math.hypot(end[0] - goal.x, end[2] - goal.z) <= WANDER_GOAL_XZ && Math.abs(end[1] - goal.y) < WANDER_GOAL_Y;
}

function appendPoints(out: Vec3[], extra: readonly Vec3[]): void {
  for (const point of extra) {
    const last = out[out.length - 1];
    if (last && Math.hypot(last[0] - point[0], last[2] - point[2]) < 1e-3) {
      last[1] = point[1];
      continue;
    }
    out.push([point[0], point[1], point[2]]);
  }
}

/**
 * Open bit per door. `passUnlocked` (Escape only) also counts a shut unlocked
 * door as passable, so the plan goes through it and the brain presses it.
 */
function doorFlags(nav: WanderNav, passUnlocked = false): Map<string, boolean> {
  const flags = new Map<string, boolean>();
  const locked = new Map<string, boolean>();
  for (const door of nav.doors) {
    flags.set(door.id, door.open === true);
    locked.set(door.id, door.locked === true);
  }
  const live = nav.liveDoors?.();
  if (live) {
    for (const door of live) {
      flags.set(door.id, door.open === true);
      if (door.locked !== undefined) locked.set(door.id, door.locked);
    }
  }
  if (passUnlocked) {
    // Only doors a route can go through. A cab door belongs to its elevator.
    const portals = doorPortalIds(nav.sceneGraph);
    for (const [id, open] of flags) {
      if (!open && locked.get(id) !== true && portals.has(id)) flags.set(id, true);
    }
  }
  return flags;
}

const portalDoors = new WeakMap<SceneGraph, Set<string>>();

function doorPortalIds(graph: SceneGraph | undefined): ReadonlySet<string> {
  if (!graph) return new Set();
  let ids = portalDoors.get(graph);
  if (!ids) {
    ids = new Set();
    for (const portal of graph.portals) {
      if (portal.kind === "door") ids.add(portal.door ?? portal.id);
    }
    portalDoors.set(graph, ids);
  }
  return ids;
}

/**
 * Ids of the doors whose leaf the polyline touches, sorted. With `graph`, only
 * the doors a route goes through, not a cab door the path happens to pass.
 */
export function doorsOnRoute(doors: ArenaView["doors"], points: readonly Vec3[], graph?: SceneGraph): string[] {
  const ids = doorsOnPath(doors, points);
  if (!graph) return ids;
  const portals = doorPortalIds(graph);
  return ids.filter((id) => portals.has(id));
}

function shutIds(flags: ReadonlyMap<string, boolean>): Set<string> {
  const shut = new Set<string>();
  for (const [id, open] of flags) {
    if (!open) shut.add(id);
  }
  return shut;
}

function navView(nav: WanderNav, flags: ReadonlyMap<string, boolean>): NavView {
  return {
    aabbs: nav.aabbs,
    doors: nav.doors.map((door) => {
      const open = flags.get(door.id);
      return open === undefined || open === door.open ? door : { ...door, open };
    }),
    pawnRadius: nav.pawnRadius,
    pawnHeight: nav.pawnHeight,
  };
}

function doorSignature(ids: readonly string[], flags: ReadonlyMap<string, boolean>): string {
  let sig = "";
  for (const id of ids) sig += `${id}:${flags.get(id) ? 1 : 0},`;
  return sig;
}

function doorsOnPath(doors: ArenaView["doors"], points: readonly Vec3[]): string[] {
  const ids: string[] = [];
  for (const door of doors) {
    const leaf = doorLeafBox(door);
    if (polylineHits(points, leaf)) ids.push(door.id);
  }
  ids.sort();
  return ids;
}

function polylineHits(
  points: readonly Vec3[],
  box: { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number },
): boolean {
  if (points.length === 0) return false;
  if (points.length === 1) return pointInBox(points[0]!, box);
  for (let i = 1; i < points.length; i += 1) {
    if (segmentHitsBox(points[i - 1]!, points[i]!, box)) return true;
  }
  return false;
}

function pointInBox(
  point: Vec3,
  box: { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number },
): boolean {
  return point[0] >= box.minX && point[0] <= box.maxX
    && point[1] >= box.minY && point[1] <= box.maxY
    && point[2] >= box.minZ && point[2] <= box.maxZ;
}

function segmentHitsBox(
  a: Vec3,
  b: Vec3,
  box: { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number },
): boolean {
  let t0 = 0;
  let t1 = 1;
  const axes: Array<[number, number, number, number]> = [
    [a[0], b[0] - a[0], box.minX, box.maxX],
    [a[1], b[1] - a[1], box.minY, box.maxY],
    [a[2], b[2] - a[2], box.minZ, box.maxZ],
  ];
  for (const [origin, delta, min, max] of axes) {
    if (Math.abs(delta) <= 1e-9) {
      if (origin < min || origin > max) return false;
      continue;
    }
    let near = (min - origin) / delta;
    let far = (max - origin) / delta;
    if (near > far) {
      const swap = near;
      near = far;
      far = swap;
    }
    if (near > t0) t0 = near;
    if (far < t1) t1 = far;
    if (t0 > t1) return false;
  }
  return true;
}

function gridForPath(
  graph: SceneGraph,
  view: NavView,
  shut: ReadonlySet<string>,
  points: readonly Vec3[],
  baseY: number,
) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const point of points) {
    if (point[0] < minX) minX = point[0];
    if (point[0] > maxX) maxX = point[0];
    if (point[2] < minZ) minZ = point[2];
    if (point[2] > maxZ) maxZ = point[2];
  }
  if (!Number.isFinite(minX)) {
    minX = 0;
    maxX = 1;
    minZ = 0;
    maxZ = 1;
  }
  const pad = 3;
  return buildGrid(
    { minX: minX - pad, maxX: maxX + pad, minZ: minZ - pad, maxZ: maxZ + pad },
    navBoxes(view, graph, shut),
    { cell: 0.25, radius: view.pawnRadius, height: view.pawnHeight, baseY },
  );
}

function wanderPose(world: AuthoritativeWorld, agent: WanderAgent): Pose | undefined {
  const view = world.store.view(agent.id);
  if (!view) return undefined;
  return {
    x: view.position.x,
    y: view.position.y,
    z: view.position.z,
    vx: view.velocity.x,
    vz: view.velocity.z,
    yaw: yawFromQuat(view.rotation),
  };
}

function followOthers(world: AuthoritativeWorld, agents: readonly WanderAgent[], self: number, radius: number): FollowPawn[] {
  const out: FollowPawn[] = [];
  for (const other of agents) {
    if (other.id === self) continue;
    const view = world.store.view(other.id);
    if (!view) continue;
    out.push({
      x: view.position.x,
      z: view.position.z,
      radius: view.radius > 0 ? view.radius : radius,
    });
  }
  return out;
}

export function startWanderLoop(
  world: AuthoritativeWorld,
  agents: WanderAgent[],
  server: EngineWsServer,
  held: HeldInputs,
  log: (line: string) => void = () => { },
  health?: PawnHealth,
  audit?: Audit,
  onTick?: () => void,
  hostNoclip = false,
  playerSpawns: readonly SpawnPick[] = [],
  /** Unowned wander pawns stay on their pads. Tests use this so a bot cannot cross a shot or a stair. */
  holdNpcs = false,
  /** Cab step. Rider ids skip input for this tick and ride through slabs. */
  elevators?: { step(dt: number): readonly number[] },
  wanderNav?: WanderNav,
): () => void {
  const rng = splitMix(20260917);
  const navCache = createNavCache();
  const snaps = hostSnapPath((clientId, envelope) => {
    server.sendSnapshot(clientId, envelope);
  });
  let tick = 0;
  let open = true;
  const timer = setInterval(() => {
    if (!open) return;
    tick += 1;
    const timedOut = new Set(server.gateway.drainTimeouts());
    for (const entity of timedOut) {
      world.clearInput(entity);
      held.drop(entity);
    }
    const owned = new Set<number>();
    for (const clientId of server.connected) {
      const record = server.gateway.get(clientId);
      if (record?.connected && record.ownedEntity !== undefined) owned.add(record.ownedEntity);
    }
    for (const entity of held.entities()) {
      if (!owned.has(entity)) held.drop(entity);
    }
    noteArenaInterest(server);
    const riders = elevators?.step(MOVE_DT) ?? [];
    const noclipIds: number[] = [];
    for (const agent of agents) {
      if (riders.includes(agent.id)) continue;
      if (timedOut.has(agent.id)) continue;
      if (health?.isDead(agent.id)) {
        if (agent.gait !== "fall") {
          agent.gait = "fall";
          // clearInput bumps the replication version. setClip alone does not,
          // so the clip would never leave this process. A grenade kill stays
          // on idle so the body does not play fall while it fades and beams out.
          const clip = health.lastDamage(agent.id)?.cause === "grenade" ? "idle" : "fall";
          world.enqueue({ kind: "setClip", entity: agent.id, clip, speed: 0 });
          world.enqueue({ kind: "clearInput", entity: agent.id });
        }
        continue;
      }
      if (agent.role === "player" && !owned.has(agent.id)) continue;
      if (owned.has(agent.id)) {
        const cmd = held.get(agent.id);
        const moveX = cmd?.moveX ?? 0;
        const moveZ = cmd?.moveZ ?? 0;
        // Owned look is the input yaw on this tick. Bots turn in stepUnownedWander.
        const yaw = cmd?.yaw ?? agent.heading;
        if (cmd) agent.heading = yaw;
        const fly = hostNoclip && cmd?.noclip === true;
        const moved = fly
          ? enqueueOwnedMove(world, agent.id, moveX, moveZ, yaw, { noclip: true, ascend: cmd?.ascend ?? 0, dt: MOVE_DT })
          : enqueueOwnedMove(world, agent.id, moveX, moveZ, yaw, MOVE_DT);
        if (fly) noclipIds.push(agent.id);
        if (moved) agent.gait = moved.gait;
        continue;
      }
      if (holdNpcs) continue;
      // The follower writes the path yaw. A fight keeps the heading the brain set.
      const fightYaw = agent.override?.stance === "angry" ? agent.heading : undefined;
      steerUnownedWander(
        world,
        agent,
        tick,
        rng,
        wanderNav,
        navCache,
        followOthers(world, agents, agent.id, wanderNav?.pawnRadius ?? 0.5),
      );
      if (fightYaw !== undefined) agent.heading = fightYaw;
      // The picked gait only scales the wish. The clip follows the eased speed.
      stepUnownedWander(world, agent);
    }
    if (health) {
      for (const id of health.takeRespawns()) respawnPawn(world, agents, id, playerSpawns);
    }
    const shielded = [...noclipIds, ...riders];
    const snap = shielded.length > 0
      ? commitShielded(world, BigInt(tick), shielded)
      : world.commit(BigInt(tick));
    try {
      onTick?.();
    } catch (err) {
      log(`[live] pickup ${err instanceof Error ? err.message : String(err)}`);
    }
    server.setTick(BigInt(tick));
    const envelopes = server.replicator.publish(world, snap);
    const snapped: number[] = [];
    for (const clientId of server.connected) {
      const env = envelopes.get(clientId);
      if (!env) continue;
      dispatchHostFrame(snaps, { type: "snap", clientId, envelope: env }, { to: `client:${clientId}`, kind: "snap" });
      snapped.push(clientId);
    }
    // Only changed or not-yet-seen rows leave; a new session gets every visible pawn once.
    if (health && snapped.length > 0) deliverHealthFrames(server, snapped, health.frames());
    if (audit) deliverAuditFrame(server, audit.frame());
    if (tick <= 3 || tick % 40 === 0) {
      log(`[live] ${JSON.stringify({
        t: tick,
        connected: server.connected,
        worldEntities: snap.entities.length,
      })}`);
    }
  }, TICK_MS);
  const handle = timer as { unref?: () => void };
  handle.unref?.();
  return () => {
    open = false;
    snaps.close();
    clearInterval(timer);
  };
}

/** Move a pawn that just became alive onto a free spawn. The shot itself does not write a transform. */
function respawnPawn(world: AuthoritativeWorld, agents: WanderAgent[], id: number, playerSpawns: readonly SpawnPick[]): void {
  const agent = agents.find((item) => item.id === id);
  if (agent) {
    agent.gait = "idle";
    if (wanderWalks.has(agent)) {
      clearWalk(agent);
      agent.nextTurn = 0;
    }
  }
  const pads = agent?.role === "player" ? playerSpawns : world.listSpawnPoints();
  const spawn = claimClearSpawn(world, id, pads);
  const view = world.store.view(id);
  if (!view || !spawn) {
    world.enqueue({ kind: "setClip", entity: id, clip: "idle", speed: 0 });
    return;
  }
  if (agent) agent.heading = spawn.yaw;
  placePawn(world, id, spawn);
  world.enqueue({ kind: "setClip", entity: id, clip: "idle", speed: 0 });
}

/**
 * First player pad clear of obstacles and other pawns. Respawn keeps the "first
 * pad anyway" fallback.
 * @pre `pending` is a pad already chosen for another pawn but not committed yet.
 * @post A pad that is still blocked is left unused.
 */
export function claimClearSpawn(
  world: AuthoritativeWorld,
  id: number,
  spawns: readonly SpawnPick[],
  pending: ReadonlyMap<number, SpawnPick> = new Map(),
): SpawnPick | undefined {
  const view = world.store.view(id);
  const radius = view && view.radius > 0 ? view.radius : 0.5;
  const height = Number.isFinite(world.pawnHeight) ? world.pawnHeight : 1.8;
  const pawns: BlockPawn[] = world.query().filter((entity) => entity.radius > 0).map((entity) => ({
    id: entity.id,
    x: entity.position.x,
    y: entity.position.y,
    z: entity.position.z,
    radius: entity.radius,
  }));
  for (const [entity, spawn] of pending) {
    const body = world.store.view(entity);
    pawns.push({
      id: entity,
      x: spawn.x,
      y: spawn.y,
      z: spawn.z,
      radius: body && body.radius > 0 ? body.radius : radius,
    });
  }
  const blockers = {
    self: id,
    radius,
    height,
    aabbs: world.listObstacles(),
    pawns,
  };
  const picked = pickRespawnSpawn(spawns, blockers);
  if (!picked) return undefined;
  if (blockers.aabbs.some((box) => pawnHitsBox(picked.x, picked.z, radius, picked.y, height, box))) return undefined;
  for (const pawn of pawns) {
    if (pawn.id === id) continue;
    const dx = picked.x - pawn.x;
    const dz = picked.z - pawn.z;
    if (Math.abs(picked.y - pawn.y) >= height) continue;
    const reach = radius + pawn.radius;
    if (dx * dx + dz * dz < reach * reach) return undefined;
  }
  return picked;
}

export function placePawn(world: AuthoritativeWorld, id: number, spawn: SpawnPick): void {
  const view = world.store.view(id);
  if (!view) return;
  world.enqueue({ kind: "clearInput", entity: id });
  world.enqueue({
    kind: "setTransform",
    entity: id,
    position: { x: spawn.x, y: spawn.y, z: spawn.z },
    rotation: yawQuaternion(spawn.yaw),
    scale: { x: view.scale.x, y: view.scale.y, z: view.scale.z },
  });
}

export type TeleportBlock = "bounds" | "blocked";

/**
 * Why this landing cannot be used.
 * @post `undefined` means the capsule is inside `bounds` and clear of static
 *       obstacles, including a shut door leaf. Another pawn nearby is not a
 *       reason.
 */
export function teleportBlockReason(
  world: AuthoritativeWorld,
  bounds: { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number },
  pawnId: number,
  x: number,
  y: number,
  z: number,
): TeleportBlock | undefined {
  const view = world.store.view(pawnId);
  const radius = view && view.radius > 0 ? view.radius : 0.5;
  const height = Number.isFinite(world.pawnHeight) ? world.pawnHeight : 1.8;
  const capsule = [x, y, z, radius, height, bounds.minX, bounds.maxX, bounds.minY, bounds.maxY, bounds.minZ, bounds.maxZ];
  if (!capsule.every(Number.isFinite)) return "bounds";
  const inside = x - radius >= bounds.minX && x + radius <= bounds.maxX
    && z - radius >= bounds.minZ && z + radius <= bounds.maxZ
    && y >= bounds.minY && y + height <= bounds.maxY;
  if (!inside) return "bounds";
  for (const box of world.listObstacles()) {
    const minY = box.minY;
    const maxY = box.maxY;
    if (typeof minY === "number" && typeof maxY === "number" && Number.isFinite(minY) && Number.isFinite(maxY)) {
      if (capsuleOverlapsAabb(x, y, z, radius, height, {
        minX: box.minX,
        maxX: box.maxX,
        minY,
        maxY,
        minZ: box.minZ,
        maxZ: box.maxZ,
      })) return "blocked";
      continue;
    }
    if (pawnHitsBox(x, z, radius, y, height, box)) return "blocked";
  }
  return undefined;
}

/** Replace the pawn mesh key. Ignored when `assetKey` is not one of `allowed`. */
export function applyPawnModel(world: AuthoritativeWorld, id: number, assetKey: string | undefined, allowed: readonly string[]): void {
  if (!assetKey || !allowed.includes(assetKey)) return;
  const view = world.store.view(id);
  const render = view?.render;
  if (!render || render.assetKey === assetKey) return;
  world.enqueue({
    kind: "setLifecycle",
    entity: id,
    render: { ...render, assetKey },
  });
}
