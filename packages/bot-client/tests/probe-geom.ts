import { loadArena } from "../../../src/server/world-loader.ts";
import { placeAt } from "../../../src/shared/scene-graph.ts";
const loaded = loadArena();
const g = loaded.sceneGraph!;
const v = loaded.view as any;
const hall = g.placeById.get("brutalist-building-2-cbake.floor-1.hall")!;
console.log("hall bounds", JSON.stringify(hall.bounds), "poly", hall.polygon?.length);
const room = g.placeById.get("brutalist-building-2-cbake.rect21094-3-6")!;
console.log("room bounds", JSON.stringify(room.bounds), "poly", room.polygon?.length);
for (const [x, z] of [[34, -8], [34, -4.4], [29.92, -4.4], [29.92, -3], [35, -1], [29.92, -12.5]]) {
  console.log(x, z, "place", placeAt(g, x, 0, z).id);
}
const walls = (v.aabbs ?? []).filter((b: any) => {
  const minY = b.minY ?? 0, maxY = b.maxY ?? 0;
  if (maxY <= 0.3 || minY >= 1.8) return false;
  return b.minX <= 40 && b.maxX >= 33 && b.minZ <= 0 && b.maxZ >= -12;
});
console.log("ground walls east of the room", walls.length);
for (const w of walls.slice(0, 12)) console.log(JSON.stringify(w));
