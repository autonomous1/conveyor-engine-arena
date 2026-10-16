/** Locomotion and emote names the wander loop and the character clips share. */
export const MOVEMENTS = ["idle", "walk", "run", "fall", "angry"] as const;

export type Movement = (typeof MOVEMENTS)[number];

/** Used when an animation entry omits speed. */
export const DEFAULT_MOVEMENT_SPEED: Record<Movement, number> = {
  idle: 0,
  walk: 1,
  run: 2,
  fall: 0,
  angry: 0,
};

/**
 * Move-input scale for one animation speed. The fastest movement in the set
 * is full input, and the others keep the same ratio, so walk:1 and run:2
 * make walk half as fast as run.
 */
/** Exact clip name, then a case-insensitive substring, matching the previous player. */
export function findClip<T extends { name: string }>(clips: readonly T[], wanted: string): T | undefined {
  const exact = clips.find((clip) => clip.name === wanted);
  if (exact) return exact;
  const needle = wanted.toLowerCase();
  if (!needle) return undefined;
  return clips.find((clip) => clip.name.toLowerCase().includes(needle));
}

export function movementIntent(speed: number, speeds: readonly number[]): number {
  let max = 0;
  for (const value of speeds) if (value > max) max = value;
  if (!(max > 0)) return 0;
  return speed / max;
}

/**
 * Host tick length in seconds. Matches `TICK_MS` (50) on the arena loop.
 * Acceleration is counted in ticks, so a full wish still lands in `MOVE_TICKS`.
 */
export const MOVE_DT = 0.05;

/** Meters per second at a unit wish. Input axes stay the client's yaw-space moveX / moveZ. */
export const MOVE_SPEED = 5;

/** Meters per second added toward the wish on one tick. The same step stops the pawn. */
export const MOVE_ACCEL = 1.25;

/** Ticks from rest to `MOVE_SPEED`, and from that speed back to zero. */
export const MOVE_TICKS = MOVE_SPEED / MOVE_ACCEL;

/**
 * Radians an unowned pawn may yaw in one tick. A tenth of a full turn.
 * Player look does not use this.
 */
export const PAWN_YAW_STEP = (Math.PI * 2) / 10;

/** At or under this planar speed the owned clip is idle. */
export const MOVE_IDLE = 0.05;

/**
 * Highest rise the capsule mounts in one sample.
 * A taller box stays a wall and the kernel push-out stands.
 */
export const STEP_HEIGHT = 0.3;

/** Float slack so a top of exactly `STEP_HEIGHT` still counts. */
const STEP_SLOP = 1e-4;

/** Yaw quaternion about +Y. Yaw 0 is identity and faces world +Z. */
export function yawQuaternion(yaw: number): { x: number; y: number; z: number; w: number } {
  const half = yaw * 0.5;
  return { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) };
}

/** Signed angle in (-π, π]. */
function wrapPi(angle: number): number {
  const tau = Math.PI * 2;
  return ((angle + Math.PI) % tau + tau) % tau - Math.PI;
}

/**
 * Turn `from` toward `to` by at most `maxStep` radians, on the short arc.
 * A gap inside one step lands on `to`.
 */
export function approachYaw(from: number, to: number, maxStep = PAWN_YAW_STEP): number {
  if (!Number.isFinite(from)) return Number.isFinite(to) ? to : 0;
  if (!Number.isFinite(to)) return from;
  const limit = maxStep > 0 ? maxStep : 0;
  const delta = wrapPi(to - from);
  if (Math.abs(delta) <= limit) return to;
  return from + Math.sign(delta) * limit;
}

export type Planar = { x: number; z: number };

/** Wish velocity. Magnitude above 1 is pulled back to the unit circle, then scaled by `MOVE_SPEED`. */
export function wishPlanar(moveX: number, moveZ: number, speed = MOVE_SPEED): Planar {
  let x = Number.isFinite(moveX) ? moveX : 0;
  let z = Number.isFinite(moveZ) ? moveZ : 0;
  const mag = Math.hypot(x, z);
  if (mag > 1) {
    x /= mag;
    z /= mag;
  }
  return { x: x * speed, z: z * speed };
}

/**
 * Step XZ velocity toward `wish` by at most `accel`.
 * A gap inside one step lands on the wish. A larger gap keeps its direction.
 */
export function approachVelocity(velocity: Planar, wish: Planar, accel = MOVE_ACCEL): Planar {
  const dx = wish.x - velocity.x;
  const dz = wish.z - velocity.z;
  const dist = Math.hypot(dx, dz);
  if (!(dist > accel)) return { x: wish.x, z: wish.z };
  const scale = accel / dist;
  return { x: velocity.x + dx * scale, z: velocity.z + dz * scale };
}

/** Owned clip from planar speed. A full wish is a walk. Only a faster body runs. */
export function gaitForSpeed(speed: number): "idle" | "walk" | "run" {
  if (!(speed > MOVE_IDLE)) return "idle";
  if (speed > MOVE_SPEED) return "run";
  return "walk";
}

type MoveView = {
  position: { x: number; y: number; z: number };
  velocity: { x: number; y: number; z: number };
  scale: { x: number; y: number; z: number };
  clip: string;
  speed: number;
  radius: number;
};

/** One height-banded AABB. Missing Y blocks at every height and is not a floor. */
export type FloorBox = {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  minY?: number;
  maxY?: number;
};

type MoveCommand =
  | { kind: "setVelocity"; entity: number; linear: { x: number; y: number; z: number } }
  | {
      kind: "setTransform";
      entity: number;
      position: { x: number; y: number; z: number };
      rotation: { x: number; y: number; z: number; w: number };
      scale: { x: number; y: number; z: number };
    }
  | { kind: "setClip"; entity: number; clip: string; speed: number };

type MoveWorld = {
  store: { view(id: number): MoveView | undefined };
  enqueue(cmd: MoveCommand): void;
  listObstacles(): readonly FloorBox[];
};

/**
 * Highest band top under the disc that is at most `step` above `feet`.
 * The room floor is 0. The disc test matches the kernel push-out: the
 * expanded face is outside, so a box that does not hit the body is not a floor.
 */
export function floorHeight(
  boxes: readonly FloorBox[],
  x: number,
  z: number,
  radius: number,
  feet: number,
  step = STEP_HEIGHT,
): number {
  const r = radius > 0 ? radius : 0;
  const limit = feet + step + STEP_SLOP;
  let floor = 0;
  for (const box of boxes) {
    if (box.minY === undefined || box.maxY === undefined) continue;
    if (!Number.isFinite(box.minY) || !Number.isFinite(box.maxY)) continue;
    const top = Math.max(box.minY, box.maxY);
    if (top > limit) continue;
    const minX = Math.min(box.minX, box.maxX) - r;
    const maxX = Math.max(box.minX, box.maxX) + r;
    const minZ = Math.min(box.minZ, box.maxZ) - r;
    const maxZ = Math.max(box.minZ, box.maxZ) + r;
    if (x <= minX || x >= maxX || z <= minZ || z >= maxZ) continue;
    if (top > floor) floor = top;
  }
  return floor;
}

/**
 * Rest height for a planar step. Each sample may rise by at most `STEP_HEIGHT`,
 * then the next sample starts from that height, so a run of short bands is a
 * floor and one tall box is not. The last sample is where the capsule rests.
 */
export function floorAlongMove(
  boxes: readonly FloorBox[],
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  radius: number,
  feet: number,
  step = STEP_HEIGHT,
): number {
  const dx = x1 - x0;
  const dz = z1 - z0;
  const dist = Math.hypot(dx, dz);
  const n = Math.max(1, Math.ceil(dist / 0.1));
  let y = feet;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    y = floorHeight(boxes, x0 + dx * t, z0 + dz * t, radius, y, step);
  }
  return y;
}

export type PlanarStep = { vx: number; vz: number; speed: number };

/**
 * Approach XZ velocity, then step the capsule by that velocity.
 * Feet then rest on the band tops along that step. A rise of at most
 * `STEP_HEIGHT` mounts the box. A taller box keeps this height so the
 * kernel push-out still stops the body. Yaw does not rotate velocity.
 * The caller commits. `setClip` is separate and does not write this position.
 */
export function enqueuePlanarMove(
  world: MoveWorld,
  entity: number,
  moveX: number,
  moveZ: number,
  yaw: number,
  dt = MOVE_DT,
): PlanarStep | undefined {
  const view = world.store.view(entity);
  if (!view) return undefined;
  const next = approachVelocity({ x: view.velocity.x, z: view.velocity.z }, wishPlanar(moveX, moveZ));
  const x = view.position.x + next.x * dt;
  const z = view.position.z + next.z * dt;
  const y = floorAlongMove(world.listObstacles(), view.position.x, view.position.z, x, z, view.radius, view.position.y);
  world.enqueue({ kind: "setVelocity", entity, linear: { x: next.x, y: 0, z: next.z } });
  world.enqueue({
    kind: "setTransform",
    entity,
    position: { x, y, z },
    rotation: yawQuaternion(yaw),
    scale: { x: view.scale.x, y: view.scale.y, z: view.scale.z },
  });
  return { vx: next.x, vz: next.z, speed: Math.hypot(next.x, next.z) };
}

/**
 * Owned pawn step. `setClip` records the planar speed and the gait it selects.
 * It does not carry a position.
 */
export function enqueueOwnedMove(
  world: MoveWorld,
  entity: number,
  moveX: number,
  moveZ: number,
  yaw: number,
  dt = MOVE_DT,
): { gait: "idle" | "walk" | "run"; speed: number } | undefined {
  const view = world.store.view(entity);
  if (!view) return undefined;
  const stepped = enqueuePlanarMove(world, entity, moveX, moveZ, yaw, dt);
  if (!stepped) return undefined;
  const gait = gaitForSpeed(stepped.speed);
  if (view.clip !== gait || view.speed !== stepped.speed) {
    world.enqueue({ kind: "setClip", entity, clip: gait, speed: stepped.speed });
  }
  return { gait, speed: stepped.speed };
}
