/**
 * Grounded GOAP actions over the scene graph.
 * `routeCost` is metres from `planRoute`. A locked leaf stays impassable
 * until `unlock` opens it in the simulated state. Holding the key does not.
 */
// ARCHITECTURE: Grounded GOAP actions over the scene graph: goTo, goToDoor,
//   unlock, pickup, and their costs.
// Wiring: server/bot-brain.ts plans with them; shared/nav/route.ts supplies
//   route costs.
import { createRoadCache, planRoute, routePlaceCosts, type Gate, type RoadCache } from "../nav/route.js";
import type { PickupPlacement } from "../pickups.js";
import type { Stand } from "../nav/stand.js";
import { placeAt, stopOf, type SceneGraph, type ScenePortal } from "../scene-graph.js";
import type { Action, Fact, WorldState } from "./goap.js";
import {
  HAS_AMMO,
  HAS_WEAPON,
  AT,
  DOOR_AT_PREFIX,
  PICKUP_AT_PREFIX,
  atDoor,
  availFact,
  doorLockedFact,
  doorOpenFact,
  hasKeyFact,
  holdingFact,
  STAND,
} from "./state.js";

/** Travel estimate, metres per second. Turns and doors sit inside this figure. */
const WALK_MPS = 4;
/** Short use or pickup, in seconds. The planner rejects a cost that is not positive. */
const ACT_S = 0.5;
/** Smallest positive route, in metres, when a stand point is already the anchor. */
const MIN_M = 0.5;

/**
 * Bot Ctx type.
 */
export type BotCtx = {
  graph: SceneGraph;
  /** Metres. Infinite when no route exists under the simulated door state. */
  routeCost(fromPlace: string, toPlace: string, s: WorldState): number;
  /**
   * Metres with locked doors passable at the have-key penalty.
   * A lower bound on the walk, not a route the pawn can take while the leaf is locked.
   */
  routeBound(fromPlace: string, toPlace: string, s: WorldState): number;
  /** Admissible lower bound on one action, in seconds. */
  minActionS: number;
  /** Road compiles for this context. The same door facts compile once. */
  readonly compiles: number;
  /** Live feet, for the final door approach. Absent: use the place anchor. */
  position?: () => Point | undefined;
};

type Point = { x: number; y: number; z: number };

type DoorBit = { id: string; locked: boolean };

/**
 * Creates Bot Context.
 */
export function createBotContext(
  graph: SceneGraph,
  pickups: readonly PickupPlacement[] = [],
  opts: { position?: () => Point | undefined } = {},
): BotCtx {
  const pickupPoints = new Map<string, Point>();
  for (const item of pickups) pickupPoints.set(item.id, feet(item));
  const doors = doorBits(graph);
  const roads = createRoadCache(graph);
  const rows = new Map<string, Map<string, Map<string, number>>>();
  const gateKeys = new WeakMap<WorldState, string>();
  const lookup = (loose: boolean, fromPlace: string, toPlace: string, s: WorldState): number =>
    cachedMetres(graph, fromPlace, toPlace, s, pickupPoints, doors, rows, gateKeys, roads, loose);
  return {
    graph,
    minActionS: minActionSeconds(graph),
    get compiles() {
      return roads.compiles;
    },
    routeCost(fromPlace, toPlace, s) {
      return lookup(false, fromPlace, toPlace, s);
    },
    routeBound(fromPlace, toPlace, s) {
      return lookup(true, fromPlace, toPlace, s);
    },
    position: opts.position,
  };
}

/**
 * One action per place, door, locked leaf, and pickup.
 * @why A key pickup is grounded only when `lockedAlternative` names that key,
 *      cheapest alternative first, so unused keys never enter the search.
 */
export function groundActions(
  graph: SceneGraph,
  pickups: readonly PickupPlacement[],
  goals?: readonly { want: WorldState }[],
  stand?: Stand,
): Action<BotCtx>[] {
  const actions: Action<BotCtx>[] = [];
  const rideGoals = rideTargets(graph, goals, stand);
  const wantsRide = rideGoals.length > 0;
  // No goals: every place and every door, so fixture plans stay complete.
  // With goals: the goal room and the pickups that goal names. `goToDoor`
  // covers the stand, so door sides are not also `goTo` targets.
  const ranked = rankedKeys(graph);
  const chosen = goals ? pickupsForGoals(pickups, goals, ranked) : undefined;
  const places = chosen ? relevantPlaces(graph, chosen, goals!) : graph.places.map((place) => place.id).sort(byText);
  if (stand && !places.includes(stand.place)) places.push(stand.place);
  if (wantsRide) {
    const seen = new Set(places);
    for (const goal of rideGoals) {
      const shaft = graph.placeById.get(goal.shaft) as { stops?: readonly number[] } | undefined;
      if (!shaft?.stops) continue;
      for (let i = 0; i < shaft.stops.length; i += 1) {
        const id = `${goal.shaft}@${i}`;
        if (seen.has(id)) continue;
        seen.add(id);
        places.push(id);
      }
    }
  }
  for (const place of places) actions.push(goTo(place));

  const doors = doorPortals(graph);
  const routed = chosen ? doors.filter((portal) => portal.locked === true && portal.key) : doors;
  for (const portal of routed) {
    for (const side of sides(portal)) actions.push(goToDoor(doorId(portal), side.place, side.point));
  }

  for (const portal of routed) {
    if (portal.locked !== true || !portal.key) continue;
    actions.push(unlock(doorId(portal), portal.key));
  }

  for (const goal of rideGoals) actions.push(rideTo(graph, goal.shaft, goal.stop));

  for (const item of chosen ?? pickupsInOrder(pickups, ranked)) {
    actions.push(pickup(item, placeOfPickup(graph, item)));
  }
  if (stand && goals?.some((goal) => "stand" in goal)) actions.push(standAt(stand));
  return actions;
}

/**
 * Stand at a resolved point and face it.
 * @post `stand:<key>` is true; `at` is the stand's place.
 */
export function standAt(stand: Stand): Action<BotCtx> {
  const metres = memoMetres((s, ctx) => ctx.routeCost(String(s.at), stand.place, s));
  return {
    id: `standAt:${stand.key}`,
    pre: { [AT]: stand.place },
    eff: { [STAND]: stand.key },
    usable: (s, ctx) => s[STAND] !== stand.key && Number.isFinite(metres(s, ctx)),
    cost: (s, ctx) => Math.max(MIN_M, metres(s, ctx)) / WALK_MPS,
  };
}

/**
 * @pre `at` is a place id present in the scene graph.
 * @post `at = <place>`.
 * @why Cost divides route metres by 4 m/s, not MOVE_SPEED 5, to allow for
 *      turns and doors.
 */
export function goTo(place: string): Action<BotCtx> {
  const metres = memoMetres((s, ctx) => ctx.routeCost(String(s.at), place, s));
  return {
    id: `goTo:${place}`,
    pre: {},
    eff: { at: place },
    usable: (s, ctx) => {
      if (s.at === place) return false;
      const m = metres(s, ctx);
      return m > 0 && Number.isFinite(m);
    },
    cost: (s, ctx) => metres(s, ctx) / WALK_MPS,
  };
}

/**
 * Stand on one side of a leaf. Effect is `at = door:<id>` plus the side stood on.
 * The far side of a locked leaf is a different action and stays unusable, so a
 * later route cannot start inside the locked room.
 *
 * @pre A route exists on the reachable side of the door.
 * @post `at = door:<doorId>`.
 */
export function goToDoor(door: string, place: string, stand: Point): Action<BotCtx> {
  const metres = memoMetres((s, ctx) => (s.at === atDoor(door) ? Infinity : metresToSide(s, ctx, place, stand)));
  return {
    id: `goToDoor:${door}:${place}`,
    pre: {},
    eff: { at: atDoor(door), [doorSideFact(door)]: place },
    usable: (s, ctx) => Number.isFinite(metres(s, ctx)),
    cost: (s, ctx) => metres(s, ctx) / WALK_MPS,
  };
}

type RideTarget = { shaft: string; stop: string };

function rideTargets(
  graph: SceneGraph,
  goals: readonly { want: WorldState }[] | undefined,
  stand?: Stand,
): RideTarget[] {
  const out = new Map<string, RideTarget>();
  for (const goal of goals ?? []) {
    const at = goal.want[AT];
    if (typeof at !== "string") continue;
    const stop = stopOf(at);
    if (stop) out.set(`${stop.shaft}|${at}`, { shaft: stop.shaft, stop: at });
  }
  const place = stand ? graph.placeById.get(stand.place) : undefined;
  if (place) {
    for (const shaft of graph.shafts) {
      for (let i = 0; i < shaft.stops.length; i += 1) {
        if (Math.abs(shaft.stops[i]! - place.y) > 0.1) continue;
        const id = `${shaft.id}@${i}`;
        out.set(`${shaft.id}|${id}`, { shaft: shaft.id, stop: id });
      }
    }
  }
  return [...out.values()];
}

/**
 * One cab edge to `stop` in `shaft`. The from stop is the state's `at`.
 * @post `at = stop`; cost is Infinity when no portal connects the two stops.
 */
export function rideTo(graph: SceneGraph, shaft: string, stop: string): Action<BotCtx> {
  const portals = elevatorPortals(graph);
  return {
    id: `rideTo:${shaft}:${stop}`,
    pre: {},
    eff: { [AT]: stop },
    usable: (s) => {
      const from = stopOf(String(s.at));
      return from?.shaft === shaft && s.at !== stop;
    },
    cost: (s) => {
      const from = String(s.at);
      const portal = portals.find((item) => (item.a === from && item.b === stop) || (item.b === from && item.a === stop));
      return portal ? Math.max(ACT_S, portal.cost / WALK_MPS) : Infinity;
    },
  };
}

/**
 * Every elevator portal, sorted by id.
 * @post Deterministic order; no duplicate ids.
 */
export function elevatorPortals(graph: SceneGraph): ScenePortal[] {
  return graph.portals.filter((portal) => portal.kind === "elevator").sort((a, b) => byText(a.id, b.id));
}

/**
 * One cab edge from the lower stop's place to the upper stop's place.
 * @post `at = portal.b`; the executor summons the cab and rides it.
 */
export function ride(portal: ScenePortal, reverse = false): Action<BotCtx> {
  const from = reverse ? portal.b : portal.a;
  const to = reverse ? portal.a : portal.b;
  return {
    id: `ride:${reverse ? "down" : "up"}:${portal.id}`,
    pre: { [AT]: from },
    eff: { [AT]: to },
    usable: (s) => s[AT] === from && from !== to,
    cost: () => Math.max(ACT_S, portal.cost / WALK_MPS),
  };
}

/**
 * @pre `at` is `door:<id>`, `doorLocked:<id>` is true, `hasKey:<key>` is true.
 * @post `doorLocked:<id>` is false and `doorOpen:<id>` is true.
 * @invariant The key stays held. One key opens every leaf that names it.
 *            (test: unlock_keeps_key)
 */
export function unlock(door: string, key: string): Action<BotCtx> {
  return {
    id: `unlock:${door}`,
    pre: { at: atDoor(door), [doorLockedFact(door)]: true, [hasKeyFact(key)]: true },
    eff: { [doorLockedFact(door)]: false, [doorOpenFact(door)]: true },
    cost: ACT_S,
  };
}

/**
 * @pre `at` is the place containing the pickup, and `avail:<id>` is true.
 * @post `hasKey:<id>` / `hasWeapon` / `hasAmmo` (per kind) is true, and
 *       `avail:<id>` is false.
 */
export function pickup(item: PickupPlacement, place: string): Action<BotCtx> {
  const eff: Record<string, Fact> = {
    [availFact(item.id)]: false,
    [holdingFact(item.id)]: true,
  };
  if (item.kind === "key") eff[hasKeyFact(item.id)] = true;
  else if (item.kind === "weapon") eff[HAS_WEAPON] = true;
  else if (item.kind === "ammo") eff[HAS_AMMO] = true;
  return {
    id: `pickup:${item.id}`,
    pre: { at: place, [availFact(item.id)]: true },
    eff,
    cost: ACT_S,
  };
}

/**
 * Place under the pickup, or `outside`.
 * Floor boxes sit on `minY`. A chest-high box matches a metre under its centre.
 * @post The first sample that lands inside a place wins.
 */
export function placeOfPickup(graph: SceneGraph, item: PickupPlacement): string {
  const x = (item.minX + item.maxX) / 2;
  const z = (item.minZ + item.maxZ) / 2;
  const midY = (item.minY + item.maxY) / 2;
  for (const y of [item.minY, midY, midY - 1, item.maxY]) {
    const id = placeAt(graph, x, y, z).id;
    if (id !== "outside") return id;
  }
  return "outside";
}

function feet(item: PickupPlacement): Point {
  return {
    x: (item.minX + item.maxX) / 2,
    y: (item.minY + item.maxY) / 2 - 1,
    z: (item.minZ + item.maxZ) / 2,
  };
}

function doorId(portal: ScenePortal): string {
  return portal.door ?? portal.id;
}

/** Side stood on after `goToDoor`. A route from the door token starts there. */
function doorSideFact(door: string): string {
  return `doorSide:${door}`;
}

function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function doorPortals(graph: SceneGraph): ScenePortal[] {
  const byDoor = new Map<string, ScenePortal>();
  for (const portal of graph.portals) {
    if (portal.kind !== "door") continue;
    const id = doorId(portal);
    if (!byDoor.has(id)) byDoor.set(id, portal);
  }
  return [...byDoor.values()].sort((a, b) => byText(doorId(a), doorId(b)));
}

function portalByDoor(graph: SceneGraph, door: string): ScenePortal | undefined {
  for (const portal of graph.portals) {
    if (portal.kind === "door" && doorId(portal) === door) return portal;
  }
  return undefined;
}

function sides(portal: ScenePortal): Array<{ place: string; point: Point }> {
  return [
    { place: portal.a, point: vec(portal.at.a) },
    { place: portal.b, point: vec(portal.at.b) },
  ];
}

function vec(value: [number, number, number]): Point {
  return { x: value[0], y: value[1], z: value[2] };
}

/**
 * Door gate for one simulated state.
 * A locked leaf is impassable. Opening it is `unlock`, not a route penalty.
 */
function gateFor(portal: ScenePortal, s: WorldState): Gate {
  if (portal.kind !== "door") return "open";
  const id = doorId(portal);
  if (s[doorOpenFact(id)] === true) return "open";
  const known = s[doorLockedFact(id)];
  const locked = known === undefined ? portal.locked === true : known === true;
  if (locked) return "locked";
  return "closed-unlocked";
}

function metresToSide(s: WorldState, ctx: BotCtx, place: string, stand: Point): number {
  const at = String(s.at);
  if (at === place) {
    const pose = ctx.position?.();
    if (pose) return Math.max(MIN_M, Math.hypot(pose.x - stand.x, pose.y - stand.y, pose.z - stand.z));
    return walkToStand(ctx.graph, place, stand);
  }
  const travel = ctx.routeCost(at, place, s);
  if (!Number.isFinite(travel)) return Infinity;
  return travel + nearestPlacePoint(ctx.graph, place, stand);
}

/** Distance from `stand` to the nearest edge of the place polygon. */
function nearestPlacePoint(graph: SceneGraph, place: string, stand: Point): number {
  const polygon = graph.placeById.get(place)?.polygon;
  if (!polygon || polygon.length === 0) return 0;
  let best = Infinity;
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i]!;
    const b = polygon[(i + 1) % polygon.length]!;
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const length2 = dx * dx + dz * dz;
    const t = length2 > 0 ? Math.max(0, Math.min(1, ((stand.x - a[0]) * dx + (stand.z - a[1]) * dz) / length2)) : 0;
    const x = a[0] + t * dx;
    const z = a[1] + t * dz;
    best = Math.min(best, Math.hypot(stand.x - x, stand.z - z));
  }
  return Number.isFinite(best) ? best : 0;
}

function walkToStand(graph: SceneGraph, place: string, stand: Point): number {
  const anchor = anchorForPlace(graph, place);
  if (!anchor) return Infinity;
  const metres = Math.hypot(anchor.x - stand.x, anchor.y - stand.y, anchor.z - stand.z);
  return metres > 0 ? metres : MIN_M;
}

/**
 * Seconds still to pay.
 * An open walk is one strict route, reused so the direct `goTo` is popped
 * next. A locked walk names the alternative doors once; any other door is
 * unreachable and `plan` drops that state.
 * @post No finite bound (elevator-only, missing id) stops the search.
 */
export function estimateSeconds(
  goal: { want: WorldState },
  ctx: BotCtx,
  pickups: readonly PickupPlacement[],
  stand?: Stand,
): (s: WorldState) => number {
  const named = goal.want[AT];
  if (typeof named === "string" && !ctx.graph.placeById.has(named)) return () => Infinity;
  const place = goalPlace(goal, ctx.graph, pickups) ?? stand?.place;
  const holding = holdingId(goal);
  const pickupS = holding ? ACT_S : 0;
  let doorSides: Map<string, [string, string]> | undefined;
  // Set once, from the first state whose `at` is a place.
  let directS: number | undefined;
  let mode: "open" | "locked" | "none" | undefined;
  let altDoors: Array<{ door: string; key?: string }> = [];
  let altMetres = Infinity;
  let altSet: Set<string> | undefined;
  const spotsOf = (at: string, s: WorldState): readonly string[] => {
    if (ctx.graph.placeById.has(at)) return [at];
    if (at.startsWith(DOOR_AT_PREFIX)) {
      const id = at.slice(DOOR_AT_PREFIX.length);
      const stood = s[doorSideFact(id)];
      if (typeof stood === "string") return [stood];
      if (!doorSides) doorSides = doorSideIndex(ctx.graph);
      return doorSides.get(id) ?? [];
    }
    if (at.startsWith(PICKUP_AT_PREFIX)) {
      const item = pickups.find((pickup) => pickup.id === at.slice(PICKUP_AT_PREFIX.length));
      return item ? [placeOfPickup(ctx.graph, item)] : [];
    }
    return [];
  };
  const classify = (at: string, s: WorldState): void => {
    if (mode !== undefined || !place || !ctx.graph.placeById.has(at)) return;
    const strict = ctx.routeCost(at, place, s);
    if (strict > 0 && Number.isFinite(strict)) {
      mode = "open";
      directS = strict / WALK_MPS;
      return;
    }
    const origin = anchorForPlace(ctx.graph, at);
    const route = origin ? planRoute(ctx.graph, origin, place, (portal) => gateFor(portal, s)) : undefined;
    const alt = route?.lockedAlternative;
    if (alt && alt.doors.length > 0 && alt.cost > 0 && Number.isFinite(alt.cost)) {
      mode = "locked";
      altDoors = alt.doors;
      altMetres = alt.cost;
      altSet = new Set(alt.doors.map((door) => door.door));
      return;
    }
    mode = "none";
  };
  const onFoot = (s: WorldState): number => {
    if (!place) return 0;
    if (holding && s[holdingFact(holding)] === true) return 0;
    const at = String(s.at);
    if (at === place) return pickupS;
    if (mode === undefined) {
      // `at` may be `pickup:<id>` or `door:<id>` after that step finishes.
      const spots = spotsOf(at, s);
      const spot = spots.find((id) => ctx.graph.placeById.has(id));
      if (spot) classify(spot, s);
    }
    if (mode === "open" && directS !== undefined) return directS;
    if (mode !== "locked" || !altSet) return Infinity;
    if (at.startsWith(DOOR_AT_PREFIX) && !altSet.has(at.slice(DOOR_AT_PREFIX.length))) return Infinity;
    const pending = altDoors.filter((door) => s[doorOpenFact(door.door)] !== true);
    if (pending.length === 0) {
      const spots = spotsOf(at, s);
      if (spots.length === 0) return Infinity;
      let best = Infinity;
      for (const spot of spots) {
        if (spot === place) return pickupS;
        const metres = ctx.routeCost(spot, place, s);
        if (metres < best) best = metres;
      }
      if (!(best > 0 && Number.isFinite(best))) return Infinity;
      return best / WALK_MPS + pickupS;
    }
    let extra = pickupS + pending.length * ACT_S;
    let hasKeys = true;
    const seen = new Set<string>();
    for (const door of pending) {
      if (!door.key || seen.has(door.key)) continue;
      seen.add(door.key);
      if (s[hasKeyFact(door.key)] !== true) {
        hasKeys = false;
        extra += ACT_S;
      }
    }
    const stood = at.startsWith(DOOR_AT_PREFIX) ? at.slice(DOOR_AT_PREFIX.length) : "";
    const here = pending.some((door) => door.door === stood);
    // Metres stay on the bound until the key is in hand and the pawn is at the leaf.
    if (!(here && hasKeys)) extra += altMetres / WALK_MPS;
    return extra;
  };
  const portals = elevatorPortals(ctx.graph);
  const rideBound = (at: string, s: WorldState): number | undefined => {
    if (!place) return undefined;
    let best = Infinity;
    for (const portal of portals) {
      const to = ctx.routeCost(portal.b, place, s);
      if (!(to >= 0 && Number.isFinite(to))) continue;
      const from = ctx.routeCost(at, portal.a, s);
      if (!(from >= 0 && Number.isFinite(from))) continue;
      const metres = from + portal.cost + to;
      if (metres < best) best = metres;
    }
    return Number.isFinite(best) ? best / WALK_MPS : undefined;
  };
  return (s) => {
    const base = onFoot(s);
    const ride = rideBound(String(s.at), s);
    if (ride === undefined) return base;
    return Math.min(base, ride);
  };
}

function pickupsInOrder(pickups: readonly PickupPlacement[], ranked: readonly string[]): PickupPlacement[] {
  const used = new Set<string>();
  const ordered: PickupPlacement[] = [];
  for (const id of ranked) {
    const item = pickups.find((pickup) => pickup.id === id);
    if (!item || used.has(item.id)) continue;
    used.add(item.id);
    ordered.push(item);
  }
  const rest = pickups.filter((item) => item.kind !== "key" && !used.has(item.id));
  rest.sort((a, b) => byText(a.id, b.id));
  for (const item of rest) ordered.push(item);
  return ordered;
}

/** Keys a locked door asks for, plus the pickups named by the goal. */
function pickupsForGoals(
  pickups: readonly PickupPlacement[],
  goals: readonly { want: WorldState }[],
  ranked: readonly string[],
): PickupPlacement[] {
  const ids = new Set<string>(ranked);
  let wantsGear = false;
  for (const goal of goals) {
    if (goal.want[HAS_WEAPON] === true || goal.want[HAS_AMMO] === true) wantsGear = true;
    for (const fact in goal.want) {
      if (fact.startsWith("holding:") && goal.want[fact] === true) ids.add(fact.slice("holding:".length));
    }
  }
  return pickupsInOrder(pickups, ranked).filter(
    (item) => ids.has(item.id) || (wantsGear && (item.kind === "weapon" || item.kind === "ammo")),
  );
}

function relevantPlaces(
  graph: SceneGraph,
  pickups: readonly PickupPlacement[],
  goals: readonly { want: WorldState }[],
): string[] {
  const wanted = new Set<string>();
  for (const goal of goals) {
    const at = goal.want[AT];
    if (typeof at === "string") wanted.add(at);
  }
  for (const item of pickups) wanted.add(placeOfPickup(graph, item));
  return [...wanted].sort(byText);
}

function doorSideIndex(graph: SceneGraph): Map<string, [string, string]> {
  const sides = new Map<string, [string, string]>();
  for (const portal of graph.portals) {
    if (portal.kind !== "door") continue;
    const id = portal.door ?? portal.id;
    if (!sides.has(id)) sides.set(id, [portal.a, portal.b]);
  }
  return sides;
}

function goalPlace(
  goal: { want: WorldState },
  graph: SceneGraph,
  pickups: readonly PickupPlacement[],
): string | undefined {
  const at = goal.want[AT];
  if (typeof at === "string" && graph.placeById.has(at)) return at;
  const id = holdingId(goal);
  if (!id) return undefined;
  const item = pickups.find((pickup) => pickup.id === id);
  return item ? placeOfPickup(graph, item) : undefined;
}

function holdingId(goal: { want: WorldState }): string | undefined {
  for (const fact in goal.want) {
    if (!fact.startsWith("holding:") || goal.want[fact] !== true) continue;
    return fact.slice("holding:".length);
  }
  return undefined;
}

function memoMetres(read: (s: WorldState, ctx: BotCtx) => number): (s: WorldState, ctx: BotCtx) => number {
  let last: WorldState | undefined;
  let lastM = Infinity;
  return (s, ctx) => {
    if (last === s) return lastM;
    last = s;
    lastM = read(s, ctx);
    return lastM;
  };
}

function doorBits(graph: SceneGraph): DoorBit[] {
  return doorPortals(graph).map((portal) => ({ id: doorId(portal), locked: portal.locked === true }));
}

/** One character per door, in `doorBits` order. Only the facts `gateFor` reads. */
function gateKey(doors: readonly DoorBit[], s: WorldState, cache: WeakMap<WorldState, string>): string {
  const hit = cache.get(s);
  if (hit !== undefined) return hit;
  let sig = "";
  for (const door of doors) {
    const open = s[doorOpenFact(door.id)] === true;
    const known = s[doorLockedFact(door.id)];
    const locked = known === undefined ? door.locked : known === true;
    sig += open ? "o" : locked ? "l" : "c";
  }
  cache.set(s, sig);
  return sig;
}

function minActionSeconds(graph: SceneGraph): number {
  let metres = Infinity;
  for (const portal of graph.portals) {
    if (portal.kind === "elevator") continue;
    if (portal.cost > 0 && portal.cost < metres) metres = portal.cost;
  }
  const walk = Number.isFinite(metres) ? metres / WALK_MPS : ACT_S;
  return Math.min(ACT_S, walk);
}

function cachedMetres(
  graph: SceneGraph,
  fromPlace: string,
  toPlace: string,
  s: WorldState,
  pickupPoints: ReadonlyMap<string, Point>,
  doors: readonly DoorBit[],
  rows: Map<string, Map<string, Map<string, number>>>,
  gateKeys: WeakMap<WorldState, string>,
  roads: RoadCache,
  loose: boolean,
): number {
  if (fromPlace === toPlace) return 0;
  if (!graph.placeById.has(toPlace)) return Infinity;
  const rowKey = `${loose ? "L" : "S"}${gateKey(doors, s, gateKeys)}`;
  let byFrom = rows.get(rowKey);
  if (!byFrom) {
    byFrom = new Map();
    rows.set(rowKey, byFrom);
  }
  let row = byFrom.get(fromPlace);
  if (!row) {
    row = costRow(graph, fromPlace, s, pickupPoints, roads, loose);
    byFrom.set(fromPlace, row);
  }
  const found = row.get(toPlace);
  if (found !== undefined && found > 0) return found;
  if (loose) return Infinity;
  return stepBack(graph, fromPlace, toPlace, s) ?? stepOffDoor(graph, fromPlace, toPlace, s) ?? Infinity;
}

/** One strict (or have-key) Dijkstra from each origin, then the min positive cost per place. */
function costRow(
  graph: SceneGraph,
  fromPlace: string,
  s: WorldState,
  pickupPoints: ReadonlyMap<string, Point>,
  roads: RoadCache,
  loose: boolean,
): Map<string, number> {
  const gate = (portal: ScenePortal): Gate => {
    const status = gateFor(portal, s);
    if (loose && status === "locked") return "locked-have-key";
    return status;
  };
  const net = roads.net(gate, false);
  const out = new Map<string, number>();
  for (const origin of originsFor(graph, fromPlace, pickupPoints, s)) {
    for (const [id, metres] of routePlaceCosts(graph, origin, net)) {
      if (!(metres > 0)) continue;
      const prev = out.get(id);
      if (prev === undefined || metres < prev) out.set(id, metres);
    }
  }
  return out;
}

/**
 * `at` is the door token, and each stand point already sits in the target
 * place, so `planRoute` reports 0. Pay the portal once when the leaf allows it.
 * A locked leaf does not get this step.
 */
/** Leave the leaf back onto the side `goToDoor` stood on. Crossing stays locked. */
function stepBack(graph: SceneGraph, fromPlace: string, toPlace: string, s: WorldState): number | undefined {
  if (!fromPlace.startsWith(DOOR_AT_PREFIX)) return undefined;
  const id = fromPlace.slice(DOOR_AT_PREFIX.length);
  if (s[doorSideFact(id)] !== toPlace) return undefined;
  const portal = portalByDoor(graph, id);
  if (!portal) return undefined;
  const side = sides(portal).find((item) => item.place === toPlace);
  if (!side) return undefined;
  return walkToStand(graph, toPlace, side.point);
}

function stepOffDoor(graph: SceneGraph, fromPlace: string, toPlace: string, s: WorldState): number | undefined {
  if (!fromPlace.startsWith(DOOR_AT_PREFIX)) return undefined;
  const portal = portalByDoor(graph, fromPlace.slice(DOOR_AT_PREFIX.length));
  if (!portal || (portal.a !== toPlace && portal.b !== toPlace)) return undefined;
  const gate = gateFor(portal, s);
  if (gate === "locked" || gate === "unusable") return undefined;
  const extra = gate === "closed-unlocked" ? 1 : 0;
  const metres = portal.cost + extra;
  return metres > 0 ? metres : MIN_M;
}

function originsFor(
  graph: SceneGraph,
  fromPlace: string,
  pickupPoints: ReadonlyMap<string, Point>,
  s: WorldState,
): Point[] {
  if (fromPlace.startsWith(DOOR_AT_PREFIX)) {
    const id = fromPlace.slice(DOOR_AT_PREFIX.length);
    const portal = portalByDoor(graph, id);
    if (!portal) return [];
    const stood = s[doorSideFact(id)];
    if (typeof stood === "string") {
      const side = sides(portal).find((item) => item.place === stood);
      return side ? [side.point] : [];
    }
    // No recorded side. A locked leaf has no far-side origin to cheat from.
    if (gateFor(portal, s) === "locked") return [];
    return sides(portal).map((side) => side.point);
  }
  if (fromPlace.startsWith(PICKUP_AT_PREFIX)) {
    const point = pickupPoints.get(fromPlace.slice(PICKUP_AT_PREFIX.length));
    return point ? [point] : [];
  }
  const anchor = anchorForPlace(graph, fromPlace);
  return anchor ? [anchor] : [];
}

function anchorForPlace(graph: SceneGraph, id: string): Point | undefined {
  const place = graph.placeById.get(id);
  if (!place) return undefined;
  for (const [x, z] of interiorSamples(place)) {
    if (placeAt(graph, x, place.y, z).id === id) return { x, y: place.y, z };
  }
  return undefined;
}

function interiorSamples(place: { polygon: Array<[number, number]>; bounds: { minX: number; maxX: number; minZ: number; maxZ: number } }): Array<[number, number]> {
  const { polygon, bounds } = place;
  let sx = 0;
  let sz = 0;
  for (const [x, z] of polygon) {
    sx += x;
    sz += z;
  }
  const cx = sx / polygon.length;
  const cz = sz / polygon.length;
  const samples: Array<[number, number]> = [[cx, cz]];
  for (const [x, z] of polygon) samples.push([cx + (x - cx) * 0.5, cz + (z - cz) * 0.5]);
  const spanX = bounds.maxX - bounds.minX;
  const spanZ = bounds.maxZ - bounds.minZ;
  samples.push([(bounds.minX + bounds.maxX) / 2, (bounds.minZ + bounds.maxZ) / 2]);
  samples.push([bounds.minX + spanX * 0.25, bounds.minZ + spanZ * 0.25]);
  samples.push([bounds.maxX - spanX * 0.25, bounds.maxZ - spanZ * 0.25]);
  return samples;
}

/** Keys named by a locked alternative, cheapest route first. */
function rankedKeys(graph: SceneGraph): string[] {
  const state = locksFromGraph(graph);
  const best = new Map<string, number>();
  for (const portal of graph.portals) {
    if (portal.kind !== "door" || portal.locked !== true) continue;
    noteAlternative(graph, portal.a, portal.b, state, best);
    noteAlternative(graph, portal.b, portal.a, state, best);
  }
  return [...best.entries()].sort((a, b) => a[1] - b[1] || byText(a[0], b[0])).map(([id]) => id);
}

function locksFromGraph(graph: SceneGraph): WorldState {
  const state: Record<string, Fact> = {};
  for (const portal of graph.portals) {
    if (portal.kind !== "door") continue;
    const id = doorId(portal);
    state[doorOpenFact(id)] = false;
    state[doorLockedFact(id)] = portal.locked === true;
  }
  return state;
}

function noteAlternative(
  graph: SceneGraph,
  fromId: string,
  toId: string,
  state: WorldState,
  best: Map<string, number>,
): void {
  const origin = anchorForPlace(graph, fromId);
  if (!origin) return;
  const route = planRoute(graph, origin, toId, (portal) => gateFor(portal, state));
  const alt = route.lockedAlternative;
  if (!alt) return;
  for (const door of alt.doors) {
    if (!door.key) continue;
    const prev = best.get(door.key);
    if (prev === undefined || alt.cost < prev) best.set(door.key, alt.cost);
  }
}
