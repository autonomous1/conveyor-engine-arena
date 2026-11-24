/**
 * The soldier's combat vocabulary for the GOAP planner: facts, actions, goals.
 * The imperative rules (heal at hp <= 50, cover below 50, retreat at < 25 hp or
 * against 3 threats, return fire when armed with a visible threat) become bands,
 * actions whose cost is a function of the state, and a goal ladder. No executor
 * is new: pickups, cover walks and `runAttack` already exist.
 */
// ARCHITECTURE: The bot-client combat vocabulary: `combatFacts` (a WorldState
//   fragment), `combatActions` (wrapping existing executors), `combatGoals` (the
//   survival ladder) and `chooseCombatGoal` (per-goal heuristics).
// Wiring: src/brain.ts merges the facts/actions into its plan loop and plans
//   with the ladder; test/goap-combat.test.ts drives the offline matrices.
// Order: facts come from the live session every state build; the actions are
//   rebuilt per plan because their targets (crates, cover points) move.
// Invariants: `combatFacts` never mutates the session; `underFire`'s clock is the
//   caller's (buildWorldState stays pure); every action wraps an executor the
//   brain already has and no action has a non-positive cost.
import type { Action, Goal, Fact, Plan, PlanOptions, WorldState } from "../../../src/shared/bots/goap.js";
import { plan } from "../../../src/shared/bots/goap.js";
import type { BotCtx } from "../../../src/shared/bots/actions.js";
import { placeOfPickup } from "../../../src/shared/bots/actions.js";
import { AT, HAS_AMMO, HAS_WEAPON, availFact } from "../../../src/shared/bots/state.js";
import { hasLineOfSight } from "../../../src/shared/hitscan.js";
import { EYE_HEIGHT } from "../../../src/shared/look.js";
import type { BotSession } from "./connection.js";
import type { PickupPlacement } from "../../../src/shared/pickups.js";

/** Travel estimate, metres per second: the planner's `WALK_MPS` in actions.ts. */
const WALK_MPS = 4;
/** Smallest positive route, in metres. */
const MIN_M = 0.5;
/** A damaged-this-recently bot is under fire. */
const UNDER_FIRE_MS = 1_500;
/** A threat is a hostile inside this range with line of sight. */
const THREAT_M = 30;
/** The band edges: heal at <= 50 (the imperative rule), retreat below 25. */
const WOUNDED_HP = 50;
const CRITICAL_HP = 25;
/** The 8 s fire estimate, and the wounded multipliers (the design knob). */
const FIRE_S = 8;
const COVER_WOUNDED_MUL = 0.6;
const FIRE_WOUNDED_MUL = 2;

/** The caller-owned hp clock: `at` is set when a health frame drops hp. */
export type HpClock = { hp: number; at: number };

const metresTo = (s: WorldState, ctx: BotCtx, place: string | undefined): number => {
  if (!place) return Infinity;
  const m = ctx.routeCost(String(s.at), place, s);
  return m > 0 && Number.isFinite(m) ? m : Infinity;
};

/** Hostile pawns: the interim team rule (players friendly, NPCs enemy). */
function hostiles(session: BotSession): Array<{ id: number; x: number; y: number; z: number }> {
  // Optional calls: the real `BotWorld` always has these; the real-graph test
  // doubles implement only the movement surface, and the combat facts must not
  // turn a partial double into a crash.
  const players = session.world.playerIds?.() ?? new Set<number>();
  return session.world.others().filter((pawn) => {
    if (players.has(pawn.id)) return false;
    return session.world.healthOf?.(pawn.id)?.dead !== true;
  });
}

/**
 * The nearest hostile with line of sight from the eye, inside `THREAT_M`.
 * @post Undefined when the eye is unknown or nothing is visible.
 */
export function visibleThreat(session: BotSession): { id: number; x: number; y: number; z: number } | undefined {
  const self = session.world.self();
  const boxes = session.world.aabbs ?? [];
  if (!self) return undefined;
  const eye = { x: self.x, y: self.y + EYE_HEIGHT, z: self.z };
  let best: { id: number; x: number; y: number; z: number } | undefined;
  let bestD = THREAT_M;
  for (const pawn of hostiles(session)) {
    const d = Math.hypot(pawn.x - self.x, pawn.z - self.z);
    if (d > bestD) continue;
    const target = { x: pawn.x, y: pawn.y + EYE_HEIGHT, z: pawn.z };
    if (!hasLineOfSight(eye, target, boxes)) continue;
    best = pawn;
    bestD = d;
  }
  return best;
}

/**
 * The combat facts as a `WorldState` fragment.
 * @post `underFire` is `now - clock.at <= UNDER_FIRE_MS`; `inCover` is the LOS to
 *       the visible threat blocked from the current point; `hpWounded` is
 *       `hp <= 50` (the imperative rule's edge, not the review's strict `< 50`).
 */
export function combatFacts(session: BotSession, clock: HpClock, now = Date.now()): Record<string, Fact> {
  const facts: Record<string, Fact> = {};
  const self = session.world.self();
  const health = session.world.health?.();
  const hp = health?.hp ?? clock.hp;
  if (typeof hp === "number" && Number.isFinite(hp)) {
    if (hp >= 70) facts.hpHigh = true;
    if (hp <= WOUNDED_HP) facts.hpWounded = true;
    if (hp < CRITICAL_HP) facts.hpCritical = true;
  }
  if (now - clock.at <= UNDER_FIRE_MS) facts.underFire = true;
  if ((session.world.weapon() ?? "").length > 0) facts.hasWeapon = true;
  if (session.world.ammo() > 0) facts.hasAmmo = true;
  const available = new Set(session.world.pickups());
  const crates = session.world.pickupPlacements().filter((item) => item.kind === "health" && available.has(item.id));
  if (crates.length > 0) facts.canHeal = true;
  const threat = visibleThreat(session);
  if (threat) {
    facts.threatVisible = true;
    if (self) {
      const d = Math.hypot(threat.x - self.x, threat.z - self.z);
      if (d < 12) facts.threatNear = true;
      const boxes = session.world.aabbs ?? [];
      const eye = { x: self.x, y: self.y + EYE_HEIGHT, z: self.z };
      const target = { x: threat.x, y: threat.y + EYE_HEIGHT, z: threat.z };
      if (!hasLineOfSight(eye, target, boxes)) facts.inCover = true;
    }
  }
  return facts;
}

/**
 * One action per available health crate, the cover point, the visible threat,
 * the retreat point, and one per available ammo crate.
 * @post Every action wraps an executor the brain has; targets are the live pose,
 *       so the list is rebuilt per plan (never cached).
 */
export function combatActions(session: BotSession, ctx: BotCtx, opts: { target?: number } = {}): Action<BotCtx>[] {
  const world = session.world;
  const graph = world.sceneGraph();
  const self = world.self();
  const actions: Action<BotCtx>[] = [];
  if (!graph || !self) return actions;
  const available = new Set(world.pickups());
  const threat = visibleThreat(session);
  const crateActions = (kind: "health" | "ammo"): void => {
    for (const item of world.pickupPlacements()) {
      if (item.kind !== kind || !available.has(item.id)) continue;
      const place = placeOfPickup(graph, item);
      const id = kind === "health" ? `seekHealth:${item.id}` : `reload:${item.id}`;
      actions.push({
        id,
        pre: kind === "health"
          ? { hpWounded: true, [availFact(item.id)]: true, [AT]: place }
          : { [HAS_AMMO]: false, [availFact(item.id)]: true, [AT]: place },
        eff: kind === "health"
          ? { hpHigh: true, [availFact(item.id)]: false }
          : { [HAS_AMMO]: true, [availFact(item.id)]: false },
        usable: (s, c) => Number.isFinite(metresTo(s, c, place)),
        cost: (s, c) => Math.max(MIN_M, metresTo(s, c, place)) / WALK_MPS,
      });
    }
  };
  crateActions("health");
  crateActions("ammo");
  if (threat) {
    const boxes = world.aabbs ?? [];
    const eye = { x: self.x, y: self.y + EYE_HEIGHT, z: self.z };
    const threatEye = { x: threat.x, y: threat.y + EYE_HEIGHT, z: threat.z };
    // Cover: a walkable point near the threat whose sight line it breaks.
    const cover = nearestCoverPoint(session, threat, eye, threatEye, boxes);
    if (cover) {
      const place = world.placeOf(cover)?.id;
      const standKey = `${cover.x.toFixed(1)},${cover.z.toFixed(1)}`;
      actions.push({
        id: `takeCover:${standKey}`,
        pre: { underFire: true, threatVisible: true },
        eff: { inCover: true, defended: true },
        usable: (s, c) => Number.isFinite(metresTo(s, c, place)),
        // Wounded: cover is cheap. Healthy: firing is.
        cost: (s, c) => (Math.max(MIN_M, metresTo(s, c, place)) / WALK_MPS) * (s.hpWounded ? COVER_WOUNDED_MUL : 1),
      });
    }
    // `usable` is frozen at build time: a live check on a moving pawn makes the
    // action vanish mid-search and the plan dies on the deadline (184 live).
    actions.push({
      id: `returnFire:${threat.id}`,
      pre: { [HAS_WEAPON]: true, [HAS_AMMO]: true, threatVisible: true },
      eff: { threatDown: true, defended: true },
      usable: () => true,
      cost: (s) => FIRE_S * (s.hpWounded ? FIRE_WOUNDED_MUL : 1),
    });
    // Retreat: a walkable point away from the threat, still on this floor.
    const away = awayPoint(session, threat);
    if (away) {
      const place = world.placeOf(away)?.id;
      actions.push({
        id: `retreat:${away.x.toFixed(1)},${away.z.toFixed(1)}`,
        pre: { hpCritical: true },
        eff: { safe: true },
        usable: (s, c) => Number.isFinite(metresTo(s, c, place)),
        cost: (s, c) => Math.max(MIN_M, metresTo(s, c, place)) / WALK_MPS,
      });
    }
  }
  // The mission's target, even when it is not the nearest visible threat: the
  // assault order is on a named pawn, and `runAttack` pursues it.
  // The named order is grounded even when the pawn is momentarily out of view:
  // `runAttack` pursues it, and losing it is its own outcome. Gating this on a
  // live `others()` check made the whole mission die on one unlucky frame.
  const named = opts.target;
  if (named !== undefined && named !== threat?.id) {
    actions.push({
      id: `returnFire:${named}`,
      pre: { [HAS_WEAPON]: true, [HAS_AMMO]: true },
      eff: { threatDown: true, defended: true },
      usable: () => true,
      cost: (s) => FIRE_S * (s.hpWounded ? FIRE_WOUNDED_MUL : 1),
    });
  }
  return actions;
}

/** The nearest point that breaks the threat's sight line, sampled on the floor. */
function nearestCoverPoint(
  session: BotSession,
  threat: { x: number; y: number; z: number },
  eye: { x: number; y: number; z: number },
  threatEye: { x: number; y: number; z: number },
  boxes: Parameters<typeof hasLineOfSight>[2],
): { x: number; y: number; z: number } | undefined {
  const self = session.world.self();
  if (!self) return undefined;
  let best: { x: number; y: number; z: number } | undefined;
  let bestD = 12;
  for (let step = 0; step < 16; step += 1) {
    const angle = (step / 16) * Math.PI * 2;
    for (const dist of [2, 4, 6, 8, 10]) {
      const point = { x: self.x + Math.sin(angle) * dist, y: self.y, z: self.z + Math.cos(angle) * dist };
      const d = Math.hypot(point.x - self.x, point.z - self.z);
      if (d >= bestD) continue;
      if (!session.world.placeOf(point)) continue;
      if (hasLineOfSight({ x: point.x, y: point.y + EYE_HEIGHT, z: point.z }, threatEye, boxes)) continue;
      best = point;
      bestD = d;
      break;
    }
  }
  return best;
}

/** A point twice as far from the threat as the bot is, clamped to this place. */
function awayPoint(session: BotSession, threat: { x: number; y: number; z: number }): { x: number; y: number; z: number } | undefined {
  const self = session.world.self();
  if (!self) return undefined;
  const dx = self.x - threat.x;
  const dz = self.z - threat.z;
  const d = Math.hypot(dx, dz);
  if (d < 0.1) return undefined;
  const point = { x: self.x + (dx / d) * 8, y: self.y, z: self.z + (dz / d) * 8 };
  return session.world.placeOf(point) ? point : { x: self.x + (dx / d) * 4, y: self.y, z: self.z + (dz / d) * 4 };
}

/**
 * The ladder: survive (critical 90 / wounded 80), defend (cover and fire at 70),
 * rearm 55, the mission, idle.
 * @post A mission whose want is `threatDown` is the assault order at 60; any
 *       other mission keeps its own priority.
 */
export function combatGoals(state: WorldState, mission?: Goal): Goal[] {
  const goals: Goal[] = [
    { id: "survive", want: { hpHigh: true }, priority: (s) => (s.hpCritical ? 90 : s.hpWounded ? 80 : 0) },
    // One goal, both actions: the two-goal OR (cover first by array order) makes
    // the cost knob inert, so cover and fire both effect `defended` and the
    // route/8 s costs decide (184's report states the deviation).
    { id: "defend", want: { defended: true }, priority: (s) => (s.underFire && !s.hpCritical ? 70 : 0) },
    { id: "rearm", want: { [HAS_AMMO]: true }, priority: (s) => (s[HAS_WEAPON] === true && s[HAS_AMMO] !== true ? 55 : 0) },
  ];
  if (mission) {
    const assault = mission.want.threatDown === true;
    goals.push(assault ? { ...mission, priority: () => 60 } : mission);
  }
  goals.push({ id: "idle", want: {}, priority: () => 10 });
  return goals;
}

/**
 * The assault order: fire on `targetId` until it is down.
 * @why It carries `threatDown` so `combatGoals` can rank it at 60 and the
 *      `returnFire` action can satisfy it.
 */
export function assaultGoal(targetId: number): Goal {
  return { id: `assault:${targetId}`, want: { threatDown: true }, priority: () => 60 };
}

/**
 * A floor heuristic for a combat goal, in seconds.
 * @why `returnFire` costs 8 s, and a `threatDown` goal has no place for
 *      `estimateSeconds` (it returns 0). With h=0 the A* must expand every
 *      `goTo` cheaper than 8 s before the fire step, which burns the whole
 *      budget on route costs (184 live: 4 s, no plan). The cheapest
 *      threatDown-effecting action is the admissible floor.
 * @post 0 for goals with no flat-cost action; the fire floor for threatDown.
 */
export function combatHeuristic(goal: Goal): (s: WorldState) => number {
  const down = goal.want.threatDown === true;
  return (s) => (down && s.threatDown !== true ? FIRE_S * (s.hpWounded ? FIRE_WOUNDED_MUL : 1) : 0);
}

const satisfies = (s: WorldState, want: WorldState): boolean => {
  for (const k in want) if ((s[k] ?? false) !== want[k]) return false;
  return true;
};

/**
 * Highest-priority goal that plans, with a per-goal heuristic.
 * @why `chooseGoal` shares one `PlanOptions` across every candidate, so a ladder
 *      with different goal places cannot use `estimateSeconds` there: one plan
 *      per ranked goal keeps the route heuristic that makes the 177 plans fast.
 * @post Same ranking and tie rule as `chooseGoal` (priority, then array order).
 */
export function chooseCombatGoal(
  state: WorldState,
  goals: readonly Goal[],
  actions: readonly Action<BotCtx>[],
  ctx: BotCtx,
  optsFor: (goal: Goal) => PlanOptions,
): Plan | undefined {
  const ranked = goals
    .map((g, i) => ({ g, i, p: g.priority(state) }))
    .filter((r) => r.p > 0 && !satisfies(state, r.g.want))
    .sort((a, b) => b.p - a.p || a.i - b.i);
  for (const r of ranked) {
    const opts = optsFor(r.g);
    if (opts.deadlineMs !== undefined && opts.now && opts.now() >= opts.deadlineMs) return undefined;
    const found = plan(state, r.g, actions as readonly Action<BotCtx>[], ctx, opts);
    if (found) return found;
  }
  return undefined;
}
