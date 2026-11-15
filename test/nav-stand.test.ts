import assert from "node:assert/strict";
import { test } from "node:test";
import { loadArena } from "../src/server/world-loader.ts";
import { placeAt } from "../src/shared/scene-graph.ts";
import { resolveStand, standKey } from "../src/shared/nav/stand.ts";

const loaded = loadArena();
const graph = loaded.sceneGraph!;
const doors = loaded.view.doors;

test("door_and_point_stands_resolve", () => {
  const door = doors.find((item) => item.id.startsWith("brutalist-building-1-cbake.door-1-1"));
  assert.ok(door, "fixture door missing");
  const sides = ["in", "out"].map((side) => resolveStand({ kind: "door", doorId: door.id, side: side as "in" | "out" }, graph, doors));
  assert.ok(sides[0] && sides[1]);
  const inside = sides.find((stand) => placeAt(graph, stand!.x, stand!.y, stand!.z).kind !== "outside");
  assert.ok(inside, "one side must be inside the building");
  assert.equal(standKey({ kind: "door", doorId: door.id }), `door:${door.id}:auto`);

  const p = { kind: "point", x: 0.54, y: 0, z: -1.78, yaw: 0 } as const;
  const stand = resolveStand(p, graph, doors);
  assert.ok(stand);
  assert.equal(stand!.place, placeAt(graph, 0.54, 0, -1.78).id);
  assert.equal(standKey(p), "point:0.540,0.000,-1.780");
});

test("door_stand_auto_picks_the_reachable_side", () => {
  const door = doors.find((item) => item.id === "brutalist-building-1-cbake.door-1-1-9-22-0");
  assert.ok(door, "locked exterior door missing");
  const outside = resolveStand({ kind: "door", doorId: door.id, side: "out" }, graph, doors);
  const hall = resolveStand({ kind: "door", doorId: door.id, side: "in" }, graph, doors);
  assert.ok(outside && hall);
  assert.equal(outside.place, "outside");
  assert.notEqual(hall.place, "outside");

  const fromPlaza = resolveStand({ kind: "door", doorId: door.id }, graph, doors, {
    from: { x: outside.x, y: outside.y, z: outside.z },
  });
  assert.equal(fromPlaza?.place, "outside", "the locked hall side must not be chosen from the plaza");

  const fromHall = resolveStand({ kind: "door", doorId: door.id }, graph, doors, {
    from: { x: hall.x, y: hall.y, z: hall.z },
  });
  assert.equal(fromHall?.place, hall.place);
});
