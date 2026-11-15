import assert from "node:assert/strict";
import { test } from "node:test";
import { planLegs, polylineHitsBlocks } from "../src/shared/nav/legs.ts";
import { specForPlace, buildGrid, navBoxes, findLocalPath } from "../src/shared/nav/grid.ts";
import { placeAt, type SceneGraph, type ScenePlace } from "../src/shared/scene-graph.ts";
import type { BakedRegionsFile } from "../src/shared/nav/regions.ts";
import { loadArena } from "../src/server/world-loader.ts";

function room(id: string, minX: number, maxX: number): ScenePlace {
  return {
    id,
    kind: "room",
    y: 0,
    polygon: [[minX, 0], [maxX, 0], [maxX, 10], [minX, 10]],
    bounds: { minX, maxX, minZ: 0, maxZ: 10 },
  };
}

test("plan_legs_does_not_cut_the_elevator_shaft", () => {
  const from = room("from", 0, 10);
  const to = room("to", 10, 20);
  const shaft = {
    id: "shaft",
    kind: "elevator" as const,
    y: 0,
    polygon: [[4, 4], [6, 4], [6, 6], [4, 6]] as Array<[number, number]>,
    bounds: { minX: 4, maxX: 6, minZ: 4, maxZ: 6 },
    stops: [0],
    waitS: 1,
    speed: 1,
    landings: [],
    joins: [],
  };
  const places = [from, to];
  const graph = {
    formatVersion: 1,
    units: "meters",
    places,
    portals: [],
    placeById: new Map(places.map((place) => [place.id, place])),
    portalsOf: new Map(),
    shafts: [shaft],
    skip: new Set(),
  } as unknown as SceneGraph;
  const route = {
    ok: true as const,
    steps: [{
      portal: { id: "p", kind: "opening" as const, a: "from", b: "to", at: { a: [10, 0, 5] as [number, number, number], b: [10, 0, 5] as [number, number, number] }, width: 2, cost: 1 },
      from: "from",
      to: "to",
      enter: [9.5, 0, 5] as [number, number, number],
      exit: [10.5, 0, 5] as [number, number, number],
    }],
    places: ["from", "to"],
    cost: 1,
  };
  const regions = {
    version: 1,
    radius: 0.5,
    height: 1.8,
    places: [{ placeId: "from", regions: [{ id: "r", minX: 0, maxX: 10, minZ: 0, maxZ: 10, y: 0 }], portals: [] }],
  } as BakedRegionsFile;
  const view = { aabbs: [], doors: [], pawnRadius: 0.5, pawnHeight: 1.8 };
  const legs = planLegs(graph, view, route, { x: 1, y: 0, z: 5 }, { regions });
  assert.equal(legs.ok, true);
  const blocks = specForPlace(graph, "from")?.block ?? [];
  assert.ok(blocks.length > 0, "the room must have a shaft block for this test to mean anything");
  assert.equal(polylineHitsBlocks(legs.points, blocks), false, "a pulled point or segment crosses a shaft block");
});

test("outside_walk_uses_the_whole_place_grid", () => {
  const loaded = loadArena();
  const graph = loaded.sceneGraph as SceneGraph;
  const view = { aabbs: loaded.view.aabbs, doors: loaded.view.doors, pawnRadius: loaded.view.pawnRadius, pawnHeight: loaded.view.pawnHeight };
  const spec = specForPlace(graph, "outside");
  assert.ok(spec);
  const shut = new Set(loaded.view.doors.filter((door) => !door.open).map((door) => door.id));
  // 0.25 m measured ~288 ms for this area (220k cells), above the 250 ms budget.
  const grid = buildGrid(spec.area, navBoxes(view, graph, shut), {
    cell: 0.5, radius: view.pawnRadius, height: view.pawnHeight, baseY: spec.baseY, block: spec.block,
  });
  const from = { x: 0.5407, z: -1.7784 };
  const to = { x: -60, z: 0 };
  const path = findLocalPath(grid, from, to);
  assert.ok(path && path.length > 1, "outside grid must find a path around the building");
  for (const point of path) assert.equal(placeAt(graph, point[0], point[1], point[2]).kind, "outside", "path leaves the outside place");
});
