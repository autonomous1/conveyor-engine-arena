// Scratch: why does reach:<upper stop> not plan? Door states + on-foot route to the landing.
import { readFileSync } from "node:fs";
import { connectBot } from "../../../packages/bot-client/src/connection.ts";
import { openNodeSocket } from "../../../packages/bot-client/src/node-socket.ts";
import { createBotContext, groundActions } from "../../../src/shared/bots/actions.ts";
import { buildWorldState } from "../../../src/shared/bots/state.ts";
import { chooseGoal } from "../../../src/shared/bots/goap.ts";
import { reach } from "../../../src/shared/bots/goals.ts";
import { stopOf } from "../../../src/shared/scene-graph.ts";

const token = readFileSync("/home/tim/.config/ce-arena/qa-token.pem", "utf8").trim();
const session = await connectBot({ url: "ws://127.0.0.1:4173", token, name: "dev-probe", role: "qa", openSocket: openNodeSocket, onLog: (l) => console.error(l) });
const world = session.world;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const start = Date.now();
while ((!world.self() || !world.sceneGraph()) && Date.now() - start < 5000) await sleep(50);
const graph = world.sceneGraph()!;
const self = world.self()!;
const at = world.placeOf(self)?.id ?? "outside";
console.log("self", self.x.toFixed(2), self.z.toFixed(2), "place", at);
for (const id of ["brutalist-building-1-cbake.door-1-1-9-22-0", "brutalist-building-1-cbake.elevator-1-1.door-1-1-9-22"]) {
  const d = world.door(id);
  console.log("door", id, "open", d?.open, "locked", d?.locked);
}
const doors = world.doors().map((d) => ({ id: d.id, open: d.open, locked: d.locked }));
const state = buildWorldState({ at, pickups: [...world.pickups()], heldKeys: [...world.keys()], doors });
const ctx = createBotContext(graph, world.pickupPlacements() as never);
for (const stop of ["brutalist-building-1-cbake.e1@0", "brutalist-building-1-cbake.e1@1", "brutalist-building-1-cbake.e1@4", "brutalist-building-1-cbake.elevator-1-1"]) {
  const place = graph.placeById.get(stop);
  console.log("place", stop, place ? `${place.kind} y=${place.y}` : "MISSING", "routeCost", ctx.routeCost(at, stop, state));
}
const portals = graph.portals.filter((p) => p.kind === "elevator" && (p.a === "brutalist-building-1-cbake.e1@0" || p.b === "brutalist-building-1-cbake.e1@0"));
console.log("elevator portals touching e1@0", portals.length);
for (const p of portals.slice(0, 6)) console.log(" ", p.id, p.a, "->", p.b, "cost", p.cost, "stopOf", JSON.stringify(stopOf(p.a)), JSON.stringify(stopOf(p.b)));
const goal = reach("brutalist-building-1-cbake.e1@4");
const actions = groundActions(graph, world.pickupPlacements() as never, [goal]);
console.log("actions", actions.length, "ride actions", actions.filter((a) => a.id.startsWith("ride:")).length);
const plan = chooseGoal(state, [goal], actions, ctx, { maxExpand: 5000, now: () => Date.now() });
console.log("plan", plan?.steps, plan?.expanded);
session.close();
