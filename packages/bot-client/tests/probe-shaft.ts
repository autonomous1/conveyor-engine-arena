// Scratch: is the legs waypoint inside a blocked shaft cell, and does the hall region graph cover the shaft?
import { readFileSync } from "node:fs";
import { parseSceneGraph } from "../../../src/shared/scene-graph.ts";
import { buildGrid, navBoxes, specForPlace } from "../../../src/shared/nav/grid.ts";
import { parseBakedRegions, regionsOf, indexRegions } from "../../../src/shared/nav/regions.ts";
const raw = JSON.parse(readFileSync("web/game/scene-graph.json", "utf8")) as unknown;
import { loadArena } from "../../../src/server/world-loader.ts";
const view = loadArena().view as any;
const g = parseSceneGraph(raw, view.doors).graph!;
const closed = new Set((view.doors ?? []).filter((d: any) => d.open === false).map((d: any) => d.id));
const hall = "brutalist-building-1-cbake.floor-1.hall";
const spec = specForPlace(g, hall)!;
const grid = buildGrid(spec.area, navBoxes(view, g, closed), { cell: 0.25, radius: view.pawnRadius, height: view.pawnHeight, baseY: spec.baseY, block: spec.block });
const at = (x: number, z: number) => {
  const i = Math.floor((x - grid.minX) / grid.cell), j = Math.floor((z - grid.minZ) / grid.cell);
  return grid.blocked[j * grid.w + i];
};
console.log("legs waypoint (-34.31,27.61) blocked:", at(-34.31, 27.61));
console.log("hall grid block polys", spec.block.length, "area", spec.area);
const shaft = g.places.find((p) => p.id === "brutalist-building-1-cbake.e1");
console.log("shaft kinds", shaft?.kind, "bounds", JSON.stringify(shaft?.bounds), "poly", shaft?.polygon?.length);
const poly = shaft?.polygon ?? [];
const inside = (x: number, z: number) => {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i]!, [xj, zj] = poly[j]!;
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit;
  }
  return hit;
};
console.log("shaft center inside polygon:", inside((shaft!.bounds.minX + shaft!.bounds.maxX) / 2, (shaft!.bounds.minZ + shaft!.bounds.maxZ) / 2));
const regRaw = JSON.parse(readFileSync("web/game/regions.json", "utf8")) as unknown;
const parsed = parseBakedRegions(regRaw);
const regions = regionsOf(parsed.file!, hall);
console.log("hall regions", regions?.regions.length, "portals", regions?.portals.length);
if (regions) {
  const s = shaft!;
  const covering = regions.regions.filter((r) => r.minX <= s.bounds.minX && r.maxX >= s.bounds.maxX && r.minZ <= s.bounds.minZ && r.maxZ >= s.bounds.maxZ);
  console.log("regions covering the shaft bbox", covering.map((r) => r.id).join(", ") || "none");
  const cx = (s.bounds.minX + s.bounds.maxX) / 2, cz = (s.bounds.minZ + s.bounds.maxZ) / 2;
  const at = regions.regions.filter((r) => cx >= r.minX && cx <= r.maxX && cz >= r.minZ && cz <= r.maxZ);
  console.log("region containing the shaft center", at.map((r) => r.id).join(", ") || "none");
}
