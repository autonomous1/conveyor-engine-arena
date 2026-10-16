/**
 * Arena hitscan. The host is the authority. A client may run the same trace
 * to draw a shot immediately. Doors have no box, so a gap does not stop the ray.
 */

export const FIRE_HZ = 8;
export const FIRE_INTERVAL_MS = 1000 / FIRE_HZ;
export const LASER_MS = 80;
export const TRACE_RANGE = 96;
/**
 * The eye is inside the shooter capsule (radius 0.5). A hit closer than this
 * is that pawn, not a wall. The capsule surface of anyone else is farther.
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
 * One sample with `firing` set is one shot. `nextAt` advances only when a shot is due.
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
 * `fast` is a newer seq inside the 8 Hz window. That seq is consumed.
 * `accept` is the only result that should trace.
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
  const shot: Shot = {
    from: { x: origin.x, y: origin.y, z: origin.z },
    to: { x: origin.x + aim.x * best, y: origin.y + aim.y * best, z: origin.z + aim.z * best },
    distance: best,
  };
  if (hitId !== undefined) shot.hitId = hitId;
  return shot;
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
 * The first accepted hit wins. This does not apply {@link MIN_HIT_DISTANCE}.
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
