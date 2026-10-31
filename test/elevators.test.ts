import assert from "node:assert/strict";
import test from "node:test";
import type { ArenaElevator } from "../src/shared/arena-view.ts";
import {
  callElevator,
  elevatorDoorSide,
  inCab,
  landingAt,
  MIN_DWELL_S,
  nextStopUp,
  seedElevator,
  stepElevator,
  stopForKey,
  type ElevatorRuntime,
} from "../src/shared/elevators.ts";

const DT = 0.05;

const cab: ArenaElevator = {
  id: "cab",
  stops: [0, 2.75],
  speed: 1,
  waitS: 8,
  polygon: [[0, 0], [2, 0], [2, 2], [0, 2]],
  landings: [[2.6, 0, 1], [2.6, 2.75, 1]],
};

function fresh(): ElevatorRuntime {
  return seedElevator(cab);
}

test("stopForKey maps digit keys onto stop indexes", () => {
  assert.equal(stopForKey("Digit1", 10), 0);
  assert.equal(stopForKey("Digit9", 10), 8);
  assert.equal(stopForKey("Digit0", 10), 9);
  assert.equal(stopForKey("Numpad2", 10), 1);
  assert.equal(stopForKey("Digit5", 3), undefined);
  assert.equal(stopForKey("KeyE", 10), undefined);
});

test("a call from idle departs on the next step, arrives in 2.75 s, dwells 8 s, then idles", () => {
  const rt = fresh();
  assert.equal(callElevator(rt, cab, 1, false), true);
  assert.equal(stepElevator(rt, cab, DT), "departed");
  assert.equal(rt.phase, "moving");
  assert.equal(rt.y, 0);
  let steps = 0;
  while (rt.phase === "moving") {
    const event = stepElevator(rt, cab, DT);
    steps += 1;
    if (event === "arrived") break;
    assert.ok(steps < 200);
  }
  assert.equal(rt.y, 2.75);
  assert.equal(rt.phase, "dwell");
  assert.equal(rt.at, 1);
  assert.ok(Math.abs(steps * DT - 2.75) <= DT);

  let dwell = 0;
  while (rt.phase === "dwell") {
    stepElevator(rt, cab, DT);
    dwell += 1;
    assert.ok(dwell < 400);
  }
  assert.equal(rt.phase, "idle");
  assert.ok(Math.abs(dwell * DT - cab.waitS) <= DT);
});

test("a queued call during dwell departs after waitS, and a cab call after 1 s", () => {
  const hallSteps = stepsUntilDepart(false);
  const cabSteps = stepsUntilDepart(true);
  assert.ok(Math.abs(hallSteps * DT - cab.waitS) <= DT);
  assert.ok(Math.abs(cabSteps * DT - MIN_DWELL_S) <= DT);
});

test("callElevator ignores a duplicate, an out-of-range stop, and the current stop while idle", () => {
  const rt = fresh();
  assert.equal(callElevator(rt, cab, 1, false), true);
  assert.equal(callElevator(rt, cab, 1, false), false);
  assert.deepEqual(rt.queue, [1]);
  assert.equal(callElevator(rt, cab, 2, false), false);
  assert.equal(callElevator(rt, cab, -1, false), false);
  assert.equal(callElevator(rt, cab, 1.5, false), false);
  assert.deepEqual(rt.queue, [1]);

  const parked = fresh();
  assert.equal(callElevator(parked, cab, 0, false), false);
  assert.deepEqual(parked.queue, []);

  const dwelling = fresh();
  dwelling.phase = "dwell";
  dwelling.at = 1;
  dwelling.y = 2.75;
  dwelling.t = 8;
  assert.equal(callElevator(dwelling, cab, 1, true), false);
  assert.equal(dwelling.t, 8);
  assert.deepEqual(dwelling.queue, []);
});

test("elevatorDoorSide follows the world landing, including a 90 degree building yaw", () => {
  assert.deepEqual(elevatorDoorSide(cab), [1, 0]);
  const north = {
    ...cab,
    landings: [[1, 0, -0.6], [1, 2.75, -0.6]] as Array<[number, number, number]>,
  };
  assert.deepEqual(elevatorDoorSide(north), [0, -1]);
  // Yaw +90° about Y sends local +X to world −Z. The side is read from the world landing.
  const yawed: ArenaElevator = {
    ...cab,
    polygon: [[0, 0], [0, -2], [2, -2], [2, 0]],
    landings: [[1, 0, -2.6], [1, 2.75, -2.6]],
  };
  assert.deepEqual(elevatorDoorSide(yawed), [0, -1]);
});

test("inCab uses the polygon and a half-metre y band, and landingAt is a 1.2 m box", () => {
  const rt = fresh();
  assert.equal(inCab(cab, rt, 1, 0, 1), true);
  assert.equal(inCab(cab, rt, 1, 0.49, 1), true);
  assert.equal(inCab(cab, rt, 1, 0.5, 1), false);
  assert.equal(inCab(cab, rt, 3, 0, 1), false);
  assert.equal(landingAt(cab, 2.6, 0, 1), 0);
  assert.equal(landingAt(cab, 2.6 + 0.6, 0, 1), 0);
  assert.equal(landingAt(cab, 2.6 + 0.61, 0, 1), undefined);
  assert.equal(landingAt(cab, 2.6, 0.49, 1), 0);
  assert.equal(landingAt(cab, 2.6, 0.5, 1), undefined);
  assert.equal(landingAt(cab, 2.6, 2.75, 1), 1);
  assert.equal(landingAt(cab, 1, 0, 1), undefined);
});

test("nextStopUp wraps from the top stop to the lowest", () => {
  const rt = fresh();
  assert.equal(nextStopUp(rt, cab), 1);
  rt.at = 1;
  assert.equal(nextStopUp(rt, cab), 0);
  const three: ArenaElevator = { ...cab, stops: [0, 2.75, 5.5] };
  rt.at = 1;
  assert.equal(nextStopUp(rt, three), 2);
  rt.at = 2;
  assert.equal(nextStopUp(rt, three), 0);
});

function stepsUntilDepart(fromCab: boolean): number {
  const rt = fresh();
  rt.phase = "dwell";
  rt.at = 1;
  rt.y = 2.75;
  rt.t = cab.waitS;
  assert.equal(callElevator(rt, cab, 0, fromCab), true);
  let steps = 0;
  let event: ReturnType<typeof stepElevator>;
  while (event !== "departed") {
    event = stepElevator(rt, cab, DT);
    steps += 1;
    assert.ok(steps < 400);
  }
  return steps;
}
