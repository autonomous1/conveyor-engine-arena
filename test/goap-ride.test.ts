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

test("ride_grounds_both_landings_and_plans_both_directions", () => {
  const doors = loaded.view.doors.map((door) => ({ id: door.id, open: door.open, locked: door.locked === true }));
  const upGoal = reach(portal.b);
  const actions = groundActions(graph, [], [upGoal]);
  assert.ok(actions.some((action) => action.id === `goTo:${portal.a}`), "from landing not grounded");
  assert.ok(actions.some((action) => action.id === `goTo:${portal.b}`), "to landing not grounded");

  const ctx = createBotContext(graph, []);
  const up = chooseGoal(buildWorldState({ at: portal.a, pickups: [], doors }), [upGoal], actions, ctx, { maxExpand: 5000 });
  assert.ok(up, "no upward plan");
  assert.equal(up.steps[0], `ride:up:${portal.id}`);

  const downGoal = reach(portal.a);
  const downActions = groundActions(graph, [], [downGoal]);
  const down = chooseGoal(buildWorldState({ at: portal.b, pickups: [], doors }), [downGoal], downActions, ctx, { maxExpand: 5000 });
  assert.ok(down, "no downward plan");
  assert.equal(down.steps[0], `ride:down:${portal.id}`);
});

test("a_floor_stop_plans_from_outside_through_the_ride", () => {
  const goal = reach(portal.b);
  const ctx = createBotContext(graph, []);
  const shaftPlace = graph.placeById.get(stopOf(portal.a)!.shaft) as { joins?: Array<string | undefined> } | undefined;
  const start = shaftPlace?.joins?.[stopOf(portal.a)!.index];
  assert.ok(start, "no lower hall for the ride test");
  const state = buildWorldState({
    at: start, pickups: [],
    doors: loaded.view.doors.map((item) => ({ id: item.id, open: item.open, locked: item.locked === true })),
  });
  assert.ok(Number.isFinite(estimateSeconds(goal, ctx, [], undefined)(state)), "heuristic prunes the ride");
  const plan = chooseGoal(state, [goal], groundActions(graph, [], [goal]), ctx, { maxExpand: 5000 });
  assert.ok(plan);
  assert.ok(plan.steps.some((id) => id.startsWith("ride:")));
});
