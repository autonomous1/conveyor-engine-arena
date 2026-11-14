/**
 * Pure helpers for the local player's marker on the scene map.
 * Yaw follows `aimDirection`: yaw 0 faces world +Z, so on the −Z-up map a
 * yaw of π points up and +π/2 (world +X) points right.
 */
// ARCHITECTURE: Pure scene-map marker math: self pose, floor label, and marker
//   geometry.
// Wiring: scene-map.ts calls `selfMoved`/`floorLabel`; tests cover the marker.
import { elevatorPolygonBounds } from "../shared/elevators.ts";
import type { MapFrame } from "../shared/map-frame.ts";

export type SelfPose = { x: number; y: number; z: number; yaw: number };

export type SelfMarker = {
  /** Dot centre in panel pixels. */
  center: [number, number];
  /** Unit heading in panel pixels (y down). */
  heading: [number, number];
  /** Wedge tip and the two base corners, panel pixels. */
  wedge: [[number, number], [number, number], [number, number]];
};

export const SELF_DOT_R = 5;
export const SELF_WEDGE_LEN = 13;

export function selfMarker(frame: Pick<MapFrame, "toPixel">, pose: SelfPose): SelfMarker {
  const center = frame.toPixel(pose.x, pose.z);
  // World forward (sin, cos) on XZ; pixel y grows with world z.
  const heading: [number, number] = [Math.sin(pose.yaw), Math.cos(pose.yaw)];
  const [hx, hy] = heading;
  const px = -hy;
  const py = hx;
  const tip: [number, number] = [center[0] + hx * SELF_WEDGE_LEN, center[1] + hy * SELF_WEDGE_LEN];
  const base = SELF_DOT_R * 0.9;
  const w = SELF_DOT_R * 0.85;
  return {
    center,
    heading,
    wedge: [
      tip,
      [center[0] + hx * base + px * w, center[1] + hy * base + py * w],
      [center[0] + hx * base - px * w, center[1] + hy * base - py * w],
    ],
  };
}

export type FloorSource = { polygon: ReadonlyArray<readonly [number, number]>; stops: readonly number[] };

/** Elevator cabs within this XZ distance count as the player's building. */
export const FLOOR_LIFT_REACH_M = 30;

/**
 * "F<n>" from the stop heights of the nearest elevator within reach.
 * @invariant Floor 1 is the lowest stop.
 *            (test: floor_label_uses_lowest_stop)
 * @post Falls back to "y <m>m" away from any elevator.
 */
export function floorLabel(pose: Pick<SelfPose, "x" | "y" | "z">, lifts: readonly FloorSource[] = []): string {
  let best: { stops: readonly number[]; d: number } | undefined;
  for (const lift of lifts) {
    if (lift.stops.length < 2 || lift.polygon.length === 0) continue;
    const b = elevatorPolygonBounds(lift.polygon);
    const dx = Math.max(b.minX - pose.x, 0, pose.x - b.maxX);
    const dz = Math.max(b.minZ - pose.z, 0, pose.z - b.maxZ);
    const d = Math.hypot(dx, dz);
    if (d <= FLOOR_LIFT_REACH_M && (!best || d < best.d)) best = { stops: lift.stops, d };
  }
  if (best) {
    const stops = [...best.stops].sort((a, b) => a - b);
    if (pose.y >= stops[0] - 1) {
      let floor = 1;
      for (let i = 0; i < stops.length; i++) if (pose.y >= stops[i] - 0.5) floor = i + 1;
      return `F${floor}`;
    }
  }
  return `y ${pose.y.toFixed(1)}m`;
}

/** True when the marker should be repainted. */
export function selfMoved(prev: SelfPose | undefined, next: SelfPose, label: string, prevLabel: string): boolean {
  if (!prev || label !== prevLabel) return true;
  const turn = Math.abs(Math.atan2(Math.sin(next.yaw - prev.yaw), Math.cos(next.yaw - prev.yaw)));
  return Math.hypot(next.x - prev.x, next.z - prev.z) > 0.05 || turn > 0.02;
}
