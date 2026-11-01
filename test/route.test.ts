import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { ArenaView } from "../src/shared/arena-view.ts";
import {
  isElevatorShaft,
  parseSceneGraph,
  placeAt,
  type SceneGraph,
  type ScenePlace,
  type ScenePortal,
} from "../dist/shared/scene-graph.js";
import { planRoute, type Gate, type Route } from "../dist/shared/nav/route.js";

const fixtureDir = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(fixtureDir, "fixtures/scene-graph.json"), "utf8")) as {
  portals: ScenePortal[];
};

const fromOutside = { x: -5, y: 0, z: -5 };

function doorRows(): ArenaView["doors"] {
  return [{
    id: "hall-b.door-ext",
    model: "/assets/models/door.glb",
    position: [0, 0, 0],
    yaw: 0,
    hinge: "left",
    size: [1, 2, 0.1],
    open: false,
    locked: true,
    key: "key",
  }];
}

function baseGraph(): SceneGraph {
  const parsed = parseSceneGraph(fixture, doorRows());
  assert.equal(parsed.issues.length, 0);
  assert.ok(parsed.graph);
  return parsed.graph;
}

function roofPlace(): ScenePlace {
  return {
    id: "hall-b.roof-1",
    kind: "platform",
    y: 5.5,
    polygon: [[30, 30], [34, 30], [34, 34], [30, 34]],
    bounds: { minX: 30, maxX: 34, minZ: 30, maxZ: 34 },
  };
}

function portal(fields: ScenePortal): ScenePortal {
  return fields;
}

/** Fixture places, plus the links the hall-b scenarios walk. */
function hallGraph(elevatorCost = 1): SceneGraph {
  const graph = baseGraph();
  const roof = roofPlace();
  graph.places.push(roof);
  graph.placeById.set(roof.id, roof);
  const portals: ScenePortal[] = [
    portal({
      id: "hall-b.door-main",
      kind: "opening",
      a: "outside",
      b: "hall-b.floor-1.hall",
      at: { a: [-5, 0, -5], b: [1, 0, 2] },
      width: 1,
      cost: 1,
    }),
    portal({
      id: "hall-b.room-1.door-1",
      kind: "door",
      a: "hall-b.floor-1.hall",
      b: "hall-b.room-1",
      door: "hall-b.room-1.door-1",
      locked: true,
      key: "key",
      at: { a: [2, 0, 2], b: [2, 0, 2] },
      width: 1,
      cost: 1,
    }),
    portal({
      id: "hall-b.s1:bottom",
      kind: "landing",
      a: "hall-b.floor-1.hall",
      b: "hall-b.s1",
      at: { a: [9, 0, 2], b: [12, 0, 2] },
      width: 2,
      cost: 4,
    }),
    portal({
      id: "hall-b.s1:top",
      kind: "landing",
      a: "hall-b.s1",
      b: "hall-b.floor-2.hall",
      at: { a: [14, 2.75, 2], b: [4, 2.75, 2] },
      width: 2,
      cost: 4,
    }),
    portal({
      id: "hall-b.s1:roof",
      kind: "landing",
      a: "hall-b.s1",
      b: "hall-b.roof-1",
      at: { a: [14, 2.75, 2], b: [32, 5.5, 32] },
      width: 2,
      cost: 1,
    }),
    portal({
      id: "hall-b.e1:0-1",
      kind: "elevator",
      a: "hall-b.e1@0",
      b: "hall-b.e1@1",
      at: { a: [22, 0, 2], b: [22, 2.75, 2] },
      width: 1.5,
      cost: elevatorCost,
    }),
    portal({
      id: "hall-b.e1@0:landing",
      kind: "landing",
      a: "hall-b.e1@0",
      b: "hall-b.floor-1.hall",
      at: { a: [22, 0, 2], b: [1.5, 0, 2] },
      width: 1.5,
      cost: 0.25,
    }),
    portal({
      id: "hall-b.e1@1:landing",
      kind: "landing",
      a: "hall-b.e1@1",
      b: "hall-b.floor-2.hall",
      at: { a: [22, 2.75, 2], b: [8, 2.75, 2] },
      width: 1.5,
      cost: 0.25,
    }),
  ];
  portals.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  graph.portals = portals;
  const linked = new Map<string, ScenePortal[]>();
  for (const item of portals) {
    pushLink(linked, item.a, item);
    if (item.b !== item.a) pushLink(linked, item.b, item);
  }
  graph.portalsOf = linked;
  return graph;
}

function rectPlace(
  id: string,
  kind: ScenePlace["kind"],
  y: number,
  minX: number,
  maxX: number,
  minZ: number,
  maxZ: number,
): ScenePlace {
  return {
    id,
    kind,
    y,
    polygon: [[minX, minZ], [maxX, minZ], [maxX, maxZ], [minX, maxZ]],
    bounds: { minX, maxX, minZ, maxZ },
  };
}

/** Two flights joined by a mid landing. The halls do not touch the landing polygon. */
function switchbackRoute(): SceneGraph {
  const hall1 = rectPlace("b.floor-1.hall", "hall", 0, 0, 4, 0, 4);
  const mid = rectPlace("b.s1-mid", "landing", 1.5, 6, 10, 2, 5);
  const hall2 = rectPlace("b.floor-2.hall", "hall", 3, 0, 4, 6, 10);
  const s1a: ScenePlace = {
    ...rectPlace("b.s1a", "stairs", 0, 6, 8, 0, 2),
    top: 1.5,
    width: 1.2,
    run: 2,
    landings: { bottom: [7, 0, 0.4], top: [7, 1.5, 2.4] },
    joins: { from: "b.floor-1.hall", to: "b.s1-mid" },
  };
  const s1b: ScenePlace = {
    ...rectPlace("b.s1b", "stairs", 1.5, 6, 8, 6, 8),
    top: 3,
    width: 1.2,
    run: 2,
    landings: { bottom: [7, 1.5, 5.6], top: [7, 3, 8.4] },
    joins: { from: "b.s1-mid", to: "b.floor-2.hall" },
  };
  const outside = rectPlace("outside", "outside", 0, -100, 100, -100, 100);
  const places = [outside, hall1, s1a, mid, s1b, hall2];
  const portals: ScenePortal[] = [
    portal({
      id: "b.s1a:bottom",
      kind: "landing",
      a: "b.floor-1.hall",
      b: "b.s1a",
      at: { a: [2, 0, 2], b: [7, 0, 0.4] },
      width: 1.2,
      cost: 0.5,
    }),
    portal({
      id: "b.s1a:top",
      kind: "landing",
      a: "b.s1a",
      b: "b.s1-mid",
      at: { a: [7, 1.5, 2.4], b: [7, 1.5, 3] },
      width: 1.2,
      cost: 2,
    }),
    portal({
      id: "b.s1b:bottom",
      kind: "landing",
      a: "b.s1-mid",
      b: "b.s1b",
      at: { a: [7, 1.5, 4], b: [7, 1.5, 5.6] },
      width: 1.2,
      cost: 0.5,
    }),
    portal({
      id: "b.s1b:top",
      kind: "landing",
      a: "b.s1b",
      b: "b.floor-2.hall",
      at: { a: [7, 3, 8.4], b: [2, 3, 8] },
      width: 1.2,
      cost: 2,
    }),
  ];
  const linked = new Map<string, ScenePortal[]>();
  for (const item of portals) {
    pushLink(linked, item.a, item);
    if (item.b !== item.a) pushLink(linked, item.b, item);
  }
  return {
    formatVersion: 1,
    units: "meters",
    places,
    portals,
    placeById: new Map(places.map((place) => [place.id, place])),
    portalsOf: linked,
    shafts: [],
    skip: new Set(),
  };
}

function pushLink(map: Map<string, ScenePortal[]>, id: string, item: ScenePortal): void {
  const list = map.get(id);
  if (list) list.push(item);
  else map.set(id, [item]);
}

/** Elevators report open. The planner still skips them unless asked. */
function gate(held: boolean): (portal: ScenePortal) => Gate {
  return (portal) => {
    if (portal.locked) return held ? "locked-have-key" : "locked";
    if (portal.kind === "door") return "closed-unlocked";
    return "open";
  };
}

function ids(route: Route): string[] {
  return route.ok ? route.steps.map((step) => step.portal.id) : [];
}

test("a locked room door is a blocker, and a held key uses it", () => {
  const graph = hallGraph();
  const blocked = planRoute(graph, fromOutside, "hall-b.room-1", gate(false));
  assert.equal(blocked.ok, false);
  if (blocked.ok) return;
  assert.equal(blocked.reason, "no-route");
  assert.deepEqual(blocked.lockedAlternative?.doors, [{ door: "hall-b.room-1.door-1", key: "key" }]);

  const held = planRoute(graph, fromOutside, "hall-b.room-1", gate(true));
  assert.equal(held.ok, true);
  if (!held.ok) return;
  assert.deepEqual(ids(held), ["hall-b.door-main", "hall-b.room-1.door-1"]);
  assert.equal(held.steps[1]?.from, "hall-b.floor-1.hall");
  assert.equal(held.steps[1]?.to, "hall-b.room-1");
  assert.equal(held.lockedAlternative, undefined);
});

test("floor-1 hall reaches floor-2 through a landing between two stairs", () => {
  const graph = switchbackRoute();
  assert.equal(placeAt(graph, 1, 0, 1).id, "b.floor-1.hall");
  assert.equal(placeAt(graph, 7, 1.5, 3).id, "b.s1-mid");
  const route = planRoute(graph, { x: 1, y: 0, z: 1 }, "b.floor-2.hall", () => "open");
  assert.equal(route.ok, true);
  if (!route.ok) return;
  assert.deepEqual(route.places, [
    "b.floor-1.hall",
    "b.s1a",
    "b.s1-mid",
    "b.s1b",
    "b.floor-2.hall",
  ]);
  assert.deepEqual(ids(route), ["b.s1a:bottom", "b.s1a:top", "b.s1b:bottom", "b.s1b:top"]);
});

test("outside to the roof crosses the s1 landings", () => {
  const route = planRoute(hallGraph(), fromOutside, "hall-b.roof-1", gate(false));
  assert.equal(route.ok, true);
  if (!route.ok) return;
  assert.ok(ids(route).includes("hall-b.s1:bottom"));
  assert.ok(ids(route).includes("hall-b.s1:roof"));
  assert.equal(route.steps.some((step) => step.portal.kind === "elevator"), false);
});

test("the elevator is used only when enabled and cheaper than the stairs", () => {
  const graph = hallGraph(1);
  const stairs = planRoute(graph, fromOutside, "hall-b.floor-2.hall", gate(false));
  const ride = planRoute(graph, fromOutside, "hall-b.floor-2.hall", gate(false), { elevators: true });
  assert.equal(stairs.ok, true);
  assert.equal(ride.ok, true);
  if (!stairs.ok || !ride.ok) return;
  assert.equal(stairs.steps.some((step) => step.portal.kind === "elevator"), false);
  assert.ok(ids(stairs).includes("hall-b.s1:bottom"));
  assert.ok(ids(stairs).includes("hall-b.s1:top"));
  assert.ok(ride.steps.some((step) => step.portal.kind === "elevator"));
  assert.ok(ride.cost < stairs.cost);

  const costly = planRoute(hallGraph(1000), fromOutside, "hall-b.floor-2.hall", gate(false), { elevators: true });
  assert.equal(costly.ok, true);
  if (!costly.ok) return;
  assert.equal(costly.steps.some((step) => step.portal.kind === "elevator"), false);
  assert.ok(ids(costly).includes("hall-b.s1:bottom"));
});

test("a moving cab waits at the stop it is heading to", () => {
  const graph = hallGraph();
  const feet = { x: 22, y: 1.4, z: 2 };
  const cabs = [{ id: "hall-b.e1", at: 0, target: 1, phase: "moving" as const, y: 1.4 }];
  assert.equal(placeAt(graph, feet.x, feet.y, feet.z, cabs).id, "hall-b.e1");
  assert.equal(isElevatorShaft(placeAt(graph, feet.x, feet.y, feet.z, cabs)), true);

  const route = planRoute(graph, feet, "hall-b.floor-2.hall", gate(false), { cabs });
  assert.equal(route.ok, true);
  if (!route.ok) return;
  assert.equal(route.places[0], "hall-b.e1@1");
  assert.equal(route.steps[0]?.portal.id, "hall-b.e1@1:landing");
  assert.equal(route.steps.some((step) => step.portal.kind === "elevator"), false);
});

test("equal-cost alternatives stay on the smaller place id", () => {
  const graph = makeGraph(
    [
      outside(),
      room("start", -1, -1, 0.5, 1),
      room("a-room", 10, 10, 11, 11),
      room("z-room", 12, 10, 13, 11),
      room("goal", 14, 10, 15, 11),
    ],
    [
      link("a-to-z", "opening", "start", "z-room", [0, 0, 0], [1, 0, 0], 1),
      link("b-to-a", "opening", "start", "a-room", [0, 0, 0], [1, 0, 0], 1),
      link("a-to-goal", "opening", "a-room", "goal", [1, 0, 0], [2, 0, 0], 1),
      link("z-to-goal", "opening", "z-room", "goal", [1, 0, 0], [2, 0, 0], 1),
    ],
  );
  const open = () => planRoute(graph, { x: 0, y: 0, z: 0 }, "goal", () => "open");
  const first = open();
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.steps[0]?.portal.id, "b-to-a");
  assert.equal(first.steps[0]?.to, "a-room");
  for (let i = 0; i < 100; i += 1) {
    assert.deepEqual(open(), first);
  }
});

test("a cheaper locked door is reported beside the open route", () => {
  const graph = makeGraph(
    [outside(), room("start", 0, 0, 2, 2), room("mid", 10, 0, 12, 2), room("goal", 4, 4, 6, 6)],
    [
      link("long-a", "opening", "start", "mid", [1, 0, 1], [11, 0, 1], 50),
      link("long-b", "opening", "mid", "goal", [11, 0, 1], [5, 0, 5], 50),
      link("short-door", "door", "start", "goal", [1, 0, 1], [5, 0, 5], 1, { door: "short-door", locked: true, key: "key" }),
    ],
  );
  const route = planRoute(graph, { x: 1, y: 0, z: 1 }, "goal", gate(false));
  assert.equal(route.ok, true);
  if (!route.ok) return;
  assert.deepEqual(ids(route), ["long-a", "long-b"]);
  assert.equal(route.cost, 100);
  assert.equal(route.lockedAlternative?.cost, 2.5);
  assert.deepEqual(route.lockedAlternative?.doors, [{ door: "short-door", key: "key" }]);
});

test("penalties add the walk between at points to the portal cost", () => {
  const graph = makeGraph(
    [outside(), room("a", 0, -1, 4, 1), room("b", 2, 2, 4, 4)],
    [link("gap", "door", "a", "b", [3, 0, 0], [3, 0, 3], 10, { door: "gap" })],
  );
  const from = { x: 1, y: 0, z: 0 };
  const open = planRoute(graph, from, "b", () => "open");
  const closed = planRoute(graph, from, "b", () => "closed-unlocked");
  const keyed = planRoute(graph, from, "b", () => "locked-have-key");
  assert.equal(open.ok && open.cost, 12);
  assert.equal(closed.ok && closed.cost, 13);
  assert.equal(keyed.ok && keyed.cost, 13.5);
});

test("unknown and disconnected targets do not invent a route", () => {
  const graph = makeGraph(
    [outside(), room("a", 0, 0, 2, 2), room("island", 20, 20, 22, 22)],
    [],
  );
  assert.deepEqual(planRoute(graph, { x: 1, y: 0, z: 1 }, "missing", () => "open"), {
    ok: false,
    reason: "unknown-target",
  });
  assert.deepEqual(planRoute(graph, { x: 1, y: 0, z: 1 }, "island", () => "open"), {
    ok: false,
    reason: "no-route",
  });
  const here = planRoute(graph, { x: 1, y: 0, z: 1 }, "a", () => "open");
  assert.deepEqual(here, { ok: true, steps: [], places: ["a"], cost: 0 });
});

test("a 200-place grid plans within the CI limit", () => {
  const cols = 20;
  const places: ScenePlace[] = [];
  const portals: ScenePortal[] = [];
  for (let i = 0; i < 200; i += 1) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    places.push(room(`n${i}`, col, row, col + 0.8, row + 0.8));
    const here: [number, number, number] = [col + 0.4, 0, row + 0.4];
    if (col + 1 < cols) {
      const right = i + 1;
      const there: [number, number, number] = [col + 1.4, 0, row + 0.4];
      portals.push(link(`h-${i}-${right}`, "opening", `n${i}`, `n${right}`, here, there, 1));
    }
    if (row + 1 < 10) {
      const up = i + cols;
      const there: [number, number, number] = [col + 0.4, 0, row + 1.4];
      portals.push(link(`v-${i}-${up}`, "opening", `n${i}`, `n${up}`, here, there, 1));
    }
  }
  const graph = makeGraph([outside(-1, -1, 21, 12), ...places], portals);
  const from = { x: 0.4, y: 0, z: 0.4 };
  const open = () => planRoute(graph, from, "n199", () => "open");
  let route = open();
  let best = Infinity;
  for (let i = 0; i < 5; i += 1) {
    const started = performance.now();
    route = open();
    best = Math.min(best, performance.now() - started);
  }
  assert.equal(route.ok, true);
  if (route.ok) assert.equal(route.places.at(-1), "n199");
  // 5 ms target, three times that for a busy CI runner. Take the fastest sample.
  assert.ok(best < 15, `planned in ${best}ms`);
});

test("nav imports neither the server nor the client", () => {
  const dir = join(fixtureDir, "../src/shared/nav");
  const files = readdirSync(dir).filter((name) => name.endsWith(".ts"));
  assert.ok(files.length > 0);
  for (const name of files) {
    const text = readFileSync(join(dir, name), "utf8");
    assert.doesNotMatch(text, /from ["'][^"']*\/server\//);
    assert.doesNotMatch(text, /from ["'][^"']*\/client\//);
    assert.doesNotMatch(text, /src\/server\//);
    assert.doesNotMatch(text, /src\/client\//);
  }
});

test("a locked building-2 room door names the key", () => {
  const baked = JSON.parse(readFileSync(join(fixtureDir, "../web/game/scene-graph.json"), "utf8")) as {
    portals: ScenePortal[];
  };
  const parsed = parseSceneGraph(baked, doorsMatching(baked.portals));
  assert.ok(parsed.graph);
  const graph = parsed.graph;
  let found = false;
  for (const portal of graph.portals) {
    if (portal.kind !== "door" || portal.locked !== true || portal.key !== "key") continue;
    if (!portal.door?.startsWith("brutalist-building-2-cbake")) continue;
    const roomSide = graph.placeById.get(portal.a)?.kind === "room"
      ? "a"
      : graph.placeById.get(portal.b)?.kind === "room"
        ? "b"
        : undefined;
    if (!roomSide) continue;
    const other = roomSide === "a" ? "b" : "a";
    const at = portal.at[other];
    const route = planRoute(
      graph,
      { x: at[0], y: at[1], z: at[2] },
      portal[roomSide],
      (item) => {
        if (item.kind === "elevator") return "unusable";
        if (item.locked) return "locked";
        if (item.kind === "door") return "closed-unlocked";
        return "open";
      },
    );
    const hit = route.lockedAlternative?.doors.some((door) => door.door === portal.door && door.key === "key");
    if (!hit) continue;
    found = true;
    break;
  }
  assert.equal(found, true);
});

function doorsMatching(portals: readonly ScenePortal[]): ArenaView["doors"] {
  const byId = new Map<string, ArenaView["doors"][number]>();
  for (const portal of portals) {
    if (portal.kind !== "door" || !portal.door || byId.has(portal.door)) continue;
    byId.set(portal.door, {
      id: portal.door,
      model: "/assets/models/door.glb",
      position: [0, 0, 0],
      yaw: 0,
      hinge: "left",
      size: [1, 2, 0.1],
      open: false,
      ...(portal.locked ? { locked: true, ...(portal.key ? { key: portal.key } : {}) } : {}),
    });
  }
  return [...byId.values()];
}

function outside(minX = -20, minZ = -20, maxX = 40, maxZ = 40): SceneGraph["places"][number] {
  return {
    id: "outside",
    kind: "outside",
    y: 0,
    polygon: [[minX, minZ], [maxX, minZ], [maxX, maxZ], [minX, maxZ]],
    bounds: { minX, maxX, minZ, maxZ },
  };
}

function room(id: string, minX: number, minZ: number, maxX: number, maxZ: number, y = 0): ScenePlace {
  return {
    id,
    kind: "room",
    y,
    polygon: [[minX, minZ], [maxX, minZ], [maxX, maxZ], [minX, maxZ]],
    bounds: { minX, maxX, minZ, maxZ },
  };
}

function link(
  id: string,
  kind: ScenePortal["kind"],
  a: string,
  b: string,
  atA: [number, number, number],
  atB: [number, number, number],
  cost: number,
  lock?: { door: string; locked?: boolean; key?: string },
): ScenePortal {
  return {
    id,
    kind,
    a,
    b,
    ...(lock?.door ? { door: lock.door } : {}),
    ...(lock?.locked ? { locked: true } : {}),
    ...(lock?.key ? { key: lock.key } : {}),
    at: { a: atA, b: atB },
    width: 1,
    cost,
  };
}

function makeGraph(places: SceneGraph["places"], portals: ScenePortal[]): SceneGraph {
  const sorted = [...portals].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const placeById = new Map(places.map((place) => [place.id, place]));
  const linked = new Map<string, ScenePortal[]>();
  for (const item of sorted) {
    pushLink(linked, item.a, item);
    if (item.b !== item.a) pushLink(linked, item.b, item);
  }
  const shafts = places.filter(isElevatorShaft);
  const skip = new Set<string>();
  for (const shaft of shafts) {
    skip.add(shaft.id);
    if (shaft.room) skip.add(shaft.room);
  }
  return {
    formatVersion: 1,
    units: "meters",
    places,
    portals: sorted,
    placeById,
    portalsOf: linked,
    shafts,
    skip,
  };
}
