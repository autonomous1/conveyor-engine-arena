import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalJson } from "../src/shared/scene-graph.ts";
import { MAX_HP, createPawnHealth } from "../src/shared/health.ts";
import { pickDoorForUse } from "../src/shared/doors.ts";

test("canonical_json_is_stable", () => {
  assert.equal(
    canonicalJson({ b: 1, a: { d: 2, c: [3, 1] } }),
    canonicalJson({ a: { c: [3, 1], d: 2 }, b: 1 }),
  );
  assert.equal(canonicalJson({ a: 1, b: undefined }), '{"a":1}');
  assert.equal(canonicalJson([3, 1]), "[3,1]");
});

test("health_stays_in_range", () => {
  let t = 0;
  const health = createPawnHealth(() => t);
  assert.equal(health.get(1).hp, MAX_HP);
  assert.equal(health.wound(1, 2, 1_000)?.hp, 0);
  assert.equal(health.isDead(1), true);
  // A dead pawn is unchanged by another wound or a heal.
  assert.equal(health.wound(1, 2, 1_000), undefined);
  assert.equal(health.get(1).hp, 0);
  assert.equal(health.heal(1, 50), undefined);
  t = 100_000;
  assert.deepEqual(health.takeRespawns(), [1]);
  assert.equal(health.get(1).hp, MAX_HP);
  health.wound(1, 2, 5);
  assert.equal(health.heal(1, 1_000)?.hp, MAX_HP);
});

test("door_pick_breaks_ties_by_id", () => {
  const base = {
    hinge: "left" as const,
    open: false,
    position: [0, 0, 0] as [number, number, number],
    size: [1, 2.1, 0.08] as [number, number, number],
    yaw: 0,
  };
  const pawn = { id: 1, x: 0.5, y: 0, z: 0, radius: 0.5, height: 1.8, alive: true };
  const b = { ...base, id: "b" };
  const a = { ...base, id: "a" };
  assert.equal(pickDoorForUse([b, a], pawn)?.id, "a");
  assert.equal(pickDoorForUse([a, b], pawn)?.id, "a");
  assert.equal(pickDoorForUse([b, a], { ...pawn, x: 100 })?.id, undefined);
});
