/**
 * The observer follow camera's pure math and the `?observe=1` parse.
 */
// ARCHITECTURE: The yaw-locked follow camera: the offset position, its
//   exponential damping, the look point, and the `observe=1` parse.
// Wiring: boot.ts's frame loop calls `followCamera` for the observer and for
//   `__qa.follow`; main.ts passes `parseObserve(location.search)` to boot.
// Order: no state. Each call takes the previous pose and the frame `dt`.
// Invariants: a missing target returns the previous pose unchanged.
import { EYE_HEIGHT } from "../shared/look.js";

/** The damped camera's look point and position, in world meters. */
export type FollowPose = {
  x: number;
  y: number;
  z: number;
  lookX: number;
  lookY: number;
  lookZ: number;
};

/** A followed pawn: feet position and the yaw its body faces (0 faces +Z). */
export type FollowTarget = { x: number; y: number; z: number; yaw: number };

/**
 * Follow Camera Options type.
 */
export type FollowCameraOptions = {
  /** Meters behind the target along its yaw. Default 3. */
  back?: number;
  /** Meters above the target's feet. Default 1.6. */
  up?: number;
  /** Meters to the target's right (over-the-shoulder). Default 0 (centred). */
  right?: number;
  /** Exponential rate per second. Default 8. */
  damping?: number;
  /** Snap when the ideal is farther than this from `prev`. Default 10 m. */
  snapM?: number;
  /** Look height above the target's feet. Default `EYE_HEIGHT`. */
  eye?: number;
};

/** The frame length is clamped, so a background tab's long frame cannot jump the camera. */
const DT_MAX = 0.05;

/**
 * Place a third-person follow camera behind, above, and optionally right of `target`.
 * @post A missing target returns `prev` unchanged; a missing `prev` or an
 *       ideal more than `snapM` away snaps to the ideal. Otherwise the
 *       position moves by `1 - exp(-damping * dt)` of the gap, and the look
 *       point is the target's eye.
 * @pre `dt` is clamped to `[0, 0.05]`; a frame spike still damps one short step.
 * @why Damp the offset position, not the yaw-derived ideal: a pawn that turns
 *      90° must not whip the camera 90° in one frame. The lateral `right`
 *      offset is added to the same ideal, so it damps with the rest.
 * @invariant Once converged the position is within `back + up + right` of the
 *       target (test: follow_camera_converges_within_the_offset).
 */
export function followCamera(
  target: FollowTarget | undefined,
  prev: FollowPose | undefined,
  opts: FollowCameraOptions = {},
  dt: number,
): FollowPose | undefined {
  if (!target) return prev;
  const back = opts.back ?? 3;
  const up = opts.up ?? 1.6;
  const eye = opts.eye ?? EYE_HEIGHT;
  // The right vector is (cos yaw, 0, -sin yaw): yaw 0 faces +Z, so right is +X.
  const right = opts.right ?? 0;
  const idealX = target.x - Math.sin(target.yaw) * back + Math.cos(target.yaw) * right;
  const idealY = target.y + up;
  const idealZ = target.z - Math.cos(target.yaw) * back - Math.sin(target.yaw) * right;
  const look = { lookX: target.x, lookY: target.y + eye, lookZ: target.z };
  if (!prev) return { x: idealX, y: idealY, z: idealZ, ...look };
  const jump = Math.hypot(idealX - prev.x, idealY - prev.y, idealZ - prev.z);
  if (jump > (opts.snapM ?? 10)) return { x: idealX, y: idealY, z: idealZ, ...look };
  const step = Math.min(DT_MAX, Math.max(0, dt));
  const alpha = 1 - Math.exp(-(opts.damping ?? 8) * step);
  return {
    x: prev.x + (idealX - prev.x) * alpha,
    y: prev.y + (idealY - prev.y) * alpha,
    z: prev.z + (idealZ - prev.z) * alpha,
    ...look,
  };
}

/**
 * True only for the search `observe=1`, like `isQaMode`: a bare `observe` and
 * `observe=true` are not the mode.
 */
export function parseObserve(search: string): boolean {
  const query = search.startsWith("?") ? search.slice(1) : search;
  return new URLSearchParams(query).get("observe") === "1";
}
