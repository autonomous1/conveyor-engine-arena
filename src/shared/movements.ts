// ARCHITECTURE: Movement and floor queries shared by the host and the client:
//   tick-rate constants, velocity and yaw steps, and the CSR floor index the
//   floor and ray queries walk.
// Wiring: server/game.ts steps movement; shared/hitscan.ts walks the floor
//   index; server/arena-host.ts and client/boot.ts share the move-button codec.
// Order: mark a box dynamic (`markDynamicObstacle`) before rewriting its XZ;
//   the index rebuilds on array length, last element, or a new dynamic box.
// Invariants: Y is never indexed, so a Y-only rewrite (a cab wall) needs no
//   rebuild; a dynamic box is tested on every query, not from a cell.
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
/**
 * Exact clip name, then a case-insensitive substring.
 * @why Matching the previous player.
 */
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
 * @why Acceleration is counted in ticks, so a full wish still lands in
 *      `MOVE_TICKS`.
 */
export const MOVE_DT = 0.05;

/** Meters per second at a unit wish. Input axes stay the client's yaw-space moveX / moveZ. */
export const MOVE_SPEED = 5;

/**
 * Meters per second added toward the wish on one tick.
 * @why The same step stops the pawn.
 */
export const MOVE_ACCEL = 1.25;

/** Ticks from rest to `MOVE_SPEED`, and from that speed back to zero. */
export const MOVE_TICKS = MOVE_SPEED / MOVE_ACCEL;

/**
 * Radians an unowned pawn may yaw in one tick.
 * @why A tenth of a full turn; player look does not use this.
 */
export const PAWN_YAW_STEP = (Math.PI * 2) / 10;

/** At or under this planar speed the owned clip is idle. */
export const MOVE_IDLE = 0.05;

/**
 * Highest rise the capsule mounts in one sample.
 * @why A taller box stays a wall and the kernel push-out stands.
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
 * @post A gap inside one step lands on `to`.
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

/**
 * Wish velocity.
 * @post Magnitude above 1 is pulled back to the unit circle, then scaled by
 *       `MOVE_SPEED`.
 */
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
 * @post A gap inside one step lands on the wish. A larger gap keeps its
 *       direction.
 */
export function approachVelocity(velocity: Planar, wish: Planar, accel = MOVE_ACCEL): Planar {
  const dx = wish.x - velocity.x;
  const dz = wish.z - velocity.z;
  const dist = Math.hypot(dx, dz);
  if (!(dist > accel)) return { x: wish.x, z: wish.z };
  const scale = accel / dist;
  return { x: velocity.x + dx * scale, z: velocity.z + dz * scale };
}

/**
 * Host label only. The client still picks its own clip from ground speed.
 * @why 2.69 m/s is the cyborg walk stride times the client's 1.5 walk cap
 *      (referenceSpeed × scale × 1.5). There is no hysteresis on the host.
 */
export const RUN_SPEED_M_S = 2.69;

/** Owned clip from planar speed. At or above `RUN_SPEED_M_S` the label is run. */
export function gaitForSpeed(speed: number): "idle" | "walk" | "run" {
  if (!(speed > MOVE_IDLE)) return "idle";
  if (speed >= RUN_SPEED_M_S) return "run";
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

/**
 * One height-banded AABB.
 * @why Missing Y blocks at every height and is not a floor.
 */
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

/**
 * Floor grid index. Static uniform XZ grid over the live obstacle array, for the floor queries in
 * `movements.ts`. Built once per array and reused every tick; nothing is
 * allocated per query.
 *
 * Each cell lists the boxes whose XZ footprint, grown by `FLOOR_INDEX_PAD`,
 * overlaps it. A disc of radius r <= PAD that touches a box's grown footprint
 * therefore always has its centre in a cell that lists the box, so one cell is
 * enough per point query.
 *
 * Boxes whose XZ can change in place (door leaves) are marked with
 * `markDynamicObstacle` and are checked on every query instead. Boxes with
 * huge or non-finite footprints go to that same always-checked list.
 *
 * The index is rebuilt only when it goes stale: the array length or its last
 * element changed (add or splice), or a box was newly marked dynamic.
 * Y is never indexed; queries read minY/maxY live, so elevator rides that
 * rewrite Y in place need no rebuild.
 */

/** Cell edge in metres. */
export const FLOOR_INDEX_CELL = 2;
/**
 * Largest query radius the cells cover.
 * @post Bigger radii fall back to a full scan.
 */
export const FLOOR_INDEX_PAD = 1;
/** A box spanning more cells than this is checked every query instead. */
const MAX_SPAN_CELLS = 256;
/** Coordinates beyond this (parked door leaves sit at -1e6) are not gridded. */
const FAR = 1e5;

export type FloorIndex = {
  readonly boxes: readonly FloorBox[];
  readonly length: number;
  readonly last: FloorBox | undefined;
  readonly epoch: number;
  readonly originX: number;
  readonly originZ: number;
  readonly cols: number;
  readonly rows: number;
  /** CSR offsets: cell c lists items[cellStart[c] .. cellStart[c + 1]). */
  readonly cellStart: Int32Array;
  readonly items: Int32Array;
  /** Box indices checked on every query. */
  readonly always: Int32Array;
  /** Build time in ms, for logs and profiling. */
  readonly buildMs: number;
};

const dynamicBoxes = new WeakSet<object>();
let dynamicEpoch = 0;
const cache = new WeakMap<readonly FloorBox[], FloorIndex>();

/**
 * A box whose XZ is rewritten in place (door leaf).
 * @why Bumps the epoch so indexes rebuild once, not on every rewrite.
 */
export function markDynamicObstacle(box: object): void {
  if (dynamicBoxes.has(box)) return;
  dynamicBoxes.add(box);
  dynamicEpoch += 1;
}

/** Cached index for this live array, rebuilt only when stale. */
export function floorIndexFor(boxes: readonly FloorBox[]): FloorIndex {
  const hit = cache.get(boxes);
  if (hit && hit.length === boxes.length && hit.last === boxes[boxes.length - 1] && hit.epoch === dynamicEpoch) return hit;
  const built = buildFloorIndex(boxes);
  cache.set(boxes, built);
  return built;
}

function hasFloorBand(box: FloorBox): boolean {
  return box.minY !== undefined && box.maxY !== undefined && Number.isFinite(box.minY) && Number.isFinite(box.maxY);
}

function gridded(box: FloorBox): boolean {
  if (dynamicBoxes.has(box)) return false;
  const { minX, maxX, minZ, maxZ } = box;
  return Number.isFinite(minX) && Number.isFinite(maxX) && Number.isFinite(minZ) && Number.isFinite(maxZ)
    && Math.abs(minX) < FAR && Math.abs(maxX) < FAR && Math.abs(minZ) < FAR && Math.abs(maxZ) < FAR;
}

export function buildFloorIndex(boxes: readonly FloorBox[]): FloorIndex {
  const t0 = performance.now();
  const cs = FLOOR_INDEX_CELL;
  const pad = FLOOR_INDEX_PAD;
  let loX = Infinity, hiX = -Infinity, loZ = Infinity, hiZ = -Infinity;
  for (const box of boxes) {
    if (!hasFloorBand(box) || !gridded(box)) continue;
    loX = Math.min(loX, box.minX, box.maxX);
    hiX = Math.max(hiX, box.minX, box.maxX);
    loZ = Math.min(loZ, box.minZ, box.maxZ);
    hiZ = Math.max(hiZ, box.minZ, box.maxZ);
  }
  const empty = !(loX <= hiX && loZ <= hiZ);
  const originX = empty ? 0 : loX - pad;
  const originZ = empty ? 0 : loZ - pad;
  const cols = empty ? 0 : Math.floor((hiX + pad - originX) / cs) + 1;
  const rows = empty ? 0 : Math.floor((hiZ + pad - originZ) / cs) + 1;
  const counts = new Int32Array(cols * rows + 1);
  const always: number[] = [];
  // Cell ranges use the same float ops as the query (box edge minus pad, minus origin, over cell),
  // so a centre strictly inside the grown footprint always lands in a listed cell.
  const span = (box: FloorBox): [number, number, number, number] => [
    Math.max(0, Math.floor((Math.min(box.minX, box.maxX) - pad - originX) / cs)),
    Math.min(cols - 1, Math.floor((Math.max(box.minX, box.maxX) + pad - originX) / cs)),
    Math.max(0, Math.floor((Math.min(box.minZ, box.maxZ) - pad - originZ) / cs)),
    Math.min(rows - 1, Math.floor((Math.max(box.minZ, box.maxZ) + pad - originZ) / cs)),
  ];
  const place: boolean[] = new Array(boxes.length).fill(false);
  boxes.forEach((box, i) => {
    if (!hasFloorBand(box) && !dynamicBoxes.has(box)) return;
    if (!gridded(box)) {
      always.push(i);
      return;
    }
    const [c0, c1, r0, r1] = span(box);
    if ((c1 - c0 + 1) * (r1 - r0 + 1) > MAX_SPAN_CELLS) {
      always.push(i);
      return;
    }
    place[i] = true;
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) counts[r * cols + c + 1]! += 1;
  });
  for (let c = 1; c < counts.length; c++) counts[c]! += counts[c - 1]!;
  const cellStart = counts;
  const items = new Int32Array(cellStart[cellStart.length - 1]!);
  const fill = cellStart.slice(0, cellStart.length - 1);
  boxes.forEach((box, i) => {
    if (!place[i]) return;
    const [c0, c1, r0, r1] = span(box);
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) items[fill[r * cols + c]!++] = i;
  });
  return {
    boxes,
    length: boxes.length,
    last: boxes[boxes.length - 1],
    epoch: dynamicEpoch,
    originX,
    originZ,
    cols,
    rows,
    cellStart,
    items,
    always: Int32Array.from(always),
    buildMs: performance.now() - t0,
  };
}

/** Cell holding (x, z), or -1 when the point is off the grid or r is too big (full-scan fallback). */
export function floorIndexCell(index: FloorIndex, x: number, z: number, r: number): number {
  if (!(r <= FLOOR_INDEX_PAD)) return -1;
  const c = Math.floor((x - index.originX) / FLOOR_INDEX_CELL);
  const w = Math.floor((z - index.originZ) / FLOOR_INDEX_CELL);
  if (!(c >= 0 && c < index.cols && w >= 0 && w < index.rows)) return -1;
  return w * index.cols + c;
}

type MoveWorld = {
  store: { view(id: number): MoveView | undefined };
  enqueue(cmd: MoveCommand): void;
  listObstacles(): readonly FloorBox[];
};

/**
 * Highest band top under the disc that is at most `step` above `feet`.
 * The room floor is 0.
 * @why The disc test matches the kernel push-out: the expanded face is outside,
 *      so a box that does not hit the body is not a floor.
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
 * floor and one tall box is not.
 * @post The last sample is where the capsule rests.
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

/** One box's contribution to `floorHeight`: same tests, same order. */
function boxFloorTop(box: FloorBox, x: number, z: number, r: number, limit: number, floor: number): number {
  if (box.minY === undefined || box.maxY === undefined) return floor;
  if (!Number.isFinite(box.minY) || !Number.isFinite(box.maxY)) return floor;
  const top = Math.max(box.minY, box.maxY);
  if (top > limit) return floor;
  const minX = Math.min(box.minX, box.maxX) - r;
  const maxX = Math.max(box.minX, box.maxX) + r;
  const minZ = Math.min(box.minZ, box.maxZ) - r;
  const maxZ = Math.max(box.minZ, box.maxZ) + r;
  if (x <= minX || x >= maxX || z <= minZ || z >= maxZ) return floor;
  return top > floor ? top : floor;
}

/**
 * `floorHeight` over the boxes the static grid lists for (x, z), plus the
 * always-checked ones. Off the grid, or for a radius past the grid pad, it is
 * the full scan. Same result as `floorHeight(index.boxes, ...)`.
 * @see floorHeight
 */
export function floorHeightIndexed(
  index: FloorIndex,
  x: number,
  z: number,
  radius: number,
  feet: number,
  step = STEP_HEIGHT,
): number {
  const r = radius > 0 ? radius : 0;
  const cell = floorIndexCell(index, x, z, r);
  if (cell < 0) return floorHeight(index.boxes, x, z, radius, feet, step);
  const limit = feet + step + STEP_SLOP;
  const boxes = index.boxes;
  const items = index.items;
  const always = index.always;
  let floor = 0;
  for (let i = index.cellStart[cell]!, end = index.cellStart[cell + 1]!; i < end; i++) {
    floor = boxFloorTop(boxes[items[i]!]!, x, z, r, limit, floor);
  }
  for (let i = 0; i < always.length; i++) floor = boxFloorTop(boxes[always[i]!]!, x, z, r, limit, floor);
  return floor;
}

/**
 * `floorAlongMove` on the static grid. Same samples, same result.
 * @see floorAlongMove
 */
export function floorAlongMoveIndexed(
  index: FloorIndex,
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
    y = floorHeightIndexed(index, x0 + dx * t, z0 + dz * t, radius, y, step);
  }
  return y;
}

export type PlanarStep = { vx: number; vz: number; speed: number };

/**
 * Approach XZ velocity, then step the capsule by that velocity.
 * Feet then rest on the band tops along that step. A rise of at most
 * `STEP_HEIGHT` mounts the box. Yaw does not rotate velocity. The caller
 * commits. `setClip` is separate and does not write this position.
 * @why A taller box keeps this height so the kernel push-out still stops the
 *      body.
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
  const y = floorAlongMoveIndexed(floorIndexFor(world.listObstacles()), view.position.x, view.position.z, x, z, view.radius, view.position.y);
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
 * Same wish and yaw as `enqueuePlanarMove`, with no obstacle or floor query.
 * `ascend` is -1, 0, or 1. Vertical speed is `MOVE_SPEED`. Yaw is not a second frame.
 * @see enqueuePlanarMove
 */
export function enqueueNoclipMove(
  world: MoveWorld,
  entity: number,
  moveX: number,
  moveZ: number,
  yaw: number,
  ascend = 0,
  dt = MOVE_DT,
): PlanarStep | undefined {
  const view = world.store.view(entity);
  if (!view) return undefined;
  const next = approachVelocity({ x: view.velocity.x, z: view.velocity.z }, wishPlanar(moveX, moveZ));
  const rise = Number.isFinite(ascend) ? ascend : 0;
  world.enqueue({ kind: "setVelocity", entity, linear: { x: next.x, y: 0, z: next.z } });
  world.enqueue({
    kind: "setTransform",
    entity,
    position: {
      x: view.position.x + next.x * dt,
      y: view.position.y + rise * MOVE_SPEED * dt,
      z: view.position.z + next.z * dt,
    },
    rotation: yawQuaternion(yaw),
    scale: { x: view.scale.x, y: view.scale.y, z: view.scale.z },
  });
  return { vx: next.x, vz: next.z, speed: Math.hypot(next.x, next.z) };
}

/** Bit 0 noclip, bit 1 ascend up, bit 2 ascend down. The kernel input `buttons` field already carries this. */
const NOCLIP_BIT = 1;
const ASCEND_UP_BIT = 2;
const ASCEND_DOWN_BIT = 4;

export function encodeMoveButtons(noclip: boolean, ascend: number): number {
  let bits = 0;
  if (noclip) bits |= NOCLIP_BIT;
  if (ascend > 0) bits |= ASCEND_UP_BIT;
  else if (ascend < 0) bits |= ASCEND_DOWN_BIT;
  return bits;
}

export function decodeMoveButtons(buttons: number | undefined): { noclip: boolean; ascend: -1 | 0 | 1 } {
  const bits = buttons === undefined || !Number.isFinite(buttons) ? 0 : buttons | 0;
  const up = (bits & ASCEND_UP_BIT) !== 0;
  const down = (bits & ASCEND_DOWN_BIT) !== 0;
  return { noclip: (bits & NOCLIP_BIT) !== 0, ascend: up === down ? 0 : up ? 1 : -1 };
}

/**
 * `ARENA_NOCLIP=1` at host start. Any other value leaves the field absent.
 * @why Not part of either content hash.
 */
export function applyHostNoclip(view: { noclip?: boolean }, env: { ARENA_NOCLIP?: string | undefined }): void {
  if (env.ARENA_NOCLIP === "1") view.noclip = true;
  else delete view.noclip;
}

/**
 * Kernel `commit` always runs obstacle push-out. A radius of -1e9 makes every
 * finite AABB and the world bounds miss that pawn for this commit. The store
 * and the returned snapshot keep the real radius.
 */
const NOCLIP_RADIUS = -1e9;

type RadiusSlots = {
  index: Map<number, number>;
  radius: Float64Array;
};

function radiusSlots(store: unknown): RadiusSlots {
  const record = store as Partial<RadiusSlots>;
  if (!(record.index instanceof Map) || !(record.radius instanceof Float64Array)) {
    throw new Error("noclip cannot see pawn radius slots");
  }
  return record as RadiusSlots;
}

export function commitShielded<S extends { entities: ReadonlyArray<{ id: number; radius: number }> }>(
  world: { store: unknown; commit(tick: bigint): S },
  tick: bigint,
  noclipIds: readonly number[],
): S {
  const saved = new Map<number, number>();
  const before = radiusSlots(world.store);
  for (const id of noclipIds) {
    const slot = before.index.get(id);
    if (slot === undefined) continue;
    saved.set(id, before.radius[slot]!);
    before.radius[slot] = NOCLIP_RADIUS;
  }
  try {
    const snap = world.commit(tick);
    if (saved.size === 0) return snap;
    return {
      ...snap,
      entities: snap.entities.map((entity) => {
        const radius = saved.get(entity.id);
        return radius === undefined ? entity : { ...entity, radius };
      }),
    } as S;
  } finally {
    const after = radiusSlots(world.store);
    for (const [id, radius] of saved) {
      const slot = after.index.get(id);
      if (slot !== undefined) after.radius[slot] = radius;
    }
  }
}

export type OwnedMoveOptions = {
  /** Skip obstacle and floor queries. The caller must `commitShielded` or the kernel push-out still stops the pawn. */
  noclip?: boolean;
  /** -1, 0, or 1. Ignored unless `noclip` is set. */
  ascend?: number;
  dt?: number;
};

/**
 * Owned pawn step. `setClip` records the planar speed and the gait it selects.
 * A numeric `dt` is the colliding step.
 * @post `setClip` does not carry a position.
 */
export function enqueueOwnedMove(
  world: MoveWorld,
  entity: number,
  moveX: number,
  moveZ: number,
  yaw: number,
  dt: number | OwnedMoveOptions = MOVE_DT,
): { gait: "idle" | "walk" | "run"; speed: number } | undefined {
  const view = world.store.view(entity);
  if (!view) return undefined;
  const options = typeof dt === "number" ? undefined : dt;
  const stepDt = typeof dt === "number" ? dt : dt.dt ?? MOVE_DT;
  const stepped = options?.noclip
    ? enqueueNoclipMove(world, entity, moveX, moveZ, yaw, options.ascend ?? 0, stepDt)
    : enqueuePlanarMove(world, entity, moveX, moveZ, yaw, stepDt);
  if (!stepped) return undefined;
  const gait = gaitForSpeed(stepped.speed);
  if (view.clip !== gait || view.speed !== stepped.speed) {
    world.enqueue({ kind: "setClip", entity, clip: gait, speed: stepped.speed });
  }
  return { gait, speed: stepped.speed };
}
