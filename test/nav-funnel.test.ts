import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { STEP_HEIGHT, type FloorBox } from "../dist/shared/movements.js";
import { pullString, type DoorAxis } from "../dist/shared/nav/funnel.js";
import { navBoxes } from "../dist/shared/nav/grid.js";
import { createNavCache, planLegs } from "../dist/shared/nav/legs.js";
import {
  findRegionPath,
  regionsOf,
  type BakedRegionsFile,
  type RegionGraph,
  type RegionPath,
  type RegionPortal,
} from "../dist/shared/nav/regions.js";
import type { SceneGraph, ScenePlace, Vec3 } from "../dist/shared/scene-graph.js";
import { loadArena } from "../dist/server/world-loader.js";

const RADIUS = 0.5;
const HEIGHT = 1.8;
const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "regions");

function loadGraph(name: string): RegionGraph {
  return JSON.parse(readFileSync(join(fixtureDir, `${name}.json`), "utf8")) as RegionGraph;
}

function wall(minX: number, maxX: number, minZ: number, maxZ: number, maxY = 2, minY = 0): FloorBox {
  return { minX, maxX, minZ, maxZ, minY, maxY };
}

function inflate(box: FloorBox, radius: number): { minX: number; maxX: number; minZ: number; maxZ: number } {
  return {
    minX: Math.min(box.minX, box.maxX) - radius,
    maxX: Math.max(box.minX, box.maxX) + radius,
    minZ: Math.min(box.minZ, box.maxZ) - radius,
    maxZ: Math.max(box.minZ, box.maxZ) + radius,
  };
}

function portal(from: string, to: string, left: Vec3, right: Vec3): RegionPortal {
  const width = Math.hypot(right[0] - left[0], right[2] - left[2]);
  return { from, to, left, right, width };
}

function lengthOf(points: readonly Vec3[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1]!;
    const b = points[i]!;
    total += Math.hypot(b[0] - a[0], b[2] - a[2]);
  }
  return total;
}

/** True when the open segment enters the rectangle, ignoring a graze of the boundary. */
function entersRect(a: Vec3, b: Vec3, rect: { minX: number; maxX: number; minZ: number; maxZ: number }): boolean {
  const minX = rect.minX + 1e-3;
  const maxX = rect.maxX - 1e-3;
  const minZ = rect.minZ + 1e-3;
  const maxZ = rect.maxZ - 1e-3;
  if (!(maxX > minX) || !(maxZ > minZ)) return false;
  let t0 = 0;
  let t1 = 1;
  const dx = b[0] - a[0];
  const dz = b[2] - a[2];
  const clip = (p: number, q: number): boolean => {
    if (Math.abs(p) < 1e-12) return q >= 0;
    const t = q / p;
    if (p < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
    return true;
  };
  if (!clip(-dx, a[0] - minX)) return false;
  if (!clip(dx, maxX - a[0])) return false;
  if (!clip(-dz, a[2] - minZ)) return false;
  if (!clip(dz, maxZ - a[2])) return false;
  return t0 <= t1;
}

function hitsAny(points: readonly Vec3[], boxes: readonly { minX: number; maxX: number; minZ: number; maxZ: number }[]): boolean {
  for (let i = 1; i < points.length; i += 1) {
    for (const box of boxes) {
      if (entersRect(points[i - 1]!, points[i]!, box)) return true;
    }
  }
  return false;
}

function crossesPortal(a: Vec3, b: Vec3, gate: RegionPortal): boolean {
  const x0 = Math.min(gate.left[0], gate.right[0]);
  const x1 = Math.max(gate.left[0], gate.right[0]);
  const z0 = Math.min(gate.left[2], gate.right[2]);
  const z1 = Math.max(gate.left[2], gate.right[2]);
  if (x1 - x0 <= 1e-4) {
    const x = gate.left[0];
    const dx = b[0] - a[0];
    if (Math.abs(dx) < 1e-9) return Math.abs(a[0] - x) <= 1e-3 && Math.max(a[2], b[2]) >= z0 - 1e-3 && Math.min(a[2], b[2]) <= z1 + 1e-3;
    const t = (x - a[0]) / dx;
    if (t < -1e-4 || t > 1 + 1e-4) return false;
    const z = a[2] + (b[2] - a[2]) * t;
    return z >= z0 - 1e-3 && z <= z1 + 1e-3;
  }
  const z = (gate.left[2] + gate.right[2]) * 0.5;
  const dz = b[2] - a[2];
  if (Math.abs(dz) < 1e-9) return Math.abs(a[2] - z) <= 1e-3 && Math.max(a[0], b[0]) >= x0 - 1e-3 && Math.min(a[0], b[0]) <= x1 + 1e-3;
  const t = (z - a[2]) / dz;
  if (t < -1e-4 || t > 1 + 1e-4) return false;
  const x = a[0] + (b[0] - a[0]) * t;
  return x >= x0 - 1e-3 && x <= x1 + 1e-3;
}

function assertPortalsInOrder(points: readonly Vec3[], portals: readonly RegionPortal[]): void {
  let from = 0;
  for (const gate of portals) {
    let found = -1;
    for (let i = from; i < points.length - 1; i += 1) {
      if (crossesPortal(points[i]!, points[i + 1]!, gate)) {
        found = i;
        break;
      }
    }
    assert.ok(found >= 0, `${gate.from}->${gate.to} at ${gate.left.join(",")}`);
    from = found;
  }
}

test("a waypoint closer than 1 cm is dropped and the path still ends at the goal", () => {
  const path: RegionPath = {
    start: [0, 0, 0],
    goal: [0.005, 1, 0],
    regions: ["a"],
    portals: [],
  };
  assert.deepEqual(pullString(path), [[0.005, 1, 0]]);
});

test("a straight corridor pulls to the two endpoints", () => {
  const path: RegionPath = {
    start: [1, 0, 2],
    goal: [29, 0, 2],
    regions: ["a", "b", "c", "d"],
    portals: [
      portal("a", "b", [8, 0, 4], [8, 0, 0]),
      portal("b", "c", [16, 0, 4], [16, 0, 0]),
      portal("c", "d", [24, 0, 4], [24, 0, 0]),
    ],
  };
  const points = pullString(path);
  assert.deepEqual(points, [[1, 0, 2], [29, 0, 2]]);
  assert.deepEqual(pullString(path), points);
  assertPortalsInOrder(points, path.portals);

  const flipped: RegionPath = {
    ...path,
    portals: path.portals.map((gate) => portal(gate.from, gate.to, gate.right, gate.left)),
  };
  assert.deepEqual(pullString(flipped), points);
});

test("a string around a box wraps the inflated corners and stays outside it", () => {
  const box = wall(8, 12, 8, 12);
  const graph = loadGraph("wall");
  const path = findRegionPath(graph, [1, 0, 10], [19, 0, 10]);
  assert.ok(path);
  const points = pullString(path);
  assert.deepEqual(points[0], path.start);
  assert.deepEqual(points[points.length - 1], path.goal);
  assert.ok(points.length >= 3, `expected a corner, got ${points.length}`);
  assert.ok(points.length <= 6, `waypoint count ${points.length}`);
  const blocked = inflate(box, RADIUS);
  assert.equal(hitsAny(points, [blocked]), false);
  assert.ok(points.some((point) => point[2] <= blocked.minZ + 1e-3 || point[2] >= blocked.maxZ - 1e-3));
  assertPortalsInOrder(points, path.portals);
  const straight = Math.hypot(path.goal[0] - path.start[0], path.goal[2] - path.start[2]);
  assert.ok(lengthOf(points) > straight);
});

test("a U corridor wraps the inner corners", () => {
  const inner = wall(0, 16, 7, 11);
  const graph = loadGraph("u");
  const path = findRegionPath(graph, [2, 0, 2], [2, 0, 16]);
  assert.ok(path);
  const points = pullString(path);
  const blocked = inflate(inner, RADIUS);
  assert.equal(hitsAny(points, [blocked]), false);
  assert.ok(points.some((point) => point[0] >= blocked.maxX - 1e-3), points.map((point) => point.join(",")).join(" | "));
  assert.ok(points.length <= 6, `waypoint count ${points.length}`);
  assertPortalsInOrder(points, path.portals);
  assert.equal(entersRect(path.start, path.goal, blocked), true);
});

test("a door stand just inside a facade is approached on the opening axis", () => {
  const left = wall(0, 18, 9.5, 10.5);
  const right = wall(22, 40, 9.5, 10.5);
  const graph = loadGraph("door");
  const goal: Vec3 = [20, 0, 11.4];
  const path = findRegionPath(graph, [4, 0, 2], goal);
  assert.ok(path);
  const points = pullString(path);
  const blocked = [inflate(left, RADIUS), inflate(right, RADIUS)];
  assert.equal(hitsAny([path.start, path.goal], blocked), true);
  assert.equal(hitsAny(points, blocked), false, points.map((point) => point.join(",")).join(" | "));
  assert.ok(points.length >= 2);
  const end = points[points.length - 1]!;
  const before = points[points.length - 2]!;
  assert.deepEqual(end, goal);
  assert.ok(Math.abs(before[0] - end[0]) <= 1e-3, `last step ${before.join(",")} -> ${end.join(",")}`);
  assert.ok(Math.abs(before[2] - end[2]) > 1e-3);
  assert.ok(points.length <= 6, `waypoint count ${points.length}`);
});

test("arena outside walks around buildings to a door, then lines up on the opening", { timeout: 180_000 }, () => {
  const loaded = loadArena();
  const scene = loaded.sceneGraph;
  assert.ok(scene);
  const view = loaded.view;
  assert.equal(view.pawnRadius, RADIUS);
  assert.equal(view.pawnHeight, HEIGHT);

  const gate = scene.portals.find((item) => item.id === "brutalist-building-1-cbake-9.door-1-1-9-22-0");
  assert.ok(gate);
  const stand = gate.b === "outside" ? gate.at.b : gate.at.a;
  const inside = gate.b === "outside" ? gate.at.a : gate.at.b;
  const open = new Set<string>();
  const baked = loaded.regions;
  assert.ok(baked);
  assert.equal(baked.radius, RADIUS);
  assert.equal(baked.height, HEIGHT);
  const regions = regionsOf(baked, "outside");
  assert.ok(regions);
  const path = findRegionPath(regions, [72.1, 0, -6.2], stand);
  assert.ok(path, `regions ${regions.regions.length}`);
  const axis: DoorAxis = Math.abs(gate.at.a[0] - gate.at.b[0]) >= Math.abs(gate.at.a[2] - gate.at.b[2]) ? "z" : "x";
  const points = pullString(path, axis);
  assert.deepEqual(points[0], path.start);
  assert.deepEqual(points[points.length - 1], path.goal);

  const boxes = navBoxes(view, scene, open);
  const blockers = boxes.flatMap((box) => {
    const blocks = box.minY === undefined || box.maxY === undefined
      || !(Math.max(box.minY, box.maxY) <= STEP_HEIGHT || Math.min(box.minY, box.maxY) >= HEIGHT);
    if (!blocks) return [];
    return [inflate(box, RADIUS)];
  });
  assert.equal(hitsAny(points, blockers), false, "pulled segment enters a blocker");

  let blockedX: number | undefined;
  for (const block of blockers) {
    if (-6.2 <= block.minZ || -6.2 >= block.maxZ) continue;
    const lo = Math.max(33.6, block.minX);
    const hi = Math.min(72.1, block.maxX);
    if (!(hi - lo > 1e-3)) continue;
    blockedX = (lo + hi) * 0.5;
    break;
  }
  assert.ok(blockedX !== undefined, "the west line never meets a building");
  assert.equal(hitsAny(points, [{ minX: blockedX - 0.05, maxX: blockedX + 0.05, minZ: -6.25, maxZ: -6.15 }]), false);

  const straight = Math.hypot(stand[0] - 72.1, stand[2] + 6.2);
  assert.ok(lengthOf(points) > straight, `length ${lengthOf(points)} straight ${straight}`);
  assert.ok(points.length > 2, "the walk is the straight line");

  const end = points[points.length - 1]!;
  const before = points[points.length - 2]!;
  const share = axis === "x" ? Math.abs(before[0] - end[0]) : Math.abs(before[2] - end[2]);
  assert.ok(share <= 1e-2, `last step ${before.join(",")} -> ${end.join(",")} axis ${axis}`);

  const fromId = gate.b === "outside" ? gate.b : gate.a;
  const toId = gate.b === "outside" ? gate.a : gate.b;
  const cache = createNavCache();
  const legs = planLegs(scene, view, {
    ok: true,
    steps: [{ portal: gate, from: fromId, to: toId, enter: stand, exit: inside }],
    places: [fromId, toId],
    cost: gate.cost,
  }, { x: 72.1, y: 0, z: -6.2 }, { cache, doorsShut: open, regions: baked });
  assert.equal(legs.ok, true, legs.ok ? "" : `step ${legs.step}`);
  if (legs.ok) {
    let cut = legs.points.length;
    for (let i = 0; i < legs.points.length; i += 1) {
      if (Math.hypot(legs.points[i]![0] - stand[0], legs.points[i]![2] - stand[2]) < 0.05) {
        cut = i + 1;
        break;
      }
    }
    assert.ok(cut > 1, "planLegs never reaches the door stand");
    assert.equal(hitsAny(legs.points.slice(0, cut), blockers), false, "planLegs enters a blocker");
    const approach = legs.points[cut - 2]!;
    const atDoor = legs.points[cut - 1]!;
    const lined = axis === "x" ? Math.abs(approach[0] - atDoor[0]) : Math.abs(approach[2] - atDoor[2]);
    assert.ok(lined <= 1e-2, `approach ${approach.join(",")} -> ${atDoor.join(",")}`);
    const built = cache.regions.misses;
    assert.ok(built >= 1);
    planLegs(scene, view, {
      ok: true,
      steps: [{ portal: gate, from: fromId, to: toId, enter: stand, exit: inside }],
      places: [fromId, toId],
      cost: gate.cost,
    }, { x: 72.1, y: 0, z: -6.2 }, { cache, doorsShut: open, regions: baked });
    assert.equal(cache.regions.misses, built);
  }
});

test("planLegs reuses a baked region graph and falls back when it does not connect", () => {
  const from = room("from", 0, 4, 0, 4);
  const to = room("to", 6, 10, 0, 4);
  const scene = emptyGraph([from, to]);
  const step = {
    portal: {
      id: "from-to",
      kind: "opening" as const,
      a: "from",
      b: "to",
      at: { a: [4, 0, 2] as Vec3, b: [6, 0, 2] as Vec3 },
      width: 2,
      cost: 1,
    },
    from: "from",
    to: "to",
    enter: [4, 0, 2] as Vec3,
    exit: [6, 0, 2] as Vec3,
  };
  const route = { ok: true as const, steps: [step], places: ["from", "to"], cost: 1 };
  const view = { aabbs: [] as [], doors: [], pawnRadius: RADIUS, pawnHeight: HEIGHT };
  const openRegions: BakedRegionsFile = {
    version: 1,
    radius: RADIUS,
    height: HEIGHT,
    places: [{
      placeId: "from",
      regions: [{ id: "r0", minX: 0, maxX: 4, minZ: 0, maxZ: 4, y: 0 }],
      portals: [],
    }],
  };
  const cache = createNavCache();
  const walked = planLegs(scene, view, route, { x: 1, y: 0, z: 2 }, { cache, doorsShut: new Set(), regions: openRegions });
  assert.equal(walked.ok, true);
  if (walked.ok) {
    assert.deepEqual(walked.points[0], [1, 0, 2]);
    const last = walked.points[walked.points.length - 1]!;
    assert.ok(Math.hypot(last[0] - 6, last[2] - 2) < 0.5);
  }
  const built = cache.regions.misses;
  assert.ok(built >= 1);
  planLegs(scene, view, route, { x: 1, y: 0, z: 2 }, { cache, doorsShut: new Set(), regions: openRegions });
  assert.equal(cache.regions.misses, built);

  // The bake does not cross the wall, so the leg falls back to the grid and the live box stops it.
  const sealed: BakedRegionsFile = {
    version: 1,
    radius: RADIUS,
    height: HEIGHT,
    places: [{
      placeId: "from",
      regions: [
        { id: "r0", minX: 0, maxX: 2, minZ: 0, maxZ: 4, y: 0 },
        { id: "r1", minX: 2.3, maxX: 4, minZ: 0, maxZ: 4, y: 0 },
      ],
      portals: [],
    }],
  };
  const blocked = planLegs(scene, {
    ...view,
    aabbs: [{ id: 1, minX: 2, maxX: 2.3, minY: 0, maxY: 2, minZ: -2, maxZ: 6 }],
  }, route, { x: 1, y: 0, z: 2 }, { doorsShut: new Set(), regions: sealed });
  assert.deepEqual(blocked, { ok: false, step: 0 });
});

function room(id: string, minX: number, maxX: number, minZ: number, maxZ: number, y = 0): ScenePlace {
  return {
    id,
    kind: "room",
    y,
    polygon: [[minX, minZ], [maxX, minZ], [maxX, maxZ], [minX, maxZ]],
    bounds: { minX, maxX, minZ, maxZ },
  };
}

function emptyGraph(places: SceneGraph["places"]): SceneGraph {
  return {
    formatVersion: 1,
    units: "meters",
    places,
    portals: [],
    placeById: new Map(places.map((place) => [place.id, place])),
    portalsOf: new Map(),
    shafts: [],
    skip: new Set(),
  };
}
