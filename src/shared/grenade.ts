/**
 * Thrown grenade. The host owns the point, the velocity, and gravity.
 * A client draws the replicated point and does not integrate it.
 * The segment test is the hitscan sweep: the same AABBs and pawn capsules.
 * Grenades do not collide with each other. There is no second dynamic body.
 */

import { MAX_HP } from "./health.js";
import { sweepSegment, type SweepHit, type TraceAabb, type TraceCapsule, type Vec3 } from "./hitscan.js";

export const GRENADE_INTERVAL_MS = 1000;
/** Finite toss. A hitscan ray crosses its range in one trace, so this is slower. */
export const GRENADE_SPEED = 24;
/** Direct pawn hit. Half of {@link MAX_HP}, because a grenade is harder to land than a laser. */
export const GRENADE_DAMAGE = MAX_HP / 2;
/** Meters per second squared, subtracted from velocity Y once per host tick. */
export const GRENADE_GRAVITY = 9.81;
/** Scales the velocity into the surface. Below 1, so a bounce loses speed. */
export const GRENADE_RESTITUTION = 0.5;
/** Push off the face after a bounce so the next segment does not re-enter it. */
export const GRENADE_SKIN = 0.01;
/** Back off the blast along incoming velocity so the sprite is not inside the wall. */
export const GRENADE_IMPACT_STANDOFF = 0.08;
/** Owner capsules are ignored until this age, so a launch can leave the shooter's body. */
export const GRENADE_ARMING_S = 0.1;
/** A miss that never meets a volume is removed after this many seconds. */
export const GRENADE_LIFE_S = 4;

/** `"explode"` detonates on first contact. `"bounce"` is the toss: one bounce, then a stop. */
export type GrenadeImpact = "explode" | "bounce";

export function parseGrenadeImpact(value: unknown): GrenadeImpact | undefined {
  return value === "explode" || value === "bounce" ? value : undefined;
}

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

/** Unit axis of a stop surface: one of ±X, ±Y, or ±Z. */
export type GrenadeSurfaceNormal = [number, number, number];

/**
 * Replicated point. `yaw` is the launch yaw, in radians, and does not change
 * when gravity or a bounce bends the velocity. `stop` is the final hit: the
 * client shows it, then removes the mesh. `n` is the snapped surface axis on a
 * box or floor stop only; absent means an air burst (pawn, timeout, or an old
 * host). Old clients ignore `n`.
 */
export type GrenadePose = {
  t: "grenade";
  id: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  stop?: true;
  n?: GrenadeSurfaceNormal;
};

/** Snap a hit normal to the dominant unit axis. Zero or non-finite yields undefined. */
export function snapSurfaceNormal(normal: Vec3): Vec3 | undefined {
  const ax = Math.abs(normal.x);
  const ay = Math.abs(normal.y);
  const az = Math.abs(normal.z);
  if (!Number.isFinite(ax) || !Number.isFinite(ay) || !Number.isFinite(az)) return undefined;
  if (ay >= ax && ay >= az && ay > 0) return { x: 0, y: normal.y < 0 ? -1 : 1, z: 0 };
  if (ax >= az && ax > 0) return { x: normal.x < 0 ? -1 : 1, y: 0, z: 0 };
  if (az > 0) return { x: 0, y: 0, z: normal.z < 0 ? -1 : 1 };
  return undefined;
}

/** Wire `n` on a stop pose: a 3-number axis, snapped. Invalid values are dropped. */
export function parseGrenadeSurfaceNormal(value: unknown): GrenadeSurfaceNormal | undefined {
  if (!Array.isArray(value) || value.length !== 3) return undefined;
  const x = value[0];
  const y = value[1];
  const z = value[2];
  if (typeof x !== "number" || typeof y !== "number" || typeof z !== "number") return undefined;
  const snapped = snapSurfaceNormal({ x, y, z });
  if (!snapped) return undefined;
  return [snapped.x, snapped.y, snapped.z];
}

/** Surface axis for a stop pose. Pawn hits and lifetime timeouts have none. */
export function stopSurfaceNormal(hit: GrenadeHit): Vec3 | undefined {
  if (hit.pawn || hit.surface !== true) return undefined;
  return snapSurfaceNormal(hit.normal);
}

export function grenadePose(id: number, point: Vec3, yaw: number, stop = false, normal?: Vec3): GrenadePose {
  const pose: GrenadePose = { t: "grenade", id, x: point.x, y: point.y, z: point.z, yaw };
  if (stop) {
    pose.stop = true;
    const snapped = normal ? snapSurfaceNormal(normal) : undefined;
    if (snapped) pose.n = [snapped.x, snapped.y, snapped.z];
  }
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
  if (rec.stop === true) {
    pose.stop = true;
    const n = parseGrenadeSurfaceNormal(rec.n);
    if (n) pose.n = n;
  }
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
  /** First-contact mode. Default on {@link launchGrenade} is the toss. */
  impact: GrenadeImpact;
};

export type GrenadeHit = {
  point: Vec3;
  normal: Vec3;
  id?: number;
  pawn: boolean;
  /** Box or ground-plane contact. Absent on a pawn hit or a lifetime timeout. */
  surface?: true;
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
  impact: GrenadeImpact = "bounce",
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
    impact,
  };
}

/**
 * One tick. Gravity is added on Y, then the segment is swept so a fast body
 * cannot tunnel through a thin box. `floorY` is the ground plane: the arena
 * floor is not a collision box (pawns stand on a height scan), so without it a
 * grenade falls through the floor and only stops on {@link GRENADE_LIFE_S}.
 *
 * `"bounce"` (toss): an obstacle bounces once, the next obstacle hit stops.
 * A pawn hit stops immediately. `"explode"` (launcher): the first box, floor,
 * or pawn contact stops, with no bounce. The owner is ignored until
 * {@link GRENADE_ARMING_S} so the launch can leave the shooter's capsule.
 * A pawn hit is marked so the caller can apply the existing damage.
 */
export function stepGrenade(
  body: GrenadeBody,
  dt: number,
  aabbs: readonly TraceAabb[],
  capsules: readonly TraceCapsule[],
  floorY?: number,
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
  const hit = closerFloorHit(from, to, sweepSegment(from, to, aabbs, capsulesFor(body, next.age, capsules)), floorY);
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
  const explode = body.impact === "explode";
  const point = explode
    ? standoffPoint(hit.point, { x: next.vx, y: next.vy, z: next.vz }, hit.normal)
    : hit.point;
  const contact: GrenadeHit = { point, normal: hit.normal, pawn: hit.pawn };
  if (hit.id !== undefined) contact.id = hit.id;
  if (!hit.pawn) contact.surface = true;
  if (hit.pawn || body.bounced || explode) {
    next.x = point.x;
    next.y = point.y;
    next.z = point.z;
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

/** The floor crossing when it comes before `hit` along the segment. */
function closerFloorHit(from: Vec3, to: Vec3, hit: SweepHit | undefined, floorY: number | undefined): SweepHit | undefined {
  if (floorY === undefined || !Number.isFinite(floorY)) return hit;
  if (!(from.y >= floorY && to.y < floorY)) return hit;
  const t = (from.y - floorY) / (from.y - to.y);
  const point = { x: from.x + (to.x - from.x) * t, y: floorY, z: from.z + (to.z - from.z) * t };
  const distance = Math.hypot(point.x - from.x, point.y - from.y, point.z - from.z);
  if (hit && hit.distance <= distance) return hit;
  return { distance, point, normal: { x: 0, y: 1, z: 0 }, pawn: false };
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

function capsulesFor(body: GrenadeBody, age: number, capsules: readonly TraceCapsule[]): readonly TraceCapsule[] {
  const allowOwner = body.impact === "explode" && age >= GRENADE_ARMING_S;
  if (allowOwner) return capsules;
  return capsules.filter((cap) => cap.id !== body.owner);
}

/** Move the blast back along incoming velocity, or along the face normal if speed is ~0. */
function standoffPoint(point: Vec3, velocity: Vec3, normal: Vec3): Vec3 {
  const speed = Math.hypot(velocity.x, velocity.y, velocity.z);
  if (speed > 1e-8) {
    const s = GRENADE_IMPACT_STANDOFF / speed;
    return {
      x: point.x - velocity.x * s,
      y: point.y - velocity.y * s,
      z: point.z - velocity.z * s,
    };
  }
  return {
    x: point.x + normal.x * GRENADE_IMPACT_STANDOFF,
    y: point.y + normal.y * GRENADE_IMPACT_STANDOFF,
    z: point.z + normal.z * GRENADE_IMPACT_STANDOFF,
  };
}

function unit(dir: Vec3): Vec3 {
  const len = Math.hypot(dir.x, dir.y, dir.z);
  if (len < 1e-8) return { x: 0, y: 0, z: 1 };
  return { x: dir.x / len, y: dir.y / len, z: dir.z / len };
}
