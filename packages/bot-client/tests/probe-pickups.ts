// Scratch: where do key/weapon pickups sit, and can the bot stand where they are?
import { readFileSync } from "node:fs";
import { parseSceneGraph, placeAt } from "../../../src/shared/scene-graph.ts";
type Pick = { id: string; kind?: string; minX?: number; maxX?: number; minY?: number; maxY?: number; minZ?: number; maxZ?: number; model?: string };
const raw = JSON.parse(readFileSync("web/game/scene-graph.json", "utf8")) as unknown;
const view = (await (await fetch("http://127.0.0.1:4173/arena.json")).json()) as { doors?: Array<{ id: string; locked?: boolean }>; pickups?: Pick[] };
const parsed = parseSceneGraph(raw, view.doors ?? []);
if (!parsed.graph) process.exit(1);
const graph = parsed.graph;
const picks = (view.pickups ?? []).filter((p) => p.kind === "key" || p.kind === "weapon");
console.log("pickups of interest", picks.length);
for (const p of picks) {
  const x = ((p.minX ?? 0) + (p.maxX ?? 0)) / 2;
  const z = ((p.minZ ?? 0) + (p.maxZ ?? 0)) / 2;
  const minY = p.minY ?? 0, maxY = p.maxY ?? 0;
  const probes = [minY, (minY + maxY) / 2, (minY + maxY) / 2 - 1, maxY, 0];
  const places = probes.map((y) => `${y.toFixed(2)}:${placeAt(graph, x, y, z).id}`);
  console.log(p.id, p.kind, "box", `x[${(p.minX ?? 0).toFixed(1)},${(p.maxX ?? 0).toFixed(1)}]`,
    `y[${minY.toFixed(2)},${maxY.toFixed(2)}]`, `z[${(p.minZ ?? 0).toFixed(1)},${(p.maxZ ?? 0).toFixed(1)}]`);
  console.log("   placeByY", places.join("  "));
  const near = graph.places
    .filter((pl) => pl.bounds && x >= pl.bounds.minX && x <= pl.bounds.maxX && z >= pl.bounds.minZ && z <= pl.bounds.maxZ)
    .map((pl) => `${pl.id}(y=${pl.y})`);
  console.log("   polygons containing x,z", near.join(", ") || "none");
}
