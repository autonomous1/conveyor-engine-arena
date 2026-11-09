import assert from "node:assert/strict";
import test from "node:test";
import { createCharacterFx } from "../src/client/character-fx.ts";

type Hit = { what: "sound" | "beam"; kind: "spawn" | "despawn"; id: number; at: number; x: number };

function setup(over: Partial<{ fadeMs: number; despawnDelayMs: number; despawnSoundDelayMs: number }> = {}) {
  const hits: Hit[] = [];
  let clock = 0;
  const fx = createCharacterFx(
    { fadeMs: 1700, despawnDelayMs: 1200, despawnSoundDelayMs: 0, ...over },
    {
      sound: (kind, id, at) => void hits.push({ what: "sound", kind, id, at: clock, x: at.x }),
      beam: (kind, id, at) => void hits.push({ what: "beam", kind, id, at: clock, x: at.x }),
    },
  );
  const at = (now: number) => {
    clock = now;
    fx.update(now);
  };
  return { fx, hits, at };
}

const spot = { x: 3, y: 0, z: 4 };

test("a spawn plays its sound and beam at once and fades in over fadeMs", () => {
  const { fx, hits, at } = setup();
  at(1000);
  fx.spawn(7, spot, 1000);
  assert.deepEqual(hits.map((h) => `${h.what}:${h.kind}@${h.at}`), ["sound:spawn@1000", "beam:spawn@1000"]);
  assert.equal(fx.opacity(7, 1000), 0);
  assert.ok(Math.abs(fx.opacity(7, 1850) - 0.5) < 1e-9);
  assert.equal(fx.opacity(7, 2700), 1);
  assert.equal(fx.opacity(7, 5000), 1);
  at(2700);
  assert.equal(fx.active, 0, "the finished fade leaves no state behind");
  assert.equal(hits.length, 2, "once");
});

test("a despawn: sound at the event, the character still for despawnDelayMs, then beam and fade, then gone", () => {
  const { fx, hits, at } = setup();
  at(0);
  fx.despawn(5, spot, 0);
  assert.deepEqual(hits.map((h) => h.what), ["sound"], "the sound is at t=0");
  assert.equal(fx.opacity(5, 0), 1);
  assert.equal(fx.opacity(5, 1199), 1, "visible and still until 1.2 s");
  at(1199);
  assert.equal(hits.length, 1);
  at(1200);
  assert.deepEqual(hits.map((h) => `${h.what}@${h.at}`), ["sound@0", "beam@1200"]);
  assert.equal(fx.opacity(5, 1200), 1);
  assert.ok(Math.abs(fx.opacity(5, 2050) - 0.5) < 1e-9);
  assert.equal(fx.gone(5, 2899), false);
  assert.equal(fx.opacity(5, 2900), 0);
  assert.equal(fx.gone(5, 2900), true);
  assert.equal(fx.leaving(5), true);
  at(9000);
  assert.equal(fx.opacity(5, 9000), 0, "stays gone until the next spawn");
  assert.equal(hits.length, 2);
  assert.equal(fx.despawnMs, 2900);
});

test("despawnSoundDelayMs shifts only the sound", () => {
  const { fx, hits, at } = setup({ despawnSoundDelayMs: 300 });
  at(0);
  fx.despawn(5, spot, 0);
  assert.equal(hits.length, 0);
  at(299);
  assert.equal(hits.length, 0);
  at(300);
  at(1200);
  assert.deepEqual(hits.map((h) => `${h.what}@${h.at}`), ["sound@300", "beam@1200"]);
});

test("a late frame fires everything that is due once, in order", () => {
  const { fx, hits, at } = setup();
  at(0);
  fx.despawn(5, spot, 0);
  at(5000);
  at(5100);
  assert.deepEqual(hits.map((h) => h.what), ["sound", "beam"]);
});

test("a death hold pushes the whole despawn back", () => {
  const { fx, hits, at } = setup();
  at(0);
  fx.despawn(5, spot, 0, 500);
  assert.equal(hits.length, 0);
  assert.equal(fx.opacity(5, 1600), 1, "still visible: the beam would have started at 1.2 s without the hold");
  at(500);
  assert.deepEqual(hits.map((h) => h.what), ["sound"]);
  at(1699);
  assert.equal(hits.length, 1);
  at(1700);
  assert.deepEqual(hits.map((h) => h.what), ["sound", "beam"]);
  assert.equal(fx.opacity(5, 1700), 1);
  assert.equal(fx.opacity(5, 3400), 0);
});

test("a spawn of the same id during the ghost period cancels the despawn cleanly", () => {
  const { fx, hits, at } = setup();
  at(0);
  fx.despawn(5, spot, 0);
  at(600);
  fx.spawn(5, { x: 9, y: 0, z: 9 }, 600);
  assert.equal(fx.opacity(5, 600), 0, "fades in from invisible at the new spot");
  assert.equal(fx.opacity(5, 2300), 1);
  // The despawn's beam (due at 1.2 s) never fires; the spawn's sound and beam did, at 600.
  at(1300);
  at(3000);
  assert.deepEqual(hits.map((h) => `${h.what}:${h.kind}@${h.at}:${h.x}`), ["sound:despawn@0:3", "sound:spawn@600:9", "beam:spawn@600:9"]);
  assert.equal(fx.leaving(5), false);
  assert.equal(fx.gone(5, 3000), false);
  at(2300);
  assert.equal(fx.active, 0);
});

test("a respawn after the character has faded out and is gone brings it back", () => {
  const { fx, at } = setup();
  at(0);
  fx.despawn(5, spot, 0);
  at(4000);
  assert.equal(fx.gone(5, 4000), true);
  fx.spawn(5, spot, 4000);
  assert.equal(fx.gone(5, 4000), false);
  assert.equal(fx.opacity(5, 4000), 0);
  assert.equal(fx.opacity(5, 5700), 1);
});

test("a second despawn while one runs keeps the first one's timeline", () => {
  const { fx, hits, at } = setup();
  at(0);
  fx.despawn(5, spot, 0);
  at(500);
  fx.despawn(5, spot, 500);
  at(1200);
  assert.deepEqual(hits.map((h) => `${h.what}@${h.at}`), ["sound@0", "beam@1200"]);
});

test("characters are independent; ids with no effect are plain", () => {
  const { fx, at } = setup();
  at(0);
  fx.despawn(1, spot, 0);
  fx.spawn(2, spot, 0);
  assert.equal(fx.opacity(3, 500), 1);
  assert.equal(fx.opacity(1, 500), 1);
  assert.equal(fx.opacity(2, 500) < 1, true);
  fx.forget(1);
  assert.equal(fx.opacity(1, 5000), 1);
  fx.clear();
  assert.equal(fx.active, 0);
});

test("the position is copied at the event: later moves of the caller's object do not move the sound", () => {
  const { fx, hits, at } = setup();
  const moving = { x: 1, y: 0, z: 0 };
  at(0);
  fx.despawn(5, moving, 0);
  moving.x = 50;
  at(1200);
  assert.deepEqual(hits.map((h) => h.x), [1, 1]);
});

test("a respawn while the despawn beam is already playing cancels only the pending timeline", () => {
  // RESPAWN_MS is 3000: despawn beam starts at 1200 and the sheet plays 2 s (to 3200), so a
  // respawn at 3000 overlaps the last 0.2 s. characterFx does not recall an already-fired beam;
  // ExplosionFx keeps that sprite running to the end. The spawn gets its own sound and beam.
  const { fx, hits, at } = setup();
  at(0);
  fx.despawn(5, spot, 0);
  at(1200);
  assert.deepEqual(hits.map((h) => `${h.what}:${h.kind}@${h.at}`), ["sound:despawn@0", "beam:despawn@1200"]);
  at(3000);
  fx.spawn(5, { x: 9, y: 0, z: 9 }, 3000);
  assert.equal(fx.leaving(5), false);
  assert.equal(fx.opacity(5, 3000), 0, "fades in from invisible at the respawn spot");
  at(4700);
  assert.deepEqual(
    hits.map((h) => `${h.what}:${h.kind}@${h.at}:${h.x}`),
    ["sound:despawn@0:3", "beam:despawn@1200:3", "sound:spawn@3000:9", "beam:spawn@3000:9"],
  );
  assert.equal(fx.opacity(5, 4700), 1);
  assert.equal(fx.active, 0);
});
