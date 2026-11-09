import assert from "node:assert/strict";
import test from "node:test";
import type { ArenaSoundName } from "../src/shared/arena-view.ts";
import { createElevatorSounds } from "../src/client/elevator-sound.ts";

const state = (id: string, y: number, doorsOpen: boolean, stop = 0) => ({ t: "elevator" as const, id, y, doorsOpen, stop });

type Played = { name: ArenaSoundName; at: { x: number; y: number; z: number }; moves: Array<[number, number, number]>; alive: boolean };

function setup() {
  const played: Played[] = [];
  const sounds = createElevatorSounds({
    cabs: [{ id: "lift", x: 10, z: -4 }, { id: "other", x: 40, z: 8 }],
    play: (name, at) => {
      const entry: Played = { name, at: { ...at }, moves: [], alive: true };
      played.push(entry);
      return {
        move(x, y, z) {
          if (!entry.alive) return false;
          entry.moves.push([x, y, z]);
          return true;
        },
      };
    },
  });
  return { sounds, played };
}

test("a cab that leaves a stop plays the start sound at the cab, once", () => {
  const { sounds, played } = setup();
  sounds.onSet([state("lift", 0, true), state("other", 0, true)]);
  sounds.onCab(state("lift", 0, false));
  assert.equal(played.length, 1);
  assert.equal(played[0]!.name, "elevatorStart");
  assert.deepEqual(played[0]!.at, { x: 10, y: 1.2, z: -4 });
  // Repeated frames while it moves do not play again.
  sounds.onCab(state("lift", 0.5, false));
  sounds.onCab(state("lift", 1, false));
  assert.equal(played.length, 1);
});

test("the sound follows the cab while it moves and is let go on arrival", () => {
  const { sounds, played } = setup();
  sounds.onSet([state("lift", 3, true, 1)]);
  sounds.onCab(state("lift", 3, false, 1));
  sounds.onCab(state("lift", 3.4, false, 1));
  sounds.onCab(state("lift", 3.8, false, 1));
  assert.deepEqual(played[0]!.moves, [[10, 4.6, -4], [10, 5, -4]]);
  assert.equal(sounds.following, 1);
  sounds.onCab(state("lift", 6, true, 2));
  assert.equal(sounds.following, 0, "arrived");
  sounds.onCab(state("lift", 6, true, 2));
  assert.equal(played[0]!.moves.length, 2);
  // The next departure is a new play.
  sounds.onCab(state("lift", 6, false, 2));
  assert.equal(played.length, 2);
});

test("a sound that has ended is dropped from following", () => {
  const { sounds, played } = setup();
  sounds.onSet([state("lift", 0, true)]);
  sounds.onCab(state("lift", 0, false));
  played[0]!.alive = false;
  sounds.onCab(state("lift", 1, false));
  assert.equal(sounds.following, 0);
});

test("welcome is the silent baseline: a cab already moving or standing makes no sound", () => {
  const { sounds, played } = setup();
  sounds.onSet([state("lift", 2, false, 0), state("other", 0, true)]);
  assert.equal(played.length, 0);
  sounds.onCab(state("lift", 2.5, false));
  sounds.onCab(state("lift", 3, false));
  sounds.onCab(state("other", 0, true));
  assert.equal(played.length, 0, "moving to moving and standing to standing are silent");
  assert.equal(sounds.following, 0, "a cab that was already moving is not followed (no voice)");
  // Both cabs make a real transition afterwards.
  sounds.onCab(state("lift", 5, true, 1));
  sounds.onCab(state("lift", 5, false, 1));
  sounds.onCab(state("other", 0, false));
  assert.equal(played.length, 2);
});

test("a frame before welcome, an unknown cab, and a failed play are all silent", () => {
  const { sounds, played } = setup();
  sounds.onCab(state("lift", 0, false));
  sounds.onCab(state("ghost", 0, true));
  sounds.onCab(state("ghost", 0, false));
  assert.equal(played.length, 0);
  // The cab was moving at that first frame, so the baseline is moving; the next stop then start is real.
  sounds.onCab(state("lift", 3, true));
  sounds.onCab(state("lift", 3, false));
  assert.equal(played.length, 1);

  const none = createElevatorSounds({ cabs: [{ id: "lift", x: 0, z: 0 }], play: () => undefined });
  none.onSet([state("lift", 0, true)]);
  none.onCab(state("lift", 0, false));
  none.onCab(state("lift", 1, false));
  assert.equal(none.following, 0);
});

test("clear forgets everything: the next frame is a baseline again", () => {
  const { sounds, played } = setup();
  sounds.onSet([state("lift", 0, true)]);
  sounds.clear();
  sounds.onCab(state("lift", 0, false));
  assert.equal(played.length, 0);
});

test("two cabs sound independently", () => {
  const { sounds, played } = setup();
  sounds.onSet([state("lift", 0, true), state("other", 0, true)]);
  sounds.onCab(state("lift", 0, false));
  sounds.onCab(state("other", 0, false));
  assert.deepEqual(played.map((p) => p.at.x), [10, 40]);
  sounds.onCab(state("other", 1, false));
  assert.equal(played[0]!.moves.length, 0);
  assert.equal(played[1]!.moves.length, 1);
});
