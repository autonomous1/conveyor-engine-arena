/**
 * 20 Hz executor. A GOAP plan becomes a route, a grid path, and world-space inputs.
 * Node-free: the same loop can run in the browser. The CLI owns sockets and argv.
 */
// ARCHITECTURE: The bot executor: goal claim, GOAP plan, route, walk, use, ride, and pickup state machine.
// Wiring: runMission/runBrain from the CLI and live tests; it drives BotSession input/world.
// Invariants: A pursue plan is rebuilt on >=1 m target drift or 200 ms; the straight line is the fallback.
import type { BotCtx } from "../../../src/shared/bots/actions.js";
import { createBotContext, estimateSeconds, groundActions } from "../../../src/shared/bots/actions.js";
import type { Fact, Goal, Plan, PlanOptions, WorldState } from "../../../src/shared/bots/goap.js";
import { chooseGoal } from "../../../src/shared/bots/goap.js";
import { buildWorldState, STAND, type WorldSnapshot } from "../../../src/shared/bots/state.js";
import { reach, standAt, type StandGoal } from "../../../src/shared/bots/goals.js";
import { INPUT_HZ, moveIntent } from "../../../src/shared/look.js";
import { MOVE_SPEED, type FloorBox } from "../../../src/shared/movements.js";
import { createFollower, doorStand, wishTo, type FollowInput, type FollowPawn, type Pose } from "../../../src/shared/nav/follow.js";
import { buildGrid, findLocalPath, navBoxes, specForPlace, type Grid } from "../../../src/shared/nav/grid.js";
import { createNavCache, planLegs, type PlanLegsOptions } from "../../../src/shared/nav/legs.js";
import { planPath } from "../../../src/shared/nav/path.js";
import { resolveStand, type DoorView, type Stand } from "../../../src/shared/nav/stand.js";
import type { BakedRegionsFile } from "../../../src/shared/nav/regions.js";
import { planRoute, type Gate } from "../../../src/shared/nav/route.js";
import { capsuleOverlapsAabb, pickupBoxSource, type PickupPlacement } from "../../../src/shared/pickups.js";
import { placeAt, stopOf, type SceneGraph, type ScenePortal } from "../../../src/shared/scene-graph.js";
import type { BotSession } from "./connection.js";
import type { Mission } from "./missions.js";
import { createMotionPredictor } from "./predict.js";
import { hasLineOfSightDag } from "../../../src/shared/hitscan.js";
import { nearestCover } from "../../../src/shared/bots/cover.js";

const STEP_MS = 1000 / INPUT_HZ;
const RIDE_SUMMON_MS = 30_000;
const RIDE_WAIT_MS = 60_000;
const RIDE_NEAR_M = 0.6;
const REPLAN_MS = 5_000;
/**
 * Budget for a periodic `safety` replan: the same state, warm route nets.
 */
const PLAN_BUDGET_MS = 250;
/**
 * Budget for a plan after the state changed: the mission's first plan, and the
 * first plan after a finished action, a door/pickup change, or a `stuck`.
 * `goap.plan` calls `h(start)` before its first `expired()` check, so a new
 * state's cold route compile is charged here; the 5-step patrol reach measures
 * 832–2000 ms cold (task 134), and the live stuck replan spent 291 ms compiling
 * before `expanded=0` (task 136). `safety` alone keeps the 250 ms.
 * @why A cap, not a delay: a goal that plans in 20 ms still returns in 20 ms.
 */
const COLD_PLAN_BUDGET_MS = 4_000;
/** Pursuit re-plan cadence (5 Hz), the intercept drift that forces one, and the lead cap. */
const PURSUE_REPLAN_MS = 200;
const PURSUE_DRIFT_M = 1;
/** Velocity window: the two-pose difference is too noisy to lead on. */
const PURSUE_WINDOW_MS = 400;
/** A target cannot be led further than this; the walker plans ~5 s ahead. */
const PURSUE_LEAD_M = 6;
/** Walk speed the follower's inputs produce: `wishTo`/`moveIntent` scale 1 at the host's MOVE_SPEED. */
const PURSUE_SPEED = MOVE_SPEED;
const GRAPH_WAIT_MS = 1_500;
const USE_WAIT_MS = 1_000;
const PICKUP_WAIT_MS = 2_000;
const NO_GRAPH = "no scene graph (token lacks scene-graph scope?)";

/**
 * Mission tuning: timeout, local prediction, log sinks, planner expansion caps,
 * and the per-plan budget.
 */
export type BrainOptions = {
  timeoutMs?: number;
  /** Integrate inputs locally. Default on. The browser client stays as it is. */
  predictOwned?: boolean;
  log?: (line: string) => void;
  error?: (line: string) => void;
  onTick?: () => void;
  /** Passed to `plan`. A huge expand budget still stops at `timeoutMs`. */
  maxExpand?: number;
  maxEvaluations?: number;
  /** Per-plan budget in ms. Default 250; the mission deadline still wins. */
  planMs?: number;
};

type TickStatus = "running" | "done" | "failed" | "stuck";

type Triple = [number, number, number];

type Running = {
  id: string;
  moving: boolean;
  started: number;
  tick(pose: Pose, tick: number, now: number): TickStatus;
  onDone?: () => void;
};

type Walk = {
  points: Triple[];
  grid: Grid;
  doorId?: string;
};

type UseState = {
  started: number;
  sent: boolean;
  second: boolean;
  secondAt: number;
};

/**
 * Run one goal, or loop a patrol until the timeout. Exit 0 met, 2 no plan, 3 timeout.
 */
export async function runMission(session: BotSession, mission: Mission, opts: BrainOptions = {}): Promise<number> {
  if (mission.kind === "goal") return runBrain(session, mission.goal, opts);
  if (mission.kind === "stand") return runBrain(session, standAt(mission.target), opts);
  if (mission.kind === "attack") return runAttack(session, mission.target, opts);
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const deadline = Date.now() + timeoutMs;
  let index = 0;
  while (Date.now() < deadline) {
    const goal = reach(mission.places[index]!);
    const code = await runBrain(session, goal, { ...opts, timeoutMs: deadline - Date.now() });
    if (code !== 0) return code;
    index = (index + 1) % mission.places.length;
  }
  return 3;
}

/**
 * Wait until this pawn owns `key` in the host claim table.
 * @post True when owned (and renews every 10 s while owned); false at the deadline.
 */
export async function claimGoal(
  session: BotSession,
  key: string,
  deadline: number,
  log: (line: string) => void,
): Promise<boolean> {
  session.claims.acquire(key, 30_000);
  let waited = false;
  for (;;) {
    const row = session.world.claims().get(key);
    const self = session.world.self();
    if (row && self && row.owner === self.id) {
      const renew = setInterval(() => session.claims.acquire(key, 30_000), 10_000);
      (renew as { unref?: () => void }).unref?.();
      (session as { __claimRenew?: ReturnType<typeof setInterval> }).__claimRenew = renew;
      return true;
    }
    if (!row) session.claims.acquire(key, 30_000);
    else if (!waited) {
      waited = true;
      log(`claim wait ${key} owner=${row.owner}`);
    }
    if (Date.now() >= deadline) return false;
    await delay(100);
  }
}

function playerOnSegment(
  from: { x: number; y: number; z: number },
  to: { x: number; y: number; z: number },
  player: { x: number; y: number; z: number },
  radius: number,
  height: number,
): boolean {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const len = dx * dx + dy * dy + dz * dz;
  if (!(len > 0)) return false;
  const t = Math.max(0, Math.min(1, ((player.x - from.x) * dx + (player.y - from.y) * dy + (player.z - from.z) * dz) / len));
  const x = from.x + dx * t;
  const y = from.y + dy * t;
  const z = from.z + dz * t;
  if (y < player.y - 0.05 || y > player.y + height + 0.05) return false;
  return Math.hypot(x - player.x, z - player.z) <= radius + 0.05;
}

function shutDoorBoxes(session: BotSession): Array<{ minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number }> {
  const boxes = [];
  for (const door of session.world.doors()) {
    if (door.open) continue;
    const body = session.world.doorBody(door.id);
    if (!body) continue;
    const [x, , z] = body.position;
    const [sx, sy, sz] = body.size;
    boxes.push({ minX: x - sx / 2, maxX: x + sx / 2, minY: 0, maxY: sy, minZ: z - sz / 2, maxZ: z + sz / 2 });
  }
  return boxes;
}

/** The compiled door wins: a shut leaf gates its portal, locked beats closed. */
function doorGate(session: BotSession): (portal: ScenePortal) => Gate {
  return (portal) => {
    if (portal.kind !== "door") return "open";
    const id = portal.door ?? portal.id;
    const door = session.world.door(id);
    if (!door) return portal.locked === true ? "locked" : "closed-unlocked";
    if (door.open) return "open";
    if (door.locked) return "locked";
    return "closed-unlocked";
  };
}

/**
 * Intercept point for a target moving at `velocity`, from `pose` at `speed`.
 * @post The point is ahead of the target along its velocity; the path stays 2D.
 * @why The velocity is a two-pose difference, so a snapshot jump can read as
 *      30 m/s; cap it at the walker's speed or the intercept leaves the graph.
 */
function interceptPoint(
  pose: { x: number; z: number },
  target: { x: number; z: number },
  velocity: { x: number; z: number },
  speed: number,
): { x: number; z: number } {
  const moving = Math.hypot(velocity.x, velocity.z);
  const k = moving > speed ? speed / moving : 1;
  const dir = moving > 1e-6 ? { x: (velocity.x * k) / moving, z: (velocity.z * k) / moving } : { x: 0, z: 0 };
  let t = Math.hypot(target.x - pose.x, target.z - pose.z) / speed;
  let x = target.x;
  let z = target.z;
  for (let i = 0; i < 3; i += 1) {
    const lead = Math.min(moving * t, PURSUE_LEAD_M);
    x = target.x + dir.x * lead;
    z = target.z + dir.z * lead;
    t = Math.hypot(x - pose.x, z - pose.z) / speed;
  }
  return { x, z };
}

/**
 * Plan a pursuit walk to the target's intercept point.
 * @post The intercept is ahead of the live target; the plan is 2D (the target's y is kept).
 * @why The polyline can detour around geometry the straight line cannot, and the
 *      intercept shortens the chase; the straight line stays the fallback.
 */
function planPursuit(
  session: BotSession,
  pose: Pose,
  target: { x: number; y: number; z: number },
  velocity: { x: number; z: number },
  cache: ReturnType<typeof createNavCache>,
): { points: Triple[]; grid: Grid; intercept: { x: number; z: number } } | undefined {
  const graph = session.world.sceneGraph();
  if (!graph) return undefined;
  const intercept = interceptPoint(pose, target, velocity, PURSUE_SPEED);
  const plan = planPath(graph, pose, { x: intercept.x, y: target.y, z: intercept.z }, doorGate(session), {
    view: navView(session, new Set()),
    cache,
    regions: bakedRegions(session),
  });
  if (!plan.ok) return undefined;
  const points = plan.points.map(triple);
  return { points, grid: gridFor(session, graph, points, new Set(), placeY(graph, pose)), intercept };
}

/**
 * Shoot a named pawn until its health frame says dead, it disappears, the bot
 * runs out of ammo or dies, or the deadline passes.
 * @post Returns 0 on dead, 2 on refused/lost/no_ammo/died/no_dag/retreat, 3 on
 *       timeout; no shot whose eye-to-target corridor contains a player.
 */
export async function runAttack(session: BotSession, targetId: number, opts: BrainOptions = {}): Promise<number> {
  const log = opts.log ?? (() => {});
  const self = session.world.self();
  if (!self) return 2;
  if (targetId === self.id || session.world.playerIds().has(targetId)) {
    log("attack: refused");
    return 2;
  }
  if (!session.world.others().some((pawn) => pawn.id === targetId)) {
    log("attack: lost");
    return 2;
  }
  const dag = session.world.spatialDag();
  if (!dag) {
    log("attack: no_dag");
    return 2;
  }
  const initial = session.world.healthOf(targetId);
  if (initial?.dead === true) {
    log("attack: dead");
    return 0;
  }
  if (!session.world.weapon() || session.world.ammo() <= 0) {
    log("attack: no_ammo");
    return 2;
  }
  const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
  // Policy knobs live here, not at module scope, so the codemap delta of this
  // change stays a line shift.
  /**
   * Fire band: inside it stand and shoot, closer back-step, farther pursue.
   * @why point-blank fighting at respawn time is how the 125 hunts died.
   */
  const FIRE_MIN_M = 12;
  const FIRE_MAX_M = 18;
  /**
   * The body turns before the shot.
   * @why the fire frame's yaw is authoritative, so the body must turn first or the
   *      shot leaves a sideways pawn.
   */
  const FACE_SETTLE_MS = 150;
  const FACE_RAD = 0.05;
  /** Hold cover when wounded; break contact when nearly dead or surrounded. */
  const COVER_REACH_M = 0.6;
  const RETREAT_HP = 25;
  const RETREAT_THREATS = 2;
  const RETREAT_THREAT_M = 8;
  const RETREAT_ESCAPE_M = 18;
  const RETREAT_MAX_MS = 6_000;
  const STANDOFF_LOG_MS = 500;
  /** Non-player pawns within `radius` of `me`. */
  const threatsNear = (me: { x: number; z: number }, radius: number): number => {
    const players = session.world.playerIds();
    let count = 0;
    for (const pawn of session.world.others()) {
      if (players.has(pawn.id)) continue;
      if (Math.hypot(pawn.x - me.x, pawn.z - me.z) <= radius) count += 1;
    }
    return count;
  };
  /**
   * Back away from the threat centroid (or `fallback` when none is near) until the
   * nearest threat is out of range, the retreat cap passes, or the deadline does.
   */
  const retreatFrom = async (me: { x: number; z: number }, fallback: { x: number; z: number }, until: number): Promise<void> => {
    const players = session.world.playerIds();
    let sumX = 0;
    let sumZ = 0;
    let count = 0;
    for (const pawn of session.world.others()) {
      if (players.has(pawn.id)) continue;
      if (Math.hypot(pawn.x - me.x, pawn.z - me.z) > RETREAT_THREAT_M) continue;
      sumX += pawn.x;
      sumZ += pawn.z;
      count += 1;
    }
    const from = count > 0 ? { x: sumX / count, z: sumZ / count } : fallback;
    const away = Math.atan2(me.x - from.x, me.z - from.z);
    while (Date.now() < until) {
      const nowSelf = session.world.self();
      if (!nowSelf) return;
      let nearest = Infinity;
      for (const pawn of session.world.others()) {
        if (players.has(pawn.id)) continue;
        nearest = Math.min(nearest, Math.hypot(pawn.x - nowSelf.x, pawn.z - nowSelf.z));
      }
      if (nearest > RETREAT_ESCAPE_M) return;
      session.input.sendInput({ ...moveIntent(away, 1, 0), yaw: away });
      await delay(50);
    }
  };
  const cache = createNavCache();
  let approached = false;
  let nextFire = 0;
  let nextStandoffLog = 0;
  let facing = false;
  /** Chosen cover point while wounded; `broken` samples the target's LOS. */
  let coverHold: { x: number; z: number; broken: boolean | undefined } | undefined;
  let tick = 0;
  const seen: Array<{ x: number; z: number; at: number }> = [];
  let pursuit: { follower: ReturnType<typeof createFollower>; target: { x: number; z: number }; at: number } | undefined;
  let fallbackLogged = false;
  log("attack: acquire");
  while (Date.now() < deadline) {
    const now = Date.now();
    const me = session.world.self();
    if (!me) return 2;
    const target = session.world.others().find((pawn) => pawn.id === targetId);
    if (!target) {
      log("attack: lost");
      return 2;
    }
    seen.push({ x: target.x, z: target.z, at: now });
    while (seen.length > 1 && now - seen[0]!.at > PURSUE_WINDOW_MS) seen.shift();
    const oldest = seen[0]!;
    const windowMs = now - oldest.at;
    const velocity = windowMs > 0
      ? { x: ((target.x - oldest.x) * 1000) / windowMs, z: ((target.z - oldest.z) * 1000) / windowMs }
      : { x: 0, z: 0 };
    if (session.world.healthOf(targetId)?.dead === true) {
      log("attack: dead");
      return 0;
    }
    if (session.world.health()?.dead === true) {
      log("attack: died");
      return 2;
    }
    const health = session.world.health();
    const eye = { x: me.x, y: me.y + session.world.pawnHeight * 0.8, z: me.z };
    const targetPoint = { x: target.x, y: target.y + session.world.pawnHeight * 0.75, z: target.z };
    const dx = targetPoint.x - eye.x;
    const dz = targetPoint.z - eye.z;
    const range = Math.hypot(dx, dz);
    const los = hasLineOfSightDag(dag, eye, targetPoint);
    // Fight or flee before trading: a nearly dead or surrounded bot breaks contact.
    const threats = threatsNear(me, RETREAT_THREAT_M);
    if (health && (health.hp < RETREAT_HP || threats >= RETREAT_THREATS)) {
      log(`attack: retreat hp=${health.hp} threats=${threats}`);
      // The retreat shares the attack deadline; `now` is this tick's clock.
      await retreatFrom(me, target, Math.min(deadline, now + RETREAT_MAX_MS));
      return 2;
    }
    // Wounded: reach the cover point once, then hold it without firing.
    if (health && health.hp < 50) {
      if (!coverHold) {
        const cover = nearestCover(dag, session.world.sceneGraph(), me, target, { dynamic: shutDoorBoxes(session) });
        if (cover) coverHold = { x: cover.x, z: cover.z, broken: undefined };
      }
      const hold = coverHold;
      if (hold) {
        if (Math.hypot(hold.x - me.x, hold.z - me.z) > COVER_REACH_M) {
          const yaw = Math.atan2(hold.x - me.x, hold.z - me.z);
          session.input.sendInput({ ...moveIntent(yaw, 1, 0), yaw });
        } else {
          const broken = !hasLineOfSightDag(dag, eye, targetPoint);
          if (broken !== hold.broken) {
            hold.broken = broken;
            log(`attack: cover hold hp=${health.hp} broken=${broken}`);
          }
        }
        await delay(100);
        continue;
      }
    } else {
      coverHold = undefined;
    }
    if (session.world.ammo() <= 0) {
      log("attack: no_ammo");
      return 2;
    }
    if (range > FIRE_MAX_M || !los) {
      const pose: Pose = { x: me.x, y: me.y, z: me.z, vx: 0, vz: 0, yaw: me.yaw };
      const stale = pursuit === undefined
        || now - pursuit.at >= PURSUE_REPLAN_MS
        || Math.hypot(pursuit.target.x - target.x, pursuit.target.z - target.z) >= PURSUE_DRIFT_M;
      if (stale) {
        const planned = planPursuit(session, pose, target, velocity, cache);
        if (planned) {
          // Stamp after planning so the 200 ms cadence starts when the plan exists.
          const plannedAt = Date.now();
          pursuit = {
            follower: createFollower(planned.points, planned.grid, { radius: session.world.pawnRadius }),
            target: { x: target.x, z: target.z },
            at: plannedAt,
          };
          log(`attack: pursue plan to=${planned.intercept.x.toFixed(2)},${planned.intercept.z.toFixed(2)} target=${target.x.toFixed(2)},${target.z.toFixed(2)} range=${range.toFixed(1)} steps=${planned.points.length}`);
          fallbackLogged = false;
        } else {
          pursuit = undefined;
        }
      }
      if (pursuit) {
        tick += 1;
        const step = pursuit.follower.step(pose, otherPawns(session), tick);
        session.input.sendInput(step.input);
        if (step.status !== "running") pursuit = undefined;
      } else {
        const yaw = Math.atan2(dx, dz);
        session.input.sendInput({ ...moveIntent(yaw, 1, 0), yaw });
        if (!fallbackLogged) {
          fallbackLogged = true;
          log("attack: straight fallback");
        }
      }
      if (!approached) { approached = true; log("attack: approach"); }
    } else {
      const aimYaw = Math.atan2(dx, dz);
      const pitch = Math.atan2(targetPoint.y - eye.y, range);
      if (Math.abs(angleDiff(me.yaw, aimYaw)) > FACE_RAD) {
        if (!facing) {
          facing = true;
          log(`attack: face yaw=${aimYaw.toFixed(2)} pose=${me.yaw.toFixed(2)}`);
        }
        session.input.sendInput({ moveX: 0, moveZ: 0, yaw: aimYaw });
        await delay(FACE_SETTLE_MS);
        continue;
      }
      if (range < FIRE_MIN_M) {
        session.input.sendInput({ ...moveIntent(aimYaw, -1, 0), yaw: aimYaw });
        if (now >= nextStandoffLog) {
          nextStandoffLog = now + STANDOFF_LOG_MS;
          log(`attack: standoff range=${range.toFixed(1)}`);
        }
      } else if (now >= nextFire) {
        const player = session.world.others().find((pawn) => session.world.playerIds().has(pawn.id)
          && playerOnSegment(eye, targetPoint, pawn, session.world.pawnRadius, session.world.pawnHeight));
        if (player) {
          log(`attack: friendly_blocked id=${player.id}`);
        } else {
          nextFire = now + 250;
          session.input.fire(aimYaw, pitch);
          log(`attack: fire range=${range.toFixed(1)} los=${los ? "yes" : "no"} yaw=${aimYaw.toFixed(2)}`);
        }
      }
    }
    await delay(50);
  }
  log("attack: timeout");
  return 3;
}

/**
 * Claim the goal id when the host supports claims, run the executor, and release
 * the claim on every exit.
 * @post 0 met, 2 no plan/target, 3 timeout or lost claim.
 */
export async function runBrain(session: BotSession, goal: Goal, opts: BrainOptions = {}): Promise<number> {
  const key = goal.id;
  const supported = session.world.claimsSupported?.() === true;
  if (supported && session.world.self() !== undefined) {
    const claimed = await claimGoal(session, key, Date.now() + (opts.timeoutMs ?? 300_000), opts.log ?? (() => {}));
    if (!claimed) return 3;
    try {
      return await runBrainInner(session, goal, opts);
    } finally {
      clearInterval((session as { __claimRenew?: ReturnType<typeof setInterval> }).__claimRenew);
      session.claims.release?.(key);
    }
  }
  return runBrainInner(session, goal, opts);
}

async function runBrainInner(session: BotSession, goal: Goal, opts: BrainOptions = {}): Promise<number> {
  const log = opts.log ?? (() => {});
  const error = opts.error ?? (() => {});
  const deadline = Date.now() + (opts.timeoutMs ?? 300_000);
  const startedAt = Date.now();
  const secs = () => ((Date.now() - startedAt) / 1000).toFixed(2);
  if (!(await waitForGraph(session, deadline, error))) return 2;

  let stand: Stand | undefined;
  const standTarget = (goal as Partial<StandGoal>).stand;
  if (standTarget) {
    const graph = session.world.sceneGraph();
    const views: DoorView[] = [];
    for (const state of session.world.doors()) {
      const body = session.world.doorBody(state.id);
      if (body) views.push({ ...body, open: state.open, locked: state.locked });
    }
    const self = session.world.self();
    stand = graph ? resolveStand(standTarget, graph, views, self ? { from: { x: self.x, y: self.y, z: self.z } } : {}) : undefined;
    if (!stand) {
      error("stand: no target");
      return 2;
    }
  }

  const predictor = createMotionPredictor(opts.predictOwned !== false);
  const cache = createNavCache();
  const collected = new Set<string>();
  let sticky: string | undefined;
  let actions: ReturnType<typeof groundActions> = [];
  let ctx: BotCtx | undefined;
  let placements: ReturnType<BotSession["world"]["pickupPlacements"]> = [];
  let grounded = "";
  let plan: Plan | undefined;
  let exec: Running | undefined;
  let pending = "";
  let watchDoors = "";
  let watchPickups = "";
  let planAt = 0;
  let tick = 0;
  let stuckCount = 0;
  let failStreak = 0;
  let lastCmd: FollowInput | undefined;
  let lastReason = "initial";

  const ensureGround = (): boolean => {
    const graph = session.world.sceneGraph();
    if (!graph) return false;
    const hash = session.world.sceneGraphHash() ?? "local";
    if (ctx && hash === grounded) return true;
    placements = session.world.pickupPlacements();
    actions = groundActions(graph, placements, [goal], stand);
    ctx = createBotContext(graph, placements, {
      position: () => {
        const self = session.world.self();
        return self ? { x: self.x, y: self.y, z: self.z } : undefined;
      },
    });
    grounded = hash;
    return true;
  };

  const here = (): string | undefined => {
    const self = session.world.self();
    if (!self) return undefined;
    return session.world.placeOf(self)?.id;
  };

  const snapshot = (moving: boolean): WorldSnapshot => {
    const place = here();
    const at = moving ? (place ?? "outside") : (sticky ?? place ?? "outside");
    const held = new Set<string>(session.world.keys());
    for (const id of collected) held.add(id);
    return {
      at,
      pickups: session.world.pickups(),
      heldKeys: [...held],
      doors: session.world.doors(),
      weapon: session.world.weapon(),
      ammo: session.world.ammo(),
    };
  };

  const worldState = (): WorldState => {
    const state: Record<string, Fact> = { ...buildWorldState(snapshot(false)) };
    const self = session.world.self();
    if (stand && self && Math.hypot(self.x - stand.x, self.z - stand.z) <= 0.35 &&
        Math.abs(angleDiff(self.yaw, stand.yaw)) <= 0.35) state[STAND] = stand.key;
    return state;
  };

  const send = (command: FollowInput): void => {
    // `createFollower` / `wishTo` already ran `moveIntent`. These axes are world-space.
    lastCmd = command;
    session.input.sendInput(command);
  };

  const gate = doorGate(session);

  const poseNow = (): Pose | undefined => {
    const auth = session.world.self();
    const steered = predictor.advance(auth, lastCmd, floorBoxes(session), session.world.pawnRadius);
    const src = steered ?? auth;
    if (!src) return undefined;
    return {
      x: src.x,
      y: src.y,
      z: src.z,
      vx: steered?.vx ?? 0,
      vz: steered?.vz ?? 0,
      yaw: src.yaw,
    };
  };

  const finish = (row: Running, failed = false): void => {
    const dt = ((Date.now() - row.started) / 1000).toFixed(2);
    log(`finish ${row.id} t=${secs()}s dt=${dt}s${failed ? " failed" : ""}`);
  };

  const begin = (id: string, pose: Pose): Running | undefined => {
    const cut = id.indexOf(":");
    const kind = cut < 0 ? id : id.slice(0, cut);
    const arg = cut < 0 ? "" : id.slice(cut + 1);
    if (kind === "goTo") return beginGoTo(id, arg, pose);
    if (kind === "standAt") return beginStand(id, arg, pose);
    if (kind === "ride") return beginRide(id, arg, pose);
    if (kind === "rideTo") return beginRide(id, arg, pose, true);
    if (kind === "goToDoor") return beginDoor(id, arg, pose);
    if (kind === "unlock") return beginUnlock(id, arg, pose);
    if (kind === "pickup") return beginPickup(id, arg, pose);
    return undefined;
  };

  const beginGoTo = (id: string, place: string, pose: Pose): Running | undefined => {
    const walked = walkToPlace(place, pose);
    if (!walked) return undefined;
    let phase: "walk" | "use" = "walk";
    let use: UseState | undefined;
    const follow = makeFollow(walked);
    return {
      id,
      moving: phase === "walk",
      started: Date.now(),
      onDone() {
        sticky = undefined;
      },
      tick(current, nowTick, now) {
        if (phase === "walk" && !walked.doorId && here() === place) return "done";
        if (phase === "use" && walked.doorId && use) {
          this.moving = false;
          return pressDoor(session, walked.doorId, use, current, now, send, false);
        }
        const step = follow.step(current, otherPawns(session), nowTick);
        send(step.input);
        if (step.status === "stuck") return "stuck";
        if (step.status === "arrived") {
          if (walked.doorId) {
            phase = "use";
            this.moving = false;
            use = { started: now, sent: false, second: false, secondAt: 0 };
            return "running";
          }
          return here() === place ? "done" : "failed";
        }
        return "running";
      },
    };
  };

  const beginStand = (id: string, key: string, pose: Pose): Running | undefined => {
    if (!stand || stand.key !== key) return undefined;
    const walked = walkToPoint(pose, stand, new Set());
    if (!walked) return undefined;
    const follow = makeFollow(walked);
    let stopped = false;
    return {
      id,
      moving: true,
      started: Date.now(),
      tick(current, nowTick) {
        const self = session.world.self();
        if (self && Math.hypot(self.x - stand.x, self.z - stand.z) <= 0.25) {
          if (!stopped) {
            stopped = true;
            send({ moveX: 0, moveZ: 0, yaw: stand.yaw });
          }
          return "done";
        }
        const step = follow.step(current, otherPawns(session), nowTick);
        send(step.input);
        if (step.status === "stuck") return "stuck";
        if (step.status === "arrived") {
          if (!stopped) {
            stopped = true;
            send({ moveX: 0, moveZ: 0, yaw: stand.yaw });
          }
          return "done";
        }
        return "running";
      },
    };
  };

  const beginRide = (id: string, arg: string, pose: Pose, byGoal = false): Running | undefined => {
    const graph = session.world.sceneGraph();
    if (!graph) return undefined;
    let portal: ScenePortal | undefined;
    let reverse = false;
    let from: { shaft: string; index: number } | undefined;
    let to: { shaft: string; index: number } | undefined;
    if (byGoal) {
      const cut = arg.indexOf(":");
      const shaft = cut >= 0 ? arg.slice(0, cut) : "";
      const goalStop = cut >= 0 ? arg.slice(cut + 1) : arg;
      const shaftPlace = graph.placeById.get(shaft) as { stops?: readonly number[] } | undefined;
      if (!shaftPlace?.stops) return undefined;
      const self = session.world.self();
      const here = self ? session.world.placeOf(self)?.id : undefined;
      const hereStop = here ? stopOf(here) : undefined;
      let fromIndex = hereStop?.index;
      if (fromIndex === undefined && self) {
        let best = Infinity;
        for (let i = 0; i < shaftPlace.stops.length; i += 1) {
          const d = Math.abs(shaftPlace.stops[i]! - self.y);
          if (d < best) { best = d; fromIndex = i; }
        }
      }
      if (fromIndex === undefined) return undefined;
      const fromId = `${shaft}@${fromIndex}`;
      portal = graph.portals.find((item) => item.kind === "elevator"
        && ((item.a === fromId && item.b === goalStop) || (item.b === fromId && item.a === goalStop)));
      if (!portal) return undefined;
      reverse = portal.b === fromId;
      from = stopOf(reverse ? portal.b : portal.a);
      to = stopOf(reverse ? portal.a : portal.b);
    } else {
      // `ride:<up|down>:<portalId>`, and live portal ids contain a colon themselves.
      const cut = arg.indexOf(":");
      const direction = cut >= 0 ? arg.slice(0, cut) : "up";
      const portalId = cut >= 0 ? arg.slice(cut + 1) : arg;
      reverse = direction === "down";
      portal = graph.portals.find((item) => item.kind === "elevator" && item.id === portalId);
      if (!portal) return undefined;
      from = stopOf(reverse ? portal.b : portal.a);
      to = stopOf(reverse ? portal.a : portal.b);
    }
    if (!portal || !from || !to || from.shaft !== to.shaft) return undefined;
    const shaftPlace = graph.placeById.get(from.shaft);
    if (!shaftPlace) return undefined;
    const landingAt = reverse ? portal.at.b : portal.at.a;
    const destinationAt = reverse ? portal.at.a : portal.at.b;
    const landing = { x: landingAt[0], y: landingAt[1], z: landingAt[2] };
    const destination = { x: destinationAt[0], y: destinationAt[1], z: destinationAt[2] };
    let phase: "landing" | "summon" | "enter" | "exit" = "landing";
    let waitAt = Date.now();
    const firstWalk = walkToPoint(pose, landing, new Set());
    if (!firstWalk) return undefined;
    let follow = makeFollow(firstWalk);
    let exitFollow: ReturnType<typeof makeFollow> | undefined;
    let exitDestination = destination;
    return {
      id,
      moving: true,
      started: Date.now(),
      tick(current, nowTick, now) {
        const self = session.world.self();
        if (!self) return "running";
        const cab = session.world.cabs().find((item) => item.id === from.shaft);
        const atLanding = Math.hypot(self.x - landing.x, self.z - landing.z) <= RIDE_NEAR_M;
        if (phase === "landing") {
          this.moving = true;
          if (atLanding) {
            phase = "summon";
            waitAt = now;
            session.input.callElevator(from.shaft, from.index);
            return "running";
          }
          const step = follow.step(current, otherPawns(session), nowTick);
          send(step.input);
          return step.status === "stuck" ? "stuck" : "running";
        }
        if (phase === "summon") {
          this.moving = false;
          if (cab && cab.at === from.index && cab.phase === "idle") {
            const centre = cabCentre(shaftPlace.polygon, cab.y);
            const enterWalk = walkToPoint(current, centre, new Set());
            if (!enterWalk) return "failed";
            follow = makeFollow(enterWalk);
            phase = "enter";
            return "running";
          }
          if (now - waitAt > RIDE_SUMMON_MS) return "failed";
          return "running";
        }
        if (phase === "enter") {
          this.moving = true;
          if (session.world.placeOf(self)?.id === from.shaft) {
            phase = "exit";
            waitAt = now;
            session.input.callElevator(from.shaft, to.index);
            return "running";
          }
          const step = follow.step(current, otherPawns(session), nowTick);
          send(step.input);
          return step.status === "stuck" ? "stuck" : step.status === "arrived" ? "failed" : "running";
        }
        // Ride, then step out: wait for the destination stop and open doors.
        if (!(cab && cab.at === to.index && cab.phase === "idle")) {
          if (now - waitAt > RIDE_WAIT_MS) return "failed";
          return "running";
        }
        this.moving = true;
        if (!exitFollow) {
          const target = rideExitTarget(session, shaftPlace, from.shaft, landing, destination, cab.y);
          const outWalk = walkToPoint(current, target, new Set());
          if (!outWalk) return "failed";
          exitFollow = makeFollow(outWalk);
          exitDestination = target;
        }
        if (Math.hypot(self.x - exitDestination.x, self.z - exitDestination.z) <= RIDE_NEAR_M) return "done";
        const step = exitFollow.step(current, otherPawns(session), nowTick);
        send(step.input);
        return step.status === "stuck" ? "stuck" : "running";
      },
    };
  };

  const beginDoor = (id: string, arg: string, pose: Pose): Running | undefined => {
    // `goToDoor:<door>:<place>` names the side; the door is the part before it.
    const doorId = arg.includes(":") ? arg.slice(0, arg.indexOf(":")) : arg;
    const stand = chooseStand(doorId, undefined, pose);
    if (!stand) return undefined;
    const walked = walkToPoint(pose, stand, new Set());
    if (!walked) return undefined;
    const follow = makeFollow(walked);
    return {
      id,
      moving: true,
      started: Date.now(),
      onDone() {
        sticky = `door:${doorId}`;
      },
      tick(current, nowTick) {
        const self = session.world.self();
        if (self && Math.hypot(self.x - stand.x, self.z - stand.z) <= 0.3) return "done";
        const step = follow.step(current, otherPawns(session), nowTick);
        send(step.input);
        if (step.status === "stuck") return "stuck";
        if (step.status === "arrived") return "done";
        return "running";
      },
    };
  };

  const beginUnlock = (id: string, doorId: string, pose: Pose): Running | undefined => {
    const body = session.world.doorBody(doorId);
    if (!body) return undefined;
    const stand = chooseStand(doorId, undefined, pose);
    const face = stand ?? { x: body.position[0], y: pose.y, z: body.position[2] };
    const use: UseState = { started: Date.now(), sent: false, second: false, secondAt: 0 };
    let armed = false;
    return {
      id,
      moving: false,
      started: Date.now(),
      tick(current, _tick, now) {
        const self = session.world.self();
        const near = !!self && Math.hypot(self.x - face.x, self.z - face.z) <= 0.35;
        if (!near) {
          send(wishTo(current, face, 1));
          if (now - use.started > 8_000) return "failed";
          return "running";
        }
        if (!armed) {
          armed = true;
          use.started = now;
        }
        return pressDoor(session, doorId, use, current, now, send, true);
      },
    };
  };

  const beginPickup = (id: string, pickupId: string, pose: Pose): Running | undefined => {
    const item = session.world.pickupPlacements().find((row) => row.id === pickupId);
    if (!item) return undefined;
    const center = {
      x: (item.minX + item.maxX) / 2,
      y: pose.y,
      z: (item.minZ + item.maxZ) / 2,
    };
    const omit = new Set([pickupBoxSource(pickupId), pickupId]);
    const walked = walkToPoint(pose, center, omit);
    if (!walked) return undefined;
    const follow = makeFollow(walked);
    let waitStart = 0;
    return {
      id,
      moving: true,
      started: Date.now(),
      onDone() {
        collected.add(pickupId);
        sticky = `pickup:${pickupId}`;
      },
      tick(current, nowTick, now) {
        if (pickupTaken(session, item)) return "done";
        const self = session.world.self();
        const touching = !!self && capsuleOverlapsAabb(
          self.x, self.y, self.z, session.world.pawnRadius, session.world.pawnHeight, item,
        );
        const step = follow.step(current, otherPawns(session), nowTick);
        if (step.status === "arrived" || touching) {
          if (waitStart === 0) waitStart = now;
          send(wishTo(current, center, touching ? 0.35 : 1));
          if (now - waitStart > PICKUP_WAIT_MS) return "failed";
          return step.status === "stuck" ? "stuck" : "running";
        }
        send(step.input);
        if (step.status === "stuck") return "stuck";
        return "running";
      },
    };
  };

  const walkToPlace = (place: string, pose: Pose): Walk | undefined => {
    const graph = session.world.sceneGraph();
    if (!graph) return undefined;
    const route = planRoute(graph, pose, place, gate);
    if (!route.ok) return undefined;
    if (route.steps.length > 0 && route.steps.every((step) => step.portal.kind === "elevator")) return undefined;
    const cut = route.steps.findIndex((step) => step.portal.kind === "door" && gate(step.portal) === "closed-unlocked");
    if (cut >= 0) {
      const step = route.steps[cut]!;
      const doorId = step.portal.door ?? step.portal.id;
      const stand = chooseStand(doorId, { x: step.enter[0], z: step.enter[2] }, pose);
      if (!stand) return undefined;
      const walked = walkToPoint(pose, stand, new Set());
      if (!walked) return undefined;
      return { ...walked, doorId };
    }
    if (route.steps.length === 0) {
      if (here() === place) {
        const points: Triple[] = [[pose.x, pose.y, pose.z]];
        return { points, grid: gridFor(session, graph, points, new Set(), placeY(graph, pose)) };
      }
      return undefined;
    }
    const legs = planLegs(graph, navView(session, new Set()), route, pose, legOpts(session, cache));
    if (!legs.ok) return undefined;
    const points = legs.points.map(triple);
    return { points, grid: gridFor(session, graph, points, new Set(), placeY(graph, pose)) };
  };

  const walkToPoint = (
    pose: Pose,
    target: { x: number; y: number; z: number },
    omit: ReadonlySet<string>,
  ): Walk | undefined => {
    const graph = session.world.sceneGraph();
    if (!graph) return undefined;
    const plan = planPath(graph, pose, target, gate, {
      view: navView(session, omit),
      cache,
      regions: bakedRegions(session),
    });
    if (!plan.ok) {
      log(`no plan: ${plan.reason}`);
      return undefined;
    }
    const points = plan.points.map(triple);
    return { points, grid: gridFor(session, graph, points, omit, placeY(graph, pose)) };
  };

  const chooseStand = (
    doorId: string,
    hint: { x: number; z: number } | undefined,
    pose: Pose,
  ): { x: number; y: number; z: number } | undefined => {
    const body = session.world.doorBody(doorId);
    const graph = session.world.sceneGraph();
    if (!body || !graph) return undefined;
    let best: { x: number; y: number; z: number } | undefined;
    let bestScore = Infinity;
    for (const side of ["in", "out"] as const) {
      const stand = doorStand(body, side);
      const place = placeAt(graph, stand.x, stand.y, stand.z).id;
      const route = planRoute(graph, pose, place, gate);
      if (!route.ok) continue;
      if (route.steps.some((step) => step.portal.kind === "door" && gate(step.portal) !== "open")) continue;
      const score = hint
        ? Math.hypot(stand.x - hint.x, stand.z - hint.z)
        : route.cost + Math.hypot(stand.x - pose.x, stand.z - pose.z);
      if (score < bestScore) {
        bestScore = score;
        best = { x: stand.x, y: stand.y, z: stand.z };
      }
    }
    return best;
  };

  while (Date.now() < deadline) {
    const loopStart = Date.now();
    if (!session.world.self() || !ensureGround() || !ctx) {
      await sleepRest(loopStart);
      continue;
    }
    const activePickup = exec && exec.id.startsWith("pickup:") ? exec.id.slice("pickup:".length) : undefined;
    if (exec && activePickup && pickupGone(session, activePickup)) {
      const item = session.world.pickupPlacements().find((row) => row.id === activePickup);
      if (item && pickupTaken(session, item)) {
        exec.onDone?.();
        finish(exec);
        pending = `${exec.id} finished`;
        exec = undefined;
        plan = undefined;
      }
    }
    const pose = poseNow();
    if (!pose) {
      await sleepRest(loopStart);
      continue;
    }
    const state = worldState();
    if (satisfies(state, goal.want)) return 0;

    const parts = watchParts(session);
    let reason = "";
    if (!plan) reason = pending || "initial";
    else if (Date.now() - planAt >= REPLAN_MS) reason = "safety";
    else if (parts.doors !== watchDoors) reason = "door";
    else if (parts.pickups !== watchPickups && !activePickup) reason = "pickup";

    if (reason) {
      const groundedCtx = ctx;
      if (!groundedCtx) return 2;
      // A macrotask between replans so the timeout and the socket can run.
      await delay(0);
      if (Date.now() >= deadline) return 3;
      if (reason !== "initial") log(`replan ${reason} t=${secs()}s`);
      // The cold cap follows the state change: `safety` is the only periodic
      // same-state refresh, so only it stays on the warm budget.
      const budgetMs = opts.planMs ?? (reason === "safety" ? PLAN_BUDGET_MS : COLD_PLAN_BUDGET_MS);
      const planDeadline = Math.min(deadline, Date.now() + budgetMs);
      const planOpts: PlanOptions = {
        minCost: groundedCtx.minActionS,
        heuristic: estimateSeconds(goal, groundedCtx, placements, stand),
        deadlineMs: planDeadline,
        now: () => Date.now(),
        ...(opts.maxExpand !== undefined ? { maxExpand: opts.maxExpand } : {}),
        ...(opts.maxEvaluations !== undefined ? { maxEvaluations: opts.maxEvaluations } : {}),
      };
      log("plan start");
      const planStarted = Date.now();
      plan = chooseGoal(state, [goal], actions, groundedCtx, planOpts);
      const planMs = Date.now() - planStarted;
      log(`plan done ${planMs}ms steps=${plan?.steps.length ?? 0} expanded=${plan?.expanded ?? 0}`);
      exec = undefined;
      stuckCount = 0;
      watchDoors = parts.doors;
      watchPickups = parts.pickups;
      planAt = Date.now();
      pending = "";
      lastReason = reason;
      if (!plan) {
        log(`no plan: ${noPlanReason(session, stand?.place ?? placeWanted(goal), pose, gate)}`);
        return satisfies(worldState(), goal.want) ? 0 : 2;
      }
    } else {
      watchPickups = parts.pickups;
    }

    const id = plan?.steps[0];
    if (!plan || !id) {
      pending = "plan exhausted";
      plan = undefined;
      opts.onTick?.();
      await sleepRest(loopStart);
      continue;
    }
    if (!exec || exec.id !== id) {
      const created = begin(id, pose);
      if (!created) {
        failStreak += 1;
        log(`start ${id} t=${secs()}s reason=${lastReason}`);
        log(`finish ${id} t=${secs()}s dt=0.00s failed`);
        if (failStreak >= 2) return 2;
        pending = `${id} failed`;
        plan = undefined;
        exec = undefined;
        opts.onTick?.();
        await sleepRest(loopStart);
        continue;
      }
      failStreak = 0;
      exec = created;
      log(`start ${id} t=${secs()}s reason=${lastReason}`);
      lastReason = "plan";
    }
    const result = exec.tick(pose, tick, Date.now());
    tick += 1;
    if (result === "done") {
      exec.onDone?.();
      finish(exec);
      pending = `${exec.id} finished`;
      plan = undefined;
      exec = undefined;
      stuckCount = 0;
    } else if (result === "failed") {
      finish(exec, true);
      pending = `${exec.id} failed`;
      plan = undefined;
      exec = undefined;
      stuckCount = 0;
    } else if (result === "stuck") {
      stuckCount += 1;
      if (stuckCount >= 2) {
        pending = "stuck";
        plan = undefined;
        exec = undefined;
        stuckCount = 0;
      }
    } else {
      stuckCount = 0;
    }
    opts.onTick?.();
    await sleepRest(loopStart);
  }
  return 3;

  function makeFollow(walked: Walk): { step(pose: Pose, others: readonly FollowPawn[], nowTick: number): ReturnType<ReturnType<typeof createFollower>["step"]> } {
    return createFollower(walked.points, walked.grid, { radius: session.world.pawnRadius });
  }
}

async function waitForGraph(session: BotSession, deadline: number, error: (line: string) => void): Promise<boolean> {
  const giveUp = Math.min(deadline, Date.now() + GRAPH_WAIT_MS);
  while (!session.world.sceneGraph()) {
    const scope = session.world.scope();
    if (scope && !scope.includes("scene-graph")) {
      error(NO_GRAPH);
      return false;
    }
    if (Date.now() >= giveUp) {
      error(NO_GRAPH);
      return false;
    }
    await delay(STEP_MS);
  }
  return true;
}

/** Face the leaf with `wishTo` (scale 0 holds) and press use. The host opens a lock in one press; a shut unlocked leaf gets a second press. */
function pressDoor(
  session: BotSession,
  doorId: string,
  use: UseState,
  pose: Pose,
  now: number,
  send: (command: FollowInput) => void,
  unlock: boolean,
): TickStatus {
  const body = session.world.doorBody(doorId);
  const door = session.world.door(doorId);
  if (!body || !door) return "failed";
  send(wishTo(pose, { x: body.position[0], z: body.position[2] }, 0));
  const press = (): boolean => session.input.use();
  if (unlock) {
    if (!door.locked && door.open) return "done";
    if (door.locked) {
      if (!use.sent) {
        if (press()) use.sent = true;
        else if (now - use.started > USE_WAIT_MS) return "failed";
        return "running";
      }
      if (now - use.started > USE_WAIT_MS) return "failed";
      return "running";
    }
    if (door.open) return "done";
    if (!use.second) {
      if (press()) {
        use.second = true;
        use.secondAt = now;
      } else if (now - use.started > USE_WAIT_MS) return "failed";
      return "running";
    }
    if (now - use.secondAt > USE_WAIT_MS) return "failed";
    return "running";
  }
  if (door.open) return "done";
  if (!use.sent) {
    if (press()) use.sent = true;
    else if (now - use.started > USE_WAIT_MS) return "failed";
    return "running";
  }
  if (now - use.started > USE_WAIT_MS) return "failed";
  return "running";
}

function watchParts(session: BotSession): { doors: string; pickups: string } {
  return {
    doors: session.world.doors().map((door) => `${door.id}:${door.open ? 1 : 0}:${door.locked ? 1 : 0}`).join(","),
    pickups: [...session.world.pickups()].sort().join(","),
  };
}

function pickupGone(session: BotSession, id: string): boolean {
  return !session.world.pickups().includes(id);
}

function pickupTaken(session: BotSession, item: PickupPlacement): boolean {
  if (session.world.pickups().includes(item.id)) return false;
  if (item.kind === "key" && !session.world.keys().includes(item.id)) return false;
  return true;
}

function otherPawns(session: BotSession): FollowPawn[] {
  const radius = session.world.pawnRadius;
  return session.world.others().map((pawn) => ({ x: pawn.x, z: pawn.z, radius }));
}

function floorBoxes(session: BotSession): FloorBox[] {
  return session.world.aabbs.map((box) => ({
    minX: box.minX,
    maxX: box.maxX,
    minZ: box.minZ,
    maxZ: box.maxZ,
    ...(box.minY !== undefined ? { minY: box.minY } : {}),
    ...(box.maxY !== undefined ? { maxY: box.maxY } : {}),
  }));
}

function bakedRegions(session: BotSession): BakedRegionsFile | undefined {
  const read = (session.world as { regions?: () => BakedRegionsFile | undefined }).regions;
  return read ? read() : undefined;
}

function legOpts(session: BotSession, cache: ReturnType<typeof createNavCache>): PlanLegsOptions {
  const regions = bakedRegions(session);
  return regions ? { cache, regions } : { cache };
}

function navView(session: BotSession, omit: ReadonlySet<string>) {
  const bodies = session.world.doors();
  const byId = new Map(bodies.map((door) => [door.id, door]));
  return {
    aabbs: session.world.aabbs.filter((box) => !box.source || !omit.has(box.source)),
    doors: doorList(session).map((door) => {
      const live = byId.get(door.id);
      return live ? { ...door, open: live.open, locked: live.locked } : door;
    }),
    pawnRadius: session.world.pawnRadius,
    pawnHeight: session.world.pawnHeight,
  };
}

function doorList(session: BotSession): Array<{
  id: string;
  model: string;
  position: [number, number, number];
  yaw: number;
  hinge: "left" | "right";
  size: [number, number, number];
  open: boolean;
  locked: boolean;
  key?: string;
}> {
  const out = [];
  for (const state of session.world.doors()) {
    const body = session.world.doorBody(state.id);
    if (!body) continue;
    out.push({
      ...body,
      open: state.open,
      locked: state.locked,
    });
  }
  if (out.length > 0) return out;
  return [];
}

function outsideGridFor(
  session: BotSession,
  graph: SceneGraph,
  omit: ReadonlySet<string>,
  cache: ReturnType<typeof createNavCache>,
): Grid | undefined {
  const spec = specForPlace(graph, "outside");
  if (!spec) return undefined;
  const view = navView(session, omit);
  const shut = new Set<string>();
  for (const door of view.doors) if (!door.open) shut.add(door.id);
  // 0.25 m is ~288 ms for the whole outside (220k cells); 0.5 m is ~166 ms.
  const key = `outside|${[...omit].sort().join(",")}|${[...shut].sort().join(",")}|${view.pawnRadius}|${view.pawnHeight}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const grid = buildGrid(spec.area, navBoxes(view, graph, shut), {
    cell: 0.5,
    radius: view.pawnRadius,
    height: view.pawnHeight,
    baseY: spec.baseY,
    block: spec.block,
  });
  cache.set(key, grid);
  return grid;
}

function rideExitTarget(
  session: BotSession,
  shaftPlace: object,
  shaft: string,
  landing: { x: number; y: number; z: number },
  destination: { x: number; y: number; z: number },
  cabY: number,
): { x: number; y: number; z: number } {
  const room = (shaftPlace as { room?: string }).room;
  if (room) {
    for (const state of session.world.doors()) {
      if (!state.id.startsWith(`${room}.`)) continue;
      const body = session.world.doorBody(state.id);
      if (!body) continue;
      for (const side of ["out", "in"] as const) {
        const stand = doorStand(body, side);
        const point = { x: stand.x, y: cabY, z: stand.z };
        const place = session.world.placeOf(point)?.id;
        if (place && place !== shaft) return point;
      }
    }
  }
  // No usable room door: step past the in-cab landing, away from its centre.
  const dx = destination.x - landing.x;
  const dz = destination.z - landing.z;
  const len = Math.hypot(dx, dz);
  if (len > 1e-6) return { x: destination.x + (dx / len) * 2, y: cabY, z: destination.z + (dz / len) * 2 };
  return { x: destination.x, y: cabY, z: destination.z };
}

function cabCentre(polygon: ReadonlyArray<readonly [number, number]>, y: number): { x: number; y: number; z: number } {
  if (polygon.length === 0) return { x: 0, y, z: 0 };
  let x = 0;
  let z = 0;
  for (const point of polygon) {
    x += point[0];
    z += point[1];
  }
  return { x: x / polygon.length, y, z: z / polygon.length };
}

function gridFor(
  session: BotSession,
  graph: SceneGraph,
  points: readonly Triple[],
  omit: ReadonlySet<string>,
  baseY: number,
): Grid {
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
  const area = { minX: minX - pad, maxX: maxX + pad, minZ: minZ - pad, maxZ: maxZ + pad };
  const view = navView(session, omit);
  const shut = new Set<string>();
  for (const door of view.doors) if (!door.open) shut.add(door.id);
  return buildGrid(area, navBoxes(view, graph, shut), {
    cell: 0.25,
    radius: view.pawnRadius,
    height: view.pawnHeight,
    baseY,
  });
}

function placeY(graph: SceneGraph, pose: Pose): number {
  const place = placeAt(graph, pose.x, pose.y, pose.z);
  return place.kind === "outside" ? 0 : place.y;
}

function triple(point: Triple | { x: number; y: number; z: number }): Triple {
  if (Array.isArray(point)) return [point[0], point[1], point[2]];
  return [point.x, point.y, point.z];
}

function pushPoint(out: Triple[], point: Triple): void {
  const last = out[out.length - 1];
  if (last && Math.abs(last[0] - point[0]) < 1e-3 && Math.abs(last[2] - point[2]) < 1e-3) return;
  out.push([point[0], point[1], point[2]]);
}

function angleDiff(a: number, b: number): number {
  let diff = a - b;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return diff;
}

function satisfies(state: WorldState, want: WorldState): boolean {
  for (const key in want) if ((state[key] ?? false) !== want[key]) return false;
  return true;
}

/** The place a goal names, if any (`at` for reach goals; stand goals use the stand). */
function placeWanted(goal: Goal): string | undefined {
  const at = goal.want.at;
  return typeof at === "string" ? at : undefined;
}

/**
 * Why the plan was empty. A goal behind a locked door whose key is not held is
 * named `door-locked`; anything else stays `unsatisfiable`.
 * @post Lowercase-hyphen, matching the command host's `no plan: ([a-z-]+)` capture.
 */
function noPlanReason(session: BotSession, place: string | undefined, pose: Pose, gate: (portal: ScenePortal) => Gate): string {
  if (!place) return "unsatisfiable";
  const graph = session.world.sceneGraph();
  if (!graph || !graph.placeById.has(place)) return "unsatisfiable";
  const route = planRoute(graph, pose, place, gate);
  const alt = route.lockedAlternative;
  if (!alt || alt.doors.length === 0) return "unsatisfiable";
  const held = new Set(session.world.keys());
  const blocked = alt.doors.some((door) => door.key === undefined || !held.has(door.key));
  return blocked ? "door-locked" : "unsatisfiable";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sleepRest(started: number): Promise<void> {
  const left = STEP_MS - (Date.now() - started);
  if (left > 0) await delay(left);
}
