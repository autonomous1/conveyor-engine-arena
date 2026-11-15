import assert from "node:assert/strict";
import { test } from "node:test";
import { buildWanderStallDump } from "../src/server/wander-debug.ts";

test("stall_dump_captures_grid_path_and_colliders", () => {
  const grid = { minX: 0, minZ: 0, cell: 0.25, w: 8, h: 8, floor: new Float32Array(64), blocked: new Uint8Array(64) };
  // Fill a 2.75 floor at the pawn cell and a 1.0 floor around; block one cell.
  grid.floor[2 * 8 + 2] = 2.75;
  grid.blocked[3 * 8 + 3] = 1;
  const dump = buildWanderStallDump({
    at: 0, tick: 100, agent: 7,
    pose: { x: 0.6, y: 0, z: 0.6, yaw: 0 },
    place: "outside",
    goal: { x: 4, y: 6, z: 4 },
    claim: false,
    path: { points: [[0.6, 0, 0.6], [4, 6, 4]], baseY: 0 },
    grid,
    spec: { baseY: 6, minX: 0, maxX: 2, minZ: 0, maxZ: 2, blocks: 0 },
    colliders: [{ id: 1, minX: 0.4, maxX: 0.8, minY: 1.75, maxY: 2, minZ: 0.4, maxZ: 0.8 }],
    source: "follower",
  });
  assert.equal(dump.pose.y, 0);
  assert.equal(dump.path.yMax, 6);
  assert.equal(dump.spec?.baseY, 6);
  assert.equal(dump.cells.find((c) => c.i === 2 && c.j === 2)?.floor, 2.75);
  assert.ok(dump.colliders.some((box) => box.minY === 1.75));
});
