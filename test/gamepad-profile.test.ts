import assert from "node:assert/strict";
import test from "node:test";
import {
  GAMEPAD_PROFILE_STORAGE_KEY,
  JUMPER_MOVE_Y,
  LOOK_PITCH_RATE,
  LOOK_YAW_RATE,
  PITCH_LIMIT,
  axesFromStick,
  clampPitch,
  gamepadLook,
  gamepadPlanar,
  gamepadProfileFromStored,
  jumperStick,
  loadGamepadProfile,
  lookFromMouse,
  lookFromStick,
  moveIntent,
  sampleMove,
} from "../src/shared/look.ts";

test("standard left stick up matches W held in yaw space", () => {
  const stickUp = [0, -1, 0, 0];
  const fromPad = sampleMove("standard", new Set(), { connected: true, axes: stickUp });
  const fromW = sampleMove("standard", new Set(["KeyW"]), { connected: false, axes: [1, 1, 1, 1] });
  assert.equal(fromPad.forward, 1);
  assert.equal(fromPad.strafe, 0);
  assert.deepEqual(fromPad, fromW);
  for (const yaw of [0, Math.PI / 2, -0.4]) {
    assert.deepEqual(
      moveIntent(yaw, fromPad.forward, fromPad.strafe),
      moveIntent(yaw, fromW.forward, fromW.strafe),
    );
  }
  const ahead = moveIntent(0, fromPad.forward, fromPad.strafe);
  assert.ok(ahead.moveZ > 0.99);
  assert.ok(Math.abs(ahead.moveX) < 1e-9);

  const lookStick = gamepadPlanar("standard", [0, 0, 1, -1]);
  assert.ok(Math.abs(lookStick.forward) < 1e-9);
  assert.ok(Math.abs(lookStick.strafe) < 1e-9);
  const look = gamepadLook("standard", [0, 0, 1, -1], 1);
  const mouse = lookFromMouse(10, -10);
  assert.ok(look.yaw < 0);
  assert.ok(mouse.yaw < 0);
  assert.ok(look.pitch > 0);
  assert.ok(mouse.pitch > 0);
  assert.ok(look.pitch > PITCH_LIMIT);
  assert.equal(clampPitch(look.pitch), PITCH_LIMIT);
});

test("jumper-t profile negates Y and matches the previous move and look signs", () => {
  const raw = { x: 0.4, y: -0.8 };
  const negated = jumperStick(JUMPER_MOVE_Y, raw);
  assert.equal(negated.x, -raw.x);
  assert.equal(negated.y, -raw.y);
  const previous = axesFromStick(negated.x, negated.y);
  assert.equal(previous.strafe, -0.4);
  assert.equal(previous.forward, -0.8);

  const axes = [0.4, -0.8, raw.y, raw.x];
  const sample = gamepadPlanar("jumper-t", axes);
  assert.equal(sample.strafe, previous.strafe);
  assert.equal(sample.forward, previous.forward);

  const fullUp = gamepadPlanar("jumper-t", [0, 0, 1, 0]);
  const heldW = sampleMove("jumper-t", new Set(["KeyW"]), { connected: false, axes: [] });
  assert.equal(fullUp.forward, heldW.forward);
  assert.ok(Math.abs(fullUp.strafe) < 1e-9);

  const fullBack = gamepadPlanar("jumper-t", [0, 0, -1, 1]);
  const heldS = sampleMove("jumper-t", new Set(["KeyS"]), { connected: false, axes: [] });
  assert.equal(fullBack.forward, heldS.forward);
  assert.equal(fullBack.strafe, -1);

  const looked = gamepadLook("jumper-t", [0.4, -0.8, 0, 0], 1);
  const previousLook = lookFromStick(0.4, -0.8, 1, LOOK_YAW_RATE, LOOK_PITCH_RATE);
  assert.deepEqual(looked, previousLook);
  assert.ok(looked.yaw < 0);
  assert.ok(looked.pitch > 0);
});

test("absent or garbage gamepad profile falls back to standard", () => {
  assert.equal(gamepadProfileFromStored(null), "standard");
  assert.equal(gamepadProfileFromStored(undefined), "standard");
  assert.equal(gamepadProfileFromStored(""), "standard");
  assert.equal(gamepadProfileFromStored("xbox"), "standard");
  assert.equal(gamepadProfileFromStored("Jumper-T"), "standard");
  assert.equal(loadGamepadProfile(null), "standard");
  assert.equal(loadGamepadProfile(undefined), "standard");

  const missing = loadGamepadProfile({
    getItem() {
      return null;
    },
    setItem() {},
  });
  assert.equal(missing, "standard");

  const garbage = loadGamepadProfile({
    getItem(key: string) {
      assert.equal(key, GAMEPAD_PROFILE_STORAGE_KEY);
      return "{\"profile\":nope}";
    },
    setItem() {},
  });
  assert.equal(garbage, "standard");

  const thrown = loadGamepadProfile({
    getItem() {
      throw new Error("storage blocked");
    },
    setItem() {},
  });
  assert.equal(thrown, "standard");

  const kept = loadGamepadProfile({
    getItem(key: string) {
      assert.equal(key, GAMEPAD_PROFILE_STORAGE_KEY);
      return "jumper-t";
    },
    setItem() {},
  });
  assert.equal(kept, "jumper-t");
  assert.equal(gamepadProfileFromStored("standard"), "standard");
});
