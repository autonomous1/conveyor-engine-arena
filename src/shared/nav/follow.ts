/**
 * Turns a world path into the input frame a player would send.
 * The host still runs `wishPlanar` and `approachVelocity`. This module
 * only chooses `moveX`, `moveZ` and `yaw`.
 */
// ARCHITECTURE: Turns a planned path into the per-tick input frame and the door
//   stands a bot presses.
// Wiring: server/game.ts's wander loop uses the follower; server/bot-brain.ts
//   plans door stands.
import {
  DOOR_GAP_DEPTH_M,
  DOOR_USE_OUTWARD_M,
  doorYawRadians,
  type DoorRuntime,
} from "../doors.js";
import { moveIntent } from "../look.js";
import type { Grid } from "./grid.js";

/** Switch to the next waypoint inside this XZ distance. */
const WAYPOINT_XZ = 0.5;
/** And only when the feet are this close in Y. A step riser is shorter. */
const WAYPOINT_Y = 0.6;
/** Pure-pursuit point, meters along the remaining path. */
const LOOKAHEAD = 1.2;
/** Slow to half inside this distance of a sharp corner. */
const TURN_DISTANCE = 1.5;
const TURN_ANGLE = (60 * Math.PI) / 180;
/** Half speed on a corner, and this fraction on the last metre. */
const TURN_SCALE = 0.5;
const GOAL_DISTANCE = 1;
const GOAL_SCALE = 0.35;
/** Declare the goal once the feet are inside this ball, so the stop is under 0.3 m. */
const ARRIVE_XZ = 0.2;
/**
 * Side push starts when the gap between the two bodies is under this.
 * Stopping from `MOVE_SPEED` uses up a 1.5 m center bubble, so the field is
 * measured from the capsules. Otherwise two 0.5 m pawns clip.
 */
const AVOID_GAP = 1.5;
/** Lateral part of the wish, as a fraction of the speed scale. */
const AVOID_CAP = 0.6;
/** Blocked-cell probe along the wish. */
const PROBE = 0.5;
/** Right-hand cell probe. A blocked cell flips the pass to the left. */
const SIDE_PROBE = 0.6;
/** Under this much closure in `STUCK_TICKS` the follower reports stuck. */
const STUCK_TICKS = 40;
const STUCK_PROGRESS = 0.25;
/** Stand this far outside `doorUseVolume`, on the bot's side of the leaf. */
const DOOR_STAND_M = 0.3;

export type Pose = { x: number; y: number; z: number; vx: number; vz: number; yaw: number };

export type FollowPawn = { x: number; z: number; radius: number };

export type FollowInput = { moveX: number; moveZ: number; yaw: number };

export type FollowStep = {
  input: FollowInput;
  status: "running" | "arrived" | "stuck";
};

export type FollowOptions = {
  /** Own capsule radius. Default is the arena pawn, 0.5 m. */
  radius?: number;
};

export type DoorSide = "in" | "out";

type Point = { x: number; y: number; z: number };

type PathPoint = readonly [number, number, number] | Point;

type Sample = { tick: number; dist: number };

/**
 * Wish toward `target`. Yaw 0 faces world +Z, the same frame `moveIntent` uses.
 * `scale` is the forward fraction the host multiplies by `MOVE_SPEED`.
 * @see moveIntent
 */
export function wishTo(pose: Pose, target: { x: number; z: number }, scale: number): FollowInput {
  const yaw = Math.atan2(target.x - pose.x, target.z - pose.z);
  const { moveX, moveZ } = moveIntent(yaw, scale, 0);
  return { moveX, moveZ, yaw };
}

/**
 * Point 0.3 m outside `doorUseVolume` on `side`, facing the opening.
 * @post `out` is local +Z (in front of the leaf); `in` is local −Z (through
 *       the gap). A pawn radius of 0.5 m at this point overlaps the volume, so
 *       `pickDoorForUse` can hit it.
 */
export function doorStand(
  door: Pick<DoorRuntime, "position" | "yaw" | "hinge" | "size">,
  side: DoorSide,
): { x: number; y: number; z: number; yaw: number } {
  const theta = doorYawRadians(door.yaw);
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const mid = door.hinge === "left" ? door.size[0] * 0.5 : -door.size[0] * 0.5;
  const localZ = side === "out" ? DOOR_USE_OUTWARD_M + DOOR_STAND_M : -DOOR_GAP_DEPTH_M - DOOR_STAND_M;
  const x = door.position[0] + mid * c + localZ * s;
  const z = door.position[2] - mid * s + localZ * c;
  const cx = door.position[0] + mid * c;
  const cz = door.position[2] - mid * s;
  return { x, y: door.position[1], z, yaw: Math.atan2(cx - x, cz - z) };
}

export function createFollower(pathIn: readonly PathPoint[], grid: Grid, opts: FollowOptions = {}): {
  step(pose: Pose, others: readonly FollowPawn[], tick: number): FollowStep;
} {
  const path = pathIn.map(asPoint);
  const radius = opts.radius !== undefined && opts.radius > 0 ? opts.radius : 0.5;
  let index = 0;
  let samples: Sample[] = [];
  let stuck = false;
  /** +1 passes on the right. Held until the pawn is behind, so a wall edge cannot flip it. */
  let passSign = 0;

  function step(pose: Pose, others: readonly FollowPawn[], tick: number): FollowStep {
    if (path.length === 0) return { input: hold(pose.yaw), status: "arrived" };
    const before = index;
    advance(pose);
    if (index !== before) samples = [];
    const goal = path[path.length - 1]!;
    if (index === path.length - 1 && xz(pose, goal) <= ARRIVE_XZ && Math.abs(pose.y - goal.y) < WAYPOINT_Y) {
      return { input: hold(pose.yaw), status: "arrived" };
    }

    const scale = remaining(pose) <= GOAL_DISTANCE ? GOAL_SCALE : sharpTurn(pose) ? TURN_SCALE : 1;
    const look = lookahead(pose);
    const yaw = Math.atan2(look.x - pose.x, look.z - pose.z);
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    const rx = -fz;
    const rz = fx;
    const rightBlocked = cellBlocked(grid, pose.x + rx * SIDE_PROBE + fx * 0.3, pose.z + rz * SIDE_PROBE + fz * 0.3);
    const steered = avoid(pose, others, scale, fx, fz, rx, rz, rightBlocked);
    const input = fitWish(pose, yaw, steered.forward, steered.strafe, rightBlocked);
    noteProgress(pose, tick);
    return { input, status: stuck ? "stuck" : "running" };
  }

  function advance(pose: Pose): void {
    while (index < path.length - 1) {
      const here = path[index]!;
      const close = xz(pose, here) <= WAYPOINT_XZ && Math.abs(pose.y - here.y) < WAYPOINT_Y;
      if (close || passed(pose)) index += 1;
      else break;
    }
  }

  /** Lookahead cuts a sharp corner outside the 0.5 m ball. The next segment then owns the pose. */
  function passed(pose: Pose): boolean {
    if (index >= path.length - 1) return false;
    const a = path[index]!;
    const b = path[index + 1]!;
    if (Math.abs(pose.y - a.y) >= WAYPOINT_Y && Math.abs(pose.y - b.y) >= WAYPOINT_Y) return false;
    const abx = b.x - a.x;
    const abz = b.z - a.z;
    const len2 = abx * abx + abz * abz;
    if (!(len2 > 1e-8)) return false;
    const t = ((pose.x - a.x) * abx + (pose.z - a.z) * abz) / len2;
    if (!(t > 0)) return false;
    const u = Math.min(t, 1);
    const lateral = Math.hypot(pose.x - (a.x + abx * u), pose.z - (a.z + abz * u));
    return lateral <= WAYPOINT_XZ;
  }

  function remaining(pose: Pose): number {
    let total = xz(pose, path[index]!);
    for (let i = index; i < path.length - 1; i += 1) total += xz(path[i]!, path[i + 1]!);
    return total;
  }

  function sharpTurn(pose: Pose): boolean {
    for (let i = Math.max(1, index); i < path.length - 1; i += 1) {
      const a = path[i - 1]!;
      const b = path[i]!;
      const c = path[i + 1]!;
      const incoming = xz(a, b);
      const outgoing = xz(b, c);
      if (incoming < 1e-6 || outgoing < 1e-6) continue;
      const dot = ((b.x - a.x) / incoming) * ((c.x - b.x) / outgoing) + ((b.z - a.z) / incoming) * ((c.z - b.z) / outgoing);
      const angle = Math.acos(Math.min(1, Math.max(-1, dot)));
      if (angle > TURN_ANGLE && xz(pose, b) <= TURN_DISTANCE) return true;
    }
    return false;
  }

  function lookahead(pose: Pose): { x: number; z: number } {
    let left = LOOKAHEAD;
    let prevX = pose.x;
    let prevZ = pose.z;
    for (let i = index; i < path.length; i += 1) {
      const next = path[i]!;
      const seg = Math.hypot(next.x - prevX, next.z - prevZ);
      if (seg >= left) {
        const t = seg > 0 ? left / seg : 0;
        return { x: prevX + (next.x - prevX) * t, z: prevZ + (next.z - prevZ) * t };
      }
      left -= seg;
      prevX = next.x;
      prevZ = next.z;
    }
    const goal = path[path.length - 1]!;
    return { x: goal.x, z: goal.z };
  }

  function avoid(
    pose: Pose,
    others: readonly FollowPawn[],
    scale: number,
    fx: number,
    fz: number,
    rx: number,
    rz: number,
    rightBlocked: boolean,
  ): { forward: number; strafe: number } {
    let nearest = Infinity;
    let pawn: { d: number; reach: number; along: number; lat: number; radius: number } | undefined;
    for (const other of others) {
      if (!(other.radius > 0) || !Number.isFinite(other.x) || !Number.isFinite(other.z)) continue;
      const dx = other.x - pose.x;
      const dz = other.z - pose.z;
      const d = Math.hypot(dx, dz);
      const reach = AVOID_GAP + radius + other.radius;
      if (!(d < reach) || !(d < nearest)) continue;
      nearest = d;
      pawn = {
        d,
        reach,
        along: dx * fx + dz * fz,
        lat: (pose.x - other.x) * rx + (pose.z - other.z) * rz,
        radius: other.radius,
      };
    }
    if (!pawn || !(pawn.along > -0.25)) {
      passSign = 0;
      return { forward: scale, strafe: 0 };
    }
    if (passSign === 0) passSign = rightBlocked ? -1 : 1;
    const sign = passSign;
    const need = radius + pawn.radius;
    const clear = sign > 0 ? pawn.lat >= need : pawn.lat <= -need;
    if (clear) return { forward: scale, strafe: 0 };
    const cap = AVOID_CAP * scale;
    const push = Math.min(cap, Math.max(0, pawn.reach - pawn.d));
    const taken = cap > 0 ? push / cap : 0;
    return { forward: scale * (1 - taken), strafe: sign * push };
  }

  function fitWish(pose: Pose, yaw: number, forward: number, strafe: number, rightBlocked: boolean): FollowInput {
    const command = (f: number, s: number): FollowInput => {
      const wish = moveIntent(yaw, f, s);
      return { moveX: wish.moveX, moveZ: wish.moveZ, yaw };
    };
    const blockedAhead = (candidate: FollowInput): boolean => {
      const mag = Math.hypot(candidate.moveX, candidate.moveZ);
      if (!(mag > 1e-4)) return false;
      return cellBlocked(grid, pose.x + (candidate.moveX / mag) * PROBE, pose.z + (candidate.moveZ / mag) * PROBE);
    };
    const input = command(forward, strafe);
    if (!blockedAhead(input)) return input;
    const away = strafe !== 0 ? -strafe : rightBlocked ? -AVOID_CAP : AVOID_CAP;
    const slide = command(Math.max(forward, 0.2), away);
    const straight = command(forward, 0);
    if (!blockedAhead(slide)) return slide;
    if (!blockedAhead(straight)) return straight;
    return command(0, 0);
  }

  function noteProgress(pose: Pose, tick: number): void {
    if (stuck) return;
    const dist = xz(pose, path[index]!);
    samples.push({ tick, dist });
    while (samples.length >= 2 && tick - samples[1]!.tick >= STUCK_TICKS) samples.shift();
    const anchor = samples[0]!;
    if (tick - anchor.tick >= STUCK_TICKS && anchor.dist - dist < STUCK_PROGRESS) stuck = true;
  }

  return { step };
}

function hold(yaw: number): FollowInput {
  return { moveX: 0, moveZ: 0, yaw };
}

function isPoint(point: PathPoint): point is Point {
  return !Array.isArray(point);
}

function asPoint(point: PathPoint): Point {
  if (!isPoint(point)) return { x: point[0], y: point[1], z: point[2] };
  return point;
}

function xz(a: { x: number; z: number }, b: { x: number; z: number }): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function cellBlocked(grid: Grid, x: number, z: number): boolean {
  if (!(grid.cell > 0) || grid.w <= 0 || grid.h <= 0) return true;
  const i = Math.floor((x - grid.minX) / grid.cell);
  const j = Math.floor((z - grid.minZ) / grid.cell);
  if (i < 0 || j < 0 || i >= grid.w || j >= grid.h) return true;
  return grid.blocked[j * grid.w + i] !== 0;
}

