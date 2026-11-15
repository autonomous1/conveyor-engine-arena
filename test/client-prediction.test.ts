import assert from "node:assert/strict";
import { test } from "node:test";
import { EngineClient } from "conveyor-engine-client";

const view = (over: Record<string, unknown> = {}) => ({
  id: 7, owner: 1,
  position: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0, w: 1 },
  scale: { x: 1, y: 1, z: 1 },
  velocity: { x: 0, y: 0, z: 0 },
  clip: "idle", radius: 0.5, speed: 0, replicationVersion: 1, inputSeq: 0,
  ...over,
});
const full = (v = view()) => ({ kind: "full" as const, seq: 1, tick: 1n, lastProcessedInput: 0, spawns: [{ entity: 7, view: v }], updates: [], despawns: [] });
const delta = (seq: number, ack: number, v = view()) => ({ kind: "delta" as const, seq, tick: BigInt(seq), lastProcessedInput: ack, spawns: [{ entity: 7, view: v }], updates: [], despawns: [] });
const make = (predictOwned = true) => {
  const c = new EngineClient(1, { predictOwned, delayMs: 0, extraMs: 0, move: { maxSpeed: 4, accel: 100, damping: 0, dt: 0.05 } });
  c.connect(7, 1);
  c.applySnapshot(full(), 0);
  return c;
};

test("client_prediction_moves_owned_before_ack", () => {
  const c = make();
  const cmd = c.collectInput({ moveX: 1, moveZ: 0, yaw: 0, buttons: 0 });
  assert.equal(c.metrics.unacked, 1);
  const frame = c.renderSnapshot(16);
  const owned = frame.entities.find((e) => e.id === 7)!;
  assert.equal(owned.predicted, true);
  assert.notDeepEqual(owned.position, { x: 0, y: 0, z: 0 });
  c.applySnapshot(delta(2, cmd.seq), 32);
  assert.equal(c.metrics.unacked, 0);
  assert.equal(c.metrics.lastAckInput, cmd.seq);
});

test("client_prediction_counts_a_hard_correction", () => {
  const c = make();
  const cmd = c.collectInput({ moveX: 1, moveZ: 0, yaw: 0, buttons: 0 });
  c.renderSnapshot(16);
  c.applySnapshot(delta(2, cmd.seq, view({ position: { x: 10, y: 0, z: 0 } })), 32);
  assert.ok(c.metrics.hardCorrections >= 1);
});

test("client_prediction_off_uses_interpolation", () => {
  const c = make(false);
  c.collectInput({ moveX: 1, moveZ: 0, yaw: 0, buttons: 0 });
  const frame = c.renderSnapshot(16);
  const owned = frame.entities.find((e) => e.id === 7)!;
  assert.equal(owned.predicted, false);
});
