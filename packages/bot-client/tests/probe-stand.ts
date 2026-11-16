import { readFileSync } from "node:fs";
import { parseSceneGraph, placeAt } from "../../../src/shared/scene-graph.ts";
import { doorStand } from "../../../src/shared/nav/follow.ts";
const raw=JSON.parse(readFileSync("web/game/scene-graph.json","utf8")) as unknown;
const view=await (await fetch("http://127.0.0.1:4173/arena.json")).json() as {doors:any[]};
const g=parseSceneGraph(raw, view.doors).graph!;
const d=view.doors.find((x:any)=>x.id==="brutalist-building-1-cbake.door-1-1-9-22-0")!;
for(const side of ["out","in"] as const){const s=doorStand(d,side);const p=placeAt(g,s.x,s.y,s.z);console.log(side,s,"place",p.id,p.kind);}
