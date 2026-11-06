import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { doorLeafBox } from "../dist/shared/doors.js";
import { STEP_HEIGHT, type FloorBox } from "../dist/shared/movements.js";
import { navBoxes, shaftBlocks } from "../dist/shared/nav/grid.js";
import {
  findRegionPath,
  overlayShutDoors,
  parseBakedRegions,
  regionsOf,
  type Region,
  type RegionGraph,
  type RegionPath,
} from "../dist/shared/nav/regions.js";
import { loadArena } from "../dist/server/world-loader.js";

const RADIUS = 0.5;
const HEIGHT = 1.8;
const here = dirname(fileURLToPath(import.meta.url));

function loadGraph(name: string): RegionGraph {
  return JSON.parse(readFileSync(join(here, "fixtures", "regions", `${name}.json`), "utf8")) as RegionGraph;
}

function wall(minX: number, maxX: number, minZ: number, maxZ: number, maxY = 2, minY = 0): FloorBox {
  return { minX, maxX, minZ, maxZ, minY, maxY };
}

function regionById(graph: RegionGraph, id: string): Region {
  const region = graph.regions.find((item) => item.id === id);
  assert.ok(region, id);
  return region;
}

function overlaps(a: { minX: number; maxX: number; minZ: number; maxZ: number }, b: { minX: number; maxX: number; minZ: number; maxZ: number }): boolean {
  return Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX) > 1e-4
    && Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ) > 1e-4;
}

function onBoundary(region: Region, point: readonly [number, number, number]): boolean {
  const x = point[0];
  const z = point[2];
  const inX = x >= region.minX - 1e-4 && x <= region.maxX + 1e-4;
  const inZ = z >= region.minZ - 1e-4 && z <= region.maxZ + 1e-4;
  if (!inX || !inZ) return false;
  const onX = Math.abs(x - region.minX) <= 1e-4 || Math.abs(x - region.maxX) <= 1e-4;
  const onZ = Math.abs(z - region.minZ) <= 1e-4 || Math.abs(z - region.maxZ) <= 1e-4;
  return onX || onZ;
}

function assertSequence(graph: RegionGraph, path: RegionPath): void {
  assert.equal(path.portals.length, path.regions.length - 1);
  for (let i = 0; i < path.portals.length; i += 1) {
    const portal = path.portals[i]!;
    assert.equal(portal.from, path.regions[i]);
    assert.equal(portal.to, path.regions[i + 1]);
    assert.ok(portal.width > 0);
    const left = regionById(graph, portal.from);
    const right = regionById(graph, portal.to);
    assert.ok(onBoundary(left, portal.left) && onBoundary(left, portal.right), portal.from);
    assert.ok(onBoundary(right, portal.left) && onBoundary(right, portal.right), portal.to);
  }
}

function inflate(box: FloorBox, radius: number): { minX: number; maxX: number; minZ: number; maxZ: number } {
  return {
    minX: Math.min(box.minX, box.maxX) - radius,
    maxX: Math.max(box.minX, box.maxX) + radius,
    minZ: Math.min(box.minZ, box.maxZ) - radius,
    maxZ: Math.max(box.minZ, box.maxZ) + radius,
  };
}

test("a baked wall graph reaches the far side without covering the box", () => {
  const graph = loadGraph("wall");
  const path = findRegionPath(graph, [1, 0, 10], [19, 0, 10]);
  assert.ok(path);
  assert.ok(path.portals.length >= 1);
  assertSequence(graph, path);
  const blocked = inflate(wall(8, 12, 8, 12), RADIUS);
  for (const id of path.regions) assert.equal(overlaps(regionById(graph, id), blocked), false);
  assert.equal(path.regions.some((id) => {
    const region = regionById(graph, id);
    return 10 >= region.minX && 10 <= region.maxX && 10 >= region.minZ && 10 <= region.maxZ;
  }), false);
});

test("a start inside a blocker snaps within 0.5 m or the search fails", () => {
  const graph = loadGraph("wall");
  assert.equal(findRegionPath(graph, [10, 0, 10], [19, 0, 10]), undefined);

  const snapped = findRegionPath(graph, [8, 0, 10], [19, 0, 10]);
  assert.ok(snapped);
  assert.ok(Math.hypot(snapped.start[0] - 8, snapped.start[2] - 10) <= RADIUS + 1e-6);
  assertSequence(graph, snapped);
  const home = regionById(graph, snapped.regions[0]!);
  assert.ok(snapped.start[0] >= home.minX - 1e-6 && snapped.start[0] <= home.maxX + 1e-6);
  assert.ok(snapped.start[2] >= home.minZ - 1e-6 && snapped.start[2] <= home.maxZ + 1e-6);
});

test("a shut door leaf drops the portal and opening restores the same graph", () => {
  const graph: RegionGraph = {
    placeId: "floor",
    regions: [
      { id: "r0", minX: 0, maxX: 10, minZ: 0, maxZ: 6, y: 0 },
      { id: "r1", minX: 10, maxX: 20, minZ: 0, maxZ: 6, y: 0 },
    ],
    portals: [{ from: "r0", to: "r1", left: [10, 0, 2.5], right: [10, 0, 3.5], width: 1 }],
  };
  const door = {
    id: "door",
    position: [10, 0, 3] as [number, number, number],
    yaw: 0,
    hinge: "left" as const,
    size: [1.6, 2.2, 0.2] as [number, number, number],
  };
  const leaf = doorLeafBox(door);
  const portal = graph.portals[0]!;
  assert.ok(leaf.minX <= portal.left[0] && leaf.maxX >= portal.left[0]);
  assert.ok(Math.min(portal.left[2], portal.right[2]) <= leaf.maxZ);
  assert.ok(Math.max(portal.left[2], portal.right[2]) >= leaf.minZ);

  assert.equal(overlayShutDoors(graph, [door], new Set()), graph);
  assert.equal(overlayShutDoors(graph, [door], new Set(["other"])), graph);
  const open = findRegionPath(graph, [1, 0, 3], [19, 0, 3]);
  assert.ok(open);
  assert.equal(open.portals.length, 1);

  const shut = overlayShutDoors(graph, [door], new Set(["door"]));
  assert.notEqual(shut, graph);
  assert.equal(shut.regions, graph.regions);
  assert.equal(shut.portals.length, 0);
  assert.equal(findRegionPath(shut, [1, 0, 3], [19, 0, 3]), undefined);
  assert.ok(findRegionPath(overlayShutDoors(graph, [door], new Set()), [1, 0, 3], [19, 0, 3]));
});

test("parseBakedRegions rejects a version other than 1", () => {
  const bad = parseBakedRegions({ version: 2, radius: RADIUS, height: HEIGHT, places: [] });
  assert.equal(bad.file, undefined);
  assert.ok(bad.issues.some((issue) => issue.path === "scene.regions.version"));
});

test("arena loads the baked regions file and does not rebuild it", { timeout: 120_000 }, () => {
  const loaded = loadArena();
  const scene = loaded.sceneGraph;
  assert.ok(scene);
  const file = loaded.regions;
  assert.ok(file);
  assert.equal("regions" in loaded.view, false);
  assert.equal(file.version, 1);
  assert.equal(file.radius, RADIUS);
  assert.equal(file.height, HEIGHT);
  assert.equal(loaded.view.pawnRadius, RADIUS);
  assert.equal(loaded.view.pawnHeight, HEIGHT);

  const disk = JSON.parse(readFileSync(join(here, "../web/game/regions.json"), "utf8")) as {
    places: Array<{ placeId: string }>;
  };
  const parsed = parseBakedRegions(disk);
  assert.deepEqual(parsed.issues, []);
  assert.deepEqual(file, parsed.file);
  assert.equal(file.places.length, disk.places.length);
  assert.equal(file.places[0]?.placeId, disk.places[0]?.placeId);
  const ids = file.places.map((place) => place.placeId);
  assert.deepEqual(ids, [...ids].sort());

  const bakedIds = new Set(ids);
  for (const place of scene.places) {
    if (scene.skip.has(place.id) || place.kind === "stairs" || place.kind === "elevator" || place.kind === "landing") {
      assert.equal(bakedIds.has(place.id), false, place.id);
    }
  }

  const outside = regionsOf(file, "outside");
  assert.ok(outside);
  assert.ok(outside.regions.length > 0);
  const portal = scene.portals.find((item) => item.id === "brutalist-building-1-cbake-9.door-1-1-9-22-0");
  assert.ok(portal);
  const stand = portal.b === "outside" ? portal.at.b : portal.at.a;
  const path = findRegionPath(outside, [72.1, 0, -6.2], stand);
  assert.ok(path, `regions ${outside.regions.length}`);
  assertSequence(outside, path);

  const open = new Set<string>();
  const boxes = navBoxes(loaded.view, scene, open);
  const blockers = boxes.flatMap((box) => {
    const blocks = box.minY === undefined || box.maxY === undefined
      || !(Math.max(box.minY, box.maxY) <= STEP_HEIGHT || Math.min(box.minY, box.maxY) >= HEIGHT);
    if (!blocks) return [];
    return [inflate(box, RADIUS)];
  });
  for (const id of path.regions) {
    const region = regionById(outside, id);
    for (const block of blockers) assert.equal(overlaps(region, block), false, `${id} hits a blocker`);
  }

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
  const covered = path.regions.some((id) => {
    const region = regionById(outside, id);
    return blockedX >= region.minX && blockedX <= region.maxX && -6.2 >= region.minZ && -6.2 <= region.maxZ;
  });
  assert.equal(covered, false, `straight west corridor covers ${blockedX}`);

  for (const baked of file.places) {
    const place = scene.placeById.get(baked.placeId);
    assert.ok(place, baked.placeId);
    for (const poly of shaftBlocks(scene, place.bounds, [place.id])) {
      let minX = Infinity;
      let maxX = -Infinity;
      let minZ = Infinity;
      let maxZ = -Infinity;
      for (const [x, z] of poly) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }
      const footprint = { minX, maxX, minZ, maxZ };
      for (const region of baked.regions) {
        assert.equal(overlaps(region, footprint), false, `${baked.placeId} ${region.id} covers a shaft`);
      }
    }
  }
});
