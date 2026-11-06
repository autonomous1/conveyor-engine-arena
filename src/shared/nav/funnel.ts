/**
 * String-pull a region path into movement waypoints.
 *
 * `left` / `right` follow regions.ts: left is to the left of travel when X
 * points right and Z points up. The funnel uses that cross-product sign.
 * A goal within 0.5 m of the last aperture, or an explicit door axis, gets an
 * axis-aligned last step through the opening.
 */
import type { RegionPath, RegionPortal } from "./regions.js";
import type { Vec3 } from "../scene-graph.js";

/** Opening's free axis: the aperture's long axis. The last step walks the other way. */
export type DoorAxis = "x" | "z";

const CLOSE = 0.01;
const EPS = 1e-6;
const DOOR_REACH = 0.5;

/**
 * `triarea2` is negative the usual XZ cross product, matching the Recast funnel.
 * `<= 0` means `c` is left of (or on) the directed segment `a → b`.
 */
function triarea2(a: Vec3, b: Vec3, c: Vec3): number {
  const ax = b[0] - a[0];
  const az = b[2] - a[2];
  const bx = c[0] - a[0];
  const bz = c[2] - a[2];
  return bx * az - ax * bz;
}

function sameXZ(a: Vec3, b: Vec3): boolean {
  return Math.abs(a[0] - b[0]) <= EPS && Math.abs(a[2] - b[2]) <= EPS;
}

function copy(point: Vec3): Vec3 {
  return [point[0], point[1], point[2]];
}

function pushPoint(out: Vec3[], point: Vec3): void {
  const last = out[out.length - 1];
  if (last && Math.hypot(last[0] - point[0], last[2] - point[2]) < CLOSE) return;
  out.push(copy(point));
}

function midpoint(portal: RegionPortal): Vec3 {
  return [
    (portal.left[0] + portal.right[0]) * 0.5,
    (portal.left[1] + portal.right[1]) * 0.5,
    (portal.left[2] + portal.right[2]) * 0.5,
  ];
}

/** Swap endpoints when `left` is not left of `forward` in the X-right, Z-up plane. */
function wind(portal: RegionPortal, dx: number, dz: number): RegionPortal {
  if (dx * dx + dz * dz < EPS) return portal;
  const cross = dx * (portal.left[2] - portal.right[2]) - dz * (portal.left[0] - portal.right[0]);
  if (cross >= -EPS) return portal;
  return { from: portal.from, to: portal.to, left: portal.right, right: portal.left, width: portal.width };
}

function oriented(path: RegionPath): RegionPortal[] {
  const portals = path.portals;
  const mids = portals.map(midpoint);
  return portals.map((portal, index) => {
    const prev = index === 0 ? path.start : mids[index - 1]!;
    const next = index + 1 < mids.length ? mids[index + 1]! : path.goal;
    return wind(portal, next[0] - prev[0], next[2] - prev[2]);
  });
}

function funnel(path: RegionPath): Vec3[] {
  const portals = oriented(path);
  const goal = path.goal;
  const channel: Array<{ left: Vec3; right: Vec3 }> = portals.map((portal) => ({
    left: portal.left,
    right: portal.right,
  }));
  channel.push({ left: goal, right: goal });

  const points: Vec3[] = [];
  pushPoint(points, path.start);
  if (channel.length === 1 && sameXZ(path.start, goal)) {
    points[0] = copy(goal);
    return points;
  }

  let apex: Vec3 = path.start;
  let left: Vec3 = path.start;
  let right: Vec3 = path.start;
  let leftIndex = 0;
  let rightIndex = 0;
  const limit = channel.length * channel.length + 4;
  let hops = 0;
  let index = 0;
  while (index < channel.length) {
    if (++hops > limit) break;
    const side = channel[index]!;
    let restarted = false;

    if (triarea2(apex, right, side.right) <= 0) {
      if (sameXZ(apex, right) || triarea2(apex, left, side.right) > 0) {
        right = side.right;
        rightIndex = index;
      } else {
        pushPoint(points, left);
        apex = left;
        const restart = leftIndex;
        left = apex;
        right = apex;
        leftIndex = restart;
        rightIndex = restart;
        index = restart + 1;
        restarted = true;
      }
    }

    if (!restarted && triarea2(apex, left, side.left) >= 0) {
      if (sameXZ(apex, left) || triarea2(apex, right, side.left) < 0) {
        left = side.left;
        leftIndex = index;
      } else {
        pushPoint(points, right);
        apex = right;
        const restart = rightIndex;
        left = apex;
        right = apex;
        leftIndex = restart;
        rightIndex = restart;
        index = restart + 1;
        restarted = true;
      }
    }

    if (!restarted) index += 1;
  }

  const last = points[points.length - 1];
  if (!last) points.push(copy(goal));
  else if (Math.hypot(last[0] - goal[0], last[2] - goal[2]) < CLOSE) points[points.length - 1] = copy(goal);
  else points.push(copy(goal));
  return points;
}

function span(portal: RegionPortal): { x0: number; x1: number; z0: number; z1: number } {
  return {
    x0: Math.min(portal.left[0], portal.right[0]),
    x1: Math.max(portal.left[0], portal.right[0]),
    z0: Math.min(portal.left[2], portal.right[2]),
    z1: Math.max(portal.left[2], portal.right[2]),
  };
}

function distanceToPortal(point: Vec3, portal: RegionPortal): number {
  const abx = portal.right[0] - portal.left[0];
  const abz = portal.right[2] - portal.left[2];
  const len2 = abx * abx + abz * abz;
  if (len2 < EPS) return Math.hypot(point[0] - portal.left[0], point[2] - portal.left[2]);
  let t = ((point[0] - portal.left[0]) * abx + (point[2] - portal.left[2]) * abz) / len2;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const x = portal.left[0] + abx * t;
  const z = portal.left[2] + abz * t;
  return Math.hypot(point[0] - x, point[2] - z);
}

function inferDoorAxis(path: RegionPath): DoorAxis | undefined {
  const portal = path.portals[path.portals.length - 1];
  if (!portal || distanceToPortal(path.goal, portal) > DOOR_REACH) return undefined;
  const box = span(portal);
  if (box.x1 - box.x0 >= box.z1 - box.z0 && box.x1 - box.x0 > EPS) return "x";
  if (box.z1 - box.z0 > EPS) return "z";
  return undefined;
}

/** A point on `portal` at the goal's free-axis coordinate, when the aperture contains it. */
function portalApproach(portal: RegionPortal, goal: Vec3, axis: DoorAxis): Vec3 | undefined {
  const box = span(portal);
  if (axis === "x") {
    if (box.x1 - box.x0 <= EPS || box.z1 - box.z0 > 1e-3) return undefined;
    if (goal[0] < box.x0 - 1e-3 || goal[0] > box.x1 + 1e-3) return undefined;
    return [goal[0], portal.left[1], portal.left[2]];
  }
  if (box.z1 - box.z0 <= EPS || box.x1 - box.x0 > 1e-3) return undefined;
  if (goal[2] < box.z0 - 1e-3 || goal[2] > box.z1 + 1e-3) return undefined;
  return [portal.left[0], portal.left[1], goal[2]];
}

function sameFree(a: Vec3, b: Vec3, axis: DoorAxis): boolean {
  return axis === "x" ? Math.abs(a[0] - b[0]) <= 1e-3 : Math.abs(a[2] - b[2]) <= 1e-3;
}

/** `point` lies on the way from `prev` to `goal` along the through-axis. */
function onTheWay(prev: Vec3, point: Vec3, goal: Vec3, axis: DoorAxis): boolean {
  const through = axis === "x" ? 2 : 0;
  const toGoal = goal[through] - prev[through];
  const toPoint = point[through] - prev[through];
  if (Math.abs(toGoal) <= 1e-6) return Math.abs(toPoint) <= 1e-3;
  if (toGoal * toPoint < -1e-6) return false;
  return Math.abs(toPoint) <= Math.abs(toGoal) + 1e-3;
}

/** The open segment crosses the aperture, so the endpoints are not in one rectangle. */
function crossesInterior(a: Vec3, b: Vec3, portal: RegionPortal): boolean {
  const box = span(portal);
  if (box.x1 - box.x0 <= 1e-3) {
    const dx = b[0] - a[0];
    if (Math.abs(dx) < 1e-9) return false;
    const t = (portal.left[0] - a[0]) / dx;
    if (t <= 1e-4 || t >= 1 - 1e-4) return false;
    const z = a[2] + (b[2] - a[2]) * t;
    return z >= box.z0 - 1e-4 && z <= box.z1 + 1e-4;
  }
  if (box.z1 - box.z0 > 1e-3) return false;
  const dz = b[2] - a[2];
  if (Math.abs(dz) < 1e-9) return false;
  const t = (portal.left[2] - a[2]) / dz;
  if (t <= 1e-4 || t >= 1 - 1e-4) return false;
  const x = a[0] + (b[0] - a[0]) * t;
  return x >= box.x0 - 1e-4 && x <= box.x1 + 1e-4;
}

function insideOneRegion(a: Vec3, b: Vec3, portals: readonly RegionPortal[]): boolean {
  for (const portal of portals) {
    if (crossesInterior(a, b, portal)) return false;
  }
  return true;
}

function alignDoor(path: RegionPath, points: Vec3[], axis: DoorAxis): Vec3[] {
  if (points.length < 2) return points;
  const goal = points[points.length - 1]!;
  const prev = points[points.length - 2]!;
  if (sameFree(prev, goal, axis)) return points;

  let approach: Vec3 | undefined;
  for (let i = path.portals.length - 1; i >= 0; i -= 1) {
    const hit = portalApproach(path.portals[i]!, goal, axis);
    if (!hit || !onTheWay(prev, hit, goal, axis)) continue;
    approach = hit;
    break;
  }
  // No aperture holds the goal's free coordinate. A corner inside the goal's
  // rectangle still matches that axis, then walks straight through.
  if (!approach && insideOneRegion(prev, goal, path.portals)) {
    const corner: Vec3 = axis === "x"
      ? [goal[0], prev[1], prev[2]]
      : [prev[0], prev[1], goal[2]];
    if (onTheWay(prev, corner, goal, axis)) approach = corner;
  }
  if (!approach) return points;
  if (Math.hypot(approach[0] - prev[0], approach[2] - prev[2]) < CLOSE) return points;
  if (Math.hypot(approach[0] - goal[0], approach[2] - goal[2]) < CLOSE) return points;
  const next = points.slice(0, -1);
  next.push(approach, copy(goal));
  return next;
}

export function pullString(path: RegionPath, doorAxis?: DoorAxis): Vec3[] {
  const points = funnel(path);
  const axis = doorAxis ?? inferDoorAxis(path);
  if (!axis) return points;
  return alignDoor(path, points, axis);
}
