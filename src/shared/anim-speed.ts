/**
 * Clip playback rate from ground speed, so walk and run feet do not skate.
 * Client visual only: the host, the world, and the snapshot are untouched.
 */

/** Clamp used when an animation entry omits `minTimeScale` / `maxTimeScale`. */
export const DEFAULT_MIN_TIME_SCALE = 0.25;
export const DEFAULT_MAX_TIME_SCALE = 2.5;

/** Seconds for the speed filter to cover ~63% of a step. Hides snapshot jitter. */
export const GROUND_SPEED_TAU = 0.15;

/** A rendered jump faster than this is a teleport or respawn, not a stride. */
export const GROUND_SPEED_TELEPORT = 25;

export type ClipRate = {
  /** Meters per second the feet travel at 1x, measured on the unscaled model (Blender). */
  referenceSpeed?: number;
  minTimeScale?: number;
  maxTimeScale?: number;
};

/**
 * `groundSpeed / (referenceSpeed * modelScale)`, clamped. The asset `scale`
 * grows the stride, so the same clip covers more ground per cycle.
 * No `referenceSpeed`: 1, the clip plays as authored.
 */
export function clipTimeScale(groundSpeed: number, rate: ClipRate | undefined, modelScale = 1): number {
  const reference = rate?.referenceSpeed;
  if (reference === undefined || !(reference > 0)) return 1;
  const stride = reference * (modelScale > 0 ? modelScale : 1);
  const min = rate?.minTimeScale ?? DEFAULT_MIN_TIME_SCALE;
  const max = rate?.maxTimeScale ?? DEFAULT_MAX_TIME_SCALE;
  const raw = Number.isFinite(groundSpeed) && groundSpeed > 0 ? groundSpeed / stride : 0;
  return Math.min(max, Math.max(min, raw));
}

export type GroundSpeed = { x: number; z: number; speed: number; seen: boolean };

export function freshGroundSpeed(): GroundSpeed {
  return { x: 0, z: 0, speed: 0, seen: false };
}

/**
 * Horizontal speed from the rendered position delta, low-pass filtered.
 * The first sample and teleports only re-anchor. Returns the smoothed m/s.
 */
export function noteGroundSpeed(state: GroundSpeed, x: number, z: number, dt: number, tau = GROUND_SPEED_TAU): number {
  if (!state.seen) {
    state.x = x;
    state.z = z;
    state.seen = true;
    return state.speed;
  }
  const moved = Math.hypot(x - state.x, z - state.z);
  state.x = x;
  state.z = z;
  if (!(dt > 0)) return state.speed;
  const sample = moved / dt;
  if (sample > GROUND_SPEED_TELEPORT) return state.speed;
  const k = 1 - Math.exp(-dt / tau);
  state.speed += (sample - state.speed) * k;
  return state.speed;
}

/** Fraction below the walk-to-run speed that a running pawn must drop to before walking again. */
export const GAIT_HYSTERESIS = 0.15;

/**
 * Fastest the walk clip is played before the pawn changes to run. Above about
 * 1.5x a walk cycle reads as cartoon legs. A slowed run keeps the feet locked
 * and reads as a jog.
 */
export const WALK_MAX_TIME_SCALE = 1.5;

/**
 * Locomotion clip for a moving pawn, by ground speed (m/s). Both strides are
 * the 1x world speeds (`referenceSpeed * scale`). Walk is kept until it would
 * play faster than `WALK_MAX_TIME_SCALE` (or past the geometric mean of the
 * strides, if the strides are close). Run then holds until the speed drops
 * `band` below that point, so a pawn near it does not flick between clips.
 */
export function pickLocomotion(
  current: string | undefined,
  groundSpeed: number,
  walkStride: number,
  runStride: number,
  band = GAIT_HYSTERESIS,
): "walk" | "run" {
  if (!(walkStride > 0) || !(runStride > walkStride)) return "walk";
  const up = Math.min(walkStride * WALK_MAX_TIME_SCALE, Math.sqrt(walkStride * runStride));
  if (current === "run") return groundSpeed < up * (1 - band) ? "walk" : "run";
  return groundSpeed > up ? "run" : "walk";
}

/**
 * Take the snapshot velocity (m/s) as the ground speed, unfiltered. The host
 * velocity changes at most `MOVE_ACCEL` per tick, so it does not jitter, and a
 * filter only delays it: with a 0.15 s filter the gait was picked about 0.2 s
 * late on every start, and walk played at 2.2x until run took over.
 * Keeps the position anchor current so a later fallback to `noteGroundSpeed`
 * does not see a stale jump.
 */
export function noteVelocitySpeed(state: GroundSpeed, speed: number, x: number, z: number): number {
  state.x = x;
  state.z = z;
  state.seen = true;
  state.speed = Number.isFinite(speed) && speed > 0 ? speed : 0;
  return state.speed;
}
