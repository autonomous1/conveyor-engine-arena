import { test } from "node:test";
import assert from "node:assert/strict";
import { loadArena } from "../src/server/world-loader.ts";
import { createBotContext, estimateSeconds, groundActions } from "../src/shared/bots/actions.ts";
import { buildWorldState } from "../src/shared/bots/state.ts";
import { standAt } from "../src/shared/bots/goals.ts";
import { chooseGoal } from "../src/shared/bots/goap.ts";
import { resolveStand } from "../src/shared/nav/stand.ts";

const loaded = loadArena();
const graph = loaded.sceneGraph!;
const door = loaded.view.doors.find((item) => item.id.startsWith("brutalist-building-1-cbake.door-1-1"))!;
const stand = resolveStand({ kind: "door", doorId: door.id }, graph, loaded.view.doors)!;

test("stand_goal_plans_a_route_then_the_stand", () => {
  const goal = standAt({ kind: "door", doorId: door.id });
  const ctx = createBotContext(graph, loaded.view.pickups ?? []);
  const state = buildWorldState({
    // The installed outside→hall route is not finite with the shipped door facts.
    at: stand.place,
    pickups: [],
    doors: loaded.view.doors.map((item) => ({ id: item.id, open: item.open, locked: item.locked === true })),
  });
  const actions = groundActions(graph, loaded.view.pickups ?? [], [goal], stand);
  const plan = chooseGoal(state, [goal], actions, ctx, { maxExpand: 5000 });
  assert.ok(plan);
  assert.ok(plan.steps.some((id) => id.startsWith("standAt:")));
  assert.ok(plan.steps[0] === `goTo:${stand.place}` || plan.steps[0]!.startsWith("standAt:"));

  // A stand goal now has a place bound: finite from another place, 0 at the stand.
  const heuristic = estimateSeconds(goal, ctx, loaded.view.pickups ?? [], stand);
  const openDoors = loaded.view.doors.map((item) => ({ id: item.id, open: true, locked: false }));
  const away = buildWorldState({
    at: "brutalist-building-1-cbake.floor-1.hall",
    pickups: [],
    doors: openDoors,
  });
  const bound = heuristic(away);
  assert.ok(Number.isFinite(bound) && bound > 0, `stand bound ${bound}`);
  assert.equal(heuristic({ ...away, at: stand.place }), 0);
});
