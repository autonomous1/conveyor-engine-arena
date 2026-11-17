import assert from "node:assert/strict";
import { test } from "node:test";
import { loadArena } from "../src/server/world-loader.ts";
import { evaluateCover, findCoverPoints, nearestCover, shutDoorBoxes } from "../src/shared/bots/cover.ts";
import { hasLineOfSightDag } from "../src/shared/hitscan.ts";
import { createHostBotSense } from "../src/server/bot-sense.ts";
import { createPawnHealth } from "../src/shared/health.ts";
import { createMind, judge } from "../src/shared/bots/arbiter.ts";

const loaded = loadArena();
const dag = loaded.spatialDag!;
const graph = loaded.sceneGraph!;
const box = loaded.view.aabbs.find((item) => item.maxX - item.minX > 2)!;
const target = { x: box.maxX + 4, y: 1.2, z: (box.minZ + box.maxZ) / 2 };

test("cover_evaluation_matches_the_raycast", () => {
  const behind = { x: box.minX - 1.2, y: 1.2, z: (box.minZ + box.maxZ) / 2 };
  const blocked = evaluateCover(dag, behind, target);
  assert.equal(blocked.block, true);
  assert.equal(blocked.los, false);

  let exposed = evaluateCover(dag, { x: target.x + 2, y: 1.2, z: target.z + 2 }, target);
  for (let i = 0; i < 16 && exposed.block; i += 1) {
    const a = (i / 16) * Math.PI * 2;
    exposed = evaluateCover(dag, { x: target.x + Math.cos(a) * 3, y: 1.2, z: target.z + Math.sin(a) * 3 }, target);
  }
  assert.equal(exposed.block, false);
  assert.equal(exposed.los, true);
});

test("dynamic_door_changes_cover_los", () => {
  let from = { x: box.maxX + 2, y: 0.2, z: box.maxZ + 2 };
  let to = { x: from.x + 4, y: 0.2, z: from.z };
  for (let i = 0; i < 16 && !hasLineOfSightDag(dag, { x: from.x, y: 1.6, z: from.z }, { x: to.x, y: 1.2, z: to.z }); i += 1) {
    const a = (i / 16) * Math.PI * 2;
    from = { x: target.x + Math.cos(a) * 2, y: 0.2, z: target.z + Math.sin(a) * 2 };
    to = { x: from.x + 4, y: 0.2, z: from.z };
  }
  assert.equal(evaluateCover(dag, from, to).los, true);
  const door = [{ minX: from.x + 2, maxX: from.x + 2.2, minY: 0, maxY: 2.2, minZ: from.z - 1, maxZ: from.z + 1 }];
  const shut = evaluateCover(dag, from, to, { dynamic: door });
  assert.equal(shut.los, false);
  assert.equal(shut.block, true);
});

test("findCoverPoints_scores_and_nearest_cover", () => {
  const points = findCoverPoints(dag, graph, { x: target.x, y: 1.6, z: target.z }, target, { limit: 6 });
  assert.ok(points.length > 0);
  assert.ok(points.every((point) => Number.isFinite(point.score)));
  for (let i = 1; i < points.length; i += 1) assert.ok(points[i - 1]!.score >= points[i]!.score);
  const nearest = nearestCover(dag, graph, { x: target.x, y: 1, z: target.z }, target, { limit: 8 });
  assert.ok(nearest);
  assert.ok(Number.isFinite(nearest.score));
  assert.ok(["ring", "polygon", "node"].includes(nearest.source));
});

test("nearestCover_uses_polygon_and_node_candidates", () => {
  const place = [...graph.placeById.values()].find((item) => {
    if (item.polygon.length < 4 || item.kind === "outside") return false;
    const b = item.bounds;
    return item.polygon.some(([x, z]) => Math.abs(x - b.minX) > 0.2 && Math.abs(x - b.maxX) > 0.2 && Math.abs(z - b.minZ) > 0.2 && Math.abs(z - b.maxZ) > 0.2);
  });
  assert.ok(place);
  const center = {
    x: place.polygon.reduce((sum, point) => sum + point[0], 0) / place.polygon.length,
    y: place.y + 0.2,
    z: place.polygon.reduce((sum, point) => sum + point[1], 0) / place.polygon.length,
  };
  const points = findCoverPoints(dag, graph, { x: center.x, y: center.y + 1.6, z: center.z }, center, { limit: 500 });
  const sources = [...new Set(points.map((point) => point.source))];
  assert.ok(sources.includes("polygon"), JSON.stringify(sources));
  assert.ok(sources.includes("node"), JSON.stringify(sources));
});

test("shutDoorBoxes_only_includes_closed_leaves", () => {
  const boxes = shutDoorBoxes([
    { open: false, position: [1, 0, 2], size: [1, 2, 0.2] },
    { open: true, position: [5, 0, 6], size: [1, 2, 0.2] },
  ]);
  assert.equal(boxes.length, 1);
  assert.equal(boxes[0]!.minX, 0.5);
  assert.equal(boxes[0]!.maxX, 1.5);
});

test("host_sense_exposes_a_cover_candidate", () => {
  const sense = createHostBotSense({
    world: loaded.world,
    agents: loaded.agents,
    health: createPawnHealth(),
    sceneGraph: graph,
    doors: () => loaded.view.doors,
    pickups: loaded.view.pickups ?? [],
    remainingPickups: () => [],
    ownedEntities: () => [],
    coverDag: dag,
  });
  const bot = loaded.agents[0]!;
  const point = sense.coverOf(bot.id, target);
  assert.ok(point);
  assert.ok(["ring", "polygon", "node"].includes(point.source));
  assert.ok(Number.isFinite(point.score));
  assert.equal(point.block, !point.los);
});

test("arbiter_raises_evade_priority_for_a_blocked_cover", () => {
  const base = {
    alive: true,
    place: "p",
    msNoProgress: 0,
    damage: { attacker: 9, ageMs: 100 },
    hpFrac: 0.2,
    threatSeen: true,
    armed: true,
  };
  const plain = judge(createMind(), base, 1_000);
  const covered = judge(createMind(), { ...base, cover: { block: true, score: 5 } }, 1_000);
  assert.equal(plain.goal, "evade");
  assert.equal(covered.goal, "evade");
  assert.ok(covered.priority > plain.priority);
});
