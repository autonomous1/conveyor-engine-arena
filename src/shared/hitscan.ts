/**
 * Arena hitscan. The host is the authority. A client may run the same trace
 * to draw a shot immediately. Doors have no box, so a gap does not stop the ray.
 *
 * `traceHitscan` tests every box. `traceIndexed` asks the floor grid which
 * cells the ray crosses and tests those boxes, plus the grid's always-list.
 */
// ARCHITECTURE: Ray and segment tests against the same obstacle and capsule
//   volumes: the indexed shot trace, the linear trace, and the grenade sweep.
// Wiring: server/fire.ts traces shots; server/arena-host.ts exposes
//   `lineOfSight`; server/grenade.ts sweeps; shared/bot-protocol.ts parses the
//   laser frame.
// Order: the first trace on a box array builds its floor index; later traces
//   reuse it until the array changes.
// Invariants: `traceIndexed` and `traceHitscan` return the same closest hit;
//   `sweepSegment` does not apply `MIN_HIT_DISTANCE`.
import { FLOOR_INDEX_CELL, floorIndexFor, type FloorIndex } from "./movements.js";

export const FIRE_HZ = 8;
export const FIRE_INTERVAL_MS = 1000 / FIRE_HZ;
export const LASER_MS = 80;
export const TRACE_RANGE = 96;
/**
 * @why The eye is inside the shooter capsule (radius 0.5), so a hit closer
 *      than this is that pawn, not a wall. The capsule surface of anyone else
 *      is farther.
 */
export const MIN_HIT_DISTANCE = 0.5;

const HIT_EPS = 1e-4;

export type Vec3 = { x: number; y: number; z: number };

export type TraceAabb = {
  id?: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /** Absent together means the box blocks at every height, matching the world. */
  minY?: number;
  maxY?: number;
};

/** Feet at `y`. The shaft runs from `radius` to `height - radius`. */
export type TraceCapsule = {
  id?: number;
  x: number;
  y: number;
  z: number;
  radius: number;
  height: number;
};

export type FireFrame = {
  t: "fire";
  v: 1;
  seq: number;
  yaw: number;
  pitch: number;
};

export function fireFrame(seq: number, yaw: number, pitch: number): FireFrame {
  return { t: "fire", v: 1, seq, yaw, pitch };
}

/**
 * Client send clock. A held trigger is due at most once per {@link FIRE_INTERVAL_MS}.
 * One sample with `firing` set is one shot.
 * @post `nextAt` advances only when a shot is due.
 */
export function advanceFireClock(firing: boolean, now: number, nextAt: number): { due: boolean; nextAt: number } {
  if (!firing || !(now >= nextAt)) return { due: false, nextAt };
  return { due: true, nextAt: now + FIRE_INTERVAL_MS };
}

export type LaserFrame = {
  t: "laser";
  shooter: number;
  from: Vec3;
  to: Vec3;
  until: number;
};

function asVec(value: unknown): Vec3 | undefined {
  if (!value || typeof value !== "object") return undefined;
  const rec = value as { x?: unknown; y?: unknown; z?: unknown };
  if (typeof rec.x !== "number" || typeof rec.y !== "number" || typeof rec.z !== "number") return undefined;
  if (!Number.isFinite(rec.x) || !Number.isFinite(rec.y) || !Number.isFinite(rec.z)) return undefined;
  return { x: rec.x, y: rec.y, z: rec.z };
}

/**
 * Host laser segment.
 * @why `shooter` is coerced with `Number`, matching the client.
 */
export function parseLaser(frame: unknown): LaserFrame | undefined {
  if (!frame || typeof frame !== "object") return undefined;
  const msg = frame as Record<string, unknown>;
  if (msg.t !== "laser") return undefined;
  const shooter = Number(msg.shooter);
  const from = asVec(msg.from);
  const to = asVec(msg.to);
  const until = Number(msg.until);
  if (!Number.isFinite(shooter) || !from || !to || !Number.isFinite(until)) return undefined;
  return { t: "laser", shooter, from, to, until };
}

export type FireGate = {
  lastSeq: number;
  lastAt: number;
};

export type Shot = {
  from: Vec3;
  to: Vec3;
  distance: number;
  /** Obstacle or pawn id of the first accepted hit. Absent on a miss. */
  hitId?: number;
};

export function freshFireGate(): FireGate {
  return { lastSeq: 0, lastAt: Number.NEGATIVE_INFINITY };
}

export function parseFire(frame: unknown): FireFrame | undefined {
  if (!frame || typeof frame !== "object") return undefined;
  const rec = frame as Record<string, unknown>;
  if (rec.t !== "fire" || rec.v !== 1) return undefined;
  if (typeof rec.seq !== "number" || !Number.isFinite(rec.seq)) return undefined;
  if (typeof rec.yaw !== "number" || !Number.isFinite(rec.yaw)) return undefined;
  if (typeof rec.pitch !== "number" || !Number.isFinite(rec.pitch)) return undefined;
  return { t: "fire", v: 1, seq: rec.seq, yaw: rec.yaw, pitch: rec.pitch };
}

/**
 * `repeat` is a seq at or below the last one this gate has seen.
 * `fast` is a newer seq inside the 8 Hz window.
 * @post A `fast` seq is consumed; `accept` is the only result that should trace.
 */
export function admitFire(gate: FireGate, seq: number, now: number): "accept" | "repeat" | "fast" {
  if (!Number.isFinite(seq) || seq <= gate.lastSeq) return "repeat";
  if (now - gate.lastAt < FIRE_INTERVAL_MS) {
    gate.lastSeq = seq;
    return "fast";
  }
  gate.lastSeq = seq;
  gate.lastAt = now;
  return "accept";
}

export function traceHitscan(
  origin: Vec3,
  dir: Vec3,
  aabbs: readonly TraceAabb[],
  capsules: readonly TraceCapsule[],
  range = TRACE_RANGE,
): Shot {
  const aim = unit(dir);
  let best = range;
  let hitId: number | undefined;
  const take = (t: number | undefined, id: number | undefined) => {
    if (t === undefined || t < MIN_HIT_DISTANCE || !(t < best)) return;
    best = t;
    hitId = id;
  };
  for (const box of aabbs) take(rayAabb(origin, aim, box, best), box.id);
  for (const cap of capsules) take(rayCapsule(origin, aim, cap, best), cap.id);
  return finishShot(origin, aim, best, hitId);
}

/**
 * Same result as {@link traceHitscan}. Static boxes come from the floor grid
 * (2 m cells). The walk is a 2D DDA on the ray's XZ projection and stops when
 * the next cell starts past the closest hit. Dynamic boxes, oversized boxes,
 * and anything the grid does not list are tested every call. Y is read live.
 * @see traceHitscan
 */
export function traceIndexed(
  origin: Vec3,
  dir: Vec3,
  aabbs: readonly TraceAabb[],
  capsules: readonly TraceCapsule[],
  range = TRACE_RANGE,
): Shot {
  const aim = unit(dir);
  let best = range;
  let hitId: number | undefined;
  let bestIndex = -1;
  let matched = false;
  const takeBox = (t: number | undefined, index: number) => {
    if (t === undefined || t < MIN_HIT_DISTANCE) return;
    // Equal distances keep the earlier box, matching the forward scan.
    if (t < best || (matched && t === best && index < bestIndex)) {
      best = t;
      bestIndex = index;
      hitId = aabbs[index]?.id;
      matched = true;
    }
  };
  prepareSeen(aabbs.length);
  const mark = stamp;
  const consider = (index: number) => {
    if (seen[index] === mark) return;
    seen[index] = mark;
    const box = aabbs[index];
    if (!box) return;
    takeBox(rayAabb(origin, aim, box, best), index);
  };
  const grid = floorIndexFor(aabbs);
  for (let i = 0; i < grid.always.length; i++) consider(grid.always[i]!);
  const extra = uncoveredBoxes(grid);
  for (let i = 0; i < extra.length; i++) consider(extra[i]!);
  walkFloorCells(grid, origin, aim, () => best, (cell) => {
    const start = grid.cellStart[cell]!;
    const end = grid.cellStart[cell + 1]!;
    for (let i = start; i < end; i++) consider(grid.items[i]!);
  });
  for (const cap of capsules) {
    const t = rayCapsule(origin, aim, cap, best);
    if (t === undefined || t < MIN_HIT_DISTANCE || !(t < best)) continue;
    best = t;
    hitId = cap.id;
  }
  return finishShot(origin, aim, best, hitId);
}

/**
 * Accepted for callers that share a clock sample.
 * @why The segment test does not read it.
 */
export type LineOfSightOpts = {
  now?: number;
};

/**
 * True when the segment hits no obstacle before `to`.
 * @why Pawns are not tested, so a dead pawn cannot block the segment.
 */
export function hasLineOfSight(
  from: Vec3,
  to: Vec3,
  boxes: readonly TraceAabb[],
  opts?: LineOfSightOpts,
): boolean {
  void opts;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const span = Math.hypot(dx, dy, dz);
  if (!(span > 0)) return true;
  const shot = traceIndexed(from, { x: dx, y: dy, z: dz }, boxes, [], span);
  return !(shot.distance < span);
}

/**
 * One gate per bot. Later calls are due once per `1/hz` seconds. `clock`
 * returns milliseconds.
 * @when The first call is due.
 */
export function losGate(hz = 5, clock: () => number = Date.now): () => boolean {
  const period = 1000 / hz;
  let nextAt = Number.NEGATIVE_INFINITY;
  return () => {
    const now = clock();
    if (!(now >= nextAt)) return false;
    nextAt = now + period;
    return true;
  };
}

/**
 * `base` plus `extras` as one array the floor index can keep.
 * The same array comes back until `base` changes (identity, length, or last
 * element) or an extra box changes id or XZ.
 * @why Extra Y is written onto the cached boxes, so a height rewrite does not
 *      rebuild the index.
 */
export function createRayBoxList(): (base: readonly TraceAabb[], extras: readonly TraceAabb[]) => readonly TraceAabb[] {
  let baseRef: readonly TraceAabb[] | undefined;
  let baseLength = -1;
  let baseLast: TraceAabb | undefined;
  let list: TraceAabb[] = [];
  return (base, extras) => {
    const last = base.length > 0 ? base[base.length - 1] : undefined;
    const baseSame = baseRef === base && baseLength === base.length && baseLast === last;
    if (baseSame && extrasMatch(list, base.length, extras)) {
      for (let i = 0; i < extras.length; i++) writeY(list[base.length + i]!, extras[i]!);
      return list;
    }
    const next = base.slice();
    for (let i = 0; i < extras.length; i++) next.push(copyBox(extras[i]!));
    baseRef = base;
    baseLength = base.length;
    baseLast = last;
    list = next;
    return list;
  };
}

function extrasMatch(list: readonly TraceAabb[], start: number, extras: readonly TraceAabb[]): boolean {
  if (list.length !== start + extras.length) return false;
  for (let i = 0; i < extras.length; i++) {
    const cached = list[start + i]!;
    const extra = extras[i]!;
    if (cached.id !== extra.id || cached.minX !== extra.minX || cached.maxX !== extra.maxX
      || cached.minZ !== extra.minZ || cached.maxZ !== extra.maxZ) return false;
  }
  return true;
}

function writeY(dst: TraceAabb, src: TraceAabb): void {
  dst.minY = src.minY;
  dst.maxY = src.maxY;
}

function copyBox(box: TraceAabb): TraceAabb {
  const copy: TraceAabb = { minX: box.minX, maxX: box.maxX, minZ: box.minZ, maxZ: box.maxZ };
  if (box.id !== undefined) copy.id = box.id;
  if (box.minY !== undefined) copy.minY = box.minY;
  if (box.maxY !== undefined) copy.maxY = box.maxY;
  return copy;
}

function finishShot(origin: Vec3, aim: Vec3, best: number, hitId: number | undefined): Shot {
  const shot: Shot = {
    from: { x: origin.x, y: origin.y, z: origin.z },
    to: { x: origin.x + aim.x * best, y: origin.y + aim.y * best, z: origin.z + aim.z * best },
    distance: best,
  };
  if (hitId !== undefined) shot.hitId = hitId;
  return shot;
}

/** Stamp buffer reused across traces. A call does not allocate once this fits `boxes.length`. */
let seen = new Int32Array(0);
let stamp = 1;

function prepareSeen(n: number): void {
  if (seen.length < n) seen = new Int32Array(n);
  stamp += 1;
  if (stamp >= 0x7ffffffe) {
    seen.fill(0);
    stamp = 1;
  }
}

const uncoveredCache = new WeakMap<FloorIndex, Int32Array>();

/** Box indices the floor grid neither lists nor puts on `always` (no Y band, not dynamic). */
function uncoveredBoxes(index: FloorIndex): Int32Array {
  const cached = uncoveredCache.get(index);
  if (cached) return cached;
  const n = index.boxes.length;
  const covered = new Uint8Array(n);
  for (let i = 0; i < index.items.length; i++) {
    const box = index.items[i]!;
    if (box >= 0 && box < n) covered[box] = 1;
  }
  for (let i = 0; i < index.always.length; i++) {
    const box = index.always[i]!;
    if (box >= 0 && box < n) covered[box] = 1;
  }
  const missing: number[] = [];
  for (let i = 0; i < n; i++) if (covered[i] === 0) missing.push(i);
  const out = Int32Array.from(missing);
  uncoveredCache.set(index, out);
  return out;
}

const XZ_EPS = 1e-12;

/**
 * Visit each grid cell the ray's XZ projection crosses, in order.
 * `limit` is the closest hit so far, in the same parameter as a unit ray.
 * A vertical ray (no XZ step) visits the one cell under the origin.
 */
function walkFloorCells(
  index: FloorIndex,
  origin: Vec3,
  dir: Vec3,
  limit: () => number,
  visit: (cell: number) => void,
): void {
  const cols = index.cols;
  const rows = index.rows;
  if (cols <= 0 || rows <= 0) return;
  const cs = FLOOR_INDEX_CELL;
  const x0 = index.originX;
  const z0 = index.originZ;
  const x1 = x0 + cols * cs;
  const z1 = z0 + rows * cs;
  const dx = Math.abs(dir.x) < XZ_EPS ? 0 : dir.x;
  const dz = Math.abs(dir.z) < XZ_EPS ? 0 : dir.z;
  const tEnter = enterGrid(origin.x, origin.z, dx, dz, x0, x1, z0, z1, limit());
  if (tEnter === undefined) return;

  // A hair past the entry face so floor() lands in the cell being entered.
  const into = tEnter > 0 ? 1e-8 : 0;
  const px = origin.x + dx * (tEnter + into);
  const pz = origin.z + dz * (tEnter + into);
  let cx = Math.floor((px - x0) / cs);
  let cz = Math.floor((pz - z0) / cs);
  if (cx === cols) cx = cols - 1;
  else if (cx === -1) cx = 0;
  if (cz === rows) cz = rows - 1;
  else if (cz === -1) cz = 0;
  if (cx < 0 || cz < 0 || cx >= cols || cz >= rows) return;

  const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;
  if (stepX === 0 && stepZ === 0) {
    if (tEnter <= limit()) visit(cz * cols + cx);
    return;
  }

  let tCell = tEnter;
  const guard = cols + rows + 4;
  for (let n = 0; n < guard; n++) {
    if (tCell > limit()) return;
    visit(cz * cols + cx);
    const tMaxX = cellExit(origin.x, dx, x0, cx, stepX, cs);
    const tMaxZ = cellExit(origin.z, dz, z0, cz, stepZ, cs);
    if (tMaxX < tMaxZ) {
      if (tMaxX > limit()) return;
      cx += stepX;
      if (cx < 0 || cx >= cols) return;
      tCell = tMaxX;
    } else if (tMaxZ < tMaxX) {
      if (tMaxZ > limit()) return;
      cz += stepZ;
      if (cz < 0 || cz >= rows) return;
      tCell = tMaxZ;
    } else {
      if (tMaxX > limit()) return;
      cx += stepX;
      cz += stepZ;
      if (cx < 0 || cz < 0 || cx >= cols || cz >= rows) return;
      tCell = tMaxX;
    }
  }
}

function cellExit(origin: number, dir: number, gridOrigin: number, cell: number, step: number, cs: number): number {
  if (step === 0 || dir === 0) return Number.POSITIVE_INFINITY;
  const boundary = gridOrigin + (step > 0 ? cell + 1 : cell) * cs;
  return (boundary - origin) / dir;
}

/** `t` at which the XZ ray enters the closed grid rectangle. 0 when the origin is already inside. */
function enterGrid(
  x: number,
  z: number,
  dx: number,
  dz: number,
  minX: number,
  maxX: number,
  minZ: number,
  maxZ: number,
  maxT: number,
): number | undefined {
  let tmin = 0;
  let tmax = maxT;
  const axes: Array<[number, number, number, number]> = [
    [x, minX, maxX, dx],
    [z, minZ, maxZ, dz],
  ];
  for (const [o, min, max, d] of axes) {
    if (d === 0) {
      if (o < min || o > max) return undefined;
      continue;
    }
    let t1 = (min - o) / d;
    let t2 = (max - o) / d;
    if (t1 > t2) {
      const swap = t1;
      t1 = t2;
      t2 = swap;
    }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return undefined;
  }
  if (tmax < 0 || tmin > maxT) return undefined;
  return tmin;
}

function unit(dir: Vec3): Vec3 {
  const len = Math.hypot(dir.x, dir.y, dir.z);
  if (len < 1e-8) return { x: 0, y: 0, z: 1 };
  return { x: dir.x / len, y: dir.y / len, z: dir.z / len };
}

function rayAabb(origin: Vec3, dir: Vec3, box: TraceAabb, maxT: number): number | undefined {
  const minY = box.minY ?? Number.NEGATIVE_INFINITY;
  const maxY = box.maxY ?? Number.POSITIVE_INFINITY;
  let tmin = 0;
  let tmax = maxT;
  const axes: Array<[number, number, number, number]> = [
    [origin.x, box.minX, box.maxX, dir.x],
    [origin.y, minY, maxY, dir.y],
    [origin.z, box.minZ, box.maxZ, dir.z],
  ];
  for (const [o, min, max, d] of axes) {
    if (Math.abs(d) < 1e-12) {
      if (o < min || o > max) return undefined;
      continue;
    }
    let t1 = (min - o) / d;
    let t2 = (max - o) / d;
    if (t1 > t2) {
      const swap = t1;
      t1 = t2;
      t2 = swap;
    }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return undefined;
  }
  if (tmax < HIT_EPS) return undefined;
  if (tmin > HIT_EPS) return tmin;
  return HIT_EPS;
}

function rayCapsule(origin: Vec3, dir: Vec3, cap: TraceCapsule, maxT: number): number | undefined {
  if (!(cap.radius > 0) || !(cap.height > 0)) return undefined;
  if (!(cap.height > cap.radius * 2)) {
    return raySphere(origin, dir, { x: cap.x, y: cap.y + cap.height / 2, z: cap.z }, Math.min(cap.radius, cap.height / 2), maxT);
  }
  const y0 = cap.y + cap.radius;
  const y1 = cap.y + cap.height - cap.radius;
  let best: number | undefined;
  const ox = origin.x - cap.x;
  const oz = origin.z - cap.z;
  const a = dir.x * dir.x + dir.z * dir.z;
  const b = 2 * (ox * dir.x + oz * dir.z);
  const c = ox * ox + oz * oz - cap.radius * cap.radius;
  if (a > 1e-12) {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const s = Math.sqrt(disc);
      for (const t of [(-b - s) / (2 * a), (-b + s) / (2 * a)]) {
        if (t <= HIT_EPS || t > maxT) continue;
        const y = origin.y + t * dir.y;
        if (y < y0 || y > y1) continue;
        best = best === undefined ? t : Math.min(best, t);
      }
    }
  }
  for (const y of [y0, y1]) {
    const t = raySphere(origin, dir, { x: cap.x, y, z: cap.z }, cap.radius, maxT);
    if (t !== undefined) best = best === undefined ? t : Math.min(best, t);
  }
  return best;
}

export type SweepHit = {
  /** Meters along the segment from `from` toward `to`. */
  distance: number;
  point: Vec3;
  /** Unit normal pointing back toward the side the segment came from. */
  normal: Vec3;
  id?: number;
  /** True when the closest volume is a pawn capsule. */
  pawn: boolean;
};

/**
 * Closest hit of the finite segment `from` → `to` against the same volumes
 * `traceHitscan` uses. A start on a surface (t at or below the ray epsilon)
 * is not a hit, so a point that just left a face does not stick to it.
 * The first accepted hit wins.
 * @why This does not apply {@link MIN_HIT_DISTANCE}.
 */
export function sweepSegment(
  from: Vec3,
  to: Vec3,
  aabbs: readonly TraceAabb[],
  capsules: readonly TraceCapsule[],
): SweepHit | undefined {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const length = Math.hypot(dx, dy, dz);
  if (!(length > HIT_EPS)) return undefined;
  const dir = { x: dx / length, y: dy / length, z: dz / length };
  let best = length;
  let normal: Vec3 | undefined;
  let hitId: number | undefined;
  let pawn = false;
  const take = (hit: FaceHit | undefined, id: number | undefined, isPawn: boolean) => {
    if (!hit || !(hit.t < best)) return;
    best = hit.t;
    normal = hit.normal;
    hitId = id;
    pawn = isPawn;
  };
  for (const box of aabbs) take(segmentAabb(from, dir, box, best), box.id, false);
  for (const cap of capsules) take(segmentCapsule(from, dir, cap, best), cap.id, true);
  if (!normal) return undefined;
  const face = normal;
  const shot: SweepHit = {
    distance: best,
    point: { x: from.x + dir.x * best, y: from.y + dir.y * best, z: from.z + dir.z * best },
    normal: face,
    pawn,
  };
  if (hitId !== undefined) shot.id = hitId;
  return shot;
}

type FaceHit = { t: number; normal: Vec3 };

/** Entry face of a finite ray. `dir` is unit. A point already inside is a miss. */
function segmentAabb(origin: Vec3, dir: Vec3, box: TraceAabb, maxT: number): FaceHit | undefined {
  const minY = box.minY ?? Number.NEGATIVE_INFINITY;
  const maxY = box.maxY ?? Number.POSITIVE_INFINITY;
  let tmin = 0;
  let tmax = maxT;
  let normal: Vec3 = { x: 0, y: 0, z: 0 };
  let entered = false;
  const axes: Array<[number, number, number, number, "x" | "y" | "z"]> = [
    [origin.x, box.minX, box.maxX, dir.x, "x"],
    [origin.y, minY, maxY, dir.y, "y"],
    [origin.z, box.minZ, box.maxZ, dir.z, "z"],
  ];
  for (const [o, min, max, d, axis] of axes) {
    if (Math.abs(d) < 1e-12) {
      if (o < min || o > max) return undefined;
      continue;
    }
    let t1 = (min - o) / d;
    let t2 = (max - o) / d;
    // t1 starts as the min face. Its outward normal is −axis. A swap makes t1 the max face.
    let sign: -1 | 1 = -1;
    if (t1 > t2) {
      const swap = t1;
      t1 = t2;
      t2 = swap;
      sign = 1;
    }
    if (t1 > tmin) {
      tmin = t1;
      normal = { x: 0, y: 0, z: 0 };
      normal[axis] = sign;
      entered = true;
    }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return undefined;
  }
  if (tmax < HIT_EPS || !entered || !(tmin > HIT_EPS) || tmin > maxT) return undefined;
  return { t: tmin, normal };
}

function segmentCapsule(origin: Vec3, dir: Vec3, cap: TraceCapsule, maxT: number): FaceHit | undefined {
  if (!(cap.radius > 0) || !(cap.height > 0)) return undefined;
  if (!(cap.height > cap.radius * 2)) {
    return segmentSphere(origin, dir, { x: cap.x, y: cap.y + cap.height / 2, z: cap.z }, Math.min(cap.radius, cap.height / 2), maxT);
  }
  const y0 = cap.y + cap.radius;
  const y1 = cap.y + cap.height - cap.radius;
  let best: FaceHit | undefined;
  const consider = (hit: FaceHit | undefined) => {
    if (!hit) return;
    if (!best || hit.t < best.t) best = hit;
  };
  const ox = origin.x - cap.x;
  const oz = origin.z - cap.z;
  const a = dir.x * dir.x + dir.z * dir.z;
  const b = 2 * (ox * dir.x + oz * dir.z);
  const c = ox * ox + oz * oz - cap.radius * cap.radius;
  if (a > 1e-12) {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const s = Math.sqrt(disc);
      for (const t of [(-b - s) / (2 * a), (-b + s) / (2 * a)]) {
        if (t <= HIT_EPS || t > maxT) continue;
        const y = origin.y + t * dir.y;
        if (y < y0 || y > y1) continue;
        const nx = origin.x + t * dir.x - cap.x;
        const nz = origin.z + t * dir.z - cap.z;
        const len = Math.hypot(nx, nz);
        if (!(len > 1e-8)) continue;
        consider({ t, normal: { x: nx / len, y: 0, z: nz / len } });
      }
    }
  }
  consider(segmentSphere(origin, dir, { x: cap.x, y: y0, z: cap.z }, cap.radius, maxT));
  consider(segmentSphere(origin, dir, { x: cap.x, y: y1, z: cap.z }, cap.radius, maxT));
  return best;
}

function segmentSphere(origin: Vec3, dir: Vec3, center: Vec3, radius: number, maxT: number): FaceHit | undefined {
  const ox = origin.x - center.x;
  const oy = origin.y - center.y;
  const oz = origin.z - center.z;
  const b = ox * dir.x + oy * dir.y + oz * dir.z;
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  const disc = b * b - c;
  if (disc < 0) return undefined;
  const s = Math.sqrt(disc);
  const t0 = -b - s;
  const t = t0 > HIT_EPS && t0 <= maxT ? t0 : -b + s;
  if (!(t > HIT_EPS) || t > maxT) return undefined;
  const nx = origin.x + dir.x * t - center.x;
  const ny = origin.y + dir.y * t - center.y;
  const nz = origin.z + dir.z * t - center.z;
  const len = Math.hypot(nx, ny, nz);
  if (!(len > 1e-8)) return undefined;
  return { t, normal: { x: nx / len, y: ny / len, z: nz / len } };
}

/** `dir` is unit. Quadratic is t² + 2 b t + c = 0. */
function raySphere(origin: Vec3, dir: Vec3, center: Vec3, radius: number, maxT: number): number | undefined {
  const ox = origin.x - center.x;
  const oy = origin.y - center.y;
  const oz = origin.z - center.z;
  const b = ox * dir.x + oy * dir.y + oz * dir.z;
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  const disc = b * b - c;
  if (disc < 0) return undefined;
  const s = Math.sqrt(disc);
  const t0 = -b - s;
  if (t0 > HIT_EPS && t0 <= maxT) return t0;
  const t1 = -b + s;
  if (t1 > HIT_EPS && t1 <= maxT) return t1;
  return undefined;
}
