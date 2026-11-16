import assert from "node:assert/strict";
import { test } from "node:test";
import { loadArena } from "../src/server/world-loader.ts";
import { createBotContext, estimateSeconds, groundActions } from "../src/shared/bots/actions.ts";
import { buildWorldState } from "../src/shared/bots/state.ts";
import { reach } from "../src/shared/bots/goals.ts";
import { chooseGoal } from "../src/shared/bots/goap.ts";
import { stopOf } from "../src/shared/scene-graph.ts";

const loaded = loadArena();
const graph = loaded.sceneGraph!;
const portal = graph.portals.find((item) => item.kind === "elevator" && stopOf(item.a) && stopOf(item.b))!;
const shaft = stopOf(portal.b)!.shaft;
const upGoal = reach(portal.b);
const downGoal = reach(portal.a);
const doors = loaded.view.doors.map((door) => ({ id: door.id, open: door.open, locked: door.locked === true }));
const ctx = createBotContext(graph, []);

test("a_stop_goal_grounds_one_ride_to_the_goal_shaft", () => {
  const actions = groundActions(graph, [], [upGoal]);
  const rides = actions.filter((action) => action.id.startsWith("rideTo:"));
  assert.equal(rides.length, 1);
  assert.equal(rides[0]!.id, `rideTo:${shaft}:${portal.b}`);
  assert.ok(actions.length < 100, `action set ${actions.length}`);
  const plan = chooseGoal(buildWorldState({ at: portal.a, pickups: [], doors }), [upGoal], actions, ctx, { maxExpand: 5000 });
  assert.ok(plan);
  assert.deepEqual(plan.steps, [`rideTo:${shaft}:${portal.b}`]);
});

test("a_floor_stop_plans_from_the_lower_hall_through_the_ride", () => {
  const shaftPlace = graph.placeById.get(shaft) as { joins?: Array<string | undefined> } | undefined;
  const start = shaftPlace?.joins?.[stopOf(portal.a)!.index];
  assert.ok(start, "no lower hall for the ride test");
  const state = buildWorldState({ at: start, pickups: [], doors });
  assert.ok(Number.isFinite(estimateSeconds(upGoal, ctx, [], undefined)(state)), "heuristic prunes the ride");
  const plan = chooseGoal(state, [upGoal], groundActions(graph, [], [upGoal]), ctx, { maxExpand: 5000 });
  assert.ok(plan);
  assert.ok(plan.steps.some((id) => id.startsWith("rideTo:")));
});

test("the_descent_uses_the_same_goal_ride", () => {
  const actions = groundActions(graph, [], [downGoal]);
  assert.ok(actions.some((action) => action.id === `goTo:${portal.a}`));
  assert.ok(actions.some((action) => action.id === `goTo:${portal.b}`));
  const plan = chooseGoal(buildWorldState({ at: portal.b, pickups: [], doors }), [downGoal], actions, ctx, { maxExpand: 5000 });
  assert.ok(plan);
  assert.deepEqual(plan.steps, [`rideTo:${shaft}:${portal.a}`]);
});
