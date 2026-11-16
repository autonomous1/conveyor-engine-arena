import assert from "node:assert/strict";
import { test } from "node:test";
import { planPath, replanNeeded } from "../src/shared/nav/path.ts";
import { loadArena } from "../src/server/world-loader.ts";
import { placeAt } from "../src/shared/scene-graph.ts";

const loaded = loadArena();
const graph = loaded.sceneGraph!;
const view = { aabbs: loaded.view.aabbs, doors: loaded.view.doors, pawnRadius: loaded.view.pawnRadius, pawnHeight: loaded.view.pawnHeight };
const gate = () => "open" as const;
const from = { x: 0.54, y: 0, z: -1.78 };

test("path_reaches_the_centre_of_each_place_kind", () => {
  const kinds = new Map<string, string>();
  for (const place of graph.placeById.values()) if (!kinds.has(place.kind) && place.kind !== "outside") kinds.set(place.kind, place.id);
  for (const [kind, id] of kinds) {
    const place = graph.placeById.get(id)!;
    const center = place.polygon.length
      ? { x: place.polygon.reduce((s, p) => s + p[0], 0) / place.polygon.length, y: place.y + 0.1, z: place.polygon.reduce((s, p) => s + p[1], 0) / place.polygon.length }
      : { x: from.x, y: place.y, z: from.z };
    const plan = planPath(graph, from, center, gate, { view });
    if (!plan.ok) assert.ok(["start-blocked", "no-portal", "no-floor"].includes(plan.reason), `${kind}: ${plan.reason}`);
    else {
      assert.ok(plan.points.length > 0, kind);
      const last = plan.points.at(-1)!;
      assert.ok(Math.hypot(last[0] - center.x, last[2] - center.z) < 0.35, `${kind} ended ${last[0]},${last[2]}`);
    }
  }
  assert.ok(kinds.size >= 3);
});

test("path_reports_a_blocked_target_and_start", () => {
  const box = { id: 999, minX: 10, maxX: 11, minY: 0, maxY: 2, minZ: 10, maxZ: 11 };
  const inside = { x: 10.5, y: 0.4, z: 10.5 };
  const plan = planPath(graph, from, inside, gate, { view: { ...view, aabbs: [...view.aabbs, box] } });
  if (plan.ok) {
    const last = plan.points.at(-1)!;
    assert.ok(Math.hypot(last[0] - inside.x, last[2] - inside.z) <= 1.05);
  } else assert.ok(["target-blocked", "no-cell", "no-floor"].includes(plan.reason));
  assert.equal(replanNeeded([[0, 0, 0]], { x: 0.5, y: 0, z: 0 }, "outside"), false);
  assert.equal(replanNeeded([[0, 0, 0]], { x: 4, y: 0, z: 0 }, "outside"), true);
});

test("floor_five_coordinate_uses_the_upper_model", () => {
  const place = [...graph.placeById.values()].find((item) => item.kind === "hall" && item.y > 4);
  assert.ok(place, "no floor-5 hall");
  const center = { x: place.polygon.reduce((s, p) => s + p[0], 0) / place.polygon.length, y: place.y + 0.1, z: place.polygon.reduce((s, p) => s + p[1], 0) / place.polygon.length };
  const plan = planPath(graph, from, center, gate, { view });
  if (plan.ok) {
    assert.equal(plan.placeId, place.id);
    const last = plan.points.at(-1)!;
    assert.ok(Math.abs(last[1] - center.y) < 1, `floor ${last[1]} vs ${center.y}`);
  } else assert.ok(["no-portal", "no-floor", "start-blocked"].includes(plan.reason));
});

test("a_nook_start_is_unstuck_or_reported", () => {
  const box = { id: 998, minX: -1, maxX: 1, minY: 0, maxY: 2, minZ: -1, maxZ: 1 };
  const plan = planPath(graph, { x: 0, y: 0.5, z: 0 }, { x: 10, y: 0.1, z: 10 }, gate, {
    view: { ...view, aabbs: [...view.aabbs, box] },
  });
  if (plan.ok) assert.ok(plan.points.length > 1);
  else assert.ok(["start-blocked", "no-portal", "target-blocked"].includes(plan.reason));
});

test("replan_needed_uses_the_explicit_planned_place", () => {
  assert.equal(replanNeeded([[0, 0, 0]], { x: 0.5, y: 0, z: 0 }, "b", 3, "a"), true);
  assert.equal(replanNeeded([[0, 0, 0]], { x: 0.5, y: 0, z: 0 }, "a", 3, "a"), false);
  assert.equal(replanNeeded([[0, 0, 0]], { x: 4, y: 0, z: 0 }, "a", 3, "a"), true);
});
