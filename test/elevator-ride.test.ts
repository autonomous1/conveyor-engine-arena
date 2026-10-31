/**
 * A cab carries a pawn through a floor slab. Runs against dist/ like door-block.test.ts
 * (`npm run build` first). Each tick steps the host, then commitShielded so the slab
 * cannot push the rider sideways.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { AuthoritativeWorld } from "conveyor-engine-world";
import { createArenaElevators } from "../dist/server/elevators.js";
import type { ArenaElevator } from "../dist/shared/arena-view.js";
import { commitShielded, enqueuePlanarMove, MOVE_DT } from "../dist/shared/movements.js";

const RADIUS = 0.5;
const HEIGHT = 1.8;

const cab: ArenaElevator = {
  id: "cab",
  stops: [0, 2.75],
  speed: 1,
  waitS: 8,
  polygon: [[0, 0], [2, 0], [2, 2], [0, 2]],
  landings: [[2.6, 0, 1], [2.6, 2.75, 1]],
};

function near(a: number, b: number, label: string, tol = 1e-6): void {
  assert.ok(Math.abs(a - b) <= tol, `${label}: ${a} != ${b}`);
}

function rig() {
  const world = new AuthoritativeWorld({ worldVersion: "t" });
  world.pawnHeight = HEIGHT;
  world.addObstacle({ id: 1, minX: -1, maxX: 40, minY: 2.65, maxY: 2.75, minZ: -1, maxZ: 4 });
  const pawn = world.createEntity(0n, { type: "pawn", shape: "capsule", assetKey: "a" }, 1);
  world.enqueue({ kind: "setBounds", entity: pawn, radius: RADIUS });
  world.commit(0n);
  const frames: Array<{ t: string; y: number; doorsOpen: boolean; stop: number }> = [];
  const logs: string[] = [];
  const host = createArenaElevators({
    elevators: [cab],
    world,
    pawns: () => {
      const view = world.store.view(pawn)!;
      return [{ id: pawn, x: view.position.x, y: view.position.y, z: view.position.z, radius: RADIUS, height: HEIGHT, alive: true }];
    },
    ownedPawn: () => pawn,
    alive: () => true,
    sendAll: (frame) => frames.push(frame),
    log: (line) => logs.push(line),
  });
  let tick = 1n;
  const nextTick = () => tick++;
  const place = (x: number, y: number, z: number) => {
    world.enqueue({
      kind: "setTransform",
      entity: pawn,
      position: { x, y, z },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 1, y: 1, z: 1 },
    });
    world.commit(nextTick());
  };
  const step = (n: number) => {
    for (let i = 0; i < n; i += 1) {
      const riders = host.step(MOVE_DT);
      commitShielded(world, nextTick(), riders);
    }
    return world.store.view(pawn)!.position;
  };
  return { world, pawn, frames, logs, host, place, step, nextTick };
}

test("a call from the cab rises to the slab and the pawn walks out on that floor", () => {
  const ride = rig();
  ride.place(1, 0, 1);
  const before = ride.world.store.view(ride.pawn)!.position;
  ride.host.onFrame(1, { t: "elevator", id: "cab", stop: 1 });
  const limit = Math.ceil(2.75 / MOVE_DT) + 2;
  let arrived = false;
  const movingY: number[] = [];
  for (let i = 0; i < limit; i += 1) {
    const riders = ride.host.step(MOVE_DT);
    commitShielded(ride.world, ride.nextTick(), riders);
    const pos = ride.world.store.view(ride.pawn)!.position;
    const frame = ride.frames.at(-1);
    if (frame && frame.doorsOpen === false) movingY.push(frame.y);
    if (Math.abs(pos.y - 2.75) <= 0.01) {
      arrived = true;
      near(pos.x, before.x, "x", 1e-6);
      near(pos.z, before.z, "z", 1e-6);
      break;
    }
  }
  assert.equal(arrived, true);
  assert.ok(movingY.length >= 2, "moving frames");
  for (let i = 1; i < movingY.length; i += 1) assert.ok(movingY[i]! >= movingY[i - 1]! - 1e-9);
  assert.ok(movingY.some((y, index) => index > 0 && y > movingY[index - 1]!));
  assert.ok(ride.frames.some((frame) => frame.doorsOpen === false));
  assert.equal(ride.frames.at(-1)?.doorsOpen, true);

  const ticks = Math.round(1.5 / MOVE_DT);
  let end = ride.world.store.view(ride.pawn)!.position;
  for (let i = 0; i < ticks; i += 1) {
    enqueuePlanarMove(ride.world as never, ride.pawn, 1, 0, 0);
    ride.world.commit(ride.nextTick());
    end = ride.world.store.view(ride.pawn)!.position;
  }
  near(end.y, 2.75, "walks on floor 2", 0.01);
  assert.ok(end.x > 2, `past the door side, x=${end.x}`);
});

test("a call from outside the cab and the landings is ignored", () => {
  const ride = rig();
  ride.place(50, 0, 50);
  const before = ride.frames.length;
  ride.host.onFrame(1, { t: "elevator", id: "cab", stop: 1 });
  ride.step(5);
  near(ride.world.store.view(ride.pawn)!.position.y, 0, "stays put", 1e-6);
  assert.equal(ride.frames.length, before);
  assert.equal(ride.host.snapshot()[0]?.y, 0);
  assert.equal(ride.host.snapshot()[0]?.stop, 0);
  assert.ok(ride.logs.some((line) => line.startsWith("[elevator]")));
});

test("E on the upper landing brings the cab up from the ground", () => {
  const ride = rig();
  ride.place(2.6, 2.75, 1);
  assert.equal(ride.host.onUse(ride.pawn), true);
  const limit = Math.ceil(2.75 / MOVE_DT) + 2;
  let rose = false;
  for (let i = 0; i < limit; i += 1) {
    ride.step(1);
    const row = ride.host.snapshot()[0]!;
    if (row.stop === 1 && Math.abs(row.y - 2.75) <= 0.01) {
      rose = true;
      break;
    }
  }
  assert.equal(rose, true);
  assert.equal(ride.host.onUse(ride.pawn), true);
});
