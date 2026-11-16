import { readFileSync } from "node:fs";
import { loadArena } from "../../../src/server/world-loader.ts";
import { buildGrid, findLocalPath, navBoxes, specForPlace } from "../../../src/shared/nav/grid.ts";
const loaded = loadArena();
const g = loaded.sceneGraph!;
const view = loaded.view as any;
const shut = new Set((view.doors ?? []).filter((d: any) => !d.open).map((d: any) => d.id));
// the two doors we care about are open in the live run
shut.delete("brutalist-building-2-cbake.rect21094-3-6.door-1-1-9-22");
const hall = "brutalist-building-2-cbake.floor-1.hall";
const spec = specForPlace(g, hall)!;
const grid = buildGrid(spec.area, navBoxes(view, g, shut), { cell: 0.25, radius: view.pawnRadius, height: view.pawnHeight, baseY: spec.baseY, block: spec.block });
const at = (x: number, z: number) => {
  const i = Math.floor((x - grid.minX) / grid.cell), j = Math.floor((z - grid.minZ) / grid.cell);
  if (i < 0 || j < 0 || i >= grid.w || j >= grid.h) return "out";
  return { blocked: grid.blocked[j * grid.w + i], floor: grid.floor[j * grid.w + i] };
};
for (const [x, z] of [[25.78, -8.57], [26.12, -8.56], [29.92, -4.4], [29.92, -4.0], [30.5, -4.0], [29.0, -3.8], [27.5, -4.0]]) {
  console.log(x, z, JSON.stringify(at(x, z)));
}
for (const [x, z] of [[29.92, -4.4], [29.92, -4.0], [29.0, -3.8]]) {
  const local = findLocalPath(grid, { x: 25.78, z: -8.57 }, { x, z });
  console.log("path to", x, z, local ? `${local.length} points last=${JSON.stringify(local[local.length - 1])}` : "NONE");
}
