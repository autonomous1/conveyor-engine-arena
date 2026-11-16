import { readFileSync } from "node:fs";
import { parseSceneGraph, placeAt } from "../../../src/shared/scene-graph.ts";
import { doorStand } from "../../../src/shared/nav/follow.ts";
const raw = JSON.parse(readFileSync("web/game/scene-graph.json", "utf8")) as unknown;
const view = await (await fetch("http://127.0.0.1:4173/arena.json")).json() as any;
const g = parseSceneGraph(raw, view.doors).graph!;
const id = "brutalist-building-1-cbake.room-a-1-5-8-9.door-1-1-9-22-5";
const body = view.doors.find((d: any) => d.id === id);
console.log("body", JSON.stringify(body));
for (const side of ["out", "in"] as const) {
  const s = doorStand(body, side);
  console.log(side, s.x.toFixed(2), s.y.toFixed(2), s.z.toFixed(2), "place", placeAt(g, s.x, s.y, s.z).id);
}
const portal = g.portals.find((p: any) => p.door === id);
console.log("portal", JSON.stringify(portal));
