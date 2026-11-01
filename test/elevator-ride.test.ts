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
    aabbs: [],
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

test("a bound room's walls and door ride with the cab and come home", () => {
  const room = "bldg.cab";
  const door = `${room}.door-1`;
  const stops = [0, 3, 6, 9, 12];
  const bound: ArenaElevator = {
    id: "cab",
    stops,
    speed: 1,
    waitS: 0,
    polygon: [[0, 0], [2, 0], [2, 2], [0, 2]],
    landings: stops.map((y) => [2.6, y, 1] as [number, number, number]),
    room,
    building: "bldg",
  };
  const world = new AuthoritativeWorld({ worldVersion: "t" });
  world.pawnHeight = HEIGHT;
  const homes = ["front.0", "front.1", "front.2", "back.0", "left.0", "right.0"].map((name, index) => {
    const id = 10 + index;
    world.addObstacle({ id, minX: 0, maxX: 1, minY: 0, maxY: 2.2, minZ: 0, maxZ: 1 });
    return { id, source: `${room}.${name}`, minY: 0, maxY: 2.2 };
  });
  world.addObstacle({ id: 20, minX: 4, maxX: 5, minY: 1, maxY: 4, minZ: 0, maxZ: 1 });
  const other = { id: 20, source: "bldg.other.front.0", minY: 1, maxY: 4 };
  const spy: string[] = [];
  const doors = {
    offset(id: string, dy: number) { spy.push(`offset ${id} ${dy}`); },
    force(id: string, open: boolean) { spy.push(`force ${id} ${open}`); },
    hold(id: string, held: boolean) { spy.push(`hold ${id} ${held}`); },
  };
  const pawn = world.createEntity(0n, { type: "pawn", shape: "capsule", assetKey: "a" }, 1);
  world.enqueue({ kind: "setBounds", entity: pawn, radius: RADIUS });
  world.commit(0n);
  const host = createArenaElevators({
    elevators: [bound],
    aabbs: [...homes, other],
    doorIds: [door],
    doors,
    world,
    pawns: () => {
      const view = world.store.view(pawn)!;
      return [{ id: pawn, x: view.position.x, y: view.position.y, z: view.position.z, radius: RADIUS, height: HEIGHT, alive: true }];
    },
    ownedPawn: () => pawn,
    alive: () => true,
    sendAll: () => {},
  });
  let tick = 1n;
  const place = (x: number, y: number, z: number) => {
    world.enqueue({
      kind: "setTransform",
      entity: pawn,
      position: { x, y, z },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 1, y: 1, z: 1 },
    });
    world.commit(tick++);
  };
  const live = (id: number) => world.listObstacles().find((box) => box.id === id)!;
  place(1, 0, 1);
  host.onFrame(1, { t: "elevator", id: "cab", stop: 2 });
  let arrived = false;
  for (let i = 0; i < 140; i += 1) {
    const riders = host.step(MOVE_DT);
    commitShielded(world, tick++, riders);
    const row = host.snapshot()[0]!;
    if (!row.doorsOpen || Math.abs(row.y - 6) <= 1e-9) {
      for (const home of homes) {
        near(live(home.id).minY ?? NaN, home.minY + row.y, `${home.source} minY`);
        near(live(home.id).maxY ?? NaN, home.maxY + row.y, `${home.source} maxY`);
      }
    }
    if (row.stop === 2 && row.doorsOpen && Math.abs(row.y - 6) <= 1e-9) {
      arrived = true;
      break;
    }
  }
  assert.equal(arrived, true);
  assert.equal(spy[0], `force ${door} false`);
  assert.equal(spy[1], `hold ${door} true`);
  assert.equal(spy.at(-2), `hold ${door} false`);
  assert.equal(spy.at(-1), `force ${door} true`);
  for (const home of homes) {
    near(live(home.id).minY ?? NaN, home.minY + 6, "arrived minY");
    near(live(home.id).maxY ?? NaN, home.maxY + 6, "arrived maxY");
  }
  near(live(other.id).minY ?? NaN, other.minY, "other minY");
  near(live(other.id).maxY ?? NaN, other.maxY, "other maxY");

  host.onFrame(1, { t: "elevator", id: "cab", stop: 0 });
  let homeAgain = false;
  for (let i = 0; i < 140; i += 1) {
    const riders = host.step(MOVE_DT);
    commitShielded(world, tick++, riders);
    const row = host.snapshot()[0]!;
    if (row.stop === 0 && row.doorsOpen && Math.abs(row.y) <= 1e-9) {
      homeAgain = true;
      break;
    }
  }
  assert.equal(homeAgain, true);
  for (const home of homes) {
    assert.equal(live(home.id).minY, home.minY);
    assert.equal(live(home.id).maxY, home.maxY);
  }
  assert.equal(live(other.id).minY, other.minY);
  assert.equal(live(other.id).maxY, other.maxY);
});

test("an unbound cab does not move obstacle boxes", () => {
  const world = new AuthoritativeWorld({ worldVersion: "t" });
  world.pawnHeight = HEIGHT;
  world.addObstacle({ id: 10, minX: 0, maxX: 1, minY: 0, maxY: 2.2, minZ: 0, maxZ: 1 });
  const pawn = world.createEntity(0n, { type: "pawn", shape: "capsule", assetKey: "a" }, 1);
  world.enqueue({ kind: "setBounds", entity: pawn, radius: RADIUS });
  world.commit(0n);
  const spy: string[] = [];
  const host = createArenaElevators({
    elevators: [cab],
    aabbs: [{ id: 10, minX: 0, maxX: 1, minZ: 0, maxZ: 1, minY: 0, maxY: 2.2, source: "bldg.cab.front.0" }],
    doorIds: ["bldg.cab.door-1"],
    doors: {
      offset: () => spy.push("offset"),
      force: () => spy.push("force"),
      hold: () => spy.push("hold"),
    },
    world,
    pawns: () => {
      const view = world.store.view(pawn)!;
      return [{ id: pawn, x: view.position.x, y: view.position.y, z: view.position.z, radius: RADIUS, height: HEIGHT, alive: true }];
    },
    ownedPawn: () => pawn,
    alive: () => true,
    sendAll: () => {},
  });
  world.enqueue({
    kind: "setTransform",
    entity: pawn,
    position: { x: 1, y: 0, z: 1 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    scale: { x: 1, y: 1, z: 1 },
  });
  world.commit(1n);
  host.onFrame(1, { t: "elevator", id: "cab", stop: 1 });
  for (let i = 0; i < 80; i += 1) host.step(MOVE_DT);
  const box = world.listObstacles().find((item) => item.id === 10)!;
  assert.equal(box.minY, 0);
  assert.equal(box.maxY, 2.2);
  assert.deepEqual(spy, []);
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
