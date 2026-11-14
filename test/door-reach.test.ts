import assert from "node:assert/strict";
import { test } from "node:test";
import { doorInReach, pickDoorForUse, type DoorRuntime } from "../src/shared/doors.ts";

type Pawn = { id: number; x: number; y: number; z: number; radius: number; height: number; alive: boolean };

function door(over: Partial<DoorRuntime> = {}): DoorRuntime {
  return {
    id: "d",
    hinge: "left",
    open: false,
    locked: false,
    position: [0, 0, 0],
    size: [1, 2.1, 0.08],
    yaw: 0,
    ...over,
  };
}

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("door_reach_matches_pick", () => {
  const r = rng(7);
  let inside = 0;
  for (let i = 0; i < 2000; i++) {
    const d = door({
      hinge: r() < 0.5 ? "left" : "right",
      position: [r() * 40 - 20, r() * 3, r() * 40 - 20],
      size: [0.6 + r() * 0.8, 2.1, 0.08],
      yaw: Math.floor(r() * 4) * 90,
    });
    const pawn: Pawn = {
      id: 1,
      x: d.position[0] + (r() - 0.5) * 8,
      y: d.position[1],
      z: d.position[2] + (r() - 0.5) * 8,
      radius: 0.5,
      height: 1.8,
      alive: true,
    };
    const picked = pickDoorForUse([d], pawn) !== undefined;
    if (picked) inside++;
    assert.equal(doorInReach(d, pawn), picked, `case ${i}`);
  }
  assert.ok(inside > 100, `too few positives: ${inside}`);
});

test("door_reach_accepts_the_far_corner_of_the_use_volume", () => {
  // Left hinge, yaw 0: local x 0..width, local z -2..0.75. The far corner from
  // the hinge is (width, 0.75). A capsule there must not be rejected.
  const d = door({ position: [0, 0, 0], size: [1, 2.1, 0.08], yaw: 0, hinge: "left" });
  const pawn: Pawn = { id: 1, x: 1, y: 0, z: 0.75, radius: 0.5, height: 1.8, alive: true };
  assert.equal(doorInReach(d, pawn), true);
  assert.notEqual(pickDoorForUse([d], pawn), undefined);
  assert.equal(doorInReach(d, { ...pawn, x: 1, z: 4 }), false);
});
