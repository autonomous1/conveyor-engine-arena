import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { applyDoorSwing, DOOR_SWING_SECONDS, doorSwingRadians, tickDoorSwing } from "../src/client/arena-scene.ts";

function rig() {
  const group = new THREE.Group();
  const hinge = new THREE.Group();
  hinge.name = "hinge";
  group.add(hinge);
  return { group, hinge };
}

test("the swing takes the configured time, in either direction, with the default as the fallback", () => {
  const { group, hinge } = rig();
  const closed = doorSwingRadians("left", false);
  const open = doorSwingRadians("left", true);
  hinge.rotation.y = closed;
  applyDoorSwing(group, "left", true, true, 2.8);
  for (let t = 0; t < 1.4 - 1e-9; t += 0.05) tickDoorSwing(group, 0.05);
  const mid = hinge.rotation.y;
  assert.ok(Math.abs(mid - (closed + open) / 2) < 1e-6, "smoothstep is half way at half the time");
  for (let t = 0; t < 1.35; t += 0.05) tickDoorSwing(group, 0.05);
  assert.ok(Math.abs(hinge.rotation.y - open) > 1e-6 || hinge.userData.swing === undefined, "not skipped ahead");
  for (let t = 0; t < 0.2; t += 0.05) tickDoorSwing(group, 0.05);
  assert.equal(hinge.rotation.y, open);
  assert.equal(hinge.userData.swing, undefined, "done");

  applyDoorSwing(group, "left", false, true, 2.8);
  for (let i = 0; i < 20; i++) tickDoorSwing(group, 0.1); // 2.0 s of 2.8 s
  assert.notEqual(hinge.rotation.y, closed);
  for (let i = 0; i < 10; i++) tickDoorSwing(group, 0.1);
  assert.equal(hinge.rotation.y, closed);

  // No duration: the old 400 ms. A bad one falls back to it too.
  for (const seconds of [undefined, 0, Number.NaN]) {
    hinge.rotation.y = closed;
    applyDoorSwing(group, "left", true, true, seconds as number | undefined);
    for (let t = 0; t < DOOR_SWING_SECONDS + 0.1; t += 0.05) tickDoorSwing(group, 0.05);
    assert.equal(hinge.rotation.y, open, `${seconds} finishes in ${DOOR_SWING_SECONDS} s`);
  }
});

test("a retarget mid-swing starts from where the leaf is and uses the new time", () => {
  const { group, hinge } = rig();
  const closed = doorSwingRadians("left", false);
  hinge.rotation.y = closed;
  applyDoorSwing(group, "left", true, true, 2.8);
  for (let i = 0; i < 10; i++) tickDoorSwing(group, 0.1);
  const at = hinge.rotation.y;
  applyDoorSwing(group, "left", false, true, 1);
  assert.equal((hinge.userData.swing as { from: number }).from, at);
  for (let i = 0; i < 11; i++) tickDoorSwing(group, 0.1);
  assert.equal(hinge.rotation.y, closed);
});
