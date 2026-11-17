import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Vector3 } from "three";
import { loadArena } from "../src/server/world-loader.ts";
import { createBotWorld } from "../packages/bot-client/src/world.ts";
import { closestPointToPoint, loadSpatialDAG, nodeAt, raycastFirst, shapecast } from "../src/shared/spatial-dag.ts";

const raw = JSON.parse(readFileSync("web/game/spatial-dag.json", "utf8")) as { hash: string };

test("dag_loads_and_has_a_hash", () => {
  const dag = loadSpatialDAG(raw);
  assert.ok(dag);
  assert.equal(dag.hash, raw.hash);
  assert.ok(dag.nodes.length > 0);
  assert.ok(dag.chunks.length > 0);
  assert.equal(loadSpatialDAG({ formatVersion: 1, hash: "x", nodes: [], chunks: [] })?.hash, "x");
  assert.equal(loadSpatialDAG({ nope: true }), undefined);
});

test("dag_rays_and_points_agree_with_the_static_boxes", () => {
  const loaded = loadArena();
  const dag = loaded.spatialDag;
  assert.ok(dag);
  const box = loaded.view.aabbs.find((item) => item.maxY !== undefined && item.maxY > 1);
  assert.ok(box);
  const origin = new Vector3((box.minX + box.maxX) / 2, (box.minY ?? 0) + 1, (box.minZ + box.maxZ) / 2);
  const hit = raycastFirst(dag, origin, new Vector3(1, 0, 0), (box.maxX - box.minX) + 2);
  assert.ok(hit);
  assert.ok(hit.point.x >= box.minX - 0.01 && hit.point.x <= box.maxX + 0.01);

  const near = closestPointToPoint(dag, origin);
  assert.ok(near);
  assert.ok(near.distance < 5);
  const sphereHits = shapecast(dag, new Vector3(origin.x, origin.y - 1, origin.z), 0.5);
  assert.ok(sphereHits.length > 0);
});

test("dag_nodes_are_places_not_dynamic_objects", () => {
  const dag = loadSpatialDAG(raw);
  assert.ok(dag);
  assert.ok(dag.nodes.every((node) => node.kind !== "door" && node.kind !== "pawn"));
  const place = dag.nodes.find((node) => node.kind === "hall" || node.kind === "room");
  assert.ok(place);
  const center = place.bounds.getCenter(new Vector3());
  assert.ok(nodeAt(dag, center));
});

test("bot_world_exposes_the_same_hash_and_dag", () => {
  const loaded = loadArena();
  assert.ok(loaded.view.spatialDagHash);
  assert.ok(loaded.view.spatialDag);
  assert.equal(loaded.spatialDag?.hash, loaded.view.spatialDagHash);
  const bot = createBotWorld({ aabbs: [], spatialDag: raw, spatialDagHash: raw.hash });
  assert.equal(bot.spatialDagHash(), raw.hash);
  assert.equal(bot.spatialDag()?.hash, raw.hash);
  assert.ok(bot.spatialDag()?.chunks.length);
});

import { hasLineOfSight, hasLineOfSightDag } from "../src/shared/hitscan.ts";

test("dag_los_agrees_with_the_flat_boxes_and_keeps_dynamic", () => {
  const loaded = loadArena();
  const dag = loaded.spatialDag;
  assert.ok(dag);
  const boxes = loaded.view.aabbs.filter((item) => item.maxX - item.minX > 1).slice(0, 5);
  assert.ok(boxes.length > 0);
  for (const box of boxes) {
    const from = { x: box.minX - 1, y: 1, z: (box.minZ + box.maxZ) / 2 };
    const to = { x: box.maxX + 1, y: 1, z: from.z };
    assert.equal(hasLineOfSight(from, to, loaded.view.aabbs), false);
    assert.equal(hasLineOfSightDag(dag, from, to), false);
  }
  const box = boxes[0]!;
  const openFrom = { x: box.maxX + 2, y: 5, z: box.maxZ + 2 };
  const openTo = { x: openFrom.x + 1, y: 5, z: openFrom.z };
  assert.equal(hasLineOfSightDag(dag, openFrom, openTo), true);
  const dynamic = [{ minX: openFrom.x + 0.6, maxX: openFrom.x + 0.8, minY: 4, maxY: 6, minZ: openFrom.z - 1, maxZ: openFrom.z + 1 }];
  assert.equal(hasLineOfSightDag(dag, openFrom, openTo, dynamic), false);
  assert.equal(hasLineOfSight(openFrom, openTo, dynamic), false);
});;

test("runtime_hash_covers_the_merged_geometry", () => {
  const loaded = loadArena();
  assert.ok(loaded.spatialDag);
  assert.equal(loaded.spatialDag.hash, loaded.view.spatialDagHash);
  assert.notEqual(loaded.spatialDag.hash, raw.hash);
  const bot = createBotWorld({ aabbs: [], spatialDag: loaded.view.spatialDag, spatialDagHash: loaded.view.spatialDagHash });
  assert.equal(bot.spatialDagHash(), loaded.spatialDag.hash);
});
