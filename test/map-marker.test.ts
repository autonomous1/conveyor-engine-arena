import assert from "node:assert/strict";
import test from "node:test";
import { mapFrame } from "../src/shared/map-frame.ts";
import { floorLabel, selfMarker, selfMoved } from "../src/client/map-marker.ts";

const frame = mapFrame({ minX: -10, maxX: 10, minZ: -10, maxZ: 10 }, 360, 360)!;
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);

test("facing -Z points up, +X points right, +Z points down", () => {
  const up = selfMarker(frame, { x: 0, y: 0, z: 0, yaw: Math.PI });
  near(up.heading[0], 0);
  near(up.heading[1], -1);
  assert.ok(up.wedge[0][1] < up.center[1]);
  const right = selfMarker(frame, { x: 0, y: 0, z: 0, yaw: Math.PI / 2 });
  near(right.heading[0], 1);
  assert.ok(right.wedge[0][0] > right.center[0]);
  const down = selfMarker(frame, { x: 0, y: 0, z: 0, yaw: 0 });
  near(down.heading[1], 1);
});

test("dot maps through mapFrame; -Z is near the top", () => {
  const m = selfMarker(frame, { x: 5, y: 0, z: -8, yaw: 0 });
  assert.deepEqual(m.center, frame.toPixel(5, -8));
  assert.ok(m.center[1] < 180 && m.center[0] > 180);
});

test("floor label from the nearest elevator stops, else height", () => {
  const lift = { polygon: [[0, 0], [2, 0], [2, 2], [0, 2]] as Array<[number, number]>, stops: [0, 3, 6, 9] };
  assert.equal(floorLabel({ x: 5, y: 0.1, z: 5 }, [lift]), "F1");
  assert.equal(floorLabel({ x: 5, y: 6.0, z: 5 }, [lift]), "F3");
  assert.equal(floorLabel({ x: 5, y: 8.7, z: 5 }, [lift]), "F4");
  assert.equal(floorLabel({ x: 500, y: 9, z: 5 }, [lift]), "y 9.0m");
  assert.equal(floorLabel({ x: 0, y: 2, z: 0 }), "y 2.0m");
});

test("selfMoved ignores jitter", () => {
  const a = { x: 0, y: 0, z: 0, yaw: 0 };
  assert.equal(selfMoved(undefined, a, "F1", ""), true);
  assert.equal(selfMoved(a, { ...a, x: 0.01 }, "F1", "F1"), false);
  assert.equal(selfMoved(a, { ...a, x: 0.2 }, "F1", "F1"), true);
  assert.equal(selfMoved(a, { ...a, yaw: 0.1 }, "F1", "F1"), true);
  assert.equal(selfMoved(a, a, "F2", "F1"), true);
});
