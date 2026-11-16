// Scratch: is the outside grid blocked where the host stops the pawn?
import { readFileSync } from "node:fs";
import { parseSceneGraph } from "../../../src/shared/scene-graph.ts";
import { buildGrid, navBoxes, specForPlace } from "../../../src/shared/nav/grid.ts";
const raw = JSON.parse(readFileSync("web/game/scene-graph.json", "utf8")) as unknown;
const view = await (await fetch("http://127.0.0.1:4173/arena.json")).json() as any;
const g = parseSceneGraph(raw, view.doors).graph!;
const spec = specForPlace(g, "outside")!;
const shut = new Set((view.doors ?? []).filter((d: any) => !d.open).map((d: any) => d.id));
const boxes = navBoxes(view, g, shut);
const grid = buildGrid(spec.area, boxes, { cell: 0.25, radius: view.pawnRadius, height: view.pawnHeight, baseY: spec.baseY, block: spec.block });
const at = (x: number, z: number) => {
  const i = Math.floor((x - grid.minX) / grid.cell), j = Math.floor((z - grid.minZ) / grid.cell);
  const k = j * grid.w + i;
  return { i, j, blocked: grid.blocked[k], floor: grid.floor[k] };
};
for (const [x, z] of [[-22.88,-15.3],[-23.2,-15.0],[-23.5,-15.0],[-24.5,-15.0],[-25.5,-15.0],[-20.9,-15.0],[-19.5,-15.0],[-18.5,-15.0],[-21.5,27.16]]) {
  console.log(x.toFixed(2), z.toFixed(2), JSON.stringify(at(x, z)));
}
console.log("grid", grid.w, "x", grid.h, "cell", grid.cell);
// Which boxes overlap the pawn capsule at -22.88,-15.3 at y 0..1.8?
const p = { x: -22.88, z: -15.3 }, r = view.pawnRadius, h = view.pawnHeight;
const hits = boxes.filter((b: any) => {
  const minY = b.minY ?? 0, maxY = b.maxY ?? Infinity;
  if (maxY <= 0.3) return false;
  if (minY >= h) return false;
  return p.x + r > b.minX && p.x - r < b.maxX && p.z + r > b.minZ && p.z - r < b.maxZ;
});
console.log("capsule hits", hits.length);
for (const b of hits) console.log(JSON.stringify(b));
