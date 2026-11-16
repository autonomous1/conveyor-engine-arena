// ARCHITECTURE: A complete point-to-point plan: portal routing, both local
//   approaches, and a reason for every failure.
// Wiring: the bot brain's walkToPoint and drivers use it; it composes route.ts
//   and legs.ts without changing their public shapes.
// Order: route, then legs, then the destination-place grid.
import type { ArenaView } from "../arena-view.js";
import { buildGrid, findLocalPath, navBoxes, specForPlace } from "./grid.js";
import { createNavCache, planLegs, type NavCache } from "./legs.js";
import { planRoute, type Gate, type Vec3Like } from "./route.js";
import { placeAt, type CabState, type SceneGraph, type Vec3 } from "../scene-graph.js";
import type { BakedRegionsFile } from "./regions.js";

/** Why a point-to-point plan failed. */
export type PathReason = "no-portal" | "start-blocked" | "target-blocked" | "no-floor" | "no-cell";

/** A complete polyline, or the named failure. */
export type PathPlan = { ok: true; points: Vec3[]; placeId: string } | { ok: false; reason: PathReason };

type PathView = Pick<ArenaView, "aabbs" | "doors" | "pawnRadius" | "pawnHeight">;

const EMPTY_VIEW: PathView = { aabbs: [], doors: [], pawnRadius: 0.5, pawnHeight: 1.8 };

/**
 * Plan a complete walk from `from` to a coordinate.
 * @post On success the polyline starts near `from` and ends within one grid
 *       cell of `to`; every failure names a PathReason, never undefined.
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
  } = {},
): PathPlan {
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
    cell: targetPlace === "outside" ? 0.5 : 0.25,
    radius: view.pawnRadius,
    height: view.pawnHeight,
    baseY: spec.baseY,
    block: spec.block,
  });
  const last = points[points.length - 1] ?? [from.x, from.y, from.z];
  const local = findLocalPath(grid, { x: last[0], z: last[2] }, { x: to.x, z: to.z });
  if (!local) return { ok: false, reason: "target-blocked" };
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
 * @post A missing or empty plan always re-plans; a place change re-plans when
 *       the planned place is supplied.
 */
export function replanNeeded(plan: readonly Vec3[], target: Vec3Like, placeId: string, driftM = 3, plannedPlace?: string): boolean {
  if (plan.length === 0) return true;
  if (plannedPlace !== undefined && plannedPlace !== placeId) return true;
  const last = plan[plan.length - 1]!;
  return Math.hypot(last[0] - target.x, last[2] - target.z) > driftM;
}
