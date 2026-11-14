import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ESCAPE_PRIORITY, WANDER_PRIORITY, createMind, judge } from "../src/shared/bots/arbiter.ts";
import { AT, availFact, buildWorldState, hasKeyFact, holdingFact } from "../src/shared/bots/state.ts";
import { parseSceneGraph } from "../src/shared/scene-graph.ts";
import { createRoadCache } from "../src/shared/nav/route.ts";

const calm = { alive: true, place: "hall", msNoProgress: 0, routeOut: { open: true, unlocked: true } };
const walled = { alive: true, place: "hall", msNoProgress: 0, routeOut: { open: false, unlocked: false } };

test("escape_stays_latched_until_outside", () => {
  const mind = createMind();
  // The no-route clock starts on the first walled reading.
  judge(mind, walled, 0);
  const trapped = judge(mind, walled, 60_000);
  assert.equal(trapped.goal, "escape");
  assert.equal(trapped.priority, ESCAPE_PRIORITY);
  // The route opens and the place is unchanged: the latch holds.
  assert.equal(judge(mind, calm, 61_000).goal, "escape");
  const outside = judge(mind, { ...calm, place: "outside" }, 62_000);
  assert.equal(outside.goal, "wander");
  assert.equal(outside.priority, WANDER_PRIORITY);
});

test("world_state_key_sets_both_facts", () => {
  const state = buildWorldState({ at: "outside", pickups: [], doors: [], heldKeys: ["key"] });
  assert.equal(state[AT], "outside");
  assert.equal(state[hasKeyFact("key")], true);
  assert.equal(state[holdingFact("key")], true);
  // Absent facts are omitted; readers treat them as false.
  assert.equal(state[availFact("gone-loot")], undefined);
});

test("road_cache_one_net_per_signature", () => {
  const fixture = JSON.parse(readFileSync("test/fixtures/scene-graph.json", "utf8")) as unknown;
  const doors = [{
    id: "hall-b.door-ext",
    model: "/assets/models/door.glb",
    position: [0, 0, 0] as [number, number, number],
    yaw: 0,
    hinge: "left" as const,
    size: [1, 2, 0.1] as [number, number, number],
    open: false,
    locked: true,
    key: "key",
  }];
  const parsed = parseSceneGraph(fixture, doors);
  assert.deepEqual(parsed.issues, []);
  assert.ok(parsed.graph);
  const cache = createRoadCache(parsed.graph);
  const open = () => "open" as const;
  const locked = () => "locked" as const;
  cache.net(open);
  cache.net(open);
  assert.equal(cache.compiles, 1);
  // `elevators` is part of the signature.
  cache.net(open, true);
  assert.equal(cache.compiles, 2);
  cache.net(open);
  assert.equal(cache.compiles, 2);
  // A changed gate compiles once more.
  cache.net(locked);
  assert.equal(cache.compiles, 3);
});
