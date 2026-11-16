// Scratch: reproduce the stand plan with the live door state and print every step's cost.
import { loadArena } from "../../../src/server/world-loader.ts";
import { createBotContext, groundActions, estimateSeconds, type BotCtx } from "../../../src/shared/bots/actions.ts";
import { chooseGoal, type Action, type WorldState } from "../../../src/shared/bots/goap.ts";
import { buildWorldState, STAND, AT } from "../../../src/shared/bots/state.ts";
import { standAt } from "../../../src/shared/bots/goals.ts";
import { resolveStand, type DoorView } from "../../../src/shared/nav/stand.ts";
import { placeAt } from "../../../src/shared/scene-graph.ts";

const OPEN = ["brutalist-building-1-cbake.door-1-1-9-22-0", "brutalist-building-1-cbake.room-a-1-5-8-9.door-1-1-9-22-5"];
const loaded = loadArena();
const graph = loaded.sceneGraph!;
const doorViews: DoorView[] = (loaded.view.doors ?? []).map((door: any) => ({
  ...door,
  open: OPEN.includes(door.id),
  locked: OPEN.includes(door.id) ? false : door.locked === true,
}));
const pickups = (loaded.view.pickups ?? []) as any[];
const placements = loaded.view.pickups ?? [];

const goal = standAt({ kind: "door", doorId: "brutalist-building-1-cbake.room-a-1-5-8-9.door-1-1-9-22-5", side: "in" });
const stand = resolveStand(goal.stand, graph, doorViews)!;
console.log("stand", JSON.stringify(stand));
const pose = { x: -21.43, y: 0, z: 25.99 };
const at = placeAt(graph, pose.x, pose.y, pose.z).id;
const state = buildWorldState({
  at,
  pickups: pickups.map((p) => p.id),
  doors: doorViews.map((d) => ({ id: d.id, open: d.open === true, locked: d.locked === true })),
});
console.log("at", at, "facts", Object.keys(state).length);

const ctx = createBotContext(graph, placements as any);
console.log("routeCost outside->room", ctx.routeCost("outside", stand.place, state).toFixed(2));
console.log("routeCost outside->hall", ctx.routeCost("outside", "brutalist-building-1-cbake.floor-1.hall", state).toFixed(2));

const actions = groundActions(graph, placements as any, [goal], stand);
console.log("actions", actions.length);
console.log("ids", actions.map((a) => a.id).join(" "));

const opts = {
  minCost: ctx.minActionS,
  heuristic: estimateSeconds(goal, ctx, placements as any),
  maxExpand: 2000,
  deadlineMs: Date.now() + 20000,
  now: () => Date.now(),
};
const t = Date.now();
const plan = chooseGoal(state, [goal], actions, ctx, opts);
console.log("plan", plan?.steps, "cost", plan?.cost, "expanded", plan?.expanded, "ms", Date.now() - t);

// Walk the chosen steps, showing the cost each action would quote from the state it is applied in.
if (plan) {
  let s: WorldState = state;
  for (const id of plan.steps) {
    const action = actions.find((a) => a.id === id) as Action<BotCtx> | undefined;
    if (!action) {
      console.log("missing action", id);
      break;
    }
    const cost = typeof action.cost === "function" ? action.cost(s, ctx) : action.cost;
    const usable = action.usable ? action.usable(s, ctx) : true;
    console.log(`step ${id} at=${String(s[AT])} cost=${Number(cost).toFixed(2)} usable=${usable}`);
    s = { ...s, ...action.eff };
  }
  console.log("final at", String(s[AT]), "stand", s[STAND]);
}

// The two costs that decide the first step.
for (const id of ["goTo:brutalist-building-1-cbake.room-a-1-5-8-9", "goToDoor:brutalist-building-1-cbake-9.door-1-1-9-22-4"]) {
  const action = actions.find((a) => a.id === id);
  console.log(id, action ? `cost=${Number(typeof action.cost === "function" ? action.cost(state, ctx) : action.cost).toFixed(2)} usable=${action.usable ? action.usable(state, ctx) : true}` : "not grounded");
}
