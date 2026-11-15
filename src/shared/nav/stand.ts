// ARCHITECTURE: Stand-target resolution: a point or a door side to a place,
//   point, and facing yaw.
// Wiring: bot brain resolves a StandGoal; shared/bots/goals.ts keys it and
//   shared/bots/actions.ts grounds it.
import { doorStand, type DoorSide } from "./follow.js";
import { planRoute, type Vec3Like } from "./route.js";
import { placeAt, type SceneGraph, type ScenePortal, type Vec3 } from "../scene-graph.js";

export type StandTarget =
  | { kind: "point"; x: number; y: number; z: number; yaw?: number }
  | { kind: "door"; doorId: string; side?: "in" | "out"; place?: string };

export type Stand = { place: string; key: string; x: number; y: number; z: number; yaw: number };

/**
 * Geometry + state a door stand needs. `ArenaView["doors"][number]` satisfies it.
 * @see ArenaView
 */
export type DoorView = {
  id: string;
  position: [number, number, number];
  yaw: number;
  hinge: "left" | "right";
  size: [number, number, number];
  open?: boolean;
  locked?: boolean;
};

/**
 * Stable key for a target, before the graph is available.
 * @post A point key has three decimals; a door key is `<id>:<side|auto>`.
 */
export function standKey(target: StandTarget): string {
  if (target.kind === "point") {
    return `point:${target.x.toFixed(3)},${target.y.toFixed(3)},${target.z.toFixed(3)}`;
  }
  return `door:${target.doorId}:${target.side ?? "auto"}`;
}

/**
 * Resolve a target to its place, point, and facing yaw.
 * @post The place is the side's `placeAt` id. An explicit side or place wins;
 *       with `from`, the nearest side reachable under the live doors wins;
 *       with no `from`, an exterior door prefers `out`, then `in`.
 */
export function resolveStand(
  target: StandTarget,
  graph: SceneGraph,
  doors: readonly DoorView[],
  opts: { from?: Vec3Like } = {},
): Stand | undefined {
  if (target.kind === "point") {
    const place = placeAt(graph, target.x, target.y, target.z);
    if (!place) return undefined;
    return { place: place.id, key: standKey(target), x: target.x, y: target.y, z: target.z, yaw: target.yaw ?? 0 };
  }

  const portal = graph.portals.find(
    (item) => item.kind === "door" && (item.door ?? item.id) === target.doorId,
  );
  const door = doors.find((item) => item.id === target.doorId);
  if (!portal || !door) return undefined;

  const sides: Array<{ side: DoorSide; place: string; point: Vec3; yaw: number }> = [];
  for (const side of ["in", "out"] as const) {
    const point = doorStand(door, side);
    const place = placeAt(graph, point.x, point.y, point.z);
    if (!place) continue;
    sides.push({ side, place: place.id, point: [point.x, point.y, point.z], yaw: point.yaw });
  }
  if (sides.length === 0) return undefined;

  let chosen = target.side !== undefined ? sides.find((item) => item.side === target.side) : undefined;
  if (!chosen && target.place !== undefined) chosen = sides.find((item) => item.place === target.place);
  if (!chosen && opts.from) {
    const gate = (portal: ScenePortal) => {
      if (portal.kind !== "door") return "open";
      const id = portal.door ?? portal.id;
      const row = doors.find((item) => item.id === id);
      if (!row) return portal.locked === true ? "locked" : "closed-unlocked";
      if (row.open === true) return "open";
      if (row.locked === true) return "locked";
      return "closed-unlocked";
    };
    let best: { side: DoorSide; cost: number } | undefined;
    for (const side of sides) {
      const route = planRoute(graph, opts.from, side.place, gate);
      if (!route.ok) continue;
      if (!best || route.cost < best.cost) best = { side: side.side, cost: route.cost };
    }
    if (best) chosen = sides.find((item) => item.side === best!.side);
    else return undefined;
  }
  if (!chosen) {
    const exterior = sides.find((item) => item.place === "outside");
    chosen = exterior && sides.some((item) => item.place !== "outside")
      ? exterior
      : sides.find((item) => item.side === "in") ?? sides[0];
  }
  if (!chosen) return undefined;

  return {
    place: chosen.place,
    key: standKey(target),
    x: chosen.point[0],
    y: chosen.point[1],
    z: chosen.point[2],
    yaw: chosen.yaw,
  };
}
