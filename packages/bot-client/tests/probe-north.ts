import { readFileSync } from "node:fs";
import { loadArena } from "../../../src/server/world-loader.ts";
import { placeAt } from "../../../src/shared/scene-graph.ts";
const loaded = loadArena();
const g = loaded.sceneGraph!;
for (const [x, z] of [[29.92, -4.40], [29.92, -5.00], [29.92, -4.00], [29.92, -3.00]]) {
  const p = placeAt(g, x, 0, z);
  console.log(x, z, "place", p.id, p.kind);
}
const near = (loaded.view.aabbs ?? []).filter((b: any) => b.maxX >= 28 && b.minX <= 32 && b.maxZ >= -6 && b.minZ <= -3);
console.log("aabbs near north", near.length);
for (const b of near.slice(0, 8)) console.log(JSON.stringify(b));
const portals = g.portals.filter((p) => p.a === "brutalist-building-2-cbake.rect21094-3-6" || p.b === "brutalist-building-2-cbake.rect21094-3-6");
for (const p of portals) console.log("portal", p.kind, p.id, p.a, "<->", p.b, JSON.stringify(p.at));
