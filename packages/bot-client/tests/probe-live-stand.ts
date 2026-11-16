// Scratch: capture the live world state, then reproduce the stand plan and print its steps + costs.
import { readFileSync } from "node:fs";
import { connectBot } from "../../../packages/bot-client/src/connection.ts";
import { openNodeSocket } from "../../../packages/bot-client/src/node-socket.ts";
import { createBotContext, estimateSeconds, groundActions, type BotCtx } from "../../../src/shared/bots/actions.ts";
import { chooseGoal, type Action, type WorldState } from "../../../src/shared/bots/goap.ts";
import { buildWorldState, AT, STAND } from "../../../src/shared/bots/state.ts";
import { standAt } from "../../../src/shared/bots/goals.ts";
import { resolveStand, type DoorView } from "../../../src/shared/nav/stand.ts";

const token = readFileSync("/home/tim/.config/ce-arena/qa-token.pem", "utf8").trim();
const session = await connectBot({ url: "ws://127.0.0.1:4173", token, name: "dev-probe", role: "qa", openSocket: openNodeSocket, onLog: (l) => console.error(l) });
const world = session.world;
const wait = async (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const start = Date.now();
while (!world.self() || !world.sceneGraph() || Date.now() - start < 800) await wait(50);
const self = world.self()!;
const graph = world.sceneGraph()!;
const at = world.placeOf(self)?.id ?? "outside";
const doors = world.doors().map((row) => ({ id: row.id, open: row.open, locked: row.locked }));
const pickups = [...world.pickups()];
const keys = [...world.keys()];
const state = buildWorldState({
  at,
  pickups,
  heldKeys: keys,
  doors,
  weapon: world.weapon(),
  ammo: world.ammo(),
});
console.log("live at", at, "self", self.x.toFixed(2), self.z.toFixed(2), "doors open", doors.filter((d) => d.open).length, "keys", keys.join(",") || "none");
const goal = standAt({ kind: "point", x: -39.6, y: 0, z: 22.6 });
const views: DoorView[] = [];
for (const row of world.doors()) {
  const body = world.doorBody(row.id);
  if (body) views.push({ ...body, open: row.open, locked: row.locked });
}
const stand = resolveStand(goal.stand, graph, views, { from: { x: self.x, y: self.y, z: self.z } })!;
console.log("stand", stand.place, stand.x.toFixed(2), stand.z.toFixed(2));
const ctx = createBotContext(graph, world.pickupPlacements() as never);
console.log("routeCost outside->stand.place", ctx.routeCost("outside", stand.place, state).toFixed(2));
const actions = groundActions(graph, world.pickupPlacements() as never, [goal], stand);
console.log("actions", actions.length);
const opts = {
  minCost: ctx.minActionS,
  heuristic: estimateSeconds(goal, ctx, world.pickupPlacements() as never),
  maxExpand: 2000,
  deadlineMs: Date.now() + 20000,
  now: () => Date.now(),
};
const t = Date.now();
const plan = chooseGoal(state, [goal], actions, ctx, opts);
console.log("plan", plan?.steps, "cost", plan?.cost, "expanded", plan?.expanded, "ms", Date.now() - t);
if (plan) {
  let s: WorldState = state;
  let total = 0;
  for (const id of plan.steps) {
    const rows = actions.filter((a) => a.id === id) as Action<BotCtx>[];
    const scored = rows.map((action) => {
      const cost = typeof action.cost === "function" ? Number(action.cost(s, ctx)) : Number(action.cost);
      const usable = action.usable ? action.usable(s, ctx) : true;
      return { action, cost, usable };
    }).sort((a, b) => a.cost - b.cost);
    const pick = scored.find((row) => row.usable && Number.isFinite(row.cost));
    const atNow = String(s[AT]);
    console.log(`  step ${id} from at=${atNow} doorSide=${atNow.startsWith("door:") ? String(s["doorSide:" + atNow.slice(5)]) : "-"}`);
    if (atNow.startsWith("door:")) {
      const doorId = atNow.slice(5);
      const fakeOut = { ...s, ["doorSide:" + doorId]: "outside" };
      const fakeHall = { ...s, ["doorSide:" + doorId]: "brutalist-building-1-cbake.floor-1.hall" };
      console.log(`    routeCost(token, room) with doorSide=outside ${ctx.routeCost(atNow, "brutalist-building-1-cbake.room-a-1-5-8-9", fakeOut).toFixed(2)} with doorSide=hall ${ctx.routeCost(atNow, "brutalist-building-1-cbake.room-a-1-5-8-9", fakeHall).toFixed(2)}`);
    }
    for (const row of scored) console.log(`    instance cost=${row.cost.toFixed(2)} usable=${row.usable} -> at=${String(row.action.eff[AT])} doorSide=${String(row.action.eff["doorSide:brutalist-building-1-cbake.door-1-1-9-22-0"] ?? row.action.eff["doorSide:brutalist-building-1-cbake-9.door-1-1-9-22-4"] ?? "")}`);
    if (!pick) { console.log("    no usable instance"); break; }
    total += pick.cost;
    s = { ...s, ...pick.action.eff };
  }
  console.log("  replay total", total.toFixed(2), "plan cost", plan.cost.toFixed(2), "final at", String(s[AT]), "stand", s[STAND]);
}
for (const id of ["goTo:brutalist-building-1-cbake.room-a-1-5-8-9", "pickup:key", "goToDoor:brutalist-building-1-cbake-9.door-1-1-9-22-4"]) {
  const action = actions.find((a) => a.id === id) as Action<BotCtx> | undefined;
  console.log(id, action ? `cost=${Number(typeof action.cost === "function" ? action.cost(state, ctx) : action.cost).toFixed(2)} usable=${action.usable ? action.usable(state, ctx) : true}` : "not grounded");
}
session.close();
