import assert from "node:assert/strict";
import test from "node:test";
import { findClip, movementIntent } from "../src/shared/movements.ts";

test("Zombie Walk and Zombie Run match the phrase inside the clip name", () => {
  const clips = [
    "angry_01",
    "fall",
    "I would like to make a \"zombie run\"",
    "I would like to make a \"zombie walk\"",
    "run",
    "walk",
  ].map((name) => ({ name }));
  assert.equal(findClip(clips, "Zombie Walk")?.name, "I would like to make a \"zombie walk\"");
  assert.equal(findClip(clips, "Zombie Run")?.name, "I would like to make a \"zombie run\"");
  assert.equal(findClip(clips, "run")?.name, "run");
  assert.equal(findClip(clips, "walk")?.name, "walk");
});

test("animation speeds keep their ratio and the fastest movement is full input", () => {
  const speeds = [0, 1, 2, 0, 0];
  assert.equal(movementIntent(0, speeds), 0);
  assert.equal(movementIntent(1, speeds), 0.5);
  assert.equal(movementIntent(2, speeds), 1);
});

test("a set of zero speeds does not move", () => {
  assert.equal(movementIntent(0, [0, 0]), 0);
});
