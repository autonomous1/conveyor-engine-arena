import { loadArena } from "../../../src/server/world-loader.ts";
import { createBotContext } from "../../../src/shared/bots/actions.ts";
import { buildWorldState } from "../../../src/shared/bots/state.ts";
const loaded = loadArena();
const graph = loaded.sceneGraph!;
const ctx = createBotContext(graph, (loaded.view.pickups as any) ?? []);
const state = buildWorldState({ at: "outside", pickups: [], doors: (loaded.view.doors ?? []).map((d: any) => ({ id: d.id, open: d.open === true, locked: d.locked === true })) });
for (const [from, to] of [
  ["brutalist-building-1-cbake.e1@4", "brutalist-building-1-cbake.floor-5.hall"],
  ["brutalist-building-1-cbake.e1@0", "brutalist-building-1-cbake.floor-1.hall"],
  ["brutalist-building-1-cbake.e1@0", "brutalist-building-1-cbake.e1@4"],
  ["outside", "brutalist-building-1-cbake.e1@0"],
]) {
  console.log(from, "->", to, ctx.routeCost(from, to, state));
}
const p = graph.placeById.get("brutalist-building-1-cbake.e1@4");
console.log("e1@4 y", p?.y, "kind", p?.kind);
const hall5 = graph.placeById.get("brutalist-building-1-cbake.floor-5.hall");
console.log("floor-5 hall y", hall5?.y);
const portals = graph.portals.filter((x) => x.a === "brutalist-building-1-cbake.e1@4" || x.b === "brutalist-building-1-cbake.e1@4");
console.log("portals at e1@4", portals.map((x) => `${x.kind}:${x.id}`).slice(0, 6), "count", portals.length);
