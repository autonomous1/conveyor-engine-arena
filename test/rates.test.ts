import assert from "node:assert/strict";
import test from "node:test";
import { createRateWindow, formatOverlay } from "../src/client/rates.ts";

test("fps averages presented frames over the window", () => {
  const rates = createRateWindow(500);
  let sample = rates.push(0);
  assert.equal(sample.fps, undefined);
  for (let i = 1; i < 29; i++) sample = rates.push(i * 16);
  assert.equal(sample.fps, undefined);
  sample = rates.push(500);
  assert.equal(sample.fps, 60);

  const sparse = createRateWindow(500);
  sparse.push(0);
  const two = sparse.push(500);
  assert.equal(two.fps, 4);
});

test("tick/s follows snapshot tick deltas and clears when none arrive", () => {
  const rates = createRateWindow(1000);
  rates.push(0, 1000);
  for (let i = 1; i < 20; i++) rates.push(i * 50, 1000 + i);
  const filled = rates.push(1000, 1020);
  assert.equal(filled.tickPerSec, 20);

  const idle = createRateWindow(500);
  idle.push(0, 10);
  const advanced = idle.push(500, 20);
  assert.equal(advanced.tickPerSec, 20);
  const quiet = idle.push(1000);
  assert.equal(quiet.tickPerSec, undefined);
});

test("overlay prints the hud lines and an em dash when tick/s is unset", () => {
  const text = formatOverlay({
    fps: 59.6,
    tickPerSec: undefined,
    tick: 1842,
    snaps: 120,
    resyncs: 0,
    seq: 120,
    calls: 42,
    tris: 120004,
    geoms: 18,
    tex: 9,
    shadows: "on",
    shadowMap: 1,
    tone: 4,
    exposure: 1,
    pawns: 4,
    owned: 2,
    positions: "",
  });
  assert.equal(text, [
    "fps 60  tick/s \u2014  tick 1842",
    "snaps 120  resync 0  seq 120",
    "calls 42  tris 120004",
    "geoms 18  tex 9",
    "shadows on  map 1  tone 4  exp 1",
    "pawns 4  owned 2",
  ].join("\n"));
});
