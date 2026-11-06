import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { AuthoritativeWorld } from "conveyor-engine-world";

// Server modules import their siblings as `.js`. Strip-types loads this test
// from source, so those specifiers have to resolve to the `.ts` files.
register(
  "data:text/javascript," +
    encodeURIComponent(`
      import { existsSync } from "node:fs";
      import { fileURLToPath } from "node:url";
      export async function resolve(specifier, context, nextResolve) {
        const parent = context.parentURL ?? "";
        if ((specifier.startsWith("./") || specifier.startsWith("../")) && specifier.endsWith(".js") && parent.includes("/src/")) {
          const ts = specifier.slice(0, -3) + ".ts";
          if (existsSync(fileURLToPath(new URL(ts, parent)))) return nextResolve(ts, context);
        }
        return nextResolve(specifier, context);
      }
    `),
);

const { createNavCache } = await import("../src/shared/nav/legs.ts");
const { doorLeafBox } = await import("../src/shared/doors.ts");
const { steerUnownedWander, wanderFollower } = await import("../src/server/game.ts");

const RADIUS = 0.5;
const HEIGHT = 1.8;
const SPEEDS = { idle: 0, walk: 1, run: 2, fall: 0, angry: 0 };

type Point = readonly [number, number, number];
type Box = { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number };

function pawn(x: number, z: number) {
  const world = new AuthoritativeWorld();
  const id = world.createEntity(0n, { type: "pawn", shape: "capsule" });
  world.enqueue({
    kind: "setTransform",
    entity: id,
    position: { x, y: 0, z },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    scale: { x: 1, y: 1, z: 1 },
  });
  world.enqueue({ kind: "setBounds", entity: id, radius: RADIUS });
  world.commit(0n);
  return {
    world,
    id,
    agent: { id, heading: 0, gait: "walk", nextTurn: 1, speeds: { ...SPEEDS } },
  };
}

function scripted(values: readonly number[]): () => number {
  let index = 0;
  return () => {
    if (index >= values.length) throw new Error(`rng underrun at ${index}`);
    const value = values[index]!;
    index += 1;
    return value;
  };
}

function place(
  id: string,
  minX: number,
  maxX: number,
  minZ: number,
  maxZ: number,
): {
  id: string;
  kind: "room";
  y: number;
  polygon: Array<[number, number]>;
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
} {
  return {
    id,
    kind: "room",
    y: 0,
    polygon: [[minX, minZ], [maxX, minZ], [maxX, maxZ], [minX, maxZ]],
    bounds: { minX, maxX, minZ, maxZ },
  };
}

function outside() {
  return {
    id: "outside" as const,
    kind: "outside" as const,
    y: 0,
    polygon: [[-80, -80], [80, -80], [80, 80], [-80, 80]] as Array<[number, number]>,
    bounds: { minX: -80, maxX: 80, minZ: -80, maxZ: 80 },
  };
}

function graph(
  places: Array<ReturnType<typeof place> | ReturnType<typeof outside>>,
  portals: Array<{
    id: string;
    kind: "door";
    a: string;
    b: string;
    door: string;
    at: { a: Point; b: Point };
    width: number;
    cost: number;
  }>,
) {
  const placeById = new Map(places.map((item) => [item.id, item]));
  const portalsOf = new Map<string, typeof portals>();
  for (const portal of portals) {
    for (const id of [portal.a, portal.b]) {
      const list = portalsOf.get(id) ?? [];
      list.push(portal);
      portalsOf.set(id, list);
    }
  }
  return {
    formatVersion: 1 as const,
    units: "meters" as const,
    places,
    portals,
    placeById,
    portalsOf,
    shafts: [],
    skip: new Set<string>(),
  };
}

function segmentHits(a: Point, b: Point, box: Box): boolean {
  let t0 = 0;
  let t1 = 1;
  const axes: Array<[number, number, number, number]> = [
    [a[0], b[0] - a[0], box.minX, box.maxX],
    [a[1], b[1] - a[1], box.minY, box.maxY],
    [a[2], b[2] - a[2], box.minZ, box.maxZ],
  ];
  for (const [origin, delta, min, max] of axes) {
    if (Math.abs(delta) <= 1e-9) {
      if (origin < min || origin > max) return false;
      continue;
    }
    let near = (min - origin) / delta;
    let far = (max - origin) / delta;
    if (near > far) {
      const swap = near;
      near = far;
      far = swap;
    }
    if (near > t0) t0 = near;
    if (far < t1) t1 = far;
    if (t0 > t1) return false;
  }
  return true;
}

function pathHits(points: readonly Point[], box: Box): boolean {
  for (let i = 1; i < points.length; i += 1) {
    if (segmentHits(points[i - 1]!, points[i]!, box)) return true;
  }
  return false;
}

function inside(x: number, z: number, box: Box): boolean {
  return x > box.minX && x < box.maxX && z > box.minZ && z < box.maxZ;
}

test("a wander goal past a wall follows waypoints around it", () => {
  const wall: Box = { minX: 5, maxX: 7, minY: 0, maxY: 3, minZ: 0, maxZ: 4.5 };
  const scene = graph([place("yard", 0, 12, 0, 10), outside()], []);
  const regions = {
    version: 1 as const,
    radius: RADIUS,
    height: HEIGHT,
    places: [{
      placeId: "yard",
      regions: [
        { id: "w", minX: 0.5, maxX: 3, minZ: 0.5, maxZ: 9.5, y: 0 },
        { id: "e", minX: 9, maxX: 11.5, minZ: 0.5, maxZ: 9.5, y: 0 },
        { id: "n", minX: 3, maxX: 9, minZ: 7, maxZ: 9.5, y: 0 },
      ],
      portals: [
        { from: "w", to: "n", left: [3, 0, 7] as Point, right: [3, 0, 9.5] as Point, width: 2.5 },
        { from: "n", to: "e", left: [9, 0, 7] as Point, right: [9, 0, 9.5] as Point, width: 2.5 },
      ],
    }],
  };
  const nav = {
    sceneGraph: scene,
    regions,
    aabbs: [{ id: 1, ...wall }],
    doors: [],
    pawnRadius: RADIUS,
    pawnHeight: HEIGHT,
  };
  const { world, id, agent } = pawn(1.5, 2);
  const cache = createNavCache();
  // Area weights: west 22.5, east 22.5, north 15. 0.5 lands in the east.
  // x = 9 + 0.6*2.5 = 10.5, z = 0.5 + (1.5/9)*9 = 2.
  const goalX = 10.5;
  const goalZ = 2;
  steerUnownedWander(world, agent, 1, scripted([0.5, 0.6, 1.5 / 9, 0]), nav, cache);
  const path = agent.path;
  assert.ok(path && path.length > 2, `path ${JSON.stringify(path)}`);
  assert.equal(pathHits([[1.5, 0, 2], [goalX, 0, goalZ]], wall), true, "the raw goal line misses the wall");
  assert.equal(pathHits(path, wall), false, `waypoints enter the wall ${JSON.stringify(path)}`);
  assert.ok(agent.goal && Math.hypot(agent.goal.x - goalX, agent.goal.z - goalZ) < 1e-6);
  assert.ok(agent.gait === "walk" || agent.gait === "run");
  assert.notEqual(agent.gait, "fall");

  const follow = wanderFollower(agent);
  assert.ok(follow);
  let x = 1.5;
  let z = 2;
  let sawNorth = false;
  for (let tick = 2; tick <= 320; tick += 1) {
    const yaw = agent.heading;
    const nx = x + Math.sin(yaw) * 0.12;
    const nz = z + Math.cos(yaw) * 0.12;
    assert.equal(inside(nx, nz, wall), false, `step entered the wall at ${nx}, ${nz} from ${x}, ${z} yaw ${yaw}`);
    assert.equal(segmentHits([x, 0, z], [nx, 0, nz], wall), false);
    if (nz > wall.maxZ + 0.5) sawNorth = true;
    x = nx;
    z = nz;
    const view = world.store.view(id)!;
    world.enqueue({
      kind: "setTransform",
      entity: id,
      position: { x, y: 0, z },
      rotation: view.rotation,
      scale: { x: 1, y: 1, z: 1 },
    });
    world.commit(BigInt(tick));
    const goal = agent.goal;
    steerUnownedWander(world, agent, tick, () => {
      throw new Error("follow retargeted before the goal");
    }, nav, cache);
    if (!goal || !agent.goal || agent.goal.x !== goal.x || agent.goal.z !== goal.z) break;
    if (Math.hypot(x - goalX, z - goalZ) < 0.35) break;
  }
  assert.ok(sawNorth, "the walk never went around the wall");
  assert.ok(Math.hypot(x - goalX, z - goalZ) < 0.5, `stopped at ${x}, ${z}`);
  assert.equal(inside(x, z, wall), false);
});

test("a shut door is skipped and an open door is walked through", () => {
  const door = {
    id: "gap",
    model: "door.glb",
    position: [4, 0, 3] as [number, number, number],
    yaw: 90,
    hinge: "left" as const,
    size: [2, 2.2, 2] as [number, number, number],
    open: false,
  };
  const leaf = doorLeafBox(door);
  assert.ok(leaf.minX <= 4.2 && leaf.maxX >= 5.8, `leaf x ${leaf.minX}..${leaf.maxX}`);
  assert.ok(leaf.minZ <= 1.2 && leaf.maxZ >= 2.8, `leaf z ${leaf.minZ}..${leaf.maxZ}`);
  const scene = graph(
    [place("west", 0, 4, 0, 4), place("east", 6, 10, 0, 4), outside()],
    [{
      id: "gap",
      kind: "door",
      a: "west",
      b: "east",
      door: "gap",
      at: { a: [3.5, 0, 2], b: [6.5, 0, 2] },
      width: 2,
      cost: 2,
    }],
  );
  const regions = {
    version: 1 as const,
    radius: RADIUS,
    height: HEIGHT,
    places: [
      { placeId: "west", regions: [{ id: "w", minX: 0.5, maxX: 3.5, minZ: 0.5, maxZ: 3.5, y: 0 }], portals: [] },
      { placeId: "east", regions: [{ id: "e", minX: 6.5, maxX: 9.5, minZ: 0.5, maxZ: 3.5, y: 0 }], portals: [] },
    ],
  };
  const nav = {
    sceneGraph: scene,
    regions,
    aabbs: [
      { id: 1, minX: 4, maxX: 6, minY: 0, maxY: 3, minZ: 0, maxZ: 1 },
      { id: 2, minX: 4, maxX: 6, minY: 0, maxY: 3, minZ: 3, maxZ: 4 },
    ],
    doors: [door],
    pawnRadius: RADIUS,
    pawnHeight: HEIGHT,
  };
  const shut = pawn(2, 2);
  const shutCache = createNavCache();
  // Equal areas. 0.75 picks east (8, 2), which the shut leaf blocks, then 0.25 picks west (0.8, 2.9).
  steerUnownedWander(
    shut.world,
    shut.agent,
    1,
    scripted([0.75, 0.5, 0.5, 0.25, 0.1, 0.8, 0]),
    nav,
    shutCache,
  );
  const shutPath = shut.agent.path;
  assert.ok(shutPath, "shut door left the pawn with no path");
  assert.ok(shut.agent.goal && shut.agent.goal.x < 4, `goal ${JSON.stringify(shut.agent.goal)} is still behind the leaf`);
  assert.notEqual(shut.agent.goal && Math.hypot(shut.agent.goal.x - 8, shut.agent.goal.z - 2) < 1e-6, true);
  assert.equal(pathHits(shutPath, leaf), false, `shut path crosses the leaf ${JSON.stringify(shutPath)}`);
  assert.ok(shutPath.every((point) => point[0] < 4.2), JSON.stringify(shutPath));
  const towardLeaf = Math.atan2(8 - 2, 2 - 2);
  assert.ok(Math.abs(shut.agent.heading - towardLeaf) > 0.4, `heading ${shut.agent.heading} aims through the leaf`);

  door.open = true;
  const open = pawn(2, 2);
  steerUnownedWander(open.world, open.agent, 1, scripted([0.75, 0.5, 0.5, 0]), nav, createNavCache());
  const openPath = open.agent.path;
  assert.ok(openPath && openPath.length > 1, JSON.stringify(openPath));
  assert.ok(open.agent.goal && open.agent.goal.x > 6, JSON.stringify(open.agent.goal));
  let through = false;
  for (let i = 1; i < openPath.length; i += 1) {
    const a = openPath[i - 1]!;
    const b = openPath[i]!;
    if (Math.min(a[0], b[0]) < 5 && Math.max(a[0], b[0]) > 5) {
      assert.ok(Math.abs(a[2] - b[2]) <= 1e-2, `approach ${a.join(",")} -> ${b.join(",")}`);
      assert.ok(a[2] > 1 && a[2] < 3, `opening z ${a[2]}`);
      through = true;
    }
  }
  assert.equal(through, true, `path misses the opening ${JSON.stringify(openPath)}`);
  assert.equal(pathHits(openPath, nav.aabbs[0] as Box), false);
  assert.equal(pathHits(openPath, nav.aabbs[1] as Box), false);

  door.open = false;
  const goalBefore = open.agent.goal;
  steerUnownedWander(open.world, open.agent, 2, scripted([0.25, 0.1, 0.8, 0]), nav, createNavCache());
  assert.ok(open.agent.goal && goalBefore && (open.agent.goal.x !== goalBefore.x || open.agent.goal.z !== goalBefore.z));
  assert.ok(open.agent.goal && open.agent.goal.x < 4, JSON.stringify(open.agent.goal));
  assert.ok(open.agent.path && pathHits(open.agent.path, leaf) === false);
});

test("missing regions or scene graph keeps the heading roll", () => {
  const { world, agent } = pawn(0, 0);
  agent.heading = 1;
  agent.nextTurn = 3;
  const roll = scripted([0.25, 0, 0.5]);
  steerUnownedWander(world, agent, 3, roll);
  assert.equal(agent.heading, 1 + (0.25 - 0.5) * Math.PI);
  assert.equal(agent.gait, "idle");
  assert.equal(agent.nextTurn, 3 + 20 + 15);
  assert.equal(agent.path, undefined);
  assert.equal(agent.goal, undefined);
  const held = agent.heading;
  steerUnownedWander(world, agent, 4, () => {
    throw new Error("heading roll ran before nextTurn");
  });
  assert.equal(agent.heading, held);

  const scene = graph([place("yard", 0, 4, 0, 4), outside()], []);
  const regions = {
    version: 1 as const,
    radius: RADIUS,
    height: HEIGHT,
    places: [{ placeId: "yard", regions: [{ id: "w", minX: 0.5, maxX: 3.5, minZ: 0.5, maxZ: 3.5, y: 0 }], portals: [] }],
  };
  const bare = {
    aabbs: [],
    doors: [],
    pawnRadius: RADIUS,
    pawnHeight: HEIGHT,
  };
  const noRegions = pawn(1, 1);
  noRegions.agent.heading = 0.4;
  noRegions.agent.nextTurn = 1;
  steerUnownedWander(noRegions.world, noRegions.agent, 1, scripted([0, 0, 0]), { ...bare, sceneGraph: scene });
  assert.equal(noRegions.agent.heading, 0.4 + (0 - 0.5) * Math.PI);
  assert.equal(noRegions.agent.path, undefined);

  const noGraph = pawn(1, 1);
  noGraph.agent.heading = 0.4;
  noGraph.agent.nextTurn = 1;
  steerUnownedWander(noGraph.world, noGraph.agent, 1, scripted([1, 4 / 5, 0]), { ...bare, regions });
  assert.equal(noGraph.agent.heading, 0.4 + (1 - 0.5) * Math.PI);
  assert.equal(noGraph.agent.gait, "angry");
  assert.equal(noGraph.agent.path, undefined);
});
