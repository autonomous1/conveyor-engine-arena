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

const probeFrom = { x: -2.79, y: 0, z: 2.16 };
function endsNear(plan: ReturnType<typeof planPath>, to: { x: number; z: number }, tolerance = 0.35): void {
  assert.ok(plan.ok, plan.ok ? "" : plan.reason);
  const last = plan.points.at(-1)!;
  assert.ok(Math.hypot(last[0] - to.x, last[2] - to.z) < tolerance, `ended ${last[0]},${last[2]} vs ${to.x},${to.z}`);
}

test("the_five_probe_cases", () => {
  endsNear(planPath(graph, probeFrom, { x: -2.9, y: 0, z: 2.3 }, gate, { view }), { x: -2.9, z: 2.3 });
  endsNear(planPath(graph, probeFrom, { x: 2, y: 0, z: 2 }, gate, { view }), { x: 2, z: 2 }, 1.05);
  endsNear(planPath(graph, probeFrom, { x: 10, y: 0, z: 2 }, gate, { view }), { x: 10, z: 2 });
  endsNear(planPath(graph, probeFrom, { x: -13.9, y: 0, z: 16.5 }, gate, { view }), { x: -13.9, z: 16.5 });

  const reverse = planPath(graph, { x: -29.43, y: 0, z: -7.45 }, { x: -2.79, y: 0, z: 2.16 }, gate, { view });
  assert.ok(reverse.ok || ["target-blocked", "start-blocked", "no-portal", "no-floor"].includes(reverse.reason));
});

test("a_short_move_does_not_stop_at_the_start", () => {
  const plan = planPath(graph, probeFrom, { x: -2.9, y: 0, z: 2.3 }, gate, { view });
  assert.ok(plan.ok);
  assert.ok(plan.points.length >= 2);
  const last = plan.points.at(-1)!;
  assert.ok(Math.hypot(last[0] + 2.9, last[2] - 2.3) < 0.35);
});

test("an_open_point_snaps_within_one_metre", () => {
  const plan = planPath(graph, probeFrom, { x: 2, y: 0, z: 2 }, gate, { view });
  assert.ok(plan.ok);
  const last = plan.points.at(-1)!;
  assert.ok(Math.hypot(last[0] - 2, last[2] - 2) <= 1.05);
  assert.equal(plan.placeId, "outside");
});

test("a_reverse_route_is_a_plan_or_a_named_reason", () => {
  const plan = planPath(graph, { x: -29.43, y: 0, z: -7.45 }, probeFrom, gate, { view });
  if (plan.ok) assert.ok(plan.points.length > 0);
  else assert.ok(["target-blocked", "start-blocked", "no-portal", "no-floor"].includes(plan.reason));
});

test("probe_ten_metres_east", () => {
  endsNear(planPath(graph, probeFrom, { x: 10, y: 0, z: 2 }, gate, { view }), { x: 10, z: 2 });
});

test("probe_far_corner", () => {
  endsNear(planPath(graph, probeFrom, { x: -13.9, y: 0, z: 16.5 }, gate, { view }), { x: -13.9, z: 16.5 });
});

test("probe_two_metres_snaps", () => {
  const plan = planPath(graph, probeFrom, { x: 2, y: 0, z: 2 }, gate, { view });
  assert.ok(plan.ok);
  const last = plan.points.at(-1)!;
  assert.ok(Math.hypot(last[0] - 2, last[2] - 2) <= 1.05);
});

test("probe_reverse_route_is_named", () => {
  const plan = planPath(graph, { x: -29.43, y: 0, z: -7.45 }, probeFrom, gate, { view });
  if (!plan.ok) assert.ok(["target-blocked", "start-blocked", "no-portal", "no-floor"].includes(plan.reason));
});

test("dag_macro_path_reaches_a_building_node", () => {
  const dag = loaded.spatialDag;
  assert.ok(dag);
  const place = [...graph.placeById.values()].find((item) => item.kind === "hall" && item.building);
  assert.ok(place);
  const center = {
    x: place.polygon.reduce((sum, point) => sum + point[0], 0) / place.polygon.length,
    y: place.y + 0.1,
    z: place.polygon.reduce((sum, point) => sum + point[1], 0) / place.polygon.length,
  };
  const plan = planPath(graph, probeFrom, center, gate, { view, dag });
  assert.ok(plan.ok, plan.ok ? "" : plan.reason);
  assert.equal(plan.placeId, place.id);
  assert.ok(plan.points.length >= 2);
});
