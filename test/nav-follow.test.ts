import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { doorUseVolume, pickDoorForUse, type DoorRuntime } from "../dist/shared/doors.js";
import { MOVE_DT, MOVE_SPEED, approachVelocity, wishPlanar } from "../dist/shared/movements.js";
import { buildGrid, findLocalPath, type Grid } from "../dist/shared/nav/grid.js";
import { createFollower, doorStand, wishTo, type FollowInput, type FollowPawn, type Pose } from "../dist/shared/nav/follow.js";
import { capsuleOverlapsAabb } from "../dist/shared/pickups.js";

const root = path.join(import.meta.dirname, "..");
const ROOM_DOOR = "brutalist-building-2-cbake.room-a-1-5-8-6-2.door-1-1-9-22-5";
const PAWN_RADIUS = 0.5;
const PAWN_HEIGHT = 1.8;

type Box = { minX: number; maxX: number; minZ: number; maxZ: number; minY?: number; maxY?: number };

function gridOf(
  area: { minX: number; maxX: number; minZ: number; maxZ: number },
  boxes: readonly Box[] = [],
  radius = PAWN_RADIUS,
): Grid {
  return buildGrid(area, boxes, { cell: 0.25, radius, height: PAWN_HEIGHT, baseY: 0 });
}

function lengthOf(path: ReadonlyArray<readonly [number, number, number]>): number {
  let total = 0;
  for (let i = 1; i < path.length; i += 1) {
    const a = path[i - 1]!;
    const b = path[i]!;
    total += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  }
  return total;
}

/** Host tick, plus a blocked cell rejecting the step the way a wall stops the pawn. */
function integrate(pose: Pose, input: FollowInput, grid: Grid): void {
  const wish = wishPlanar(input.moveX, input.moveZ);
  const vel = approachVelocity({ x: pose.vx, z: pose.vz }, wish);
  let nx = pose.x + vel.x * MOVE_DT;
  let nz = pose.z + vel.z * MOVE_DT;
  const i = Math.floor((nx - grid.minX) / grid.cell);
  const j = Math.floor((nz - grid.minZ) / grid.cell);
  const bad = i < 0 || j < 0 || i >= grid.w || j >= grid.h || grid.blocked[j * grid.w + i] !== 0;
  if (bad) {
    nx = pose.x;
    nz = pose.z;
    vel.x = 0;
    vel.z = 0;
  }
  const fi = Math.floor((nx - grid.minX) / grid.cell);
  const fj = Math.floor((nz - grid.minZ) / grid.cell);
  if (fi >= 0 && fj >= 0 && fi < grid.w && fj < grid.h) pose.y = grid.floor[fj * grid.w + fi] ?? pose.y;
  pose.x = nx;
  pose.z = nz;
  pose.vx = vel.x;
  pose.vz = vel.z;
  pose.yaw = input.yaw;
}

function poseAt(x: number, z: number, y = 0): Pose {
  return { x, y, z, vx: 0, vz: 0, yaw: 0 };
}

test("wishTo faces world +Z when the target is straight ahead", () => {
  const wish = wishTo(poseAt(0, 0), { x: 0, z: 4 }, 1);
  assert.ok(Math.abs(wish.yaw) < 1e-9);
  assert.ok(Math.abs(wish.moveX) < 1e-9);
  assert.ok(wish.moveZ > 0.99);
});

test("an L path arrives inside the time budget and stops short of 0.3 m", () => {
  const path: Array<[number, number, number]> = [[0.5, 0, 0.5], [8, 0, 0.5], [8, 0, 8]];
  const grid = gridOf({ minX: -1, maxX: 10, minZ: -1, maxZ: 10 });
  const limit = Math.ceil((1.2 * (lengthOf(path) / MOVE_SPEED) + 1) / MOVE_DT);
  const pose = poseAt(0.5, 0.5);
  const follower = createFollower(path, grid, { radius: PAWN_RADIUS });
  let status = "running";
  let tick = 0;
  for (; tick < limit; tick += 1) {
    const step = follower.step(pose, [], tick);
    status = step.status;
    if (status !== "running") break;
    integrate(pose, step.input, grid);
  }
  assert.equal(status, "arrived");
  assert.ok(tick < limit, `arrived at tick ${tick}, budget ${limit}`);
  const overshoot = Math.hypot(pose.x - 8, pose.z - 8);
  assert.ok(overshoot < 0.3, `overshoot ${overshoot}`);
});

test("a static pawn on the path is passed with body clearance", () => {
  const grid = gridOf({ minX: -2, maxX: 12, minZ: -2, maxZ: 4 });
  const pawn: FollowPawn = { x: 5, z: 1, radius: PAWN_RADIUS };
  const pose = poseAt(0, 1);
  const follower = createFollower([[0, 0, 1], [10, 0, 1]], grid, { radius: PAWN_RADIUS });
  let status = "running";
  let closest = Infinity;
  for (let tick = 0; tick < 400 && status === "running"; tick += 1) {
    closest = Math.min(closest, Math.hypot(pose.x - pawn.x, pose.z - pawn.z));
    const step = follower.step(pose, [pawn], tick);
    status = step.status;
    if (status !== "running") break;
    integrate(pose, step.input, grid);
  }
  assert.equal(status, "arrived");
  assert.ok(closest >= PAWN_RADIUS + pawn.radius, `clearance ${closest}`);
});

test("a blocked cell on the right passes the pawn on the left", () => {
  const wall: Box = { minX: -1.7, maxX: -0.9, minZ: -1, maxZ: 12, minY: 0, maxY: 2 };
  const grid = gridOf({ minX: -3, maxX: 4, minZ: -1, maxZ: 12 }, [wall]);
  const pawn: FollowPawn = { x: 0, z: 5, radius: PAWN_RADIUS };
  const pose = poseAt(0, 0);
  const follower = createFollower([[0, 0, 0], [0, 0, 10]], grid, { radius: PAWN_RADIUS });
  let status = "running";
  let closest = Infinity;
  let passX = 0;
  for (let tick = 0; tick < 400 && status === "running"; tick += 1) {
    const apart = Math.hypot(pose.x - pawn.x, pose.z - pawn.z);
    if (apart < closest) {
      closest = apart;
      passX = pose.x;
    }
    const step = follower.step(pose, [pawn], tick);
    status = step.status;
    if (status !== "running") break;
    integrate(pose, step.input, grid);
  }
  assert.equal(status, "arrived");
  assert.ok(closest >= PAWN_RADIUS + pawn.radius, `clearance ${closest}`);
  assert.ok(passX > 0.2, `passed at x ${passX}`);
});

test("a wall straight ahead reports stuck between 40 and 60 ticks", () => {
  const area = { minX: 0, maxX: 8, minZ: 0, maxZ: 2 };
  const wall: Box = { minX: 3, maxX: 3.25, minZ: -1, maxZ: 3, minY: 0, maxY: 2 };
  const grid = gridOf(area, [wall]);
  const pose = poseAt(0.4, 1);
  const follower = createFollower([[0.4, 0, 1], [7, 0, 1]], grid, { radius: PAWN_RADIUS });
  let status = "running";
  let tick = 0;
  for (; tick < 80 && status === "running"; tick += 1) {
    const step = follower.step(pose, [], tick);
    status = step.status;
    if (status !== "running") break;
    integrate(pose, step.input, grid);
  }
  assert.equal(status, "stuck");
  assert.ok(tick >= 40 && tick <= 60, `stuck at tick ${tick}, pose ${pose.x}, ${pose.z}`);
});

test("two bots crossing head-on both arrive on their right", () => {
  const grid = gridOf({ minX: -4, maxX: 4, minZ: -1, maxZ: 13 });
  const a = poseAt(0, 0);
  const b = poseAt(0, 12);
  b.yaw = Math.PI;
  const followA = createFollower([[0, 0, 0], [0, 0, 12]], grid, { radius: PAWN_RADIUS });
  const followB = createFollower([[0, 0, 12], [0, 0, 0]], grid, { radius: PAWN_RADIUS });
  let statusA = "running";
  let statusB = "running";
  let closest = Infinity;
  let ax = 0;
  let bx = 0;
  for (let tick = 0; tick < 500 && (statusA === "running" || statusB === "running"); tick += 1) {
    const apart = Math.hypot(a.x - b.x, a.z - b.z);
    if (apart < closest) {
      closest = apart;
      ax = a.x;
      bx = b.x;
    }
    const otherA: FollowPawn = { x: b.x, z: b.z, radius: PAWN_RADIUS };
    const otherB: FollowPawn = { x: a.x, z: a.z, radius: PAWN_RADIUS };
    if (statusA === "running") {
      const step = followA.step(a, [otherA], tick);
      statusA = step.status;
      if (statusA === "running") integrate(a, step.input, grid);
    }
    if (statusB === "running") {
      const step = followB.step(b, [otherB], tick);
      statusB = step.status;
      if (statusB === "running") integrate(b, step.input, grid);
    }
  }
  assert.equal(statusA, "arrived");
  assert.equal(statusB, "arrived");
  assert.ok(closest >= PAWN_RADIUS * 2, `clearance ${closest}`);
  assert.ok(ax < bx, `pass sides ${ax}, ${bx}`);
});

test("a step stack from the grid fixture is climbed without a stuck report", () => {
  const steps: Box[] = [];
  for (let i = 0; i < 11; i += 1) {
    const top = 0.25 * (i + 1);
    steps.push({ minX: i * 0.4, maxX: (i + 1) * 0.4, minZ: 0, maxZ: 1.5, minY: top - 0.25, maxY: top });
  }
  const grid = gridOf({ minX: -1, maxX: 5, minZ: -0.25, maxZ: 1.75 }, steps, 0.3);
  const path = findLocalPath(grid, { x: -0.5, z: 0.75 }, { x: 4.2, z: 0.75 });
  assert.ok(path);
  const goal = path[path.length - 1]!;
  const pose = poseAt(path[0]![0], path[0]![2], path[0]![1]);
  const follower = createFollower(path, grid, { radius: 0.3 });
  let status = "running";
  for (let tick = 0; tick < 400 && status === "running"; tick += 1) {
    const step = follower.step(pose, [], tick);
    status = step.status;
    if (status !== "running") break;
    integrate(pose, step.input, grid);
  }
  assert.equal(status, "arrived");
  assert.ok(Math.abs(pose.y - goal[1]) < 0.05, `feet at ${pose.y}, step top ${goal[1]}`);
});

test("doorStand for a room door overlaps that door's use volume", () => {
  const file = JSON.parse(readFileSync(path.join(root, "web/game/rooms.placements.json"), "utf8")) as {
    placements: Array<{
      id?: string;
      hinge?: "left" | "right";
      position?: [number, number, number];
      yaw?: number;
      size?: [number, number, number];
      open?: boolean;
      locked?: boolean;
      key?: string;
    }>;
  };
  const doors: DoorRuntime[] = [];
  for (const item of file.placements) {
    if ((item.hinge !== "left" && item.hinge !== "right") || !item.id || !item.position || !item.size || item.yaw === undefined) {
      continue;
    }
    doors.push({
      id: item.id,
      hinge: item.hinge,
      open: item.open === true,
      locked: item.locked === true,
      ...(item.key ? { key: item.key } : {}),
      position: item.position,
      size: item.size,
      yaw: item.yaw,
    });
  }
  const door = doors.find((item) => item.id === ROOM_DOOR);
  assert.ok(door);
  for (const side of ["out", "in"] as const) {
    const stand = doorStand(door, side);
    const volume = doorUseVolume(door);
    assert.equal(
      capsuleOverlapsAabb(stand.x, stand.y, stand.z, PAWN_RADIUS, PAWN_HEIGHT, volume),
      true,
      side,
    );
    const picked = pickDoorForUse(doors, {
      id: 1,
      x: stand.x,
      y: stand.y,
      z: stand.z,
      radius: PAWN_RADIUS,
      height: PAWN_HEIGHT,
      alive: true,
    });
    assert.equal(picked?.id, ROOM_DOOR, side);
  }
});
