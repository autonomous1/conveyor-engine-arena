import assert from "node:assert/strict";
import { test } from "node:test";
import { createDoorBlockers } from "../src/server/doors.ts";
import { DEFAULT_SCOPES, SCOPES, resolvedScopes } from "../src/server/auth/tokens.ts";

type Box = { id: number; minX: number; maxX: number; minZ: number; maxZ: number; minY?: number; maxY?: number };
/** createDoorBlockers parks an open leaf here: far below the floor, zero size. */
const PARKED = -1e6;

test("door_blockers_one_obstacle_per_door", () => {
  const boxes: Box[] = [];
  const world = {
    addObstacle(box: Box): void {
      boxes.push(box);
    },
    listObstacles(): readonly Box[] {
      return boxes;
    },
  };
  const blockers = createDoorBlockers(world);
  const door = {
    id: "d1",
    hinge: "left" as const,
    open: false,
    position: [0, 0, 0] as [number, number, number],
    size: [1, 2.1, 0.08] as [number, number, number],
    yaw: 0,
  };

  blockers.sync(door);
  assert.equal(boxes.length, 1);
  const id = blockers.obstacleId("d1");
  assert.equal(typeof id, "number");

  // Opening parks the same box; nothing is removed.
  blockers.sync({ ...door, open: true });
  assert.equal(boxes.length, 1);
  assert.equal(boxes[0]!.id, id);
  assert.equal(boxes[0]!.minX, PARKED);

  // Shutting rewrites the same box in place.
  blockers.sync({ ...door, open: false });
  assert.equal(boxes.length, 1);
  assert.equal(boxes[0]!.id, id);
  assert.notEqual(boxes[0]!.minX, PARKED);

  // A second door gets its own obstacle; an unknown door has none.
  blockers.sync({ ...door, id: "d2" });
  assert.equal(boxes.length, 2);
  assert.notEqual(blockers.obstacleId("d2"), id);
  assert.equal(blockers.obstacleId("nope"), undefined);
});

test("resolved_scopes_keep_defaults", () => {
  const player = resolvedScopes("player", ["admin"]);
  for (const scope of DEFAULT_SCOPES.player) assert.ok(player.includes(scope), scope);
  assert.ok(player.includes("admin"));
  assert.deepEqual(resolvedScopes("qa"), [...DEFAULT_SCOPES.qa]);
  assert.deepEqual(resolvedScopes("admin", ["teleport"]), [...SCOPES]);
  assert.throws(() => resolvedScopes("player", ["nope" as never]), /bad-claims/);
});
