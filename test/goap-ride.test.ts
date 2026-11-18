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
  const state = buildWorldState({ at: portal.b, pickups: [], doors });
  const heuristic = estimateSeconds(downGoal, ctx, [], undefined);
  assert.ok(Number.isFinite(heuristic(state)), "h(start) is Infinity");
  // The brain's call: heuristic and a 250 ms budget (`brain.ts` `planMs`).
  const plan = chooseGoal(state, [downGoal], actions, ctx, {
    minCost: ctx.minActionS,
    heuristic,
    deadlineMs: Date.now() + 250,
    now: () => Date.now(),
  });
  assert.ok(plan, "no plan");
  assert.deepEqual(plan.steps, [`rideTo:${shaft}:${portal.a}`]);
});

const upperHall = [...graph.placeById.values()].find((place) => place.kind === "hall" && place.y > 1);
const lowerHall = [...graph.placeById.values()].find((place) => place.kind === "hall" && place.y === 0);
const outside = graph.placeById.get("outside")!;

test("a_place_goal_on_an_upper_floor_grounds_a_ride", () => {
  assert.ok(upperHall);
  const goal = reach(upperHall.id);
  const actions = groundActions(graph, [], [goal]);
  const ride = actions.find((action) => action.id.startsWith("rideTo:"));
  assert.ok(ride, "no ride action");
  const shaftPlace = graph.placeById.get(ride.id.split(":")[1]!) as { joins?: Array<string | undefined> } | undefined;
  const lower = shaftPlace?.joins?.[0];
  assert.ok(lower, "no lower landing");
  const state = buildWorldState({ at: lower, pickups: [], doors });
  assert.ok(Number.isFinite(estimateSeconds(goal, ctx, [], undefined)(state)));
});;

test("a_ground_floor_place_goal_does_not_ground_a_ride", () => {
  assert.ok(lowerHall);
  const actions = groundActions(graph, [], [reach(lowerHall.id)]);
  assert.equal(actions.some((action) => action.id.startsWith("rideTo:")), false);
});

test("the_live_floor_1_hall_reaches_floor_3", () => {
  const from = graph.placeById.get("brutalist-building-1-cbake.floor-1.hall");
  const to = graph.placeById.get("brutalist-building-1-cbake.floor-3.hall");
  assert.ok(from && to);
  const goal = reach(to.id);
  const actions = groundActions(graph, [], [goal]);
  const state = buildWorldState({ at: from.id, pickups: [], doors });
  const heuristic = estimateSeconds(goal, ctx, [], undefined);
  assert.ok(Number.isFinite(heuristic(state)), "h(start) is Infinity");
  // The brain's call: heuristic and a 250 ms budget (`brain.ts` `planMs`).
  const plan = chooseGoal(state, [goal], actions, ctx, {
    minCost: ctx.minActionS,
    heuristic,
    deadlineMs: Date.now() + 250,
    now: () => Date.now(),
  });
  assert.ok(plan, "no plan");
  assert.equal(plan.steps.length, 3, JSON.stringify(plan.steps));
  assert.ok(plan.steps[0]!.startsWith("goTo:") && plan.steps[0]!.endsWith(".e1@0"), plan.steps[0]);
  assert.ok(plan.steps[1]!.startsWith("rideTo:"), plan.steps[1]);
  assert.equal(plan.steps[2], `goTo:${to.id}`);
});
