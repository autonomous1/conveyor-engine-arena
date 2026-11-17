// ARCHITECTURE: Candidate cover points scored by the static DAG ray and the
//   current dynamic door boxes; the caller consumes one, this never moves.
// Wiring: bot client runAttack and host bot sense/arbiter read the sorted list;
//   it composes spatial-dag and scene-graph only.
// Order: generate candidates, evaluate each, sort and dedupe.
// Invariants: `block` is exactly the raycast result; a shut door must be a
//   dynamic box or it does not block. (test: cover_evaluation_matches_the_raycast)
import { placeAt, type SceneGraph } from "../scene-graph.js";
import type { SpatialDAG } from "../spatial-dag.js";
import { hasLineOfSightDag, type TraceAabb } from "../hitscan.js";

/**
 * One scored candidate. `block` means a static/dynamic face cuts the candidate
 * eye to the target chest; `los` is its inverse.
 */
export type CoverPoint = {
  x: number;
  y: number;
  z: number;
  score: number;
  block: boolean;
  los: boolean;
  dist: number;
  angle: number;
};

/**
 * Cover query tuning and the current dynamic blockers.
 */
export type CoverOptions = {
  idealDistance?: number;
  dynamic?: readonly TraceAabb[];
  limit?: number;
};

const EYE = 1.6;
const CHEST = 1.2;

function pointAt(x: number, y: number, z: number): { x: number; y: number; z: number } {
  return { x, y, z };
}

function angleOf(from: { x: number; z: number }, to: { x: number; z: number }): number {
  const a = Math.atan2(to.x - from.x, to.z - from.z);
  return Math.abs(Math.atan2(Math.sin(a), Math.cos(a)));
}

/**
 * Score one candidate against the target.
 * @post `block === !los`; the score is finite for finite points.
 */
export function evaluateCover(
  dag: SpatialDAG,
  point: { x: number; y: number; z: number },
  target: { x: number; y: number; z: number },
  opts: CoverOptions = {},
): CoverPoint {
  const eye = pointAt(point.x, point.y + EYE, point.z);
  const chest = pointAt(target.x, target.y + CHEST, target.z);
  const span = Math.hypot(chest.x - eye.x, chest.y - eye.y, chest.z - eye.z);
  const dist = Math.hypot(point.x - target.x, point.z - target.z);
  const clear = hasLineOfSightDag(dag, eye, chest, opts.dynamic ?? []);
  const ideal = opts.idealDistance ?? 5;
  const angle = angleOf(point, target);
  const score = (clear ? -2 : 3) + Math.max(0, 2 - Math.abs(dist - ideal) * 0.2) + (1 - angle / Math.PI) * 0.5;
  return { x: point.x, y: point.y, z: point.z, score, block: !clear, los: clear, dist, angle };
}

/**
 * Candidate points around the target place: a ring plus the place polygon.
 * @post Every candidate is finite and at the target floor height.
 */
export function findCoverPoints(
  dag: SpatialDAG,
  graph: SceneGraph,
  eye: { x: number; y: number; z: number },
  target: { x: number; y: number; z: number },
  opts: CoverOptions = {},
): CoverPoint[] {
  let polygon: ReadonlyArray<readonly [number, number]> = [];
  try {
    polygon = placeAt(graph, target.x, target.y, target.z).polygon;
  } catch {
    polygon = [];
  }
  const candidates = new Map<string, { x: number; y: number; z: number }>();
  const add = (x: number, y: number, z: number): void => {
    if (![x, y, z].every(Number.isFinite)) return;
    const key = `${x.toFixed(2)}:${y.toFixed(2)}:${z.toFixed(2)}`;
    candidates.set(key, { x, y, z });
  };
  for (const radius of [3, 5, 7]) {
    for (let i = 0; i < 12; i += 1) {
      const a = (i / 12) * Math.PI * 2;
      add(target.x + Math.cos(a) * radius, target.y, target.z + Math.sin(a) * radius);
    }
  }
  for (const point of polygon) add(point[0], target.y, point[1]);
  const points: CoverPoint[] = [];
  for (const candidate of candidates.values()) {
    if (Math.hypot(candidate.x - eye.x, candidate.z - eye.z) < 0.6) continue;
    points.push(evaluateCover(dag, candidate, target, opts));
  }
  points.sort((a, b) => b.score - a.score || a.dist - b.dist);
  return (opts.limit ?? 24) > 0 ? points.slice(0, opts.limit ?? 24) : points;
}

/**
 * Closest scored candidate to `from`, preferring a blocked one.
 * @post Undefined only when the candidate list is empty.
 */
export function nearestCover(
  dag: SpatialDAG,
  from: { x: number; y: number; z: number },
  target: { x: number; y: number; z: number },
  opts: CoverOptions = {},
): CoverPoint | undefined {
  const graph = undefined as SceneGraph | undefined;
  void graph;
  const points = findCoverPoints(dag, { places: [], portals: [] } as unknown as SceneGraph, from, target, opts);
  const blocked = points.filter((point) => point.block);
  const pool = blocked.length > 0 ? blocked : points;
  let best: CoverPoint | undefined;
  let bestDistance = Infinity;
  for (const point of pool) {
    const d = Math.hypot(point.x - from.x, point.z - from.z);
    if (d < bestDistance) { bestDistance = d; best = point; }
  }
  return best;
}
