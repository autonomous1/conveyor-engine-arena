// Scratch: how long does chooseGoal take for standAt on the real graph, and where?
import { readFileSync } from "node:fs";
import { loadArena } from "../../../src/server/world-loader.ts";
import { placeAt } from "../../../src/shared/scene-graph.ts";
import { createBotContext, groundActions, estimateSeconds } from "../../../src/shared/bots/actions.ts";
import { chooseGoal } from "../../../src/shared/bots/goap.ts";
import { buildWorldState } from "../../../src/shared/bots/state.ts";
import { standAt } from "../../../src/shared/bots/goals.ts";
import { resolveStand, type DoorView } from "../../../src/shared/nav/stand.ts";

const loaded = loadArena();
const graph = loaded.sceneGraph!;
const doors = (loaded.view.doors ?? []).map((door: any) => ({ ...door, open: false, locked: door.locked === true }));
const goal = standAt({ kind: "door", doorId: "brutalist-building-1-cbake.door-1-1-9-22-0" });
const stand = resolveStand(goal.stand, graph, doors as DoorView[]);
console.log("stand", stand);
const pose = { x: -2.32, y: 0, z: 2.56 };
const at = placeAt(graph, pose.x, pose.y, pose.z).id;
const state = buildWorldState({
  at,
  pickups: (loaded.view.pickups ?? []).map((p: any) => p.id),
  doors: doors.map((d: any) => ({ id: d.id, open: d.open, locked: d.locked })),
});
let t = Date.now();
const ctx = createBotContext(graph, []);
console.log("context ms", Date.now() - t);
t = Date.now();
const actions = groundActions(graph, [], [goal], stand);
console.log("actions", actions.length, "ms", Date.now() - t);
const opts = {
  minCost: ctx.minActionS,
  heuristic: estimateSeconds(goal, ctx, []),
  maxExpand: 2000,
  now: () => Date.now(),
};
t = Date.now();
const plan = chooseGoal(state, [goal], actions, ctx, opts);
console.log("plan", plan?.steps, "expanded", plan?.expanded, "ms", Date.now() - t);
