import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { ArenaView } from "../src/shared/arena-view.ts";
import { pointInPolygon } from "../dist/shared/elevators.js";
import { loadArena } from "../dist/server/world-loader.js";
import { startArenaServer } from "../dist/server/main.js";
import {
  isElevatorShaft,
  parseSceneGraph,
  placeAt,
  portalsOf,
  type SceneGraph,
  type ScenePortal,
} from "../dist/shared/scene-graph.js";

const fixture = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures/scene-graph.json"), "utf8")) as {
  places: Array<{ id: string; joins?: unknown }>;
  portals: ScenePortal[];
};

function door(locked?: boolean, key?: string): ArenaView["doors"] {
  return [{
    id: "hall-b.door-ext",
    model: "/assets/models/door.glb",
    position: [0, 0, 0],
    yaw: 0,
    hinge: "left",
    size: [1, 2, 0.1],
    open: false,
    ...(locked ? { locked: true } : {}),
    ...(key ? { key } : {}),
  }];
}

function graph(): SceneGraph {
  const parsed = parseSceneGraph(fixture, door(true, "key"));
  assert.equal(parsed.issues.length, 0);
  assert.ok(parsed.graph);
  return parsed.graph;
}

test("parseSceneGraph accepts the hall-b fixture, including a null join hole", () => {
  const parsed = graph();
  assert.equal(portalsOf(parsed, "hall-b.e1").length, 0);
  assert.ok(portalsOf(parsed, "hall-b.room-1").some((portal) => portal.id === "hall-b.door-ext"));
  assert.ok(portalsOf(parsed, "outside").some((portal) => portal.id === "hall-b.door-ext"));

  const holed = structuredClone(fixture);
  const shaft = holed.places.find((place) => place.id === "hall-b.e1");
  assert.ok(shaft);
  shaft.joins = ["hall-b.floor-1.hall", null];
  const again = parseSceneGraph(holed, door(true, "key"));
  assert.equal(again.issues.length, 0);
  assert.ok(again.graph);
  const stored = again.graph.shafts[0];
  assert.ok(stored);
  assert.equal(stored.joins[1], undefined);
});

test("parseSceneGraph rejects a bad portal, a duplicate id, a missing door, and a missing stop", () => {
  const unknown = structuredClone(fixture);
  unknown.portals[0]!.b = "no-such-place";
  const unknownParsed = parseSceneGraph(unknown, door(true, "key"));
  assert.equal(unknownParsed.graph, undefined);
  assert.ok(unknownParsed.issues.some((issue) => issue.path === "scene.sceneGraph.portals.hall-b.door-ext.b" && issue.message === "unknown place no-such-place"));

  const duplicate = structuredClone(fixture);
  duplicate.places.push(structuredClone(duplicate.places[2]!));
  const duplicateParsed = parseSceneGraph(duplicate, door(true, "key"));
  assert.equal(duplicateParsed.graph, undefined);
  assert.ok(duplicateParsed.issues.some((issue) => issue.path === "scene.sceneGraph.places.hall-b.room-1" && issue.message === "duplicate id"));

  const missingDoor = parseSceneGraph(fixture, []);
  assert.equal(missingDoor.graph, undefined);
  assert.ok(missingDoor.issues.some((issue) => issue.path === "scene.sceneGraph.portals.hall-b.door-ext" && issue.message === "unknown door hall-b.door-ext"));

  const missingStop = structuredClone(fixture);
  missingStop.places = missingStop.places.filter((place) => place.id !== "hall-b.e1@1");
  const missingStopParsed = parseSceneGraph(missingStop, door(true, "key"));
  assert.equal(missingStopParsed.graph, undefined);
  assert.ok(missingStopParsed.issues.some((issue) => issue.path === "scene.sceneGraph.places.hall-b.e1" && issue.message === "missing stop place hall-b.e1@1"));
});

test("a door lock that disagrees is reported and the door placement wins", () => {
  const parsed = parseSceneGraph(fixture, door(false));
  assert.ok(parsed.graph);
  assert.ok(parsed.issues.some((issue) => issue.path === "scene.sceneGraph.portals.hall-b.door-ext" && issue.message === "locked disagrees with the door placement"));
  const portal = parsed.graph.portals.find((item) => item.id === "hall-b.door-ext");
  assert.ok(portal);
  assert.equal(portal.locked, undefined);
  assert.equal(portal.key, undefined);
});

test("placeAt prefers the smallest place and names elevator stops", () => {
  const places = graph();
  assert.equal(placeAt(places, 2, 0, 2).id, "hall-b.room-1");
  assert.equal(placeAt(places, 8, 0, 2).id, "hall-b.floor-1.hall");
  assert.equal(placeAt(places, 8, 2.75, 2).id, "hall-b.floor-2.hall");
  assert.equal(placeAt(places, 14, 1.375, 2).id, "hall-b.s1");
  assert.equal(placeAt(places, 30, 0, 30).id, "outside");

  const ground = placeAt(places, 22, 0, 2);
  const upper = placeAt(places, 22, 2.75, 2);
  assert.equal(ground.id, "hall-b.e1@0");
  assert.equal(upper.id, "hall-b.e1@1");
  assert.notEqual(ground.id, "hall-b.e1");
  assert.notEqual(ground.id, "hall-b.lift-room");
  assert.notEqual(upper.id, "hall-b.e1");
  assert.notEqual(upper.id, "hall-b.lift-room");

  const dwell = { id: "hall-b.e1", at: 0, phase: "dwell" as const, y: 0 };
  assert.equal(placeAt(places, 22, 0, 2, [dwell]).id, "hall-b.e1@0");
  assert.equal(placeAt(places, 22, 2.75, 2, [dwell]).id, "hall-b.e1@1");
  const moving = placeAt(places, 22, 1.4, 2, [{ id: "hall-b.e1", at: 0, phase: "moving", y: 1.4 }]);
  assert.equal(moving.id, "hall-b.e1");
  assert.deepEqual(portalsOf(places, moving.id), []);
});

test("the baked graph loads, and placeAt names the floor-3 cab and hall", () => {
  const loaded = loadArena();
  assert.equal(loaded.sceneGraph?.places.length, 150);
  assert.equal(loaded.sceneGraph?.portals.length, 288);
  const graphFile = loaded.sceneGraph;
  assert.ok(graphFile);
  const baked = JSON.parse(readFileSync(new URL("../web/game/scene-graph.json", import.meta.url), "utf8")) as {
    portals: Array<ScenePortal & { door?: string }>;
  };
  const parsed = parseSceneGraph(baked, loaded.view.doors);
  assert.ok(parsed.graph);
  // Room leaves drop locked/key on the view. The bake keeps the placement lock.
  // Those disagreements are the only issues. Building doors match, and the view wins.
  let disagreed = 0;
  for (const portal of baked.portals) {
    if (portal.kind !== "door" || !portal.door) continue;
    const leaf = loaded.view.doors.find((door) => door.id === portal.door);
    assert.ok(leaf, portal.id);
    const sameLock = (portal.locked === true) === (leaf.locked === true);
    const sameKey = (portal.key ?? undefined) === (leaf.key ?? undefined);
    if (sameLock && sameKey) continue;
    disagreed += 1;
    assert.equal(leaf.locked, undefined, portal.id);
    assert.equal(portal.locked, true, portal.id);
  }
  assert.equal(parsed.issues.length, disagreed);
  for (const issue of parsed.issues) {
    assert.equal(issue.message, "locked disagrees with the door placement");
  }
  for (const portal of parsed.graph.portals) {
    if (portal.kind !== "door" || !portal.door) continue;
    const leaf = loaded.view.doors.find((door) => door.id === portal.door);
    assert.ok(leaf);
    assert.equal(portal.locked === true, leaf.locked === true, portal.id);
    assert.equal(portal.key, leaf.key, portal.id);
  }

  const shaft = graphFile.placeById.get("brutalist-building-1-cbake-0.e1");
  assert.ok(shaft && isElevatorShaft(shaft));
  const landing = shaft.landings[2]!;
  assert.equal(landing[1], 6);
  const cx = shaft.polygon.reduce((sum, point) => sum + point[0], 0) / shaft.polygon.length;
  const cz = shaft.polygon.reduce((sum, point) => sum + point[1], 0) / shaft.polygon.length;
  const dx = cx - landing[0];
  const dz = cz - landing[2];
  const len = Math.hypot(dx, dz);
  let entered = len;
  for (let distance = 0.05; distance < len; distance += 0.05) {
    const x = landing[0] + (dx / len) * distance;
    const z = landing[2] + (dz / len) * distance;
    if (!pointInPolygon(shaft.polygon, x, z)) continue;
    entered = distance;
    break;
  }
  // The landing sits outside the shaft. Step onto it, then 0.3 m further toward the cab.
  const inside = entered + 0.3;
  const cabX = landing[0] + (dx / len) * inside;
  const cabZ = landing[2] + (dz / len) * inside;
  assert.equal(pointInPolygon(shaft.polygon, cabX, cabZ), true);
  assert.equal(placeAt(graphFile, cabX, landing[1], cabZ).id, "brutalist-building-1-cbake-0.e1@2");
  const hallX = landing[0] - (dx / len);
  const hallZ = landing[2] - (dz / len);
  assert.equal(placeAt(graphFile, hallX, landing[1], hallZ).id, "brutalist-building-1-cbake-0.floor-3.hall");
});

test("GET /arena.json does not include the scene graph", { timeout: 30_000 }, async () => {
  const host = await startArenaServer(0);
  try {
    const page = await fetch(`${host.url}/arena.json`);
    const body = await page.json() as Record<string, unknown>;
    assert.equal(page.status, 200);
    assert.equal("places" in body, false);
    assert.equal("portals" in body, false);
    assert.equal("sceneGraph" in body, false);
    assert.ok(Array.isArray(body.doors));
  } finally {
    await host.close();
  }
});
