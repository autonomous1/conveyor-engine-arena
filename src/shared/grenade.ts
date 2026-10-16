/**
 * Thrown grenade. The host owns the point, the velocity, and gravity.
 * A client draws the replicated point and does not integrate it.
 * The segment test is the hitscan sweep: the same AABBs and pawn capsules.
 * Grenades do not collide with each other. There is no second dynamic body.
 */

import { sweepSegment, type TraceAabb, type TraceCapsule, type Vec3 } from "./hitscan.js";

export const GRENADE_INTERVAL_MS = 1000;
/** Finite toss. A hitscan ray crosses its range in one trace, so this is slower. */
export const GRENADE_SPEED = 24;
/** Meters per second squared, subtracted from velocity Y once per host tick. */
export const GRENADE_GRAVITY = 9.81;
/** Scales the velocity into the surface. Below 1, so a bounce loses speed. */
export const GRENADE_RESTITUTION = 0.5;
/** Push off the face after a bounce so the next segment does not re-enter it. */
export const GRENADE_SKIN = 0.01;
/** A miss that never meets a volume is removed after this many seconds. */
export const GRENADE_LIFE_S = 4;

export type GrenadeFrame = {
  t: "grenade";
  v: 1;
  seq: number;
  yaw: number;
  pitch: number;
};

export function grenadeFrame(seq: number, yaw: number, pitch: number): GrenadeFrame {
  return { t: "grenade", v: 1, seq, yaw, pitch };
}

export function parseGrenade(frame: unknown): GrenadeFrame | undefined {
  if (!frame || typeof frame !== "object") return undefined;
  const rec = frame as Record<string, unknown>;
  if (rec.t !== "grenade" || rec.v !== 1) return undefined;
  if (typeof rec.seq !== "number" || !Number.isFinite(rec.seq)) return undefined;
  if (typeof rec.yaw !== "number" || !Number.isFinite(rec.yaw)) return undefined;
  if (typeof rec.pitch !== "number" || !Number.isFinite(rec.pitch)) return undefined;
  return { t: "grenade", v: 1, seq: rec.seq, yaw: rec.yaw, pitch: rec.pitch };
}

/** Held throw. Due at most once per {@link GRENADE_INTERVAL_MS}. */
export function advanceGrenadeClock(armed: boolean, now: number, nextAt: number): { due: boolean; nextAt: number } {
  if (!armed || !(now >= nextAt)) return { due: false, nextAt };
  return { due: true, nextAt: now + GRENADE_INTERVAL_MS };
}

export type GrenadeGate = {
  lastSeq: number;
  lastAt: number;
};

export function freshGrenadeGate(): GrenadeGate {
  return { lastSeq: 0, lastAt: Number.NEGATIVE_INFINITY };
}

/** Same three results as fire. `accept` is the only result that spawns a body. */
export function admitGrenade(gate: GrenadeGate, seq: number, now: number): "accept" | "repeat" | "fast" {
  if (!Number.isFinite(seq) || seq <= gate.lastSeq) return "repeat";
  if (now - gate.lastAt < GRENADE_INTERVAL_MS) {
    gate.lastSeq = seq;
    return "fast";
  }
  gate.lastSeq = seq;
  gate.lastAt = now;
  return "accept";
}

/**
 * Replicated point. `yaw` is the launch yaw, in radians, and does not change
 * when gravity or a bounce bends the velocity. `stop` is the final hit: the
 * client shows it, then removes the mesh.
 */
export type GrenadePose = {
  t: "grenade";
  id: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  stop?: true;
};

export function grenadePose(id: number, point: Vec3, yaw: number, stop = false): GrenadePose {
  const pose: GrenadePose = { t: "grenade", id, x: point.x, y: point.y, z: point.z, yaw };
  if (stop) pose.stop = true;
  return pose;
}

export function parseGrenadePose(frame: unknown): GrenadePose | undefined {
  if (!frame || typeof frame !== "object") return undefined;
  const rec = frame as Record<string, unknown>;
  if (rec.t !== "grenade") return undefined;
  if (typeof rec.id !== "number" || !Number.isInteger(rec.id)) return undefined;
  if (typeof rec.x !== "number" || typeof rec.y !== "number" || typeof rec.z !== "number") return undefined;
  if (!Number.isFinite(rec.x) || !Number.isFinite(rec.y) || !Number.isFinite(rec.z)) return undefined;
  if (typeof rec.yaw !== "number" || !Number.isFinite(rec.yaw)) return undefined;
  const pose: GrenadePose = { t: "grenade", id: rec.id, x: rec.x, y: rec.y, z: rec.z, yaw: rec.yaw };
  if (rec.stop === true) pose.stop = true;
  return pose;
}

export type GrenadeBody = {
  id: number;
  owner: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** Launch yaw in radians. Stays put while velocity bends. */
  yaw: number;
  bounced: boolean;
  age: number;
};

export type GrenadeHit = {
  point: Vec3;
  normal: Vec3;
  id?: number;
  pawn: boolean;
};

export type GrenadeStep =
  | { kind: "fly"; body: GrenadeBody }
  | { kind: "bounce"; body: GrenadeBody; hit: GrenadeHit }
  | { kind: "stop"; body: GrenadeBody; hit: GrenadeHit };

export function launchGrenade(
  id: number,
  owner: number,
  origin: Vec3,
  dir: Vec3,
  speed = GRENADE_SPEED,
  yaw = 0,
): GrenadeBody {
  const aim = unit(dir);
  return {
    id,
    owner,
    x: origin.x,
    y: origin.y,
    z: origin.z,
    vx: aim.x * speed,
    vy: aim.y * speed,
    vz: aim.z * speed,
    yaw,
    bounced: false,
    age: 0,
  };
}

/**
 * One host tick. Gravity is added on Y, then the segment is swept.
 * An obstacle bounces once. The next obstacle hit stops the body.
 * A pawn hit stops it and is marked so the caller can apply the existing damage.
 */
export function stepGrenade(
  body: GrenadeBody,
  dt: number,
  aabbs: readonly TraceAabb[],
  capsules: readonly TraceCapsule[],
): GrenadeStep {
  const next: GrenadeBody = { ...body, age: body.age + dt };
  if (!(dt > 0)) return { kind: "fly", body: next };
  next.vy -= GRENADE_GRAVITY * dt;
  const from = { x: body.x, y: body.y, z: body.z };
  const to = {
    x: body.x + next.vx * dt,
    y: body.y + next.vy * dt,
    z: body.z + next.vz * dt,
  };
  const hit = sweepSegment(from, to, aabbs, capsules);
  if (!hit) {
    next.x = to.x;
    next.y = to.y;
    next.z = to.z;
    if (next.age > GRENADE_LIFE_S) {
      return {
        kind: "stop",
        body: next,
        hit: { point: { x: next.x, y: next.y, z: next.z }, normal: { x: 0, y: 1, z: 0 }, pawn: false },
      };
    }
    return { kind: "fly", body: next };
  }
  const contact: GrenadeHit = { point: hit.point, normal: hit.normal, pawn: hit.pawn };
  if (hit.id !== undefined) contact.id = hit.id;
  if (hit.pawn || body.bounced) {
    next.x = hit.point.x;
    next.y = hit.point.y;
    next.z = hit.point.z;
    next.vx = 0;
    next.vy = 0;
    next.vz = 0;
    return { kind: "stop", body: next, hit: contact };
  }
  const reflected = bounceVelocity({ x: next.vx, y: next.vy, z: next.vz }, hit.normal, GRENADE_RESTITUTION);
  next.vx = reflected.x;
  next.vy = reflected.y;
  next.vz = reflected.z;
  next.bounced = true;
  next.x = hit.point.x + hit.normal.x * GRENADE_SKIN;
  next.y = hit.point.y + hit.normal.y * GRENADE_SKIN;
  next.z = hit.point.z + hit.normal.z * GRENADE_SKIN;
  return { kind: "bounce", body: next, hit: contact };
}

/** `normal` points toward the incoming side, so `dot(velocity, normal)` is negative. */
export function bounceVelocity(velocity: Vec3, normal: Vec3, restitution: number): Vec3 {
  const vn = velocity.x * normal.x + velocity.y * normal.y + velocity.z * normal.z;
  if (!(vn < 0)) return { x: velocity.x, y: velocity.y, z: velocity.z };
  const scale = (1 + restitution) * vn;
  return {
    x: velocity.x - scale * normal.x,
    y: velocity.y - scale * normal.y,
    z: velocity.z - scale * normal.z,
  };
}

function unit(dir: Vec3): Vec3 {
  const len = Math.hypot(dir.x, dir.y, dir.z);
  if (len < 1e-8) return { x: 0, y: 0, z: 1 };
  return { x: dir.x / len, y: dir.y / len, z: dir.z / len };
}
