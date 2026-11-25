/**
 * 20 Hz executor. A GOAP plan becomes a route, a grid path, and world-space inputs.
 * Node-free: the same loop can run in the browser. The CLI owns sockets and argv.
 */
// ARCHITECTURE: The bot executor: goal claim, GOAP plan, route, walk, use, ride, and pickup state machine.
// Wiring: runMission/runBrain from the CLI and live tests; it drives BotSession input/world.
// Invariants: A pursue plan is rebuilt on >=1 m target drift or 200 ms; the straight line is the fallback;
//   the retreat plans one cover/away point, replans only on stuck/a cover LOS failure, and holds when no
//   point plans; the stand fact and the stand walk measure one plan-resolved goal, y included;
//   every plan-step kind has one binder in STEP_BINDERS, and a step's kind/arg are set by its
//   binder, never re-parsed from the id; a `safety` plan gets PLAN_BUDGET_MS, and a missed warm
//   attempt retries once at COLD_PLAN_BUDGET_MS; the combat ladder plans through
//   combatGoals/chooseCombatGoal with the combat actions (test: combat_ladder_matrices).
import type { BotCtx } from "../../../src/shared/bots/actions.js";
import { createBotContext, estimateSeconds, goTo, groundActions, pickup, placeOfPickup } from "../../../src/shared/bots/actions.js";
import type { Action, Fact, Goal, Plan, PlanOptions, WorldState } from "../../../src/shared/bots/goap.js";
import { chooseGoal } from "../../../src/shared/bots/goap.js";
import { buildWorldState, STAND, type WorldSnapshot } from "../../../src/shared/bots/state.js";
import { reach, standAt, type StandGoal } from "../../../src/shared/bots/goals.js";
import { EYE_HEIGHT, INPUT_HZ, moveIntent } from "../../../src/shared/look.js";
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
import { assaultGoal, chooseCombatGoal, combatActions, combatFacts, combatGoals, combatHeuristic, threatWatchKey, type HpClock } from "./combat.js";

const STEP_MS = 1000 / INPUT_HZ;
const RIDE_SUMMON_MS = 30_000;
const RIDE_WAIT_MS = 60_000;
const RIDE_NEAR_M = 0.6;
const REPLAN_MS = 5_000;
/** A pawn this far above its place's base stands on a raised surface (a crate top). */
const RAISED_EPS = 0.05;
/** XZ distance and yaw tolerance for the stand fact and the stand action's done check. */
const STAND_TOLERANCE = 0.35;
/** Y tolerance for the stand goal: the follower's `WAYPOINT_Y` (nav/follow.ts) — a 0.5 m step passes, a 4 m gap fails. */
const STAND_GOAL_Y = 0.6;
/**
 * Budget for a periodic `safety` replan: the same state, warm route nets.
 * The route heuristic's warm plans measure 79–259 ms; 250 ms sits inside that
 * distribution, so a plan that missed it fell to the 4 s cold retry (177).
 * 600 ms removes the retry for the measured plans.
 * @invariant `safety` plans get PLAN_BUDGET_MS; a missed warm attempt retries
 *            once at COLD_PLAN_BUDGET_MS. (test: warm_plan_budget_is_600ms)
 */
const PLAN_BUDGET_MS = 600;
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
  /** 199: the declared hostile player ids (SquadView v1). Absent = NPCs only. */
  enemies?: ReadonlySet<number>;
};

type TickStatus = "running" | "done" | "failed" | "stuck";

type Triple = [number, number, number];

type Running = {
  id: string;
  /** The binder that built it, and its raw argument: the executor's typed binding (177). */
  kind: string;
  arg: string;
  moving: boolean;
  started: number;
  tick(pose: Pose, tick: number, now: number): TickStatus;
  onDone?: () => void;
};

/** One plan-step kind to its binder. `arg` is everything after the first `:`. */
type StepBinder = (id: string, arg: string, pose: Pose) => Running | undefined;

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
 * The patrol leg policy (201), pure so the matrix can drive it.
 * - 0 → advance;
 * - 2 with a `no plan:` line → retry the leg once, then skip it (or stop after 2
 *   consecutive skips);
 * - any other 2 (refused/lost/no-ammo/died) or 3 → propagate.
 */
export type PatrolLegOutcome = { action: "advance" | "retry" | "skip" | "stop" | "propagate"; consecutiveSkips: number };

export function patrolLegOutcome(
  code: number,
  noPlan: string | null,
  consecutiveSkips: number,
  retried: boolean,
): PatrolLegOutcome {
  if (code === 0) return { action: "advance", consecutiveSkips: 0 };
  if (code === 2 && noPlan !== null) {
    if (!retried) return { action: "retry", consecutiveSkips };
    const skips = consecutiveSkips + 1;
    return skips >= 2 ? { action: "stop", consecutiveSkips: skips } : { action: "skip", consecutiveSkips: skips };
  }
  return { action: "propagate", consecutiveSkips };
}

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
  let consecutiveSkips = 0;
  while (Date.now() < deadline) {
    const place = mission.places[index]!;
    // One leg = one `reach(place)`; the ladder inside runBrain pre-empts for
    // combat and the leg resumes because its `at` fact is still unmet (201).
    let noPlan: string | null = null;
    const legLog = (line: string): void => {
      opts.log?.(line);
      const m = /no plan: ([a-z-]+)/.exec(line);
      if (m) noPlan = m[1]!;
    };
    let code = await runBrain(session, reach(place), { ...opts, timeoutMs: deadline - Date.now(), log: legLog });
    let retried = false;
    let outcome = patrolLegOutcome(code, noPlan, consecutiveSkips, retried);
    if (outcome.action === "retry") {
      retried = true;
      let retryNoPlan: string | null = null;
      code = await runBrain(session, reach(place), {
        ...opts,
        timeoutMs: deadline - Date.now(),
        log: (line) => {
          opts.log?.(line);
          const m = /no plan: ([a-z-]+)/.exec(line);
          if (m) retryNoPlan = m[1]!;
        },
      });
      outcome = patrolLegOutcome(code, retryNoPlan, consecutiveSkips, retried);
    }
    if (outcome.action === "propagate") return code;
    if (outcome.action === "stop") {
      opts.log?.(`patrol: stop after ${outcome.consecutiveSkips} dead legs`);
      return 2;
    }
    if (outcome.action === "skip") {
      opts.log?.(`patrol: skip leg=${place} reason=${noPlan ?? "unknown"}`);
      consecutiveSkips = outcome.consecutiveSkips;
      index = (index + 1) % mission.places.length;
      continue;
    }
    consecutiveSkips = 0;
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
 * Plan a walk to one point and return its points/grid for `createFollower`.
 * @why Task 177: the retreat picks one escape/cover point and walks it once;
 *      this is `planPursuit`'s `planPath` → `createFollower` shape without the
 *      interception prediction.
 */
function planToPoint(
  session: BotSession,
  pose: Pose,
  point: { x: number; z: number; y?: number },
  cache: ReturnType<typeof createNavCache>,
): { points: Triple[]; grid: Grid } | undefined {
  const graph = session.world.sceneGraph();
  if (!graph) return undefined;
  const plan = planPath(graph, pose, { x: point.x, y: point.y ?? pose.y, z: point.z }, doorGate(session), {
    view: navView(session, new Set()),
    cache,
    regions: bakedRegions(session),
  });
  if (!plan.ok) return undefined;
  const points = plan.points.map(triple);
  return { points, grid: gridFor(session, graph, points, new Set(), placeY(graph, pose)) };
}

/**
 * Shoot a named pawn until its health frame says dead, it disappears, the bot
 * runs out of ammo or dies, or the deadline passes.
 * @post Returns 0 on dead, 2 on refused/lost/no_ammo/died/no_dag/retreat, 3 on
 *       timeout; no shot whose eye-to-target corridor contains a player. The
 *       retreat plans one cover/away point and holds when none plans.
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
    // Interim teams: every player is friendly, every NPC is the enemy. The
    // future two-team model replaces this with a team id (see the report); until
    // then a teammate must not count as a threat.
    let count = 0;
    for (const pawn of session.world.others()) {
      if (session.world.playerIds().has(pawn.id)) continue;
      if (Math.hypot(pawn.x - me.x, pawn.z - me.z) <= radius) count += 1;
    }
    return count;
  };
  /**
   * Back away from the threat centroid (or `fallback` when none is near) until the
   * nearest threat is out of range, the retreat cap passes, or the deadline does.
   * @why Cover first, then one planned away point: the cover is the retreat's real
   *      goal, and one plan avoids the 176 250 ms replan loop. When no candidate
   *      plans, the pawn holds instead of steering blindly into a wall.
   */
  const retreatFrom = async (me: { x: number; y: number; z: number }, fallback: { x: number; y: number; z: number }, until: number): Promise<void> => {
    const graph = session.world.sceneGraph();
    // Interim teams: the players are friendly, the NPCs are the enemy. The
    // threat centroid, the nearest-threat exit and the cover attacker are the
    // enemy NPCs only; a teammate never counts. The future two-team model
    // replaces this with a team id.
    let sumX = 0;
    let sumZ = 0;
    let count = 0;
    let nearestEnemy: { x: number; y: number; z: number } | undefined;
    let enemyD = Infinity;
    for (const pawn of session.world.others()) {
      if (session.world.playerIds().has(pawn.id)) continue;
      const d = Math.hypot(pawn.x - me.x, pawn.z - me.z);
      if (d <= RETREAT_THREAT_M) {
        sumX += pawn.x;
        sumZ += pawn.z;
        count += 1;
      }
      if (d < enemyD) {
        enemyD = d;
        nearestEnemy = { x: pawn.x, y: pawn.y, z: pawn.z };
      }
    }
    const from = count > 0 ? { x: sumX / count, z: sumZ / count } : fallback;
    const attacker = nearestEnemy ?? fallback;
    const away = Math.atan2(me.x - from.x, me.z - from.z);
    const pose = (): Pose => {
      const self = session.world.self();
      return { x: self?.x ?? me.x, y: self?.y ?? me.y, z: self?.z ?? me.z, vx: 0, vz: 0, yaw: self?.yaw ?? 0 };
    };
    // Cover first: a spot the attacker cannot see is the retreat's real goal.
    const cover = dag && graph
      ? nearestCover(dag, graph, { x: me.x, y: me.y, z: me.z }, attacker, { dynamic: shutDoorBoxes(session) })
      : undefined;
    const candidates: Array<{ x: number; z: number; kind: "cover" | "away" }> = [];
    if (cover) {
      candidates.push({ x: cover.x, z: cover.z, kind: "cover" });
      log(`attack: retreat cover attacker=${attacker.x.toFixed(2)},${attacker.z.toFixed(2)} to=${cover.x.toFixed(2)},${cover.z.toFixed(2)}`);
    } else {
      log("attack: retreat cover none");
    }
    for (const distance of [RETREAT_ESCAPE_M, 14, 10, 6]) {
      for (const side of [0, 0.5, -0.5]) {
        const a = away + side;
        candidates.push({ x: me.x + Math.sin(a) * distance, z: me.z + Math.cos(a) * distance, kind: "away" });
      }
    }
    interface RetreatPlan { follower: ReturnType<typeof createFollower>; point: { x: number; z: number }; kind: "cover" | "away" }
    const cache = createNavCache();
    const tried = new Set<string>();
    let plan: RetreatPlan | undefined;
    const choose = (): boolean => {
      for (const c of candidates) {
        const key = `${c.x.toFixed(2)},${c.z.toFixed(2)}`;
        if (tried.has(key)) continue;
        tried.add(key);
        const planned = planToPoint(session, pose(), c, cache);
        if (!planned) {
          if (c.kind === "cover") log(`attack: retreat cover unreachable to=${c.x.toFixed(2)},${c.z.toFixed(2)}`);
          continue;
        }
        plan = {
          follower: createFollower(planned.points, planned.grid, { radius: session.world.pawnRadius }),
          point: c,
          kind: c.kind,
        };
        log(`attack: retreat plan kind=${c.kind} to=${c.x.toFixed(2)},${c.z.toFixed(2)}`);
        return true;
      }
      return false;
    };
    if (!choose()) {
      log("attack: retreat no-plan hold");
      return;
    }
    let tick = 0;
    while (Date.now() < until) {
      opts.onTick?.();
      const nowSelf = session.world.self();
      if (!nowSelf) return;
      let nearest = Infinity;
      for (const pawn of session.world.others()) {
        if (session.world.playerIds().has(pawn.id)) continue;
        nearest = Math.min(nearest, Math.hypot(pawn.x - nowSelf.x, pawn.z - nowSelf.z));
      }
      if (nearest > RETREAT_ESCAPE_M) return;
      const step = plan!.follower.step(pose(), otherPawns(session), ++tick);
      session.input.sendInput(step.input);
      if (step.status !== "running") {
        if (step.status === "arrived" && plan!.kind === "cover") {
          // The cover test picked the point; verify the attacker's sight line
          // from where the bot actually stopped.
          const eye = { x: nowSelf.x, y: nowSelf.y + EYE_HEIGHT, z: nowSelf.z };
          const broken = !hasLineOfSightDag(dag, { x: attacker.x, y: attacker.y + EYE_HEIGHT, z: attacker.z }, eye);
          log(`attack: retreat cover reached los=${broken ? "no" : "yes"}`);
          if (broken) return;
        } else if (step.status === "arrived") {
          return;
        } else {
          log("attack: retreat replan reason=stuck");
        }
        plan = undefined;
        if (!choose()) {
          log("attack: retreat no-plan hold");
          return;
        }
      }
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
    opts.onTick?.();
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

  /**
   * @why `planPath` may snap the goal up to 1 m to a free cell with that floor's
   *      y; the STAND fact and `beginStand` must measure the plan's point, or the
   *      action finishes where the fact can never latch (the 151 climb loop).
   *      Reset by each `beginStand`, which re-plans from the current pose.
   */
  let resolvedStand: { x: number; y: number; z: number; yaw: number } | undefined;

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
  let watchThreat = "";
  let threatReplanAt = 0;
  let planAt = 0;
  let tick = 0;
  let stuckCount = 0;
  let failStreak = 0;
  let lastCmd: FollowInput | undefined;
  let lastReason = "initial";
  /** The caller-owned hp clock for `underFire` (a drop within 1.5 s). */
  let hpClock: HpClock = { hp: 100, at: -Infinity };

  /**
   * The grounding union: the mission, the ladder's wants (so `hasAmmo` pulls the
   * gear pickups) and every health crate's place, so `goTo:<crate place>` and
   * `seekHealth` exist whichever goal wins. The set is stable per map.
   */
  const groundGoalsNow = (): Goal[] => {
    const goals: Goal[] = [goal];
    if (stand) goals.push(reach(stand.place));
    const ladderWants: WorldState[] = [{ hpHigh: true }, { inCover: true }, { threatDown: true }];
    for (const want of ladderWants) {
      goals.push({ id: `ground:${Object.keys(want)[0]}`, want, priority: () => 0 });
    }
    const graph = session.world.sceneGraph();
    if (graph) {
      const available = new Set(session.world.pickups());
      // The crates' *places*, not a `hasAmmo` want: the combat reload/seekHealth
      // action needs `goTo:<place>`, but grounding every gear pickup also adds
      // `pickup:<crate>` (eff `at=<place>`) as a cheap mission shortcut (188).
      for (const item of session.world.pickupPlacements()) {
        if ((item.kind !== "health" && item.kind !== "ammo") || !available.has(item.id)) continue;
        goals.push({ id: `ground:crate:${item.id}`, want: { at: placeOfPickup(graph, item) }, priority: () => 0 });
      }
    }
    return goals;
  };

  /** The assault order's pawn id, when the mission is one. */
  const missionTarget = (): number | undefined => {
    const match = /^assault:(\d+)$/.exec(goal.id);
    return match ? Number(match[1]) : undefined;
  };
  const ensureGround = (): boolean => {
    const graph = session.world.sceneGraph();
    if (!graph) return false;
    const hash = session.world.sceneGraphHash() ?? "local";
    if (ctx && hash === grounded) return true;
    placements = session.world.pickupPlacements();
    // The union: the combat ladder adds places a mission-shaped grounding would
    // miss (a health crate is neither a key nor gear).
    const groundStarted = performance.now();
    actions = groundActions(graph, placements, groundGoalsNow(), stand);
    // Shared `groundActions` drops keys no locked door names (`pickupsInOrder`
    // keeps only the ranked keys), so the new arena's four routine keys cannot
    // be planned: `retrieve:key-<n>` grounds no `pickup:key-<n>` and starves the
    // cold budget (192). Append the mission's own holding pickup and its place;
    // the shared fix is a coder task.
    const holdingId = Object.keys(goal.want).find((k) => k.startsWith("holding:") && goal.want[k] === true);
    if (holdingId) {
      const id = holdingId.slice("holding:".length);
      if (!actions.some((a) => a.id === `pickup:${id}`)) {
        const item = placements.find((row) => row.id === id);
        if (item) {
          const place = placeOfPickup(graph, item);
          if (!actions.some((a) => a.id === `goTo:${place}`)) actions.push(goTo(place));
          actions.push(pickup(item, place));
        }
      }
    }
    // A closed-but-unlocked door is not in the goal-shaped set (it grounds only
    // locked doors with a key), so a route out of the building cannot plan
    // around it: the 192-hunt reload planned a 1-step, 3.1 s route to an outside
    // ammo box from inside. Merge the unlocked-door actions from the full set;
    // locked doors stay the union's job (a key must be held to unlock).
    const lockedDoors = new Set(
      graph.portals.filter((portal) => portal.kind === "door" && portal.locked === true).map((portal) => portal.door ?? portal.id),
    );
    const doorActions = groundActions(graph, placements, undefined)
      .filter((act) => act.id.startsWith("goToDoor:") && !lockedDoors.has(act.id.slice("goToDoor:".length).split(":")[0]!));
    let doorAdded = 0;
    for (const act of doorActions) {
      if (actions.some((row) => row.id === act.id)) continue;
      actions.push(act);
      doorAdded += 1;
    }
    // A `hasAmmo` order must use the combat `reload:<crate>` (which pays the
    // walk); the shared `pickup:<ammo>` costs a flat ACT_S, ignoring the route,
    // so it collapsed the floor and made the rearm search a 248-action Dijkstra
    // (192-hunt 19:19: a 2-step plan missed the 4 s budget; found at 8 s as a
    // room-pickup detour). Drop those pickups for this order only.
    if (goal.want.hasAmmo === true && !Object.keys(goal.want).some((k) => k.startsWith("holding:"))) {
      const ammoIds = new Set(placements.filter((item) => item.kind === "ammo").map((item) => item.id));
      const before = actions.length;
      actions = actions.filter((act) => !(act.id.startsWith("pickup:") && ammoIds.has(act.id.slice("pickup:".length))));
      if (before !== actions.length) log(`ground drop-ammo-pickups=${before - actions.length}`);
    }
    log(`ground actions=${actions.length} unlocked-doors=+${doorAdded} ms=${(performance.now() - groundStarted).toFixed(1)}`);
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
    // `at` is where the pawn is while an action moves; the door token is only
    // for the moment an action ended on that spot. A stale token is 20 m and
    // ~100 ms wrong, and a safety replan cannot afford it (162).
    const state: Record<string, Fact> = {
      ...buildWorldState(snapshot(exec?.moving === true)),
      ...combatFacts(session, hpClock, Date.now(), { missionTarget: missionTarget() ?? undefined, enemies: opts.enemies }),
    };
    const self = session.world.self();
    if (stand && resolvedStand && self && Math.hypot(self.x - resolvedStand.x, self.z - resolvedStand.z) <= STAND_TOLERANCE &&
        Math.abs(self.y - resolvedStand.y) <= STAND_GOAL_Y &&
        Math.abs(angleDiff(self.yaw, resolvedStand.yaw)) <= STAND_TOLERANCE) state[STAND] = stand.key;
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

  const beginGoTo = (id: string, place: string, pose: Pose): Running | undefined => {
    const walked = walkToPlace(place, pose);
    if (!walked) return undefined;
    let phase: "walk" | "use" = "walk";
    let use: UseState | undefined;
    const follow = makeFollow(walked);
    return {
      id,
      kind: "goTo",
      arg: place,
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

  /** Keep the fact and the walk on the plan's last point; `planPath` may snap it. */
  const resolveStandGoal = (walked: Walk): void => {
    if (!stand) return;
    const last = walked.points[walked.points.length - 1];
    resolvedStand = last
      ? { x: last[0], y: last[1], z: last[2], yaw: stand.yaw }
      : { x: stand.x, y: stand.y, z: stand.z, yaw: stand.yaw };
  };

  const beginStand = (id: string, key: string, pose: Pose): Running | undefined => {
    if (!stand || stand.key !== key) return undefined;
    const walked = walkToPoint(pose, stand, new Set());
    if (!walked) return undefined;
    resolveStandGoal(walked);
    const goal = resolvedStand;
    if (!goal) return undefined;
    // At the goal's XZ but off its floor: no walk can finish here. Fail the
    // start so the brain's fail streak returns the mission instead of spinning.
    const here0 = session.world.self();
    if (here0 && Math.hypot(here0.x - goal.x, here0.z - goal.z) <= STAND_TOLERANCE &&
        Math.abs(here0.y - goal.y) > STAND_GOAL_Y) return undefined;
    const follow = makeFollow(walked);
    let stopped = false;
    return {
      id,
      kind: "standAt",
      arg: key,
      moving: true,
      started: Date.now(),
      tick(current, nowTick) {
        const self = session.world.self();
        if (self && Math.hypot(self.x - goal.x, self.z - goal.z) <= STAND_TOLERANCE) {
          if (Math.abs(self.y - goal.y) > STAND_GOAL_Y) return "failed";
          if (!stopped) {
            stopped = true;
            send({ moveX: 0, moveZ: 0, yaw: goal.yaw });
          }
          return "done";
        }
        const step = follow.step(current, otherPawns(session), nowTick);
        send(step.input);
        if (step.status === "stuck") return "stuck";
        if (step.status === "arrived") {
          if (!stopped) {
            stopped = true;
            send({ moveX: 0, moveZ: 0, yaw: goal.yaw });
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
      kind: byGoal ? "rideTo" : "ride",
      arg: arg,
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
      kind: "goToDoor",
      arg: arg,
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
      kind: "unlock",
      arg: doorId,
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
    const last = walked.points[walked.points.length - 1];
    // @why A plan ending below the item's box (or with the feet above its top)
    //      can never take it; fail now instead of pressing under it for 30 s.
    if (last && (last[1] + session.world.pawnHeight < item.minY || last[1] > item.maxY)) {
      log(`pickup: no floor for ${pickupId} (plan ends y=${last[1].toFixed(2)}, item y=${item.minY.toFixed(2)}..${item.maxY.toFixed(2)})`);
      return undefined;
    }
    const follow = makeFollow(walked);
    let waitStart = 0;
    return {
      id,
      kind: "pickup",
      arg: pickupId,
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
    // On a raised surface the last stretch is planned on the pawn's own floor:
    // `planPath` builds its destination grid at the place's base, so a crate-top
    // target (the outside base is 0) would be snapped to the ground and the
    // walk would go down the crate (task 154's pickup fall). Snap the target on
    // the feet-floor grid first; planPath then keeps the local path up there.
    let goal = target;
    if (pose.y > floorBase(graph, pose) + RAISED_EPS && target.y >= pose.y - RAISED_EPS) {
      const grid = gridFor(session, graph, [[pose.x, pose.y, pose.z], [target.x, target.y, target.z]], omit, pose.y);
      const snapped = nearestFreeCell(grid, target.x, target.z, 1, pose.y);
      if (snapped) goal = { x: snapped.x, y: pose.y, z: snapped.z };
    }
    const plan = planPath(graph, pose, goal, gate, {
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

  /**
   * Walk to a point encoded as `x,z`: cover and retreat share it.
   * @post `done` on arrival within 0.6 m; `stuck` when the follower stalls.
   */
  const beginWalkPoint = (id: string, arg: string, pose: Pose, kind: string): Running | undefined => {
    const [rawX, rawZ] = arg.split(",");
    const x = Number(rawX);
    const z = Number(rawZ);
    if (!Number.isFinite(x) || !Number.isFinite(z)) return undefined;
    const walked = walkToPoint(pose, { x, y: pose.y, z }, new Set());
    if (!walked) return undefined;
    const follow = makeFollow(walked);
    return {
      id,
      kind,
      arg,
      moving: true,
      started: Date.now(),
      tick(current, nowTick) {
        const self = session.world.self();
        if (self && Math.hypot(self.x - x, self.z - z) <= 0.6) return "done";
        const step = follow.step(current, otherPawns(session), nowTick);
        send(step.input);
        if (step.status === "stuck") return "stuck";
        if (step.status === "arrived") return "done";
        return "running";
      },
    };
  };

  /**
   * `seekHealth:<crate>` / `reload:<crate>`: the existing pickup executor, with
   * its own kind so the loop's active-pickup check sees it.
   */
  const beginPickupAs = (kind: string) => (id: string, arg: string, pose: Pose): Running | undefined => {
    const run = beginPickup(id, arg, pose);
    if (run) run.kind = kind;
    return run;
  };

  /**
   * `returnFire:<pawn>`: `runAttack` is the step body (the prototype's aim/burst
   * code is not re-derived). The tick reports the promise's outcome; the attack
   * sends its own inputs, so this executor never sends.
   * @post `done` when the target is down (code 0); `failed` otherwise.
   */
  const beginReturnFire = (id: string, arg: string, pose: Pose): Running | undefined => {
    const targetId = Number(arg);
    if (!Number.isInteger(targetId)) return undefined;
    void pose;
    let outcome: "running" | "done" | "failed" = "running";
    void runAttack(session, targetId, {
      log,
      error,
      onTick: opts.onTick,
      timeoutMs: Math.max(2_000, deadline - Date.now()),
    })
      .then((code) => {
        // 199: no executor flag; `threatDown` comes from the health frame only.
        outcome = code === 0 ? "done" : "failed";
      })
      .catch(() => {
        outcome = "failed";
      });
    return {
      id,
      kind: "returnFire",
      arg,
      moving: false,
      started: Date.now(),
      tick() {
        return outcome;
      },
    };
  };

  /**
   * @why The typed map is the executor's action binding (177): a new plan-step
   *      kind is one entry here and one grounded action in actions.ts — no
   *      second string parse elsewhere in the loop. Each binder sets `kind`/`arg`
   *      on its Running, so the loop reads those and never re-parses `exec.id`.
   * @invariant Every plan-step kind has one binder in STEP_BINDERS; a step's
   *            `kind`/`arg` are set by its binder, never re-parsed from the id.
   *            (test: plan_step_map_covers_every_kind)
   */
  const STEP_BINDERS = new Map<string, StepBinder>([
    ["goTo", beginGoTo],
    ["standAt", beginStand],
    ["ride", (id, arg, pose) => beginRide(id, arg, pose)],
    ["rideTo", (id, arg, pose) => beginRide(id, arg, pose, true)],
    ["goToDoor", beginDoor],
    ["unlock", beginUnlock],
    ["pickup", beginPickup],
    ["seekHealth", beginPickupAs("seekHealth")],
    ["reload", beginPickupAs("reload")],
    ["takeCover", (id, arg, pose) => beginWalkPoint(id, arg, pose, "takeCover")],
    ["retreat", (id, arg, pose) => beginWalkPoint(id, arg, pose, "retreat")],
    ["returnFire", beginReturnFire],
  ]);
  const begin = (id: string, pose: Pose): Running | undefined => {
    const cut = id.indexOf(":");
    const kind = cut < 0 ? id : id.slice(0, cut);
    const arg = cut < 0 ? "" : id.slice(cut + 1);
    return STEP_BINDERS.get(kind)?.(id, arg, pose);
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
    const activePickup = exec && (exec.kind === "pickup" || exec.kind === "seekHealth" || exec.kind === "reload")
      ? exec.arg
      : undefined;
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
    const hpNow = session.world.health?.()?.hp;
    if (typeof hpNow === "number" && hpNow < hpClock.hp) hpClock = { hp: hpNow, at: Date.now() };
    const state = worldState();
    if (satisfies(state, goal.want)) return 0;

    const parts = watchParts(session, opts.enemies);
    let reason = "";
    if (!plan) reason = pending || "initial";
    else if (Date.now() - planAt >= REPLAN_MS) reason = "safety";
    else if (parts.doors !== watchDoors) reason = "door";
    else if (parts.pickups !== watchPickups && !activePickup) reason = "pickup";
    else if (parts.threat !== watchThreat && Date.now() - threatReplanAt >= 1_000) reason = "threat";

    // 198: a started cover walk is held >=300 ms so a moving shooter cannot
    // flap cover <-> fire between replans.
    if (reason && exec && exec.id.startsWith("takeCover:") && Date.now() - exec.started < 300) reason = "";
    if (reason) {
      const groundedCtx = ctx;
      if (!groundedCtx) return 2;
      // A macrotask between replans so the timeout and the socket can run.
      await delay(0);
      if (Date.now() >= deadline) return 3;
      if (reason !== "initial") log(`replan ${reason} t=${secs()}s`);
      // The cold cap follows the state change: `safety` is the only periodic
      // same-state refresh, so only it stays on the warm budget.
      // `threat` is a mid-fight state change (a moving shooter): warm budget, like safety.
      const budgetMs = opts.planMs ?? (reason === "safety" || reason === "threat" ? PLAN_BUDGET_MS : COLD_PLAN_BUDGET_MS);
      // Build the ladder's action set before the plan clock starts: the combat
      // cover scan walks the scene AABBs (188), and charging it to the plan
      // deadline made a valid plan start already expired.
      // 199: an ordered target that is a player must be declared hostile; refuse
      // a squadmate instead of silently re-targeting the nearest NPC.
      const ordered = missionTarget();
      if (goal.want.threatDown === true && ordered !== undefined && session.world.playerIds?.().has(ordered) === true && opts.enemies?.has(ordered) !== true) {
        log(`assault: not-a-hostile id=${ordered}`);
        return 2;
      }
      const ladder = combatGoals(state, goal);
      const combat = combatActions(session, groundedCtx, { target: missionTarget(), enemies: opts.enemies, onNote: log });
      const planActions = combat.length > 0 ? [...actions, ...combat] : actions;
      log(`plan ladder target=${missionTarget() ?? "-"} combat=${combat.length} goals=${ladder.map((g) => `${g.id}@${g.priority(state)}`).join(",")}`);
      const planDeadline = Math.min(deadline, Date.now() + budgetMs);
      // One route-bound closure per goal (the 160/185 contract): re-creating
      // `estimateSeconds` inside the heuristic made every state a fresh "start"
      // and paid the classify/route compile per evaluation (merged 188).
      const planOpts = (g: Goal): PlanOptions => {
        const estimate = estimateSeconds(g, groundedCtx, placements, stand);
        return {
          minCost: groundedCtx.minActionS,
          heuristic: (s) => Math.max(estimate(s), combatHeuristic(g, planActions, groundedCtx)(s)),
          deadlineMs: planDeadline,
          now: () => Date.now(),
          ...(opts.maxExpand !== undefined ? { maxExpand: opts.maxExpand } : {}),
          ...(opts.maxEvaluations !== undefined ? { maxEvaluations: opts.maxEvaluations } : {}),
        };
      };
      log("plan start");
      const planStarted = Date.now();
      plan = chooseCombatGoal(state, ladder, planActions, groundedCtx, planOpts);
      // A periodic replan gets 250 ms; if that is not enough for a state that
      // exists, retry once at the cold budget before declaring `unsatisfiable`
      // (136).
      if (!plan && reason === "safety") {
        plan = chooseCombatGoal(state, ladder, planActions, groundedCtx, (g) => ({
          ...planOpts(g),
          deadlineMs: Math.min(deadline, Date.now() + COLD_PLAN_BUDGET_MS),
        }));
      }
      const planMs = Date.now() - planStarted;
      log(`plan done ${planMs}ms steps=${plan?.steps.length ?? 0} expanded=${plan?.expanded ?? 0}`);
      exec = undefined;
      stuckCount = 0;
      watchDoors = parts.doors;
      watchPickups = parts.pickups;
      watchThreat = parts.threat;
      if (reason === "threat") threatReplanAt = Date.now();
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
      if (created.id.startsWith("takeCover:")) log(`cover start ${created.id}`);
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

function watchParts(
  session: BotSession,
  enemies?: ReadonlySet<number>,
): { doors: string; pickups: string; threat: string } {
  return {
    doors: session.world.doors().map((door) => `${door.id}:${door.open ? 1 : 0}:${door.locked ? 1 : 0}`).join(","),
    pickups: [...session.world.pickups()].sort().join(","),
    threat: threatWatchKey(session, enemies),
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
  // @why The grid must start on the pawn's feet, not the place's base: a
  //      crate-top pickup solved from the outside base (0) walks off the crate.
  return Math.max(floorBase(graph, pose), pose.y);
}

function floorBase(graph: SceneGraph, pose: Pose): number {
  const place = placeAt(graph, pose.x, pose.y, pose.z);
  return place.kind === "outside" ? 0 : place.y;
}

/**
 * The nearest free grid cell within `metres` of (x, z), for a feet-floor plan.
 * Cells on the given floor win over nearer cells on a step above/below, so a
 * crate-top pickup does not target the top of a higher step it cannot climb.
 */
function nearestFreeCell(grid: Grid, x: number, z: number, metres: number, floorY?: number): { x: number; z: number } | undefined {
  const reach = Math.ceil(metres / grid.cell);
  const ci = Math.floor((x - grid.minX) / grid.cell);
  const cj = Math.floor((z - grid.minZ) / grid.cell);
  let best: { x: number; z: number; d: number; rank: number } | undefined;
  for (let j = cj - reach; j <= cj + reach; j += 1) {
    for (let i = ci - reach; i <= ci + reach; i += 1) {
      if (i < 0 || j < 0 || i >= grid.w || j >= grid.h) continue;
      if ((grid.blocked[j * grid.w + i] ?? 1) !== 0) continue;
      const px = grid.minX + (i + 0.5) * grid.cell;
      const pz = grid.minZ + (j + 0.5) * grid.cell;
      const d = Math.hypot(px - x, pz - z);
      if (d > metres) continue;
      const rank = floorY === undefined || Math.abs((grid.floor[j * grid.w + i] ?? 0) - floorY) <= RAISED_EPS ? 0 : 1;
      if (!best || rank < best.rank || (rank === best.rank && d < best.d)) best = { x: px, z: pz, d, rank };
    }
  }
  return best ? { x: best.x, z: best.z } : undefined;
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
