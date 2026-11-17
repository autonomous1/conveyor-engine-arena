// ARCHITECTURE: A complete point-to-point plan: portal routing, both local
//   approaches, and a reason for every failure.
// Wiring: the bot brain's walkToPoint and drivers use it; it composes route.ts
//   and legs.ts without changing their public shapes.
// Order: route, then legs, then the destination-place grid.
import type { ArenaView } from "../arena-view.js";
import { buildGrid, findLocalPath, navBoxes, specForPlace } from "./grid.js";
import { createNavCache, planLegs, type NavCache } from "./legs.js";
import { planRoute, type Gate, type Vec3Like } from "./route.js";
import { Vector3 } from "three";
import { placeAt, type CabState, type SceneGraph, type Vec3 } from "../scene-graph.js";
import { nodeAt, type SpatialDAG } from "../spatial-dag.js";
import type { BakedRegionsFile } from "./regions.js";

/** Why a point-to-point plan failed. */
export type PathReason = "no-portal" | "start-blocked" | "target-blocked" | "no-floor" | "no-cell";

/** A complete polyline, or the named failure. */
export type PathPlan = { ok: true; points: Vec3[]; placeId: string } | { ok: false; reason: PathReason };

type PathView = Pick<ArenaView, "aabbs" | "doors" | "pawnRadius" | "pawnHeight">;

const EMPTY_VIEW: PathView = { aabbs: [], doors: [], pawnRadius: 0.5, pawnHeight: 1.8 };

/**
 * Plan a complete walk from `from` to a coordinate.
 * @post On success the polyline starts at the un-stuck start and ends at `to`
 *       or a free cell within 1 m; every failure names a PathReason.
 */
export function planPath(
  graph: SceneGraph,
  from: Vec3Like,
  to: Vec3Like,
  gate: (portal: import("../scene-graph.js").ScenePortal) => Gate,
  opts: {
    view?: PathView;
    cabs?: readonly CabState[];
    regions?: BakedRegionsFile;
    cache?: NavCache;
    elevators?: boolean;
    dag?: SpatialDAG;
  } = {},
): PathPlan {
  if (opts.dag) return planDagPath(opts.dag, from, to, placeAt(graph, to.x, to.y, to.z, opts.cabs).id);
  const view = opts.view ?? EMPTY_VIEW;
  const cache = opts.cache ?? createNavCache();
  const targetPlace = placeAt(graph, to.x, to.y, to.z, opts.cabs).id;
  const route = planRoute(graph, from, to, gate, { elevators: opts.elevators, cabs: opts.cabs });
  if (!route.ok) return { ok: false, reason: "no-portal" };
  const legs = planLegs(graph, view, route, from, { cache, cabs: opts.cabs, regions: opts.regions });
  if (!legs.ok) return { ok: false, reason: "no-portal" };
  const points = legs.points.map((point) => [point[0], point[1], point[2]] as Vec3);
  const spec = specForPlace(graph, targetPlace);
  if (!spec) return { ok: false, reason: "no-floor" };
  const shut = new Set(view.doors.filter((door) => !door.open).map((door) => door.id));
  const grid = buildGrid(spec.area, navBoxes(view, graph, shut, opts.cabs), {
    cell: 0.25,
    radius: view.pawnRadius,
    height: view.pawnHeight,
    baseY: spec.baseY,
    block: spec.block,
  });
  const last = points.length > 1 ? points[points.length - 1]! : [from.x, from.y, from.z];
  let goal = { x: to.x, z: to.z };
  if (cellBlocked(grid, goal.x, goal.z) !== 0) {
    const snapped = freeCellNear(grid, goal.x, goal.z, 1);
    if (!snapped) return { ok: false, reason: "target-blocked" };
    goal = snapped;
  }
  let start = { x: last[0], z: last[2] };
  if (cellBlocked(grid, start.x, start.z) !== 0) {
    const freed = freeCellNear(grid, start.x, start.z, 1);
    if (!freed) return { ok: false, reason: "start-blocked" };
    start = freed;
  }
  let local = findLocalPath(grid, start, goal);
  if (!local) return { ok: false, reason: "target-blocked" };
  if (local.length === 1 && Math.hypot(local[0]![0] - goal.x, local[0]![2] - goal.z) > 0.05) {
    local = [[goal.x, local[0]![1], goal.z]];
  }
  for (const point of local) {
    const tail = points[points.length - 1];
    if (tail && Math.abs(tail[0] - point[0]) < 1e-4 && Math.abs(tail[2] - point[2]) < 1e-4) {
      tail[1] = point[1];
      continue;
    }
    points.push([point[0], point[1], point[2]]);
  }
  return { ok: true, points, placeId: targetPlace };
}

/**
 * True when a moving target has drifted more than `driftM` from the plan's
 * destination or changed place.
 * @pre `plan` came from `planPath`, or the caller supplies `plannedPlace`.
 * @post A missing or empty plan always re-plans; a place change re-plans when
 *       the planned place is supplied.
 */
function macroPath(dag: SpatialDAG, start: string, goal: string): string[] | undefined {
  if (start === goal) return [start];
  const open = new Set([start]);
  const cameFrom = new Map<string, string>();
  const cost = new Map<string, number>([[start, 0]]);
  while (open.size > 0) {
    let current: string | undefined;
    let best = Infinity;
    for (const id of open) {
      const c = cost.get(id) ?? Infinity;
      if (c < best) { best = c; current = id; }
    }
    if (current === undefined) break;
    if (current === goal) {
      const out = [goal];
      let at = goal;
      while (at !== start) { const prev = cameFrom.get(at); if (!prev) return undefined; out.unshift(prev); at = prev; }
      return out;
    }
    open.delete(current);
    for (const next of dag.byId.get(current)?.adjacency ?? []) {
      if (!dag.byId.has(next)) continue;
      const nextCost = (cost.get(current) ?? Infinity) + 1;
      if (nextCost >= (cost.get(next) ?? Infinity)) continue;
      cost.set(next, nextCost);
      cameFrom.set(next, current);
      open.add(next);
    }
  }
  return undefined;
}

function planDagPath(dag: SpatialDAG, from: Vec3Like, to: Vec3Like, targetPlace: string): PathPlan {
  const start = nodeAt(dag, from);
  const goal = dag.byId.get(targetPlace) ?? nodeAt(dag, to);
  if (!start || !goal) return { ok: false, reason: "no-cell" };
  const sequence = macroPath(dag, start.id, goal.id);
  if (!sequence) return { ok: false, reason: "no-portal" };
  const points: Vec3[] = [[from.x, from.y, from.z]];
  for (const id of sequence.slice(1, -1)) {
    const node = dag.byId.get(id)!;
    const center = node.bounds.getCenter(new Vector3());
    points.push([center.x, center.y, center.z]);
  }
  points.push([to.x, to.y, to.z]);
  return { ok: true, points, placeId: goal.id };
}

function cellBlocked(grid: ReturnType<typeof buildGrid>, x: number, z: number): number {
  const i = Math.floor((x - grid.minX) / grid.cell);
  const j = Math.floor((z - grid.minZ) / grid.cell);
  if (i < 0 || j < 0 || i >= grid.w || j >= grid.h) return 2;
  return grid.blocked[j * grid.w + i] ?? 2;
}

function freeCellNear(grid: ReturnType<typeof buildGrid>, x: number, z: number, metres: number): { x: number; z: number } | undefined {
  const reach = Math.ceil(metres / grid.cell);
  let best: { x: number; z: number; d: number } | undefined;
  const ci = Math.floor((x - grid.minX) / grid.cell);
  const cj = Math.floor((z - grid.minZ) / grid.cell);
  for (let j = cj - reach; j <= cj + reach; j += 1) {
    for (let i = ci - reach; i <= ci + reach; i += 1) {
      if (i < 0 || j < 0 || i >= grid.w || j >= grid.h) continue;
      if ((grid.blocked[j * grid.w + i] ?? 1) !== 0) continue;
      const px = grid.minX + (i + 0.5) * grid.cell;
      const pz = grid.minZ + (j + 0.5) * grid.cell;
      const d = Math.hypot(px - x, pz - z);
      if (d <= metres && (!best || d < best.d)) best = { x: px, z: pz, d };
    }
  }
  return best ? { x: best.x, z: best.z } : undefined;
}

/**
 * True when a moving target has drifted more than `driftM` from the plan's
 * destination or changed place.
 * @pre `plan` came from `planPath`, or the caller supplies `plannedPlace`.
 * @post A missing or empty plan always re-plans; a place change re-plans when
 *       the planned place is supplied.
 */
export function replanNeeded(plan: readonly Vec3[], target: Vec3Like, placeId: string, driftM = 3, plannedPlace?: string): boolean {
  if (plan.length === 0) return true;
  if (plannedPlace !== undefined && plannedPlace !== placeId) return true;
  const last = plan[plan.length - 1]!;
  return Math.hypot(last[0] - target.x, last[2] - target.z) > driftM;
}
