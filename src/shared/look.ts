/**
 * Engine planar frame. Yaw 0 faces world +Z, matching `integratePlanarMove`
 * (moveZ positive, moveX zero) and the yaw quaternion the server stores.
 * Right is world −X when facing +Z. Pitch is client-only; the input message
 * has no pitch field.
 */
/**
 * Jumper-T pad. Both sticks and the move pair are reversed relative to the
 * W3C map (same axes the fly camera used).
 * Move reads RightY as horizontal and RightX as vertical, then negates both.
 * Look reads LeftX and LeftY with no extra negate.
 */
export const JUMPER_MOVE_X = 3;
export const JUMPER_MOVE_Y = 2;
export const JUMPER_LOOK_X = 0;
export const JUMPER_LOOK_Y = 1;

export function jumperStick(yAxis: number, sample: { x: number; y: number }): { x: number; y: number } {
  if (yAxis === JUMPER_MOVE_Y) return { x: -sample.x, y: -sample.y };
  return { x: sample.x, y: sample.y };
}

export const EYE_HEIGHT = 1.6;
export const INPUT_HZ = 20;
/** Stay under ±90° so the look target does not cross the up axis. */
export const PITCH_LIMIT = 1.35;

export function clampPitch(pitch: number): number {
  if (pitch > PITCH_LIMIT) return PITCH_LIMIT;
  if (pitch < -PITCH_LIMIT) return -PITCH_LIMIT;
  return pitch;
}

/** Mouse right turns right. Mouse down looks down. */
export function lookFromMouse(movementX: number, movementY: number, sensitivity = 0.0022): { yaw: number; pitch: number } {
  return { yaw: -movementX * sensitivity, pitch: -movementY * sensitivity };
}

/**
 * Standard-mapping sticks after the library dead zone.
 * LeftY and RightY are negative when the stick is up, so both are negated.
 * Returned yaw/pitch are deltas: stick-right decreases yaw, stick-up increases pitch.
 */
export function axesFromStick(stickX: number, stickY: number): { strafe: number; forward: number } {
  return { strafe: stickX, forward: -stickY };
}

export function lookFromStick(stickX: number, stickY: number, dt: number, yawRate: number, pitchRate: number): { yaw: number; pitch: number } {
  return { yaw: -stickX * yawRate * dt, pitch: -stickY * pitchRate * dt };
}

/** Local forward/strafe in the pawn yaw frame, clamped to the unit circle the server accepts. */
export function moveIntent(yaw: number, forward: number, strafe: number): { moveX: number; moveZ: number } {
  let f = forward;
  let s = strafe;
  const mag = Math.hypot(f, s);
  if (mag > 1) {
    f /= mag;
    s /= mag;
  }
  const fx = Math.sin(yaw);
  const fz = Math.cos(yaw);
  const rx = -fz;
  const rz = fx;
  return { moveX: rx * s + fx * f, moveZ: rz * s + fz * f };
}

export function yawFromQuat(rotation: { y: number; w: number }): number {
  return 2 * Math.atan2(rotation.y, rotation.w);
}

export function eyeLook(
  pawn: { x: number; y: number; z: number },
  yaw: number,
  pitch: number,
  eye = EYE_HEIGHT,
): { position: { x: number; y: number; z: number }; target: { x: number; y: number; z: number } } {
  const cp = Math.cos(pitch);
  const y = pawn.y + eye;
  return {
    position: { x: pawn.x, y, z: pawn.z },
    target: {
      x: pawn.x + Math.sin(yaw) * cp,
      y: y + Math.sin(pitch),
      z: pawn.z + Math.cos(yaw) * cp,
    },
  };
}
