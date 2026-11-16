// Scratch: is the legs waypoint inside any hall region? (string-pull cutting the shaft hole?)
import { readFileSync } from "node:fs";
import { parseBakedRegions, regionsOf } from "../../../src/shared/nav/regions.ts";
const parsed = parseBakedRegions(JSON.parse(readFileSync("web/game/regions.json", "utf8")) as unknown);
const g = regionsOf(parsed.file!, "brutalist-building-1-cbake.floor-1.hall")!;
const p = { x: -34.31, z: 27.61 };
const hit = g.regions.filter((r) => p.x >= r.minX && p.x <= r.maxX && p.z >= r.minZ && p.z <= r.maxZ);
console.log("regions containing", p, hit.map((r) => r.id).join(", ") || "none (hole)");
console.log("regions", g.regions.length, "portals", g.portals.length);
