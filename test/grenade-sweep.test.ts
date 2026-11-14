import assert from "node:assert/strict";
import { test } from "node:test";
import { sweepSegment, sweepIndexed, type TraceAabb, type TraceCapsule } from "../src/shared/hitscan.ts";
import { markDynamicObstacle } from "../src/shared/movements.ts";

function field(): TraceAabb[] {
  const boxes: TraceAabb[] = [];
  let id = 1;
  for (let x = 0; x < 30; x++) {
    for (let z = 0; z < 30; z++) {
      boxes.push({ id: id++, minX: x * 2, maxX: x * 2 + 1, minZ: z * 2, maxZ: z * 2 + 1, minY: 0, maxY: 2 });
    }
  }
  // A no-height box (blocks at every height) and an oversized box (always-list).
  boxes.push({ id: 900, minX: 5, maxX: 6, minZ: 5, maxZ: 6 });
  boxes.push({ id: 901, minX: -50, maxX: 80, minZ: -50, maxZ: 80, minY: -1, maxY: 0 });
  return boxes;
}

const capsules: TraceCapsule[] = [
  { id: 1000, x: 12, y: 0, z: 12, radius: 0.5, height: 1.8 },
  { id: 1001, x: 40, y: 0, z: 8, radius: 0.5, height: 1.8 },
];

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

test("grenade_sweep_indexed_matches_linear", () => {
  const boxes = field();
  // The door path: a dynamic box is tested on every query, not from a cell.
  markDynamicObstacle(boxes[450]!);
  const r = rng(42);
  let hits = 0;
  for (let i = 0; i < 1000; i++) {
    const from = { x: r() * 60 - 5, y: r() * 3, z: r() * 60 - 5 };
    const to = { x: from.x + (r() - 0.5) * 40, y: from.y + (r() - 0.5) * 6, z: from.z + (r() - 0.5) * 40 };
    const linear = sweepSegment(from, to, boxes, capsules);
    const indexed = sweepIndexed(from, to, boxes, capsules);
    if (!linear) {
      assert.equal(indexed, undefined, `miss ${i}`);
      continue;
    }
    hits++;
    assert.ok(indexed, `hit ${i} lost`);
    assert.equal(indexed.id, linear.id, `id ${i}`);
    assert.equal(indexed.pawn, linear.pawn, `pawn ${i}`);
    assert.ok(Math.abs(indexed.distance - linear.distance) < 1e-9, `t ${i}`);
    assert.ok(
      indexed.normal.x === linear.normal.x &&
        indexed.normal.y === linear.normal.y &&
        indexed.normal.z === linear.normal.z,
      `normal ${i}`,
    );
  }
  assert.ok(hits > 100, `too few hits: ${hits}`);
});
