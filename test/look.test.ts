import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { GAMEPAD_AXIS } from "three-gamepad-controls";
import {
  EYE_HEIGHT,
  JUMPER_LOOK_X,
  JUMPER_LOOK_Y,
  JUMPER_MOVE_X,
  JUMPER_MOVE_Y,
  PITCH_LIMIT,
  axesFromStick,
  clampPitch,
  eyeLook,
  jumperStick,
  lookFromMouse,
  lookFromStick,
  moveIntent,
  yawFromQuat,
} from "../src/shared/look.ts";

test("move intent is pawn yaw, and full stick stays inside the unit circle", () => {
  const forward = moveIntent(0, 1, 0);
  assert.ok(Math.abs(forward.moveX) < 1e-9);
  assert.ok(forward.moveZ > 0.99);
  const right = moveIntent(0, 0, 1);
  assert.ok(right.moveX < -0.99);
  assert.ok(Math.abs(right.moveZ) < 1e-9);
  const east = moveIntent(Math.PI / 2, 1, 0);
  assert.ok(east.moveX > 0.99);
  assert.ok(Math.abs(east.moveZ) < 1e-9);
  const diagonal = moveIntent(0.4, 1, 1);
  assert.ok(Math.hypot(diagonal.moveX, diagonal.moveZ) <= 1 + 1e-9);
});

test("mouse and stick signs turn right and look up", () => {
  const mouse = lookFromMouse(10, 4);
  assert.ok(mouse.yaw < 0);
  assert.ok(mouse.pitch < 0);
  const stickUp = axesFromStick(0, -1);
  assert.equal(stickUp.forward, 1);
  assert.equal(stickUp.strafe, 0);
  const look = lookFromStick(1, -1, 1, 2, 2);
  assert.equal(look.yaw, -2);
  assert.equal(look.pitch, 2);
  assert.equal(clampPitch(4), PITCH_LIMIT);
  assert.equal(clampPitch(-4), -PITCH_LIMIT);
});

test("eye sits at 1.6 m and looks along engine forward", () => {
  const aim = eyeLook({ x: 2, y: 0, z: -3 }, 0, 0);
  assert.equal(aim.position.y, EYE_HEIGHT);
  assert.equal(aim.position.x, 2);
  assert.ok(aim.target.z > aim.position.z);
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(aim.position.x, aim.position.y, aim.position.z);
  camera.up.set(0, 1, 0);
  camera.lookAt(aim.target.x, aim.target.y, aim.target.z);
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  assert.ok(dir.z > 0.99);
  assert.ok(Math.abs(dir.x) < 1e-6);
  const yaw = Math.PI / 2;
  const quat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  assert.ok(Math.abs(yawFromQuat(quat) - yaw) < 1e-9);
  const faced = new THREE.Vector3(0, 0, 1).applyQuaternion(quat);
  assert.ok(faced.x > 0.99);
});

test("jumper-t move stick is the swapped inverted right stick", () => {
  assert.equal(JUMPER_MOVE_X, GAMEPAD_AXIS.RightY);
  assert.equal(JUMPER_MOVE_Y, GAMEPAD_AXIS.RightX);
  assert.equal(JUMPER_LOOK_X, GAMEPAD_AXIS.LeftX);
  assert.equal(JUMPER_LOOK_Y, GAMEPAD_AXIS.LeftY);
  const moved = jumperStick(JUMPER_MOVE_Y, { x: 0.4, y: -0.8 });
  assert.deepEqual(moved, { x: -0.4, y: 0.8 });
  const looked = jumperStick(JUMPER_LOOK_Y, { x: 0.4, y: -0.8 });
  assert.deepEqual(looked, { x: 0.4, y: -0.8 });
  const intent = axesFromStick(moved.x, moved.y);
  assert.equal(intent.strafe, -0.4);
  assert.equal(intent.forward, -0.8);
});
