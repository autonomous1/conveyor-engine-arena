// Scratch: what the bot can plan from its spawn, using the real route module.
// Run: node --import ./scripts/ts-ext-register.mjs plan/dsh-tasks/live/probe-graph.ts
import { readFileSync } from "node:fs";
import { parseSceneGraph, placeAt } from "../../../src/shared/scene-graph.ts";
import { createRoadCache, planRoute, routePlaceCosts, type Gate } from "../../../src/shared/nav/route.ts";
import type { ScenePortal } from "../../../src/shared/scene-graph.ts";

type View = {
  doors?: Array<{ id: string; locked?: boolean }>;
  pickups?: Array<{
    id: string;
    kind?: string;
    minX?: number; maxX?: number; minY?: number; maxY?: number; minZ?: number; maxZ?: number;
  }>;
};

const raw = JSON.parse(readFileSync("web/game/scene-graph.json", "utf8")) as unknown;
const view = (await (await fetch("http://127.0.0.1:4173/arena.json")).json()) as View;
const parsed = parseSceneGraph(raw, view.doors ?? []);
if (!parsed.graph) {
  console.error("graph rejected", parsed.issues.slice(0, 3));
  process.exit(1);
}
const graph = parsed.graph;
const spawn = { x: -2.79, y: 0, z: 2.16 };
const here = placeAt(graph, spawn.x, spawn.y, spawn.z);
console.log("spawn place", here.id, here.kind, "places", graph.places.length, "portals", graph.portals.length);

const live = new Map((view.doors ?? []).map((d) => [d.id, d.locked === true]));
const gate = (portal: ScenePortal): Gate => {
  if (portal.kind !== "door") return "open";
  const id = portal.door ?? portal.id;
  return live.get(id) === true || (live.get(id) === undefined && portal.locked === true) ? "locked" : "closed-unlocked";
};
const cache = createRoadCache(graph);
const net = cache.net(gate);

const costs = routePlaceCosts(graph, spawn, net);
const reach = [...costs.entries()].filter(([, m]) => Number.isFinite(m) && m > 0).sort((a, b) => a[1] - b[1]);
console.log("reachable places from spawn (strict):", reach.length, "of", graph.places.length);
for (const [id, m] of reach.slice(0, 20)) console.log("  ", m.toFixed(1), "m", id);

const kinds: Record<string, number> = {};
for (const p of graph.places) kinds[p.kind] = (kinds[p.kind] ?? 0) + 1;
console.log("place kinds", kinds);

const halls = graph.places.filter((p) => p.kind === "hall").map((p) => p.id);
console.log("halls", halls.length, "reachable halls", halls.filter((id) => Number.isFinite(costs.get(id))).length);
const rooms = graph.places.filter((p) => p.kind === "room").map((p) => p.id);
console.log("rooms", rooms.length, "reachable rooms", rooms.filter((id) => Number.isFinite(costs.get(id))).length);

const keys = (view.pickups ?? []).filter((p) => p.kind === "key");
console.log("key pickups", keys.length);
for (const k of keys.slice(0, 8)) {
  const x = ((k.minX ?? 0) + (k.maxX ?? 0)) / 2;
  const z = ((k.minZ ?? 0) + (k.maxZ ?? 0)) / 2;
  const y = ((k.minY ?? 0) + (k.maxY ?? 0)) / 2;
  console.log("  ", k.id, "at", x.toFixed(1), y.toFixed(1), z.toFixed(1), "place", placeAt(graph, x, y, z).id);
}
const weapons = (view.pickups ?? []).filter((p) => p.kind === "weapon");
console.log("weapon pickups", weapons.length);
for (const w of weapons.slice(0, 8)) {
  const x = ((w.minX ?? 0) + (w.maxX ?? 0)) / 2;
  const z = ((w.minZ ?? 0) + (w.maxZ ?? 0)) / 2;
  const y = ((w.minY ?? 0) + (w.maxY ?? 0)) / 2;
  console.log("  ", w.id, "at", x.toFixed(1), y.toFixed(1), z.toFixed(1), "place", placeAt(graph, x, y, z).id);
}

for (const target of [
  "brutalist-building-1-cbake-0.floor-1.hall",
  "brutalist-building-2-cbake-3.room-a-1-5-8-6-2",
]) {
  const route = planRoute(graph, spawn, target, gate);
  console.log("route ->", target, route.ok
    ? `ok steps=${route.steps.length} cost=${route.cost.toFixed(1)}`
    : `FAIL ${route.reason}${route.lockedAlternative ? ` alt=${route.lockedAlternative.cost.toFixed(0)}m/${route.lockedAlternative.doors.length} doors` : ""}`);
}

const openNet = cache.net(() => "open");
const openCosts = routePlaceCosts(graph, spawn, openNet);
const openReach = [...openCosts.entries()].filter(([, m]) => Number.isFinite(m) && m > 0);
console.log("reachable with every door open:", openReach.length, "of", graph.places.length);
console.log("net compiles", cache.compiles);
