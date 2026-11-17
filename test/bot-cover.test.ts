import assert from "node:assert/strict";
import { test } from "node:test";
import { loadArena } from "../src/server/world-loader.ts";
import { evaluateCover, findCoverPoints, nearestCover } from "../src/shared/bots/cover.ts";

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

  const exposed = evaluateCover(dag, { x: target.x + 2, y: 1.2, z: target.z + 2 }, target);
  assert.equal(exposed.block, false);
  assert.equal(exposed.los, true);
});

test("dynamic_door_changes_cover_los", () => {
  const from = { x: box.maxX + 2, y: 0.2, z: box.maxZ + 2 };
  const to = { x: from.x + 4, y: 0.2, z: from.z };
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
  const nearest = nearestCover(dag, { x: target.x, y: 1, z: target.z }, target, { limit: 8 });
  assert.ok(nearest);
  assert.ok(Number.isFinite(nearest.score));
});
