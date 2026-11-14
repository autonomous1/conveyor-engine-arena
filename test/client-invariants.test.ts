import assert from "node:assert/strict";
import { test } from "node:test";
import { createEchoDedupe } from "../src/client/audio.ts";
import { createRateWindow } from "../src/client/rates.ts";
import { floorLabel } from "../src/client/map-marker.ts";

test("echo_dedupe_consumes_once", () => {
  const dedupe = createEchoDedupe(1_000, 8);
  dedupe.noteLocal(100);
  assert.equal(dedupe.pending, 1);
  // The waiting local play covers exactly one echo and is consumed.
  assert.equal(dedupe.echo(200), false);
  assert.equal(dedupe.pending, 0);
  assert.equal(dedupe.echo(300), true);
  // An echo after the window plays: the note was pruned, not consumed.
  dedupe.noteLocal(100);
  assert.equal(dedupe.echo(1_101), true);
  assert.equal(dedupe.pending, 0);
});

test("rate_window_tick_unset_without_snapshot", () => {
  const idle = createRateWindow(500);
  assert.equal(idle.push(0).tickPerSec, undefined);
  const idleWindow = idle.push(500);
  assert.equal(idleWindow.fps, 4);
  assert.equal(idleWindow.tickPerSec, undefined);

  const moving = createRateWindow(1_000);
  moving.push(0, 10);
  assert.equal(moving.push(1_000, 20).tickPerSec, 10);
  // The next window saw no snapshot: unset, not the previous value.
  assert.equal(moving.push(2_000).tickPerSec, undefined);
});

test("floor_label_uses_lowest_stop", () => {
  const lift = {
    polygon: [[0, 0], [10, 0], [10, 10], [0, 10]] as ReadonlyArray<readonly [number, number]>,
    stops: [0, 3, 6] as readonly number[],
  };
  const at = (x: number, y: number, z: number) => floorLabel({ x, y, z }, [lift]);
  assert.equal(at(5, 0, 5), "F1");
  assert.equal(at(5, 3, 5), "F2");
  assert.equal(at(5, 6, 5), "F3");
  assert.equal(at(100, 6, 100), "y 6.0m");
});
