// Scratch: is the open room-door gap free in the hall grid?
import { readFileSync } from "node:fs";
import { parseSceneGraph } from "../../../src/shared/scene-graph.ts";
import { buildGrid, navBoxes, specForPlace } from "../../../src/shared/nav/grid.ts";
const raw = JSON.parse(readFileSync("web/game/scene-graph.json", "utf8")) as unknown;
const view = await (await fetch("http://127.0.0.1:4173/arena.json")).json() as any;
const g = parseSceneGraph(raw, view.doors).graph!;
const closed = new Set((view.doors ?? []).filter((d: any) => !d.open).map((d: any) => d.id));
// live door state: assume the room door is open (it was in the last session)
closed.delete("brutalist-building-1-cbake.room-a-1-5-8-9.door-1-1-9-22-5");
for (const placeId of ["brutalist-building-1-cbake.floor-1.hall", "brutalist-building-1-cbake.room-a-1-5-8-9"]) {
  const spec = specForPlace(g, placeId)!;
  const grid = buildGrid(spec.area, navBoxes(view, g, closed), { cell: 0.25, radius: view.pawnRadius, height: view.pawnHeight, baseY: spec.baseY, block: spec.block });
  const at = (x: number, z: number) => {
    const i = Math.floor((x - grid.minX) / grid.cell), j = Math.floor((z - grid.minZ) / grid.cell);
    if (i < 0 || j < 0 || i >= grid.w || j >= grid.h) return "out";
    return { blocked: grid.blocked[j * grid.w + i], floor: grid.floor[j * grid.w + i] };
  };
  console.log(placeId, grid.w, grid.h);
  for (let dz = -1.2; dz <= 1.2; dz += 0.2) console.log("  z", (22.6 + dz).toFixed(1), JSON.stringify(at(-37.0, 22.6 + dz)), JSON.stringify(at(-37.6, 22.6 + dz)));
}
