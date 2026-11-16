import { loadArena } from "../../../src/server/world-loader.ts";
import { placeOfPickup } from "../../../src/shared/bots/actions.ts";
const loaded = loadArena();
const g = loaded.sceneGraph!;
const w = (loaded.view.pickups as any[]).find((p) => p.id === "alien-weapon-1");
console.log("weapon", w && { x: (w.minX + w.maxX) / 2, y: (w.minY + w.maxY) / 2, z: (w.minZ + w.maxZ) / 2, minY: w.minY, maxY: w.maxY });
console.log("place", w && placeOfPickup(g, w));
