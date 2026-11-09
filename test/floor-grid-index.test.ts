import assert from "node:assert/strict";
import test from "node:test";
import { createArenaDoors, createDoorBlockers } from "../dist/server/doors.js";
import { loadArena } from "../dist/server/world-loader.js";
import {
  buildFloorIndex,
  floorIndexFor,
  FLOOR_INDEX_PAD,
  floorAlongMove,
  floorAlongMoveIndexed,
  floorHeight,
  floorHeightIndexed,
  type FloorBox,
} from "../dist/shared/movements.js";
import { doorUseVolume, useFrame } from "../dist/shared/doors.js";
import type { PawnBody } from "../src/shared/pickups.ts";

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

/** Random probes, half of them hugging a box edge (stairs and steps included) so strict edges get hit. */
function probe(boxes: readonly FloorBox[], rand: () => number, n: number, label: string): void {
  const index = floorIndexFor(boxes);
  const banded = boxes.filter((b) => Number.isFinite(b.minY) && Number.isFinite(b.maxY) && Math.abs(b.minX) < 1e5);
  const tops = banded.map((b) => Math.max(b.minY!, b.maxY!));
  const radii = [0, 0.25, 0.35, 0.4, 0.5, FLOOR_INDEX_PAD, 1.4, -1, Number.NaN];
  const span = { x0: index.originX - 3, x1: index.originX + index.cols * 2 + 3, z0: index.originZ - 3, z1: index.originZ + index.rows * 2 + 3 };
  let mismatches = 0;
  for (let i = 0; i < n; i++) {
    const r = i % 5 === 0 ? radii[i % radii.length]! : rand() * 0.6;
    let x: number;
    let z: number;
    if (i % 2 === 0 && banded.length > 0) {
      const b = banded[Math.floor(rand() * banded.length)]!;
      const rr = r > 0 ? r : 0;
      const pick = (lo: number, hi: number) => {
        const e = [0, 1e-9, -1e-9, 1e-4, -1e-4][Math.floor(rand() * 5)]!;
        const u = rand();
        return u < 0.25 ? lo - rr + e : u < 0.5 ? hi + rr + e : lo + (hi - lo) * rand();
      };
      x = pick(Math.min(b.minX, b.maxX), Math.max(b.minX, b.maxX));
      z = pick(Math.min(b.minZ, b.maxZ), Math.max(b.minZ, b.maxZ));
    } else {
      x = span.x0 + (span.x1 - span.x0) * rand();
      z = span.z0 + (span.z1 - span.z0) * rand();
    }
    const feet = rand() < 0.6 ? tops[Math.floor(rand() * tops.length)]! - 0.3 + rand() * 0.6 : -0.5 + rand() * 12;
    const step = rand() < 0.8 ? undefined : rand() * 1.5;
    const want = floorHeight(boxes, x, z, r, feet, step);
    const got = floorHeightIndexed(index, x, z, r, feet, step);
    if (want !== got && mismatches++ < 5) assert.fail(`${label}: (${x}, ${z}) r=${r} feet=${feet} step=${step}: full ${want} indexed ${got}`);
  }
  assert.equal(mismatches, 0, label);
}

test("the static floor grid matches the full floorHeight scan on the installed arena", { timeout: 60_000 }, () => {
  const loaded = loadArena();
  const world = loaded.world;
  const boxes = world.listObstacles() as readonly FloorBox[];
  const built = buildFloorIndex(boxes);
  console.log(`[floor-index] ${boxes.length} boxes, ${built.cols}x${built.rows} cells, ${built.items.length} items, ${built.always.length} always, build ${built.buildMs.toFixed(2)} ms`);
  assert.ok(boxes.length > 100);
  assert.ok(built.items.length > 0);
  const rand = rng(31);
  probe(boxes, rand, 40_000, "baked");

  // Unchanged array: the same index object every call (no per-tick rebuild).
  const first = floorIndexFor(boxes);
  assert.equal(floorIndexFor(boxes), first);

  // Moves: floorAlongMove sample-by-sample equality, stairs included.
  const banded = boxes.filter((b) => Number.isFinite(b.maxY) && Math.abs(b.minX) < 1e5);
  for (let i = 0; i < 4_000; i++) {
    const b = banded[Math.floor(rand() * banded.length)]!;
    const x0 = b.minX - 1 + rand() * (b.maxX - b.minX + 2);
    const z0 = b.minZ - 1 + rand() * (b.maxZ - b.minZ + 2);
    const x1 = x0 + (rand() - 0.5) * 0.8;
    const z1 = z0 + (rand() - 0.5) * 0.8;
    const feet = Math.max(b.minY ?? 0, b.maxY ?? 0) - 0.3 + rand() * 0.4;
    assert.equal(floorAlongMoveIndexed(first, x0, z0, x1, z1, 0.4, feet), floorAlongMove(boxes, x0, z0, x1, z1, 0.4, feet));
  }

  // Door blockers: added once (rebuild), then rewritten in place on toggle (always-checked, no rebuild).
  const blockers = createDoorBlockers(world);
  const at = new Map<number, PawnBody>();
  let seq = 0;
  const host = createArenaDoors({
    doors: loaded.view.doors,
    pawnOf: (id) => at.get(id),
    keys: { hasKey: () => true, consumeKey: () => true },
    sendAll() {},
    ownedPawn: () => 7,
    sessionId: () => 1,
    blockers,
  });
  const seeded = floorIndexFor(boxes);
  assert.notEqual(seeded, first, "adding door blockers rebuilds once");
  assert.equal(seeded.always.length >= loaded.view.doors.length, true, "door leaves are always checked");
  probe(boxes, rand, 10_000, "doors shut");
  const before = JSON.stringify(host.snapshot());
  for (const door of loaded.view.doors) {
    const reach = doorUseVolume(door);
    const p = { x: (reach.minX + reach.maxX) / 2, y: door.position[1], z: (reach.minZ + reach.maxZ) / 2 };
    const body: PawnBody = { id: 7, x: p.x, y: p.y, z: p.z, radius: 0.5, height: 1.8, alive: true };
    at.set(7, body);
    host.onFrame(1, useFrame(++seq));
  }
  assert.notEqual(JSON.stringify(host.snapshot()), before, "some doors toggled");
  assert.equal(floorIndexFor(boxes), seeded, "a door toggle does not rebuild");
  probe(boxes, rand, 10_000, "doors toggled");

  // Elevator-style in-place Y rewrite: read live, no rebuild needed.
  const live = boxes as FloorBox[];
  const lift = banded.slice(0, 20);
  for (const b of lift) {
    b.minY = (b.minY ?? 0) + 0.2;
    b.maxY = (b.maxY ?? 0) + 0.2;
  }
  assert.equal(floorIndexFor(boxes), seeded);
  probe(boxes, rand, 5_000, "y offset");

  // Pickup-style splice: the length changes, so the index rebuilds and still matches.
  live.splice(Math.floor(live.length / 2), 1);
  assert.notEqual(floorIndexFor(boxes), seeded, "a splice rebuilds");
  probe(boxes, rand, 5_000, "after splice");
});
