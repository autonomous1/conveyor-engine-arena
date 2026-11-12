import assert from "node:assert/strict";
import test from "node:test";
import { createDoorBlockers } from "../src/server/doors.ts";
import { loadArena } from "../src/server/world-loader.ts";
import { doorLeafBox } from "../src/shared/doors.ts";
import {
  createRayBoxList,
  hasLineOfSight,
  losGate,
  TRACE_RANGE,
  traceHitscan,
  traceIndexed,
  type TraceAabb,
  type TraceCapsule,
  type Vec3,
} from "../src/shared/hitscan.ts";
import { aimDirection, EYE_HEIGHT } from "../src/shared/look.ts";
import { floorIndexFor, markDynamicObstacle, type FloorBox } from "../src/shared/movements.ts";

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function assertSame(
  origin: Vec3,
  dir: Vec3,
  boxes: readonly TraceAabb[],
  capsules: readonly TraceCapsule[],
  label: string,
  range?: number,
): void {
  const brute = range === undefined
    ? traceHitscan(origin, dir, boxes, capsules)
    : traceHitscan(origin, dir, boxes, capsules, range);
  const indexed = range === undefined
    ? traceIndexed(origin, dir, boxes, capsules)
    : traceIndexed(origin, dir, boxes, capsules, range);
  assert.equal(indexed.hitId, brute.hitId, `${label} hitId indexed ${indexed.hitId} brute ${brute.hitId}`);
  assert.ok(
    Math.abs(indexed.distance - brute.distance) <= 1e-9,
    `${label} distance indexed ${indexed.distance} brute ${brute.distance}`,
  );
}

test("traceIndexed matches traceHitscan on synthetic boxes", () => {
  const wall: TraceAabb = { id: 1, minX: -1, maxX: 1, minY: 0, maxY: 3, minZ: 4, maxZ: 5 };
  const cap: TraceCapsule = { id: 2, x: 0, y: 0, z: 8, radius: 0.5, height: 1.8 };
  const origin = { x: 0, y: 1, z: 0 };
  const dir = { x: 0, y: 0, z: 1 };
  assertSame(origin, dir, [wall], [cap], "box before capsule");
  assertSame(origin, dir, [wall], [{ ...cap, z: 2 }], "capsule before box");

  const tied: TraceAabb[] = [
    { id: 1, minX: 2, maxX: 3, minY: 0, maxY: 2, minZ: -1, maxZ: 1 },
    { id: 2, minX: 2, maxX: 3, minY: 0, maxY: 2, minZ: -1, maxZ: 1 },
  ];
  markDynamicObstacle(tied[1]!);
  assertSame({ x: 0, y: 1, z: 0 }, { x: 1, y: 0, z: 0 }, tied, [], "equal distance keeps the earlier box");
  assert.equal(traceIndexed({ x: 0, y: 1, z: 0 }, { x: 1, y: 0, z: 0 }, tied, []).hitId, 1);

  const unbanded: TraceAabb = { id: 7, minX: 0, maxX: 1, minZ: 0, maxZ: 1 };
  assertSame({ x: -2, y: 5, z: 0.5 }, { x: 1, y: 0, z: 0 }, [unbanded], [], "box with no height band");

  const stacked: TraceAabb = { id: 8, minX: 0, maxX: 1, minY: 2, maxY: 4, minZ: 0, maxZ: 1 };
  assertSame({ x: 0.5, y: 0, z: 0.5 }, { x: 0, y: 1, z: 0 }, [stacked], [], "vertical ray");
  assertSame({ x: 0.5, y: 6, z: 0.5 }, { x: 0, y: -1, z: 0 }, [stacked], [], "straight down");

  const grid: TraceAabb[] = [];
  for (let x = 0; x < 8; x++) {
    for (let z = 0; z < 8; z++) {
      grid.push({
        id: x * 8 + z + 1,
        minX: x * 4,
        maxX: x * 4 + 1,
        minY: 0,
        maxY: 2,
        minZ: z * 4,
        maxZ: z * 4 + 1,
      });
    }
  }
  const rand = rng(7);
  for (let i = 0; i < 200; i++) {
    const origin = { x: -2 + rand() * 36, y: 0.2 + rand() * 3, z: -2 + rand() * 36 };
    const dir = aimDirection(rand() * Math.PI * 2, (rand() * 2 - 1) * 0.4);
    assertSame(origin, dir, grid, [], `grid ${i}`);
  }

  const far: TraceAabb = { id: 90, minX: -1e6, maxX: -1e6 + 1, minY: 0, maxY: 2, minZ: 0, maxZ: 1 };
  const near: TraceAabb = { id: 91, minX: 0, maxX: 1, minY: 0, maxY: 2, minZ: 0, maxZ: 1 };
  assertSame({ x: -1, y: 1, z: 0.5 }, { x: 1, y: 0, z: 0 }, [near, far], [], "parked box stays on the always list");

  const huge: TraceAabb = { id: 92, minX: -400, maxX: 400, minY: 10, maxY: 12, minZ: -400, maxZ: 400 };
  assertSame({ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, [huge, near], [], "oversized box");

  const face: TraceAabb = { id: 93, minX: 1, maxX: 2, minY: 0, maxY: 2, minZ: -1, maxZ: 1 };
  assertSame({ x: 2, y: 1, z: 0 }, { x: -1, y: 0, z: 0 }, [face], [], "origin on the face, inward");
  assertSame({ x: 2, y: 1, z: 0 }, { x: 1, y: 0, z: 0 }, [face], [], "origin on the face, outward");

  assertSame({ x: 0, y: 1, z: 0 }, dir, [wall], [], "short range", 2);
  const miss = traceIndexed({ x: 0, y: 40, z: 0 }, { x: 0, y: 1, z: 0 }, [], []);
  assert.equal(miss.hitId, undefined);
  assert.equal(miss.distance, TRACE_RANGE);
});

test("ray box list keeps the floor index until the obstacles change", () => {
  const boxes = createRayBoxList();
  const base: TraceAabb[] = [
    { id: 1, minX: 0, maxX: 1, minY: 0, maxY: 3, minZ: -1, maxZ: 1 },
  ];
  const leaf: TraceAabb = { id: -1, minX: 4, maxX: 4.2, minY: 0, maxY: 2, minZ: -0.5, maxZ: 0.5 };
  const first = boxes(base, [leaf]);
  const index = floorIndexFor(first);
  const raised = boxes(base, [{ ...leaf, minY: 10, maxY: 12 }]);
  assert.equal(raised, first);
  assert.equal(raised[1]?.minY, 10);
  assert.equal(floorIndexFor(raised), index, "a height rewrite does not rebuild");
  assert.equal(traceIndexed({ x: 2, y: 11, z: 0 }, { x: 1, y: 0, z: 0 }, raised, []).hitId, -1);
  assert.notEqual(traceIndexed({ x: 2, y: 1, z: 0 }, { x: 1, y: 0, z: 0 }, raised, []).hitId, -1);

  const moved = boxes(base, [{ ...leaf, minX: 8, maxX: 8.2 }]);
  assert.notEqual(moved, first);
  assert.notEqual(floorIndexFor(moved), index, "an XZ change rebuilds");

  const open = boxes(base, []);
  assert.notEqual(open, moved);
  assert.equal(open.length, base.length);

  base.push({ id: 2, minX: -3, maxX: -2, minY: 0, maxY: 1, minZ: 0, maxZ: 1 });
  const longer = boxes(base, [leaf]);
  assert.notEqual(longer, open);
  assert.equal(longer.length, 3);
  assert.notEqual(floorIndexFor(longer), floorIndexFor(open), "a longer obstacle list rebuilds");
});

test("line of sight ignores capsules and stops on a wall", () => {
  const wall: TraceAabb = { id: 1, minX: -1, maxX: 1, minY: 0, maxY: 3, minZ: -0.2, maxZ: 0.2 };
  const from = { x: 0, y: 1.5, z: -2 };
  const beyond = { x: 0, y: 1.5, z: 2 };
  assert.equal(hasLineOfSight(from, beyond, [wall]), false);
  assert.equal(hasLineOfSight(from, { x: 0, y: 1.5, z: -0.4 }, [wall]), true);
  assert.equal(hasLineOfSight(from, from, [wall]), true);

  const cap: TraceCapsule = { id: 4, x: 0, y: 0, z: 0, radius: 0.5, height: 1.8 };
  const eye = { x: 0, y: 1, z: -3 };
  const chest = { x: 0, y: 1, z: 3 };
  assert.equal(traceHitscan(eye, { x: 0, y: 0, z: 1 }, [], [cap]).hitId, 4);
  assert.equal(hasLineOfSight(eye, chest, []), true);

  let now = 1_000;
  const gate = losGate(5, () => now);
  assert.equal(gate(), true);
  assert.equal(gate(), false);
  now = 1_199;
  assert.equal(gate(), false);
  now = 1_200;
  assert.equal(gate(), true);
  const other = losGate(5, () => now);
  assert.equal(other(), true);
});

type DoorLeaf = {
  id: string;
  open: boolean;
  position: [number, number, number];
  yaw: number;
  hinge: "left" | "right";
  size: [number, number, number];
};

function leafOf(door: { id: string; position: [number, number, number]; yaw: number; hinge: "left" | "right"; size: [number, number, number] }, open: boolean): DoorLeaf {
  return { id: door.id, open, position: door.position, yaw: door.yaw, hinge: door.hinge, size: door.size };
}

function aimAtLeaf(door: DoorLeaf): { from: Vec3; to: Vec3; dir: Vec3 } {
  const leaf = doorLeafBox(door);
  const cx = (leaf.minX + leaf.maxX) / 2;
  const cy = (leaf.minY + leaf.maxY) / 2;
  const cz = (leaf.minZ + leaf.maxZ) / 2;
  const spanX = Math.abs(leaf.maxX - leaf.minX);
  const spanZ = Math.abs(leaf.maxZ - leaf.minZ);
  if (spanX <= spanZ) {
    const near = Math.min(leaf.minX, leaf.maxX);
    const far = Math.max(leaf.minX, leaf.maxX);
    return { from: { x: near - 1, y: cy, z: cz }, to: { x: far + 0.4, y: cy, z: cz }, dir: { x: 1, y: 0, z: 0 } };
  }
  const near = Math.min(leaf.minZ, leaf.maxZ);
  const far = Math.max(leaf.minZ, leaf.maxZ);
  return { from: { x: cx, y: cy, z: near - 1 }, to: { x: cx, y: cy, z: far + 0.4 }, dir: { x: 0, y: 0, z: 1 } };
}

test("indexed rays match the brute scan on the arena, including doors and a lifted box", { timeout: 60_000 }, () => {
  const loaded = loadArena();
  const blockers = createDoorBlockers(loaded.world);
  const doors = loaded.view.doors;
  const initial = doors.map((door) => leafOf(door, door.locked === true ? false : door.open === true));
  for (let i = 0; i < initial.length; i++) blockers.sync({ ...initial[i]!, open: i % 2 === 0 });
  const boxes = loaded.world.listObstacles();
  assert.equal(loaded.world.listObstacles(), boxes);
  const regions = (loaded.regions?.places ?? [])
    .flatMap((place) => place.regions)
    .filter((region) => region.maxX > region.minX && region.maxZ > region.minZ);
  assert.ok(regions.length > 0, "arena has no walkable regions");
  const banded = boxes.filter((box) =>
    box.minY !== undefined && box.maxY !== undefined
    && Number.isFinite(box.minY) && Number.isFinite(box.maxY)
    && Math.abs(box.minX) < 1e5 && Math.abs(box.maxX) < 1e5
    && box.maxX !== box.minX && box.maxZ !== box.minZ,
  );
  assert.ok(banded.length > 0, "arena has no banded boxes");

  const rand = rng(48);
  const pitch = Math.PI / 6;
  const walk = (): Vec3 => {
    const region = regions[Math.floor(rand() * regions.length)]!;
    return {
      x: region.minX + rand() * (region.maxX - region.minX),
      y: region.y + EYE_HEIGHT,
      z: region.minZ + rand() * (region.maxZ - region.minZ),
    };
  };
  const onFace = (): { origin: Vec3; dir: Vec3 } => {
    const box = banded[Math.floor(rand() * banded.length)]!;
    const minY = box.minY ?? 0;
    const maxY = box.maxY ?? 0;
    const face = Math.floor(rand() * 6);
    const u = rand();
    const v = rand();
    let origin: Vec3;
    if (face === 0) origin = { x: box.maxX, y: minY + (maxY - minY) * u, z: box.minZ + (box.maxZ - box.minZ) * v };
    else if (face === 1) origin = { x: box.minX, y: minY + (maxY - minY) * u, z: box.minZ + (box.maxZ - box.minZ) * v };
    else if (face === 2) origin = { x: box.minX + (box.maxX - box.minX) * u, y: maxY, z: box.minZ + (box.maxZ - box.minZ) * v };
    else if (face === 3) origin = { x: box.minX + (box.maxX - box.minX) * u, y: minY, z: box.minZ + (box.maxZ - box.minZ) * v };
    else if (face === 4) origin = { x: box.minX + (box.maxX - box.minX) * u, y: minY + (maxY - minY) * v, z: box.maxZ };
    else origin = { x: box.minX + (box.maxX - box.minX) * u, y: minY + (maxY - minY) * v, z: box.minZ };
    return { origin, dir: aimDirection(rand() * Math.PI * 2, (rand() * 2 - 1) * pitch) };
  };

  for (let i = 0; i < 5_000; i++) {
    let origin: Vec3;
    let dir: Vec3;
    if (i < 100) {
      origin = walk();
      dir = { x: 0, y: 1, z: 0 };
    } else if (i < 200) {
      origin = walk();
      dir = { x: 0, y: -1, z: 0 };
    } else if (i < 600) {
      origin = walk();
      dir = aimDirection((i % 4) * (Math.PI / 2), 0);
    } else if (i < 1_100) {
      const face = onFace();
      origin = face.origin;
      dir = face.dir;
    } else {
      origin = walk();
      dir = aimDirection(rand() * Math.PI * 2, (rand() * 2 - 1) * pitch);
    }
    assertSame(origin, dir, boxes, [], `ray ${i}`);
  }

  let toggled = false;
  for (const door of initial) {
    const aim = aimAtLeaf(door);
    const id = blockers.obstacleId(door.id);
    blockers.sync({ ...door, open: false });
    const shut = traceIndexed(aim.from, aim.dir, boxes, []);
    if (shut.hitId !== id) {
      blockers.sync(door);
      continue;
    }
    const index = floorIndexFor(boxes as readonly FloorBox[]);
    try {
      assertSame(aim.from, aim.dir, boxes, [], `${door.id} shut`);
      assert.equal(hasLineOfSight(aim.from, aim.to, boxes), false, `${door.id} shut blocks`);
      blockers.sync({ ...door, open: true });
      assert.equal(floorIndexFor(boxes as readonly FloorBox[]), index, "opening a leaf does not rebuild");
      const open = traceIndexed(aim.from, aim.dir, boxes, []);
      assert.notEqual(open.hitId, id, `${door.id} open still hits the leaf`);
      assert.ok(open.distance > shut.distance - 1e-9, `${door.id} open is not farther`);
      assertSame(aim.from, aim.dir, boxes, [], `${door.id} open`);
      assert.equal(hasLineOfSight(aim.from, aim.to, boxes), true, `${door.id} open doorway`);
      blockers.sync({ ...door, open: false });
      const again = traceIndexed(aim.from, aim.dir, boxes, []);
      assert.equal(again.hitId, shut.hitId);
      assert.ok(Math.abs(again.distance - shut.distance) <= 1e-9);
      assert.equal(floorIndexFor(boxes as readonly FloorBox[]), index, "shutting a leaf does not rebuild");
      toggled = true;
      break;
    } finally {
      blockers.sync(door);
    }
  }
  assert.equal(toggled, true, "no shut leaf was the first hit along its face normal");

  const doorIds = new Set(initial.map((door) => blockers.obstacleId(door.id)));
  let lifted = false;
  for (const box of banded) {
    if (box.id === undefined || doorIds.has(box.id)) continue;
    const height = Math.abs((box.maxY ?? 0) - (box.minY ?? 0));
    const width = Math.abs(box.maxX - box.minX);
    const depth = Math.abs(box.maxZ - box.minZ);
    if (height < 0.2 || height > 4 || width < 0.2 || width > 6 || depth < 0.2 || depth > 6) continue;
    const savedY = box.minY!;
    const savedTop = box.maxY!;
    const index = floorIndexFor(boxes as readonly FloorBox[]);
    box.minY = savedY + 30;
    box.maxY = savedTop + 30;
    try {
      assert.equal(floorIndexFor(boxes as readonly FloorBox[]), index, "a Y rewrite does not rebuild");
      const midY = (box.minY + box.maxY) / 2;
      const midZ = (Math.min(box.minZ, box.maxZ) + Math.max(box.minZ, box.maxZ)) / 2;
      const faceX = Math.max(box.minX, box.maxX);
      const origin = { x: faceX + 0.75, y: midY, z: midZ };
      const shot = traceHitscan(origin, { x: -1, y: 0, z: 0 }, boxes, []);
      if (shot.hitId !== box.id || Math.abs(shot.distance - 0.75) > 1e-6) continue;
      assertSame(origin, { x: -1, y: 0, z: 0 }, boxes, [], "lifted box");
      const low = traceIndexed({ x: origin.x, y: (savedY + savedTop) / 2, z: origin.z }, { x: -1, y: 0, z: 0 }, boxes, []);
      assert.notEqual(low.hitId, box.id, "the old height misses the lifted box");
      lifted = true;
      break;
    } finally {
      box.minY = savedY;
      box.maxY = savedTop;
    }
  }
  assert.equal(lifted, true, "no box could be lifted and hit at its new height");
});
