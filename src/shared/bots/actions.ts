/**
 * Grounded GOAP actions over the scene graph.
 * `routeCost` is metres from `planRoute`. A locked leaf stays impassable
 * until `unlock` opens it in the simulated state. Holding the key does not.
 */
import { planRoute, type Gate } from "../nav/route.js";
import type { PickupPlacement } from "../pickups.js";
import { placeAt, type SceneGraph, type ScenePortal } from "../scene-graph.js";
import type { Action, Fact, WorldState } from "./goap.js";
import {
  HAS_AMMO,
  HAS_WEAPON,
  DOOR_AT_PREFIX,
  PICKUP_AT_PREFIX,
  atDoor,
  availFact,
  doorLockedFact,
  doorOpenFact,
  hasKeyFact,
  holdingFact,
} from "./state.js";

/** Travel estimate, metres per second. Turns and doors sit inside this figure. */
const WALK_MPS = 4;
/** Short use or pickup, in seconds. The planner rejects a cost that is not positive. */
const ACT_S = 0.5;
/** Smallest positive route, in metres, when a stand point is already the anchor. */
const MIN_M = 0.5;

export type BotCtx = {
  graph: SceneGraph;
  /** Metres. Infinite when no route exists under the simulated door state. */
  routeCost(fromPlace: string, toPlace: string, s: WorldState): number;
};

type Point = { x: number; y: number; z: number };

export function createBotContext(graph: SceneGraph, pickups: readonly PickupPlacement[] = []): BotCtx {
  const pickupPoints = new Map<string, Point>();
  for (const item of pickups) pickupPoints.set(item.id, feet(item));
  return {
    graph,
    routeCost(fromPlace, toPlace, s) {
      return travelMetres(graph, fromPlace, toPlace, s, pickupPoints);
    },
  };
}

/**
 * One action per place, door, locked leaf, and pickup.
 * A key pickup is grounded only when `lockedAlternative` names that key,
 * cheapest alternative first, so unused keys never enter the search.
 */
export function groundActions(graph: SceneGraph, pickups: readonly PickupPlacement[]): Action<BotCtx>[] {
  const actions: Action<BotCtx>[] = [];
  const places = graph.places.map((place) => place.id).sort(byText);
  for (const place of places) actions.push(goTo(place));

  const doors = doorPortals(graph);
  for (const portal of doors) actions.push(goToDoor(doorId(portal)));

  for (const portal of doors) {
    if (portal.locked !== true || !portal.key) continue;
    actions.push(unlock(doorId(portal), portal.key));
  }

  const ranked = rankedKeys(graph);
  const used = new Set<string>();
  for (const id of ranked) {
    const item = pickups.find((pickup) => pickup.id === id);
    if (!item || used.has(item.id)) continue;
    used.add(item.id);
    actions.push(pickup(item, placeOfPickup(graph, item)));
  }
  const rest = pickups.filter((item) => item.kind !== "key" && !used.has(item.id));
  rest.sort((a, b) => byText(a.id, b.id));
  for (const item of rest) {
    used.add(item.id);
    actions.push(pickup(item, placeOfPickup(graph, item)));
  }
  return actions;
}

export function goTo(place: string): Action<BotCtx> {
  const metres = (s: WorldState, ctx: BotCtx) => ctx.routeCost(String(s.at), place, s);
  return {
    id: `goTo:${place}`,
    pre: {},
    eff: { at: place },
    usable: (s, ctx) => s.at !== place && metres(s, ctx) > 0 && Number.isFinite(metres(s, ctx)),
    cost: (s, ctx) => metres(s, ctx) / WALK_MPS,
  };
}

/** Stand on the reachable side of a leaf. Effect is `at = door:<id>`. */
export function goToDoor(door: string): Action<BotCtx> {
  const metres = (s: WorldState, ctx: BotCtx): number => {
    if (s.at === atDoor(door)) return Infinity;
    const portal = portalByDoor(ctx.graph, door);
    if (!portal) return Infinity;
    let best = Infinity;
    for (const side of sides(portal)) {
      const travel = metresToSide(s, ctx, side.place, side.point);
      if (travel < best) best = travel;
    }
    return best;
  };
  return {
    id: `goToDoor:${door}`,
    pre: {},
    eff: { at: atDoor(door) },
    usable: (s, ctx) => Number.isFinite(metres(s, ctx)),
    cost: (s, ctx) => metres(s, ctx) / WALK_MPS,
  };
}

export function unlock(door: string, key: string): Action<BotCtx> {
  return {
    id: `unlock:${door}`,
    pre: { at: atDoor(door), [doorLockedFact(door)]: true, [hasKeyFact(key)]: true },
    eff: { [doorLockedFact(door)]: false, [doorOpenFact(door)]: true },
    cost: ACT_S,
  };
}

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

/** Place under the pickup. Feet are a metre under the box centre, or `outside`. */
export function placeOfPickup(graph: SceneGraph, item: PickupPlacement): string {
  const point = feet(item);
  return placeAt(graph, point.x, point.y, point.z).id;
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
  if (at === place) return walkToStand(ctx.graph, place, stand);
  const travel = ctx.routeCost(at, place, s);
  if (!Number.isFinite(travel)) return Infinity;
  return travel > 0 ? travel : walkToStand(ctx.graph, place, stand);
}

function walkToStand(graph: SceneGraph, place: string, stand: Point): number {
  const anchor = anchorForPlace(graph, place);
  if (!anchor) return Infinity;
  const metres = Math.hypot(anchor.x - stand.x, anchor.y - stand.y, anchor.z - stand.z);
  return metres > 0 ? metres : MIN_M;
}

function travelMetres(
  graph: SceneGraph,
  fromPlace: string,
  toPlace: string,
  s: WorldState,
  pickupPoints: ReadonlyMap<string, Point>,
): number {
  if (fromPlace === toPlace) return 0;
  if (!graph.placeById.has(toPlace)) return Infinity;
  let best = Infinity;
  for (const origin of originsFor(graph, fromPlace, pickupPoints)) {
    const route = planRoute(graph, origin, toPlace, (portal) => gateFor(portal, s));
    if (!route.ok || !(route.cost > 0)) continue;
    if (route.cost < best) best = route.cost;
  }
  if (Number.isFinite(best)) return best;
  const stepped = stepOffDoor(graph, fromPlace, toPlace, s);
  return stepped ?? Infinity;
}

/**
 * `at` is the door token, and each stand point already sits in the target
 * place, so `planRoute` reports 0. Pay the portal once when the leaf allows it.
 * A locked leaf does not get this step.
 */
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
): Point[] {
  if (fromPlace.startsWith(DOOR_AT_PREFIX)) {
    const portal = portalByDoor(graph, fromPlace.slice(DOOR_AT_PREFIX.length));
    if (!portal) return [];
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
