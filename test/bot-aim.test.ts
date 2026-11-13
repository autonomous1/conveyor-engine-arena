import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(
  "data:text/javascript," +
    encodeURIComponent(`
      import { existsSync } from "node:fs";
      import { fileURLToPath } from "node:url";
      export async function resolve(specifier, context, nextResolve) {
        const parent = context.parentURL ?? "";
        if ((specifier.startsWith("./") || specifier.startsWith("../")) && specifier.endsWith(".js") && parent.includes("/src/")) {
          const ts = specifier.slice(0, -3) + ".ts";
          if (existsSync(fileURLToPath(new URL(ts, parent)))) return nextResolve(ts, context);
        }
        return nextResolve(specifier, context);
      }
    `),
);

const { aimSigma, burstScheduler, sampleAim, turnToward } = await import("../src/shared/bots/aim.ts");
const { BOT_TUNING } = await import("../src/shared/bots/bot-tuning.ts");
const { FIRE_INTERVAL_MS, traceIndexed } = await import("../src/shared/hitscan.ts");
const { aimDirection, EYE_HEIGHT } = await import("../src/shared/look.ts");
const { splitMix } = await import("../src/server/game.ts");

const SHOTS = 2_000;
const CAPSULE = { id: 7, x: 0, y: 0, z: 0, radius: 0.5, height: 1.8 };

/**
 * The accepted σ meets 35–55% at 10 m and cannot at 20 m. The capsule's
 * angular size halves while σ only grows from about 3.7° to 4.9°.
 */
function hitRate(range: number, speed: number, seed: number): number {
  const rng = splitMix(seed);
  const eye = { x: 0, y: EYE_HEIGHT, z: 0 };
  const chest = { x: 0, y: BOT_TUNING.chestM, z: range };
  const capsule = { ...CAPSULE, z: range };
  let hits = 0;
  for (let i = 0; i < SHOTS; i += 1) {
    const aim = sampleAim(rng, eye, chest, range, speed);
    const shot = traceIndexed(eye, aimDirection(aim.yaw, aim.pitch), [], [capsule]);
    if (shot.hitId === capsule.id) hits += 1;
  }
  return hits / SHOTS;
}

function shotTimes(rng: () => number, until = 20_000): number[] {
  const burst = burstScheduler(rng);
  const times: number[] = [];
  for (let t = 0; t <= until; t += 1) if (burst.due(t)) times.push(t);
  return times;
}

test("aim: a still capsule at 10 m is inside 35–55%, and 20 m is the smaller measured rate", (t) => {
  const still10 = hitRate(10, 0, 0xa11);
  const still20 = hitRate(20, 0, 0xa11);
  const move10 = hitRate(10, 5, 0xa11);
  const move20 = hitRate(20, 5, 0xa11);
  t.diagnostic(`still 10 m ${(still10 * 100).toFixed(1)}%, 20 m ${(still20 * 100).toFixed(1)}%; moving ${(move10 * 100).toFixed(1)}% / ${(move20 * 100).toFixed(1)}%`);
  assert.ok(still10 >= 0.35 && still10 <= 0.55, `10 m ${(still10 * 100).toFixed(1)}%`);
  assert.ok(still20 > 0.04 && still20 < 0.16, `20 m ${(still20 * 100).toFixed(1)}%`);
  assert.ok(still20 < still10);
  assert.ok(move10 < still10, `moving 10 m ${(move10 * 100).toFixed(1)}%`);
  assert.ok(move20 < still20, `moving 20 m ${(move20 * 100).toFixed(1)}%`);
  const deg = (aimSigma(10, 0) * 180) / Math.PI;
  assert.ok(Math.abs(deg - (2.5 + 0.12 * 10)) < 1e-9);
});

test("aim: a 180° turn at 270°/s lands on the 14th 50 ms tick", () => {
  let yaw = 0;
  let at13 = 0;
  for (let tick = 1; tick <= 14; tick += 1) {
    yaw = turnToward(yaw, Math.PI, 50);
    if (tick === 13) at13 = yaw;
  }
  assert.ok(Math.abs(at13 - Math.PI) > 1e-6, `tick 13 already at ${at13}`);
  assert.equal(yaw, Math.PI);
  assert.equal(14 * 50, 700);
});

test("aim: bursts are 2–4 shots at 500 ms, then a 1.2–2.0 s gap", () => {
  const steady = shotTimes(() => 0.5, 4_000);
  assert.deepEqual(steady.slice(0, 6), [0, 500, 1000, 2600, 3100, 3600]);
  const low = shotTimes(() => 0, 4_000);
  assert.equal(low[0], 0);
  assert.equal(low[1]! - low[0]!, 500);
  assert.ok(low[2]! - low[1]! >= 1_200 && low[2]! - low[1]! <= 2_000);
  for (const seed of [1, 2, 99]) {
    const times = shotTimes(splitMix(seed));
    assert.equal(times[0], 0, "the first call is due");
    let group = 1;
    for (let i = 1; i < times.length; i += 1) {
      const gap = times[i]! - times[i - 1]!;
      assert.ok(gap >= FIRE_INTERVAL_MS, `gap ${gap}`);
      if (gap <= 500) {
        group += 1;
        assert.equal(gap, 500);
      } else {
        assert.ok(group >= 2 && group <= 4, `group ${group}`);
        assert.ok(gap >= 1_200 && gap <= 2_000, `pause ${gap}`);
        group = 1;
      }
    }
  }
});
