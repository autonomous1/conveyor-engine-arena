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

/**
 * Client gamepad profiles. One `GamepadInput` reads the pad; these functions
 * only interpret axes that `stick()` already deadzoned (axial 0.1, no rescale).
 * Face buttons, triggers, and shoulders stay unbound. Nothing here is sent
 * to the server. The 20 Hz message is still `{ moveX, moveZ, yaw, buttons, seq, entity }`.
 *
 * `standard` (W3C), the default for a new session:
 * - Axis 0 left/right, axis 1 up/down: move. Stick-up is already negative.
 *   `axesFromStick` negates Y once, so up matches W. No second negation.
 * - Axis 2 left/right, axis 3 up/down: look. Up is pitch up, right is yaw
 *   right, through the same `lookFromStick` signs as the mouse. The caller
 *   clamps pitch with `clampPitch`, same as the pointer.
 *
 * `jumper-t` is the mapping this tree already used. A Jumper T-series radio
 * (T-Lite, T-Pro, T16, T18) in EdgeTX/OpenTX classic USB joystick mode,
 * Mode 2, channel order AETR. The browser leaves `mapping` empty, so these
 * indices are raw axes, not a standard pad.
 *
 * | Axis | Stick | Radio control | Use | Rest |
 * | --- | --- | --- | --- | --- |
 * | 0 | right, left/right | aileron, CH1 | look yaw | spring, 0 |
 * | 1 | right, up/down | elevator, CH2 | look pitch | spring, 0 |
 * | 3 | left, left/right | rudder / yaw, CH4 | strafe | spring, 0 |
 * | 2 | left, up/down | throttle, CH3 | forward / back | no spring |
 *
 * Move reads axis 3 as horizontal and axis 2 as vertical, then negates both
 * (`jumperStick`). Y is negated because this stick reports up as negative.
 * Look reads axis 0 and axis 1 with no extra negation; `lookFromStick`
 * negates Y so stick-up is pitch-up.
 *
 * The throttle has no return spring. It rests at the bottom stop, which this
 * transmitter reports as -1 (CH3 at -100%). That full-back position reverses,
 * the same sign as S. Full up (+1) is forward, the same sign as W. The sprung
 * sticks still idle at 0.
 */
export const GAMEPAD_PROFILE_STORAGE_KEY = "arena.gamepadProfile.v1";

export const LOOK_YAW_RATE = 2.4;
export const LOOK_PITCH_RATE = 1.8;

const MOVE_KEYS = ["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];

export type GamepadProfileName = "standard" | "jumper-t";

export type ProfileStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

export function isMoveKey(code: string): boolean {
  return MOVE_KEYS.includes(code);
}

export function keyboardMove(held: { has(code: string): boolean }): { forward: number; strafe: number } {
  const forward = (held.has("KeyW") || held.has("ArrowUp") ? 1 : 0) - (held.has("KeyS") || held.has("ArrowDown") ? 1 : 0);
  const strafe = (held.has("KeyD") || held.has("ArrowRight") ? 1 : 0) - (held.has("KeyA") || held.has("ArrowLeft") ? 1 : 0);
  return { forward, strafe };
}

/** Missing, empty, or unknown stored text is `standard`. */
export function gamepadProfileFromStored(value: string | null | undefined): GamepadProfileName {
  if (value === "standard" || value === "jumper-t") return value;
  return "standard";
}

export function loadGamepadProfile(storage: ProfileStorage | null | undefined): GamepadProfileName {
  if (!storage) return "standard";
  try {
    return gamepadProfileFromStored(storage.getItem(GAMEPAD_PROFILE_STORAGE_KEY));
  } catch {
    return "standard";
  }
}

export function saveGamepadProfile(storage: ProfileStorage | null | undefined, profile: GamepadProfileName): void {
  if (!storage) return;
  try {
    storage.setItem(GAMEPAD_PROFILE_STORAGE_KEY, profile);
  } catch {
    // The in-memory choice still applies for this session.
  }
}

export function nextGamepadProfile(profile: GamepadProfileName): GamepadProfileName {
  return profile === "standard" ? "jumper-t" : "standard";
}

function padAxis(axes: readonly number[], index: number): number {
  const value = axes[index];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Planar move in the same yaw-space units as `keyboardMove` (forward +1 is W, -1 is S). */
export function gamepadPlanar(profile: GamepadProfileName, axes: readonly number[]): { forward: number; strafe: number } {
  if (profile === "jumper-t") {
    const moved = jumperStick(JUMPER_MOVE_Y, {
      x: padAxis(axes, JUMPER_MOVE_X),
      y: padAxis(axes, JUMPER_MOVE_Y),
    });
    return axesFromStick(moved.x, moved.y);
  }
  return axesFromStick(padAxis(axes, 0), padAxis(axes, 1));
}

/** Look deltas for one tick. Pitch clamp stays with the caller, shared with the mouse. */
export function gamepadLook(profile: GamepadProfileName, axes: readonly number[], dt: number): { yaw: number; pitch: number } {
  if (profile === "jumper-t") {
    const looked = jumperStick(JUMPER_LOOK_Y, {
      x: padAxis(axes, JUMPER_LOOK_X),
      y: padAxis(axes, JUMPER_LOOK_Y),
    });
    return lookFromStick(looked.x, looked.y, dt, LOOK_YAW_RATE, LOOK_PITCH_RATE);
  }
  return lookFromStick(padAxis(axes, 2), padAxis(axes, 3), dt, LOOK_YAW_RATE, LOOK_PITCH_RATE);
}

export function sampleMove(
  profile: GamepadProfileName,
  held: { has(code: string): boolean },
  pad: { connected: boolean; axes: readonly number[] },
): { forward: number; strafe: number } {
  const keys = keyboardMove(held);
  if (!pad.connected) return keys;
  const stick = gamepadPlanar(profile, pad.axes);
  return { forward: keys.forward + stick.forward, strafe: keys.strafe + stick.strafe };
}
