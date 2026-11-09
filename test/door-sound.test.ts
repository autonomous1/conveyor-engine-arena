import assert from "node:assert/strict";
import test from "node:test";
import type { ArenaSoundName } from "../src/shared/arena-view.ts";
import { createDoorSounds } from "../src/client/door-sound.ts";

// A 1 m wide, 2 m tall leaf at x..x+1: centre (x + 0.5, 1, z).
const door = (id: string, x: number, z: number, open = false, locked = false) => ({ id, open, locked, at: { x: x + 0.5, y: 1, z } });
const doors = [door("a", 0, 0), door("b", 1.5, 0), door("far", 30, 0), door("open-at-start", 50, 0, true), door("locked", 70, 0, false, true)];

type Played = [ArenaSoundName, { x: number; y: number; z: number }];
function setup() {
  const played: Played[] = [];
  const sounds = createDoorSounds({ doors, play: (name, at) => void played.push([name, { ...at }]) });
  return { sounds, played };
}

function setupSlam() {
  const played: Played[] = [];
  const sounds = createDoorSounds({ doors, play: (name, at) => void played.push([name, { ...at }]), closeDelayMs: 400 });
  return { sounds, played };
}

test("closed to open creaks at once, at the leaf centre, for anyone", () => {
  const { sounds, played } = setup();
  sounds.onDoor({ id: "a", open: true }, 1000);
  assert.equal(played.length, 1);
  assert.equal(played[0]![0], "doorOpen");
  assert.ok(Math.abs(played[0]![1].y - 1) < 1e-9);
  assert.ok(Math.abs(played[0]![1].x - 0.5) < 1e-6, `x ${played[0]![1].x}`);
});

test("open to closed plays the close sound at the start of the closing, by default", () => {
  const { sounds, played } = setup();
  sounds.onDoor({ id: "far", open: true }, 0);
  played.length = 0;
  sounds.onDoor({ id: "far", open: false }, 1000);
  assert.deepEqual(played.map((p) => p[0]), ["doorClose"]);
  sounds.update(1400);
  assert.equal(played.length, 1, "once");
});

test("with closeDelayMs the slam waits for the end of the swing", () => {
  const { sounds, played } = setupSlam();
  sounds.onDoor({ id: "far", open: true }, 0);
  played.length = 0;
  sounds.onDoor({ id: "far", open: false }, 1000);
  sounds.update(1100);
  assert.equal(played.length, 0, "still swinging");
  sounds.update(1400);
  assert.deepEqual(played.map((p) => p[0]), ["doorClose"]);
  sounds.update(3000);
  assert.equal(played.length, 1, "once");
  assert.equal(sounds.waiting, 0);
});

test("with closeDelayMs, a door that reopens before the slam is not slammed", () => {
  const { sounds, played } = setupSlam();
  sounds.onDoor({ id: "far", open: true }, 0);
  sounds.onDoor({ id: "far", open: false }, 1000);
  sounds.onDoor({ id: "far", open: true }, 1200);
  sounds.update(2000);
  assert.deepEqual(played.map((p) => p[0]), ["doorOpen", "doorOpen"]);
});

test("only real transitions: resends, lock-only frames, unknown ids, and the starting state are silent", () => {
  const { sounds, played } = setup();
  sounds.onDoor({ id: "a", open: false }, 0); // resend of the shut state
  sounds.onDoor({ id: "open-at-start", open: true }, 0); // already open in the view
  sounds.onDoor({ id: "locked", open: false }, 0); // lock change alone
  sounds.onDoor({ id: "nope", open: true }, 0);
  sounds.update(5000);
  assert.deepEqual(played, []);
  sounds.onDoor({ id: "a", open: true }, 10);
  sounds.onDoor({ id: "a", open: true }, 20); // duplicate of the same frame
  assert.equal(played.length, 1);
});

test("welcome sets the baseline silently, including a late joiner's open doors", () => {
  const { sounds, played } = setup();
  sounds.onSet([{ id: "a", open: true, locked: false }, { id: "far", open: true, locked: false }, { id: "gone", open: true, locked: false }]);
  sounds.update(1000);
  assert.deepEqual(played, [], "nothing plays at welcome");
  sounds.onDoor({ id: "a", open: true }, 1000);
  assert.deepEqual(played, [], "the same state again is a resend");
  sounds.onDoor({ id: "a", open: false }, 1100);
  assert.deepEqual(played.map((p) => p[0]), ["doorClose"], "a later real change still plays");
  // A welcome mid-swing drops a pending slam.
  const delayed = setupSlam();
  delayed.sounds.onSet([{ id: "far", open: true, locked: false }]);
  delayed.sounds.onDoor({ id: "far", open: false }, 2000);
  delayed.sounds.onSet([{ id: "far", open: false, locked: false }]);
  delayed.sounds.update(3000);
  assert.equal(delayed.played.length, 0);
});

test("doors that change together within 2 m merge into one sound; far ones do not", () => {
  const { sounds, played } = setup();
  sounds.onDoor({ id: "a", open: true }, 1000);
  sounds.onDoor({ id: "b", open: true }, 1010); // 1.5 m from a
  sounds.onDoor({ id: "far", open: true }, 1010);
  assert.deepEqual(played.map((p) => p[0]), ["doorOpen", "doorOpen"]);
  assert.ok(played[1]![1].x > 20, "the second sound is the far door");
  sounds.onDoor({ id: "a", open: false }, 2000);
  sounds.onDoor({ id: "b", open: false }, 2000);
  assert.equal(played.filter((p) => p[0] === "doorClose").length, 1);
  // The same pair later, outside the merge time, plays again.
  sounds.onDoor({ id: "a", open: true }, 5000);
  sounds.onDoor({ id: "b", open: true }, 5500);
  assert.equal(played.filter((p) => p[0] === "doorOpen").length, 4);
});
