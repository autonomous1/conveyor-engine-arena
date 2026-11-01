import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { ArenaView } from "../src/shared/arena-view.ts";
import { pointInPolygon } from "../dist/shared/elevators.js";
import { STEP_HEIGHT } from "../dist/shared/movements.js";
import {
  buildGrid,
  crossingGridArea,
  findLocalPath,
  navBoxes,
  placeGridArea,
  shaftBlocks,
  specForCrossing,
  specForPlace,
  type Grid,
  type GridArea,
} from "../dist/shared/nav/grid.js";
import { createNavCache, planLegs } from "../dist/shared/nav/legs.js";
import { planRoute, type Gate } from "../dist/shared/nav/route.js";
import {
  isElevatorShaft,
  placeAt,
  type ElevatorPlace,
  type SceneGraph,
  type ScenePlace,
  type ScenePortal,
} from "../dist/shared/scene-graph.js";
import { loadArena } from "../dist/server/world-loader.js";

const RADIUS = 0.4;
const HEIGHT = 1.8;

type XZ = { x: number; z: number };

function emptyGraph(places: SceneGraph["places"] = [], shafts: ElevatorPlace[] = []): SceneGraph {
  return {
    formatVersion: 1,
    units: "meters",
    places,
    portals: [],
    placeById: new Map(places.map((place) => [place.id, place])),
    portalsOf: new Map(),
    shafts,
    skip: new Set(),
  };
}

function room(id: string, minX: number, maxX: number, minZ: number, maxZ: number, y = 0): ScenePlace {
  return {
    id,
    kind: "room",
    y,
    polygon: [[minX, minZ], [maxX, minZ], [maxX, maxZ], [minX, maxZ]],
    bounds: { minX, maxX, minZ, maxZ },
  };
}

function gridOf(
  area: GridArea,
  boxes: ReadonlyArray<{ minX: number; maxX: number; minZ: number; maxZ: number; minY?: number; maxY?: number }>,
  opts: { baseY?: number; radius?: number; height?: number; cell?: number; block?: Array<Array<[number, number]>> } = {},
): Grid {
  return buildGrid(area, boxes, {
    cell: opts.cell ?? 0.25,
    radius: opts.radius ?? RADIUS,
    height: opts.height ?? HEIGHT,
    baseY: opts.baseY ?? 0,
    ...(opts.block ? { block: opts.block } : {}),
  });
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

function segmentHits(path: ReadonlyArray<readonly [number, number, number]>, polygon: ReadonlyArray<readonly [number, number]>): boolean {
  for (let n = 0; n < path.length; n += 1) {
    const [x, , z] = path[n]!;
    if (pointInPolygon(polygon, x, z)) return true;
    const next = path[n + 1];
    if (!next) continue;
    const dist = Math.hypot(next[0] - x, next[2] - z);
    const steps = Math.max(1, Math.ceil(dist / 0.1));
    for (let s = 1; s < steps; s += 1) {
      const t = s / steps;
      if (pointInPolygon(polygon, x + (next[0] - x) * t, z + (next[2] - z) * t)) return true;
    }
  }
  return false;
}

function gapToBox(x: number, z: number, box: { minX: number; maxX: number; minZ: number; maxZ: number }): number {
  const dx = x < box.minX ? box.minX - x : x > box.maxX ? x - box.maxX : 0;
  const dz = z < box.minZ ? box.minZ - z : z > box.maxZ ? z - box.maxZ : 0;
  return Math.hypot(dx, dz);
}

/** 8-connected shortest path in the same metric as the planner, between the cells that hold the points. */
function eightOptimum(grid: Grid, start: XZ, goal: XZ): number {
  const w = grid.w;
  const h = grid.h;
  const at = (x: number, z: number): number => {
    const i = Math.floor((x - grid.minX) / grid.cell);
    const j = Math.floor((z - grid.minZ) / grid.cell);
    return j * w + i;
  };
  const startIdx = at(start.x, start.z);
  const goalIdx = at(goal.x, goal.z);
  const cost = new Float64Array(w * h);
  cost.fill(Infinity);
  cost[startIdx] = 0;
  const open = new Uint8Array(w * h);
  open[startIdx] = 1;
  const step = grid.cell;
  const diag = grid.cell * Math.SQRT2;
  for (;;) {
    let best = -1;
    let bestCost = Infinity;
    for (let idx = 0; idx < cost.length; idx += 1) {
      if (open[idx] !== 1 || !(cost[idx]! < bestCost)) continue;
      best = idx;
      bestCost = cost[idx]!;
    }
    if (best < 0) return Infinity;
    if (best === goalIdx) return bestCost;
    open[best] = 2;
    const i = best % w;
    const j = (best - i) / w;
    const here = grid.floor[best]!;
    for (let dj = -1; dj <= 1; dj += 1) {
      const nj = j + dj;
      if (nj < 0 || nj >= h) continue;
      for (let di = -1; di <= 1; di += 1) {
        if (di === 0 && dj === 0) continue;
        const ni = i + di;
        if (ni < 0 || ni >= w) continue;
        if (di !== 0 && dj !== 0) {
          if (grid.blocked[j * w + ni] !== 0 || grid.blocked[nj * w + i] !== 0) continue;
        }
        const next = nj * w + ni;
        if (grid.blocked[next] !== 0 || open[next] === 2) continue;
        if (Math.abs(grid.floor[next]! - here) > STEP_HEIGHT + 1e-4) continue;
        const nextCost = bestCost + (di !== 0 && dj !== 0 ? diag : step);
        if (!(nextCost < cost[next]!)) continue;
        cost[next] = nextCost;
        open[next] = 1;
      }
    }
  }
}

test("a crate is walked around and the path stays a radius clear of it", () => {
  const crate = { minX: 4.5, maxX: 5.5, minZ: 4.5, maxZ: 5.5, minY: 0, maxY: 1 };
  const area = { minX: 0, maxX: 10, minZ: 0, maxZ: 10 };
  const grid = gridOf(area, [crate]);
  const start = { x: 0.625, z: 5.125 };
  const goal = { x: 9.125, z: 5.125 };
  const path = findLocalPath(grid, start, goal);
  assert.ok(path);
  assert.ok(path.length >= 2);
  for (const [x, , z] of path) {
    assert.ok(gapToBox(x, z, crate) >= RADIUS - 1e-6, `${x},${z} is within radius of the crate`);
  }
  const optimum = eightOptimum(grid, start, goal);
  assert.ok(lengthOf(path) <= optimum * 1.08 + 1e-6, `length ${lengthOf(path)} optimum ${optimum}`);
});

test("short steps climb onto a deck and a one metre box does not", () => {
  const steps = [];
  for (let i = 0; i < 11; i += 1) {
    const top = 0.25 * (i + 1);
    steps.push({ minX: i * 0.4, maxX: (i + 1) * 0.4, minZ: 0, maxZ: 1.5, minY: top - 0.25, maxY: top });
  }
  const climbed = findLocalPath(
    gridOf({ minX: -1, maxX: 5, minZ: -0.25, maxZ: 1.75 }, steps, { radius: 0.3 }),
    { x: -0.5, z: 0.75 },
    { x: 4.2, z: 0.75 },
  );
  assert.ok(climbed);
  assert.ok(Math.abs(climbed[climbed.length - 1]![1] - 2.75) < 1e-3, `ended at ${climbed[climbed.length - 1]![1]}`);

  const wall = { minX: 2, maxX: 3.2, minZ: -1, maxZ: 2, minY: 0, maxY: 1 };
  const blocked = findLocalPath(
    gridOf({ minX: 0, maxX: 6, minZ: 0, maxZ: 1 }, [wall], { radius: 0.3 }),
    { x: 0.5, z: 0.5 },
    { x: 5, z: 0.5 },
  );
  assert.equal(blocked, undefined);
});

test("a stairs to landing crossing stands on the landing slab", () => {
  const stairs: ScenePlace = {
    ...room("b.s1a", 0, 2, 0, 2),
    kind: "stairs",
    y: 0,
    top: 1.5,
    width: 1.2,
    run: 2,
    landings: { bottom: [1, 0, 0.4], top: [1, 1.5, 2.2] },
    joins: { to: "b.mid" },
  };
  const landing = { ...room("b.mid", 0, 4, 2, 4, 1.5), kind: "landing" as const };
  const graph = emptyGraph([stairs, landing]);
  const up = specForCrossing(graph, "b.s1a", "b.mid");
  const down = specForCrossing(graph, "b.mid", "b.s1a");
  assert.ok(up);
  assert.ok(down);
  assert.equal(up.baseY, 1.5);
  assert.equal(down.baseY, 1.5);
  const hall = { ...room("hall", -2, 6, -2, 6, 3), kind: "hall" as const };
  const beside = specForCrossing(emptyGraph([stairs, hall]), "b.s1a", "hall");
  assert.equal(beside?.baseY, 0);
  const slab = { minX: -1, maxX: 5, minZ: 1, maxZ: 5, minY: 1.4, maxY: 1.5 };
  const path = findLocalPath(
    gridOf(up.area, [slab], { baseY: up.baseY, radius: 0.3 }),
    { x: 1, z: 1.8 },
    { x: 2, z: 3.2 },
  );
  assert.ok(path);
  for (const point of path) assert.ok(Math.abs(point[1] - 1.5) < 1e-3, String(point[1]));
});

test("an elevated place does not drop off the slab or climb a setback above", () => {
  const slab = { minX: 0, maxX: 5, minZ: 0, maxZ: 5, minY: 2.9, maxY: 3 };
  const above = { minX: 7, maxX: 9, minZ: 1, maxZ: 4, minY: 6, maxY: 6.1 };
  const grid = gridOf({ minX: -1, maxX: 11, minZ: -1, maxZ: 6 }, [slab, above], { baseY: 3, radius: 0.3 });
  const path = findLocalPath(grid, { x: 1, z: 2 }, { x: 8, z: 2 });
  assert.equal(path, undefined);
});

test("a shut door leaf blocks the gap and an open leaf does not", () => {
  const walls = [
    { minX: 0, maxX: 4, minZ: -0.15, maxZ: 0.15, minY: 0, maxY: 2.5 },
    { minX: 6, maxX: 10, minZ: -0.15, maxZ: 0.15, minY: 0, maxY: 2.5 },
  ];
  const door = {
    id: "gap",
    model: "/door.glb",
    position: [4, 0, 0] as [number, number, number],
    yaw: 0,
    hinge: "left" as const,
    size: [2, 2.2, 0.1] as [number, number, number],
    open: false,
  };
  const area = { minX: 0, maxX: 10, minZ: -2, maxZ: 2 };
  const graph = emptyGraph();
  const shut = navBoxes({ aabbs: [], doors: [door] }, graph, new Set([door.id]));
  const open = navBoxes({ aabbs: [], doors: [door] }, graph, new Set());
  const start = { x: 5, z: -1.5 };
  const goal = { x: 5, z: 1.5 };
  assert.equal(findLocalPath(gridOf(area, [...walls, ...shut], { radius: 0.3 }), start, goal), undefined);
  assert.ok(findLocalPath(gridOf(area, [...walls, ...open], { radius: 0.3 }), start, goal));
});

test("a diagonal does not cut a blocked corner, and a clear corridor smooths to two points", () => {
  const pillar = { minX: 0.12, maxX: 0.38, minZ: 0.12, maxZ: 0.38, minY: 0, maxY: 1.2 };
  const corner = gridOf({ minX: 0, maxX: 2, minZ: 0, maxZ: 2 }, [pillar], { cell: 0.5, radius: 0.1 });
  const around = findLocalPath(corner, { x: 0.25, z: 0.75 }, { x: 0.75, z: 0.25 });
  assert.ok(around);
  assert.ok(around.length >= 3);
  assert.ok(around.some((point) => Math.hypot(point[0] - 0.75, point[2] - 0.75) < 0.2));

  const start = { x: 0.625, z: 1.125 };
  const goal = { x: 7.625, z: 1.125 };
  const clear = gridOf({ minX: 0, maxX: 8, minZ: 0, maxZ: 2 }, []);
  const path = findLocalPath(clear, start, goal);
  assert.ok(path);
  assert.equal(path.length, 2);
  const optimum = eightOptimum(clear, start, goal);
  assert.ok(lengthOf(path) <= optimum * 1.08 + 1e-6);
});

test("a shaft polygon is blocked in a hall and open on that shaft's stop", () => {
  const slab = { minX: -1, maxX: 12, minZ: -1, maxZ: 8, minY: 2.9, maxY: 3 };
  const shaft: Array<[number, number]> = [[4, 1], [6, 1], [6, 4], [4, 4]];
  const area = { minX: 0, maxX: 10, minZ: 0, maxZ: 6 };
  const start = { x: 1.125, z: 2.625 };
  const goal = { x: 8.625, z: 2.625 };
  const opts = { baseY: 3, radius: 0.3 };
  const around = findLocalPath(gridOf(area, [slab], { ...opts, block: [shaft] }), start, goal);
  assert.ok(around);
  assert.equal(segmentHits(around, shaft), false);
  assert.ok(around.some((point) => point[2] < 1 || point[2] > 4));

  const through = findLocalPath(gridOf(area, [slab], opts), start, goal);
  assert.ok(through);
  assert.equal(segmentHits(through, shaft), true);

  const place = shaftPlace();
  const hall = room("hall", -2, 8, -2, 8);
  const graph = emptyGraph([hall, place.stop, place.shaft], [place.shaft]);
  const hallSpec = specForPlace(graph, "hall");
  const stopSpec = specForPlace(graph, "b.e1@0");
  assert.ok(hallSpec);
  assert.ok(stopSpec);
  assert.equal(shaftBlocks(graph, hallSpec.area, ["hall"]).length, 1);
  assert.equal(shaftBlocks(graph, stopSpec.area, ["b.e1@0"]).length, 0);
  const stopArea = placeGridArea(graph, "b.e1@0");
  assert.ok(stopArea);
  assert.ok(stopArea.maxX >= 3);
  assert.ok(stopArea.minZ <= 1 && stopArea.maxZ >= 1);
  const union = crossingGridArea(graph, "hall", "b.e1@0");
  assert.ok(union);
  assert.ok(union.minX <= hallSpec.area.minX && union.maxX >= stopArea.maxX);
});

test("elevator room boxes are dropped until a cab offset puts them back", () => {
  const placed = shaftPlace();
  const graph = emptyGraph([placed.stop, placed.shaft], [placed.shaft]);
  const room = { id: 1, source: "b.cab.front.0", minX: 0, maxX: 1, minY: 1, maxY: 3, minZ: 0, maxZ: 1 };
  const other = { id: 2, source: "b.other.wall", minX: 4, maxX: 5, minY: 0, maxY: 2, minZ: 0, maxZ: 1 };
  const lookalike = { id: 3, source: "b.cabExtra.wall", minX: 6, maxX: 7, minY: 0, maxY: 2, minZ: 0, maxZ: 1 };
  const view = { aabbs: [room, other, lookalike], doors: [] as ArenaView["doors"] };
  const dropped = navBoxes(view, graph, new Set());
  assert.equal(dropped.length, 2);
  assert.ok(dropped.every((box) => box.minX !== 0));

  const lifted = navBoxes(view, graph, new Set(), [{ id: "b.e1", at: 2, phase: "dwell", y: 6 }]);
  const moved = lifted.find((box) => box.minX === 0);
  assert.ok(moved);
  assert.equal(moved.minY, 7);
  assert.equal(moved.maxY, 9);
  const kept = lifted.find((box) => box.minX === 4);
  assert.ok(kept);
  assert.equal(kept.minY, 0);
  assert.equal(lifted.find((box) => box.minX === 6)?.minY, 0);
});

test("planLegs walks a portal, reports the blocked step, and reuses a grid until a door changes", () => {
  const from = room("from", 0, 4, 0, 4);
  const to = room("to", 6, 10, 0, 4);
  const graph = emptyGraph([from, to]);
  const step = {
    portal: {
      id: "from-to",
      kind: "opening" as const,
      a: "from",
      b: "to",
      at: { a: [4, 0, 2] as [number, number, number], b: [6, 0, 2] as [number, number, number] },
      width: 2,
      cost: 1,
    },
    from: "from",
    to: "to",
    enter: [4, 0, 2] as [number, number, number],
    exit: [6, 0, 2] as [number, number, number],
  };
  const route = { ok: true as const, steps: [step], places: ["from", "to"], cost: 1 };
  const door = {
    id: "corner",
    model: "/door.glb",
    position: [0.2, 0, 0.2] as [number, number, number],
    yaw: 0,
    hinge: "left" as const,
    size: [0.4, 2, 0.1] as [number, number, number],
    open: true,
  };
  const view = { aabbs: [] as ArenaView["aabbs"], doors: [door], pawnRadius: 0.3, pawnHeight: HEIGHT };
  const cache = createNavCache();
  const walked = planLegs(graph, view, route, { x: 1, y: 0, z: 2 }, { cache, doorsShut: new Set() });
  assert.equal(walked.ok, true);
  if (walked.ok) {
    assert.ok(Math.hypot(walked.points[0]![0] - 1, walked.points[0]![2] - 2) < 0.5);
    const last = walked.points[walked.points.length - 1]!;
    assert.ok(Math.hypot(last[0] - 6, last[2] - 2) < 0.5);
  }
  const built = cache.misses;
  assert.ok(built >= 1);
  const again = planLegs(graph, view, route, { x: 1, y: 0, z: 2 }, { cache, doorsShut: new Set() });
  assert.equal(again.ok, true);
  assert.equal(cache.misses, built);
  planLegs(graph, view, route, { x: 1, y: 0, z: 2 }, { cache, doorsShut: new Set(["corner"]) });
  assert.ok(cache.misses > built);

  const wall = { id: 1, minX: 2, maxX: 2.3, minY: 0, maxY: 2, minZ: -2, maxZ: 6 };
  const blocked = planLegs(
    graph,
    { ...view, aabbs: [wall] },
    route,
    { x: 1, y: 0, z: 2 },
    { doorsShut: new Set() },
  );
  assert.deepEqual(blocked, { ok: false, step: 0 });

  const elevator = planLegs(graph, view, {
    ok: true,
    steps: [{ ...step, portal: { ...step.portal, id: "lift", kind: "elevator" } }],
    places: ["from", "to"],
    cost: 1,
  }, { x: 1, y: 0, z: 2 }, { doorsShut: new Set() });
  assert.equal(elevator.ok, true);
  if (elevator.ok) assert.equal(elevator.points.length, 1);
});

test("a 40 m grid builds and searches inside the budget", () => {
  const boxes = [];
  for (let x = 2; x < 38; x += 4) {
    for (let z = 2; z < 38; z += 4) {
      boxes.push({ minX: x, maxX: x + 0.8, minZ: z, maxZ: z + 0.8, minY: 0, maxY: 1 });
    }
  }
  const area = { minX: 0, maxX: 40, minZ: 0, maxZ: 40 };
  const warm = gridOf(area, boxes, { radius: 0.3 });
  findLocalPath(warm, { x: 0.5, z: 0.5 }, { x: 39, z: 39 });
  const startBuild = performance.now();
  const grid = gridOf(area, boxes, { radius: 0.3 });
  const built = performance.now() - startBuild;
  const startSearch = performance.now();
  const path = findLocalPath(grid, { x: 0.5, z: 0.5 }, { x: 39, z: 39 });
  const searched = performance.now() - startSearch;
  console.log(`grid build ${built.toFixed(2)} ms, search ${searched.toFixed(2)} ms (${grid.w * grid.h} cells)`);
  assert.ok(path);
  assert.ok(built < 30 * 3, `build ${built.toFixed(1)} ms`);
  assert.ok(searched < 10 * 3, `search ${searched.toFixed(1)} ms`);
});

function shaftPlace(): { shaft: ElevatorPlace; stop: ScenePlace } {
  const shaft: ElevatorPlace = {
    id: "b.e1",
    kind: "elevator",
    y: 0,
    polygon: [[0, 0], [2, 0], [2, 2], [0, 2]],
    bounds: { minX: 0, maxX: 2, minZ: 0, maxZ: 2 },
    stops: [0, 3],
    waitS: 1,
    speed: 1,
    landings: [[3, 0, 1], [3, 3, 1]],
    joins: [undefined, undefined],
    room: "b.cab",
  };
  const stop: ScenePlace = {
    id: "b.e1@0",
    kind: "elevator",
    y: 0,
    polygon: shaft.polygon.map((point) => [point[0], point[1]]),
    bounds: { minX: 0, maxX: 2, minZ: 0, maxZ: 2 },
  };
  return { shaft, stop };
}

test("real arena places either path or get printed", { timeout: 180_000 }, () => {
  const loaded = loadArena();
  const graph = loaded.sceneGraph;
  assert.ok(graph);
  const view = loaded.view;
  const shut = new Set(view.doors.filter((door) => !door.open).map((door) => door.id));
  const boxes = navBoxes(view, graph, shut);
  const opts = { radius: view.pawnRadius, height: view.pawnHeight, cell: 0.25 };

  const spawns = [
    ...readPoints("../web/game/spawn-points.json"),
    ...readPoints("../web/game/player-spawns.json"),
  ];
  const groups = new Map<string, Array<{ id: string; x: number; z: number }>>();
  for (const spawn of spawns) {
    const place = placeAt(graph, spawn.x, 0, spawn.z);
    const list = groups.get(place.id) ?? [];
    list.push(spawn);
    groups.set(place.id, list);
  }
  for (const [placeId, list] of groups) {
    if (list.length < 2) continue;
    const spec = specForPlace(graph, placeId);
    assert.ok(spec, placeId);
    const started = performance.now();
    const grid = buildGrid(spec.area, boxes, { ...opts, baseY: spec.baseY, block: spec.block });
    console.log(`place ${placeId} grid ${grid.w}x${grid.h} in ${(performance.now() - started).toFixed(0)} ms`);
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const path = findLocalPath(grid, list[i]!, list[j]!);
        if (!path) console.log(`no path ${list[i]!.id} -> ${list[j]!.id} in ${placeId}`);
      }
    }
  }

  const hallId = "brutalist-building-1-cbake-0.floor-3.hall";
  const hall = graph.placeById.get(hallId);
  assert.ok(hall);
  const shaft = graph.placeById.get("brutalist-building-1-cbake-0.e1");
  assert.ok(shaft && isElevatorShaft(shaft));
  const hallSpec = specForPlace(graph, hallId);
  assert.ok(hallSpec);
  const hallGrid = buildGrid(hallSpec.area, boxes, { ...opts, baseY: hallSpec.baseY, block: hallSpec.block });
  const samples: XZ[] = [];
  for (let x = hall.bounds.minX + 0.5; x < hall.bounds.maxX; x += 1) {
    for (let z = hall.bounds.minZ + 0.5; z < hall.bounds.maxZ; z += 1) {
      if (!pointInPolygon(hall.polygon, x, z)) continue;
      if (pointInPolygon(shaft.polygon, x, z)) continue;
      const i = Math.floor((x - hallGrid.minX) / hallGrid.cell);
      const j = Math.floor((z - hallGrid.minZ) / hallGrid.cell);
      if (i < 0 || j < 0 || i >= hallGrid.w || j >= hallGrid.h) continue;
      if (hallGrid.blocked[j * hallGrid.w + i] !== 0) continue;
      samples.push({ x, z });
    }
  }
  assert.ok(samples.length >= 2, `hall has ${samples.length} free samples`);
  const pairs = [];
  for (let i = 0; i < samples.length; i += 1) {
    for (let j = i + 1; j < samples.length; j += 1) {
      const dx = samples[i]!.x - samples[j]!.x;
      const dz = samples[i]!.z - samples[j]!.z;
      pairs.push({ i, j, d: dx * dx + dz * dz });
    }
  }
  pairs.sort((a, b) => b.d - a.d);
  let hallPath: ReturnType<typeof findLocalPath>;
  for (const pair of pairs.slice(0, 40)) {
    hallPath = findLocalPath(hallGrid, samples[pair.i]!, samples[pair.j]!);
    if (hallPath) break;
  }
  assert.ok(hallPath, "floor-3 hall has no path between free samples");
  for (let n = 0; n < hallPath.length; n += 1) {
    const [x, y, z] = hallPath[n]!;
    assert.ok(Math.abs(y - 6) < 0.35, `y ${y} at ${x},${z}`);
    assert.equal(pointInPolygon(shaft.polygon, x, z), false, `${x},${z} is in the shaft`);
    const next = hallPath[n + 1];
    if (!next) continue;
    const dist = Math.hypot(next[0] - x, next[2] - z);
    const steps = Math.max(1, Math.ceil(dist / 0.2));
    for (let s = 1; s < steps; s += 1) {
      const t = s / steps;
      const sx = x + (next[0] - x) * t;
      const sz = z + (next[2] - z) * t;
      assert.equal(pointInPolygon(shaft.polygon, sx, sz), false, `segment enters the shaft`);
    }
  }

  for (const place of graph.places) {
    if (place.kind !== "stairs" || !("landings" in place)) continue;
    const spec = specForPlace(graph, place.id);
    if (!spec) continue;
    const grid = buildGrid(spec.area, boxes, { ...opts, baseY: spec.baseY, block: spec.block });
    const path = findLocalPath(
      grid,
      { x: place.landings.bottom[0], z: place.landings.bottom[2] },
      { x: place.landings.top[0], z: place.landings.top[2] },
    );
    if (!path) console.log(`stairs ${place.id} has no walkable path`);
  }

  const seen = new Map<string, Grid>();
  for (const portal of graph.portals) {
    if (portal.kind !== "door") continue;
    const spec = specForCrossing(graph, portal.a, portal.b);
    if (!spec) continue;
    const key = `${spec.area.minX},${spec.area.maxX},${spec.area.minZ},${spec.area.maxZ},${spec.baseY},${spec.block.map((poly) => poly.map((point) => point.join(",")).join(";")).join("|")}`;
    let grid = seen.get(key);
    if (!grid) {
      grid = buildGrid(spec.area, boxes, { ...opts, baseY: spec.baseY, block: spec.block });
      seen.set(key, grid);
    }
    const path = findLocalPath(
      grid,
      { x: portal.at.a[0], z: portal.at.a[2] },
      { x: portal.at.b[0], z: portal.at.b[2] },
    );
    if (path) continue;
    if (portal.width < 1.5) console.log(`narrow door ${portal.id} width ${portal.width} blocked`);
    else console.log(`door ${portal.id} width ${portal.width} blocked`);
  }

  const ground = spawns[0];
  assert.ok(ground);
  const gate = (portal: ScenePortal): Gate => {
    if (portal.kind === "elevator") return "unusable";
    if (portal.locked) return "locked";
    return "open";
  };
  const target = "brutalist-building-2-cbake.floor-2.hall";
  const route = planRoute(graph, { x: ground.x, y: 0, z: ground.z }, target, gate);
  if (!route.ok) {
    console.log(`planRoute to ${target} failed: ${route.reason}`);
    return;
  }
  const legs = planLegs(graph, view, route, { x: ground.x, y: 0, z: ground.z }, { doorsShut: shut });
  if (legs.ok) return;
  const failed = route.steps[legs.step];
  console.log(`planLegs to ${target} failed at step ${legs.step}${failed ? ` ${failed.portal.id}` : ""}`);
});

function readPoints(relative: string): Array<{ id: string; x: number; z: number }> {
  const file = fileURLToPath(new URL(relative, import.meta.url));
  const rows = JSON.parse(readFileSync(file, "utf8")) as Array<{ id: string; x: number; z: number }>;
  return rows.map((row) => ({ id: row.id, x: row.x, z: row.z }));
}
