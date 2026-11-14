/**
 * Portal sequence over a scene graph. Local walking inside a place is a
 * straight line between `at` points; task 07 plans around obstacles.
 *
 * A moving cab resolves to the shaft id, and that place has no portals.
 * The rider is waiting for the stop the cab is going to (`target`, else `at`),
 * so the search starts on `<shaft>@<i>` instead of failing. Elevator portals
 * stay unusable unless `opts.elevators` is set.
 */
// ARCHITECTURE: Portal routing: one compiled net per gate signature, plus the
//   strict place-cost map the planner reads.
// Wiring: server/game.ts calls `planRoute`; server/bot-brain.ts builds the road
//   cache and calls `routePlaceCosts`; shared/bots/actions.ts plans through it.
// Order: a net is compiled once per (graph, gates, elevators) signature, before
//   `routePlaceCosts` is called for an origin.
// Invariants: The same signature reuses one compile; `net` returns a new
//   wrapper each call but the same live roads.
import {
  isElevatorShaft,
  placeAt,
  type CabState,
  type SceneGraph,
  type ScenePortal,
  type Vec3,
} from "../scene-graph.js";

export type Gate = "open" | "closed-unlocked" | "locked-have-key" | "locked" | "unusable";

export type Vec3Like = { x: number; y: number; z: number };

export type RouteStep = {
  portal: ScenePortal;
  from: string;
  to: string;
  enter: Vec3;
  exit: Vec3;
};

export type LockedAlternative = {
  steps: RouteStep[];
  cost: number;
  doors: Array<{ door: string; key?: string }>;
};

export type Route =
  | { ok: true; steps: RouteStep[]; places: string[]; cost: number; lockedAlternative?: LockedAlternative }
  | { ok: false; reason: "no-route" | "unknown-target"; lockedAlternative?: LockedAlternative };

const EXTRA: Record<Gate, number> = {
  open: 0,
  "closed-unlocked": 1,
  "locked-have-key": 1.5,
  locked: Infinity,
  unusable: Infinity,
};

/** Permissive search: a locked leaf is passable at the have-key penalty. */
const LOCKED_PASS = 1.5;

type Point = { x: number; y: number; z: number };

type Found = { steps: RouteStep[]; places: string[]; cost: number };

type Dir = {
  portal: ScenePortal;
  to: number;
  toId: string;
  fromId: string;
  enter: Vec3;
  exit: Vec3;
  /** Portal cost plus the gate penalty. Infinite when this mode cannot cross. */
  strict: number;
  loose: number;
};

/** Compiled portals for one graph and one gate snapshot. */
export type RoadNet = { readonly roads: Roads };

/** Compiled portal nets for one graph. One net per gate signature. */
export type RoadCache = {
  /** New compiles. The same gate results and `elevators` flag do not increment. */
  compiles: number;
  /**
   * Omitted `elevators` means false. New wrapper each call.
   * `roads` is the live cached compile; do not mutate it.
   */
  net(gate: (portal: ScenePortal) => Gate, elevators?: boolean): RoadNet;
};

/**
 * One compiled net per gate signature.
 * @why `plan` asks for hundreds of routes under the same doors; compiling each
 *      one is the hang.
 * @invariant The same gate results and `elevators` flag reuse one compile; a
 *            changed signature compiles again.
 *            (test: road_cache_one_net_per_signature)
 */
export function createRoadCache(graph: SceneGraph): RoadCache {
  const bucket = new Map<string, Roads>();
  const cache: RoadCache = {
    compiles: 0,
    net(gate, elevators = false) {
      const sig = `${elevators ? "1" : "0"}\0${gateSignature(graph, gate)}`;
      const hit = bucket.get(sig);
      if (hit) return { roads: hit };
      const built = compile(graph, gate, elevators);
      cache.compiles += 1;
      bucket.set(sig, built);
      return { roads: built };
    },
  };
  return cache;
}

const SHARED_NETS = new WeakMap<SceneGraph, RoadCache>();

function sharedNet(graph: SceneGraph, gate: (portal: ScenePortal) => Gate, elevators: boolean): Roads {
  let cache = SHARED_NETS.get(graph);
  if (!cache) {
    cache = createRoadCache(graph);
    SHARED_NETS.set(graph, cache);
  }
  return cache.net(gate, elevators).roads;
}

function gateSignature(graph: SceneGraph, gate: (portal: ScenePortal) => Gate): string {
  let sig = "";
  for (const portal of graph.portals) {
    sig += gate(portal);
    sig += "\0";
  }
  return sig;
}

/**
 * Strict metres from `from` to every reachable place.
 * @post The origin place is 0; missing ids are unreachable. One Dijkstra;
 *       `net` already baked the gate, so several origins share one compile.
 */
export function routePlaceCosts(
  graph: SceneGraph,
  from: Vec3Like,
  net: RoadNet,
  cabs?: readonly CabState[],
): ReadonlyMap<string, number> {
  const origin = onFoot(graph, placeAt(graph, from.x, from.y, from.z, cabs), from, cabs);
  return costsFrom(net.roads, origin);
}

export function planRoute(
  graph: SceneGraph,
  from: Vec3Like,
  to: string | Vec3Like,
  gate: (portal: ScenePortal) => Gate,
  opts: { elevators?: boolean; cabs?: readonly CabState[] } = {},
): Route {
  const origin = onFoot(graph, placeAt(graph, from.x, from.y, from.z, opts.cabs), from, opts.cabs);
  const goal = resolveGoal(graph, to, opts.cabs);
  if (!goal) return { ok: false, reason: "unknown-target" };

  if (origin.id === goal.id) {
    const cost = goal.point ? distance(origin.point, goal.point) : 0;
    return { ok: true, steps: [], places: [origin.id], cost };
  }

  const roads = sharedNet(graph, gate, opts.elevators === true);
  const strict = search(roads, origin, goal, false);
  const loose = roads.locked ? search(roads, origin, goal, true) : strict;
  const lockedAlternative = alternative(strict, loose, gate, opts.elevators === true);

  if (!strict) {
    return lockedAlternative
      ? { ok: false, reason: "no-route", lockedAlternative }
      : { ok: false, reason: "no-route" };
  }
  return lockedAlternative ? { ok: true, ...strict, lockedAlternative } : { ok: true, ...strict };
}

function resolveGoal(
  graph: SceneGraph,
  to: string | Vec3Like,
  cabs: readonly CabState[] | undefined,
): { id: string; point?: Point } | undefined {
  if (typeof to === "string") {
    if (!graph.placeById.has(to)) return undefined;
    return { id: to };
  }
  const resolved = placeAt(graph, to.x, to.y, to.z, cabs);
  return onFoot(graph, resolved, to, cabs);
}

/** Shaft id → the stop the cab is heading to. Other places stay put. */
function onFoot(
  graph: SceneGraph,
  place: ReturnType<typeof placeAt>,
  point: Point,
  cabs: readonly CabState[] | undefined,
): { id: string; point: Point } {
  if (!isElevatorShaft(place)) return { id: place.id, point };
  const cab = cabs?.find((item) => item.id === place.id);
  if (!cab) return { id: place.id, point };
  const stop = graph.placeById.get(`${place.id}@${cab.target ?? cab.at}`);
  if (!stop) return { id: place.id, point };
  return { id: stop.id, point: { x: point.x, y: stop.y, z: point.z } };
}

type Roads = {
  placeIds: string[];
  /** Lexicographic rank of each place index. Tie-break without comparing strings. */
  order: Uint32Array;
  index: Map<string, number>;
  out: number[][];
  dirs: Dir[];
  locked: boolean;
};

function compile(graph: SceneGraph, gate: (portal: ScenePortal) => Gate, elevators: boolean): Roads {
  const placeIds = graph.places.map((place) => place.id);
  const index = new Map(placeIds.map((id, i) => [id, i]));
  const grouped: Dir[][] = placeIds.map(() => []);
  let locked = false;
  for (const portal of graph.portals) {
    const weights = weigh(portal, gate, elevators);
    if (!weights) continue;
    if (!Number.isFinite(weights.strict)) locked = true;
    const ai = index.get(portal.a);
    const bi = index.get(portal.b);
    if (ai === undefined || bi === undefined) continue;
    grouped[ai]!.push(dir(portal, bi, "a", weights));
    if (portal.a !== portal.b) grouped[bi]!.push(dir(portal, ai, "b", weights));
  }
  const dirs: Dir[] = [];
  const out: number[][] = grouped.map((list) => {
    list.sort((a, b) => (a.portal.id < b.portal.id ? -1 : a.portal.id > b.portal.id ? 1 : 0));
    return list.map((item) => {
      const id = dirs.length;
      dirs.push(item);
      return id;
    });
  });
  return { placeIds, order: placeOrder(placeIds), index, out, dirs, locked };
}

function placeOrder(placeIds: string[]): Uint32Array {
  const order = new Uint32Array(placeIds.length);
  const sorted = placeIds.map((_, i) => i);
  sorted.sort((a, b) => (placeIds[a]! < placeIds[b]! ? -1 : placeIds[a]! > placeIds[b]! ? 1 : 0));
  for (let i = 0; i < sorted.length; i += 1) order[sorted[i]!] = i;
  return order;
}

function dir(
  portal: ScenePortal,
  to: number,
  fromSide: "a" | "b",
  weights: { strict: number; loose: number },
): Dir {
  const toSide: "a" | "b" = fromSide === "a" ? "b" : "a";
  return {
    portal,
    to,
    toId: portal[toSide],
    fromId: portal[fromSide],
    enter: portal.at[fromSide],
    exit: portal.at[toSide],
    strict: weights.strict,
    loose: weights.loose,
  };
}

function weigh(
  portal: ScenePortal,
  gate: (portal: ScenePortal) => Gate,
  elevators: boolean,
): { strict: number; loose: number } | undefined {
  if (portal.kind === "elevator" && !elevators) return undefined;
  const status = gate(portal);
  if ((status as string) === "opening") return { strict: portal.cost, loose: portal.cost };
  if (status === "locked") return { strict: Infinity, loose: portal.cost + LOCKED_PASS };
  const extra = EXTRA[status];
  if (extra === undefined || !Number.isFinite(extra)) return undefined;
  return { strict: portal.cost + extra, loose: portal.cost + extra };
}

function search(
  roads: Roads,
  origin: { id: string; point: Point },
  goal: { id: string; point?: Point },
  allowLocked: boolean,
): Found | undefined {
  const originIndex = roads.index.get(origin.id);
  const goalIndex = roads.index.get(goal.id);
  if (originIndex === undefined || goalIndex === undefined) return undefined;

  const cost: number[] = [0];
  const place: number[] = [originIndex];
  const px: number[] = [origin.point.x];
  const py: number[] = [origin.point.y];
  const pz: number[] = [origin.point.z];
  const prev: number[] = [-1];
  const via: number[] = [-1];
  const seq: number[] = [0];
  const best = new Float64Array(roads.dirs.length);
  best.fill(Infinity);
  const heap: number[] = [0];
  let stamp = 0;
  let bestState = -1;
  let bestTotal = Infinity;

  while (heap.length > 0) {
    const state = pop(heap, cost, place, seq, roads.order);
    const stateCost = cost[state]!;
    const arrived = via[state]!;
    if (arrived >= 0 && stateCost > best[arrived]!) continue;
    if (stateCost > bestTotal) break;
    const here = place[state]!;
    if (here === goalIndex) {
      const total = goal.point
        ? stateCost + distance({ x: px[state]!, y: py[state]!, z: pz[state]! }, goal.point)
        : stateCost;
      if (total < bestTotal) {
        bestTotal = total;
        bestState = state;
      }
      if (!goal.point) break;
      continue;
    }

    const exits = roads.out[here];
    if (!exits) continue;
    for (const dirId of exits) {
      const edge = roads.dirs[dirId]!;
      const cross = allowLocked ? edge.loose : edge.strict;
      if (!Number.isFinite(cross)) continue;
      const dx = px[state]! - edge.enter[0];
      const dy = py[state]! - edge.enter[1];
      const dz = pz[state]! - edge.enter[2];
      const nextCost = stateCost + Math.hypot(dx, dy, dz) + cross;
      if (!(nextCost < best[dirId]!)) continue;
      best[dirId] = nextCost;
      stamp += 1;
      const id = cost.length;
      cost.push(nextCost);
      place.push(edge.to);
      px.push(edge.exit[0]);
      py.push(edge.exit[1]);
      pz.push(edge.exit[2]);
      prev.push(state);
      via.push(dirId);
      seq.push(stamp);
      push(heap, id, cost, place, seq, roads.order);
    }
  }

  if (bestState < 0) return undefined;
  return { ...trace(bestState, prev, via, place, roads), cost: bestTotal };
}

/** Min strict arrival cost at each place. Same edge weights as `search` with locks closed. */
function costsFrom(roads: Roads, origin: { id: string; point: Point }): Map<string, number> {
  const out = new Map<string, number>();
  const originIndex = roads.index.get(origin.id);
  if (originIndex === undefined) return out;

  const bestAt = new Float64Array(roads.placeIds.length);
  bestAt.fill(Infinity);
  const cost: number[] = [0];
  const place: number[] = [originIndex];
  const px: number[] = [origin.point.x];
  const py: number[] = [origin.point.y];
  const pz: number[] = [origin.point.z];
  const via: number[] = [-1];
  const seq: number[] = [0];
  const best = new Float64Array(roads.dirs.length);
  best.fill(Infinity);
  const heap: number[] = [0];
  let stamp = 0;

  while (heap.length > 0) {
    const state = pop(heap, cost, place, seq, roads.order);
    const stateCost = cost[state]!;
    const arrived = via[state]!;
    if (arrived >= 0 && stateCost > best[arrived]!) continue;
    const here = place[state]!;
    if (stateCost < bestAt[here]!) bestAt[here] = stateCost;

    const exits = roads.out[here];
    if (!exits) continue;
    for (const dirId of exits) {
      const edge = roads.dirs[dirId]!;
      const cross = edge.strict;
      if (!Number.isFinite(cross)) continue;
      const dx = px[state]! - edge.enter[0];
      const dy = py[state]! - edge.enter[1];
      const dz = pz[state]! - edge.enter[2];
      const nextCost = stateCost + Math.hypot(dx, dy, dz) + cross;
      if (!(nextCost < best[dirId]!)) continue;
      best[dirId] = nextCost;
      stamp += 1;
      const id = cost.length;
      cost.push(nextCost);
      place.push(edge.to);
      px.push(edge.exit[0]);
      py.push(edge.exit[1]);
      pz.push(edge.exit[2]);
      via.push(dirId);
      seq.push(stamp);
      push(heap, id, cost, place, seq, roads.order);
    }
  }

  for (let i = 0; i < bestAt.length; i += 1) {
    const metres = bestAt[i]!;
    if (Number.isFinite(metres)) out.set(roads.placeIds[i]!, metres);
  }
  return out;
}

function alternative(
  strict: Found | undefined,
  loose: Found | undefined,
  gate: (portal: ScenePortal) => Gate,
  elevators: boolean,
): LockedAlternative | undefined {
  if (!loose) return undefined;
  if (strict && loose.cost >= strict.cost) return undefined;
  const doors: LockedAlternative["doors"] = [];
  const seen = new Set<string>();
  for (const step of loose.steps) {
    const portal = step.portal;
    if (portal.kind === "elevator" && !elevators) continue;
    if (gate(portal) !== "locked") continue;
    const door = portal.door ?? portal.id;
    if (seen.has(door)) continue;
    seen.add(door);
    doors.push(portal.key ? { door, key: portal.key } : { door });
  }
  if (doors.length === 0) return undefined;
  return { steps: loose.steps, cost: loose.cost, doors };
}

function trace(
  state: number,
  prev: number[],
  via: number[],
  place: number[],
  roads: Roads,
): { steps: RouteStep[]; places: string[] } {
  const chain: number[] = [];
  for (let cursor = state; cursor >= 0; cursor = prev[cursor]!) chain.push(cursor);
  chain.reverse();
  const steps: RouteStep[] = [];
  const places: string[] = [];
  for (const id of chain) {
    places.push(roads.placeIds[place[id]!]!);
    const dirId = via[id]!;
    if (dirId < 0) continue;
    const edge = roads.dirs[dirId]!;
    steps.push({
      portal: edge.portal,
      from: edge.fromId,
      to: edge.toId,
      enter: edge.enter,
      exit: edge.exit,
    });
  }
  return { steps, places };
}

function distance(point: Point, to: Vec3 | Point): number {
  const x = Array.isArray(to) ? to[0] : to.x;
  const y = Array.isArray(to) ? to[1] : to.y;
  const z = Array.isArray(to) ? to[2] : to.z;
  return Math.hypot(point.x - x, point.y - y, point.z - z);
}

function less(
  a: number,
  b: number,
  cost: number[],
  place: number[],
  seq: number[],
  order: Uint32Array,
): boolean {
  const costA = cost[a]!;
  const costB = cost[b]!;
  if (costA !== costB) return costA < costB;
  const idA = order[place[a]!]!;
  const idB = order[place[b]!]!;
  if (idA !== idB) return idA < idB;
  return seq[a]! < seq[b]!;
}

function push(
  heap: number[],
  item: number,
  cost: number[],
  place: number[],
  seq: number[],
  order: Uint32Array,
): void {
  heap.push(item);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = (index - 1) >> 1;
    if (!less(heap[index]!, heap[parent]!, cost, place, seq, order)) break;
    const swap = heap[parent]!;
    heap[parent] = heap[index]!;
    heap[index] = swap;
    index = parent;
  }
}

function pop(
  heap: number[],
  cost: number[],
  place: number[],
  seq: number[],
  order: Uint32Array,
): number {
  const top = heap[0]!;
  const last = heap.pop()!;
  if (heap.length === 0) return top;
  heap[0] = last;
  let index = 0;
  for (;;) {
    const left = index * 2 + 1;
    const right = left + 1;
    let best = index;
    if (left < heap.length && less(heap[left]!, heap[best]!, cost, place, seq, order)) best = left;
    if (right < heap.length && less(heap[right]!, heap[best]!, cost, place, seq, order)) best = right;
    if (best === index) break;
    const swap = heap[best]!;
    heap[best] = heap[index]!;
    heap[index] = swap;
    index = best;
  }
  return top;
}
