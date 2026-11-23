import assert from "node:assert/strict";
import test from "node:test";
import { followCamera, parseObserve } from "../src/client/follow-camera.ts";
import { hasSpectate } from "../src/client/auth-key.ts";

const TARGET = { x: 0, y: 0, z: 0, yaw: 0 };
const STEP = 1 / 60;

test("follow_camera_places_behind_and_above", () => {
  const pose = followCamera(TARGET, undefined, { back: 3, up: 1.6 }, STEP);
  assert.ok(pose);
  assert.ok(Math.abs(pose.x) < 1e-9, `x ${pose.x}`);
  assert.ok(Math.abs(pose.y - 1.6) < 1e-9, `y ${pose.y}`);
  assert.ok(Math.abs(pose.z + 3) < 1e-9, `z ${pose.z}`);
  assert.ok(Math.abs(pose.lookY - 1.6) < 1e-9, `lookY ${pose.lookY}`);
  const side = followCamera({ ...TARGET, yaw: Math.PI / 2 }, undefined, {}, STEP);
  assert.ok(side);
  assert.ok(Math.abs(side.x + 3) < 1e-9, `side x ${side.x}`);
  assert.ok(Math.abs(side.z) < 1e-9, `side z ${side.z}`);
});

test("follow_camera_converges_within_the_offset", () => {
  const start = followCamera(TARGET, undefined, {}, STEP);
  assert.ok(start);
  const moved = { ...TARGET, x: 10 };
  let pose = start;
  for (let i = 0; i < 60; i += 1) {
    const next = followCamera(moved, pose, {}, STEP);
    assert.ok(next);
    pose = next;
  }
  assert.ok(Math.abs(pose.x - 10) < 0.2, `x ${pose.x}`);
  assert.ok(Math.abs(pose.z + 3) < 0.2, `z ${pose.z}`);
  // The lateral offset is part of the ideal, so it converges with the rest.
  const opts = { back: 3, up: 1.9, right: 0.8 };
  const sideStart = followCamera(TARGET, undefined, opts, STEP);
  assert.ok(sideStart);
  let side = sideStart;
  for (let i = 0; i < 60; i += 1) {
    const next = followCamera(moved, side, opts, STEP);
    assert.ok(next);
    side = next;
  }
  assert.ok(Math.abs(side.x - 10.8) < 0.2, `right x ${side.x}`);
  assert.ok(Math.abs(side.y - 1.9) < 0.2, `right y ${side.y}`);
  assert.ok(Math.abs(side.z + 3) < 0.2, `right z ${side.z}`);
  const distance = Math.hypot(side.x - 10, side.y, side.z);
  assert.ok(distance <= 3 + 1.9 + 0.8, `distance ${distance}`);
});

test("follow_camera_places_right_of_the_rear", () => {
  // yaw 0 faces +Z; the right-hand side is +X.
  const pose = followCamera(TARGET, undefined, { back: 3, up: 1.9, right: 0.8 }, STEP);
  assert.ok(pose);
  assert.ok(Math.abs(pose.x - 0.8) < 1e-9, `x ${pose.x}`);
  assert.ok(Math.abs(pose.y - 1.9) < 1e-9, `y ${pose.y}`);
  assert.ok(Math.abs(pose.z + 3) < 1e-9, `z ${pose.z}`);
  assert.ok(Math.abs(pose.lookY - 1.6) < 1e-9, `lookY ${pose.lookY}`);
  // yaw π/2 faces +X; the right-hand side is −Z.
  const side = followCamera({ ...TARGET, yaw: Math.PI / 2 }, undefined, { back: 3, up: 1.9, right: 0.8 }, STEP);
  assert.ok(side);
  assert.ok(Math.abs(side.x + 3) < 1e-9, `side x ${side.x}`);
  assert.ok(Math.abs(side.z + 0.8) < 1e-9, `side z ${side.z}`);
});

test("follow_camera_is_frame_rate_independent", () => {
  const start = followCamera(TARGET, undefined, {}, STEP);
  assert.ok(start);
  const moved = { ...TARGET, x: 1 };
  const one = followCamera(moved, start, {}, 1 / 30);
  const half = followCamera(moved, start, {}, STEP);
  assert.ok(one && half);
  const two = followCamera(moved, half, {}, STEP);
  assert.ok(two);
  const gap = Math.hypot(one.x - two.x, one.y - two.y, one.z - two.z);
  assert.ok(gap < 1e-3, `gap ${gap}`);
  // The damped look is frame-rate independent too.
  const lookGap = Math.hypot(one.lookX - two.lookX, one.lookY - two.lookY, one.lookZ - two.lookZ);
  assert.ok(lookGap < 1e-3, `look gap ${lookGap}`);
});

test("follow_camera_keeps_the_last_pose_when_the_target_is_missing", () => {
  const prev = followCamera(TARGET, undefined, {}, STEP);
  assert.ok(prev);
  assert.equal(followCamera(undefined, prev, {}, STEP), prev);
});

test("follow_camera_damps_the_look", () => {
  const start = followCamera(TARGET, undefined, {}, STEP);
  assert.ok(start);
  // A snap returns the exact eye.
  assert.equal(start.lookX, 0);
  assert.equal(start.lookZ, 0);
  // A 1 m lateral step of the target must not jump the look in one frame: it
  // moves by the same damped fraction as the position.
  const moved = { ...TARGET, x: 1 };
  const next = followCamera(moved, start, {}, STEP);
  assert.ok(next);
  const alpha = 1 - Math.exp(-8 * STEP);
  assert.ok(next.lookX < 0.5, `lookX ${next.lookX}`);
  assert.ok(Math.abs(next.lookX - alpha) < 1e-9, `lookX ${next.lookX} alpha ${alpha}`);
  // After 1 s at 60 Hz the damped look is the target's eye.
  let pose = start;
  for (let i = 0; i < 60; i += 1) {
    const step = followCamera(moved, pose, {}, STEP);
    assert.ok(step);
    pose = step;
  }
  assert.ok(Math.abs(pose.lookX - 1) < 0.2, `converged lookX ${pose.lookX}`);
  assert.ok(Math.abs(pose.lookY - 1.6) < 1e-9, `lookY ${pose.lookY}`);
});

test("follow_camera_yaw_wraps", () => {
  const plus = followCamera({ ...TARGET, yaw: Math.PI }, undefined, {}, STEP);
  const minus = followCamera({ ...TARGET, yaw: -Math.PI }, undefined, {}, STEP);
  assert.ok(plus && minus);
  assert.ok(Math.abs(plus.x - minus.x) < 1e-9, `x ${plus.x} vs ${minus.x}`);
  assert.ok(Math.abs(plus.z - minus.z) < 1e-9, `z ${plus.z} vs ${minus.z}`);
});

test("observe_parameter_is_parsed", () => {
  assert.equal(parseObserve("?observe=1"), true);
  assert.equal(parseObserve("observe=1"), true);
  assert.equal(parseObserve("?qa=1&observe=1"), true);
  assert.equal(parseObserve("?observe=0"), false);
  assert.equal(parseObserve("?qa=1"), false);
  assert.equal(parseObserve(""), false);
});

test("observe_is_ignored_without_spectate", () => {
  // The parse is not the gate: the boot also needs the scope hint.
  assert.equal(parseObserve("?observe=1"), true);
  assert.equal(hasSpectate({ sub: "tim", role: "player", exp: 0 }), false);
  assert.equal(hasSpectate({ sub: "tim", role: "player", exp: 0, scope: ["play"] }), false);
  assert.equal(hasSpectate({ sub: "tim", role: "qa", exp: 0, scope: ["play", "spectate"] }), true);
  assert.equal(hasSpectate({ sub: "tim", role: "admin", exp: 0, scope: ["play", "spectate", "qa"] }), true);
});
