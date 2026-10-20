/**
 * A shut door leaf blocks; an open one does not. Runs against dist/ like host.test.ts
 * (`npm run build:server` first). Uses the kernel world as-is: one `addObstacle` per
 * door, toggled in place. No kernel change and no splice.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { AuthoritativeWorld } from "conveyor-engine-world";
import { createArenaDoors, createDoorBlockers } from "../dist/server/doors.js";
import { doorLeafBox, doorUseVolume, DOOR_LEAF_MIN_THICKNESS_M } from "../dist/shared/doors.js";
import { enqueuePlanarMove, floorHeight } from "../dist/shared/movements.js";
import { traceHitscan } from "../dist/shared/hitscan.js";
import type { ArenaView } from "../dist/shared/arena-view.js";

type Door = ArenaView["doors"][number];
const RADIUS = 0.5;
const HEIGHT = 1.8;

/** door-1-1-9 and door-1-1-9-22 from arena-1: building-3 west face x = -9.2876, outward −X. */
const ground: Door = { id: "ground", model: "/m/door1.glb", position: [-9.287584, 0, 36.585486], yaw: 270, hinge: "left", size: [1.047216, 2.1, 0.08], open: false };
const high: Door = { id: "high", model: "/m/door1.glb", position: [-9.287584, 2.75, 33.274426], yaw: 270, hinge: "left", size: [1.047216, 2.1, 0.08], open: false, locked: true, key: "key" };

function near(a: number, b: number, label: string, tol = 1e-6): void {
  assert.ok(Math.abs(a - b) < tol, `${label}: ${a} != ${b}`);
}

function arena(doors: Door[], held = new Map<number, Set<string>>()) {
  const world = new AuthoritativeWorld({ worldVersion: "t" });
  world.pawnHeight = HEIGHT;
  // Wall either side of each opening and a sill under the elevated one, like the stamped bake.
  world.addObstacle({ id: 1, minX: -9.29, maxX: -7.29, minY: 0.07, maxY: 16.5, minZ: 20, maxZ: 33.27 });
  world.addObstacle({ id: 2, minX: -9.29, maxX: -7.29, minY: 0.07, maxY: 16.5, minZ: 34.32, maxZ: 36.585 });
  world.addObstacle({ id: 3, minX: -9.29, maxX: -7.29, minY: 0, maxY: 2.75, minZ: 33.27, maxZ: 34.32 });
  world.addObstacle({ id: 4, minX: -9.29, maxX: -7.29, minY: 2.1, maxY: 16.5, minZ: 36.585, maxZ: 37.632 });
  world.addObstacle({ id: 5, minX: -9.29, maxX: -7.29, minY: 0.07, maxY: 16.5, minZ: 37.632, maxZ: 50 });
  const pawn = world.createEntity(0n, { type: "pawn", shape: "capsule", assetKey: "a" }, 1);
  world.enqueue({ kind: "setBounds", entity: pawn, radius: RADIUS });
  world.commit(0n);
  const frames: unknown[] = [];
  const blockers = createDoorBlockers(world);
  const host = createArenaDoors({
    doors,
    pawnOf: (id) => {
      const v = world.store.view(id)!;
      return { id, x: v.position.x, y: v.position.y, z: v.position.z, radius: RADIUS, height: HEIGHT, alive: true };
    },
    keys: {
      hasKey: (p, k) => held.get(p)?.has(k) === true,
      consumeKey: (p, k) => held.get(p)?.delete(k) === true,
    },
    sendAll: (f) => frames.push(f),
    ownedPawn: () => pawn,
    sessionId: () => 1,
    blockers,
  });
  let tick = 1n;
  let seq = 0;
  const place = (x: number, y: number, z: number) => {
    world.enqueue({ kind: "setTransform", entity: pawn, position: { x, y, z }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } });
    world.commit(tick++);
  };
  const walk = (moveX: number, moveZ: number, ticks: number) => {
    for (let i = 0; i < ticks; i++) {
      enqueuePlanarMove(world as never, pawn, moveX, moveZ, 0);
      world.commit(tick++);
    }
    return world.store.view(pawn)!.position;
  };
  const use = () => host.onFrame(7, { t: "use", v: 1, seq: ++seq });
  return { world, pawn, frames, blockers, place, walk, use };
}

test("the leaf box spans the panel from the hinge, sits on the outer face, and runs sill..sill+height", () => {
  for (const yaw of [0, 90, 180, 270]) {
    for (const hinge of ["left", "right"] as const) {
      const door = { ...high, yaw, hinge };
      const leaf = doorLeafBox(door);
      const reach = doorUseVolume(door);
      near(leaf.minY, 2.75, "sill");
      near(leaf.maxY, 2.75 + 2.1, "head");
      const alongX = yaw === 0 || yaw === 180;
      // Same span along the wall as the use volume (hinge..hinge±width).
      if (alongX) { near(leaf.minX, reach.minX, `${yaw} ${hinge} minX`); near(leaf.maxX, reach.maxX, `${yaw} ${hinge} maxX`); }
      else { near(leaf.minZ, reach.minZ, `${yaw} ${hinge} minZ`); near(leaf.maxZ, reach.maxZ, `${yaw} ${hinge} maxZ`); }
      const thick = alongX ? leaf.maxZ - leaf.minZ : leaf.maxX - leaf.minX;
      near(thick, DOOR_LEAF_MIN_THICKNESS_M, `${yaw} ${hinge} thickness`);
    }
  }
  // yaw 270: outward is −X, so the outer face is 8 cm outside the hinge plane.
  const leaf = doorLeafBox(ground);
  near(leaf.minX, -9.287584 - 0.08, "outer face");
  near(leaf.maxX, -9.287584 + 0.12, "inner face, inside the stamped gap");
});

test("a shut door stops a pawn walking through; E opens it and the pawn passes; E again shuts it", () => {
  const a = arena([ground]);
  const before = a.world.listObstacles().length;
  a.place(-11, 0, 37.11);
  let p = a.walk(1, 0, 40);
  assert.ok(p.x < -9.287584 - 0.08 - RADIUS + 1e-3, `blocked outside the leaf, x=${p.x}`);
  a.use();
  assert.deepEqual(a.frames.at(-1), { t: "door", id: "ground", open: true, locked: false });
  p = a.walk(1, 0, 8);
  assert.ok(p.x > -8.8, `walked through the open door, x=${p.x}`);
  a.use();
  assert.deepEqual(a.frames.at(-1), { t: "door", id: "ground", open: false, locked: false });
  p = a.walk(-1, 0, 20);
  assert.ok(p.x > -9.287584 + 0.12 + RADIUS - 1e-3, `blocked inside the shut leaf, x=${p.x}`);
  assert.equal(a.world.listObstacles().length, before, "toggling never adds or removes a box");
});

test("a locked elevated door blocks until its key is used, and never blocks a pawn walking under it", () => {
  const held = new Map([[1, new Set<string>()]]);
  const a = arena([high], held);
  // On the sill lip at 2.75, walking in.
  a.place(-9.75, 2.75, 33.8);
  let p = a.walk(1, 0, 30);
  assert.ok(p.x < -9.3, `locked leaf blocks, x=${p.x}`);
  a.place(-9.0, 2.75, 33.8);
  a.use();
  assert.equal(a.frames.length, 0, "no key: no frame, still shut");
  held.get(1)!.add("key");
  a.use();
  assert.deepEqual(a.frames.at(-1), { t: "door", id: "high", open: true, locked: false });
  assert.equal(held.get(1)!.has("key"), false, "key consumed");
  const id = a.blockers.obstacleId("high")!;
  const box = a.world.listObstacles().find((b) => b.id === id)!;
  assert.ok(box.maxY! < -1000, "open: blocker parked far below the floor");
  // Under the elevated door at ground level: the wall below the sill stops it, the leaf never does.
  const b = arena([high]);
  b.place(-11, 0, 33.8);
  p = b.walk(1, 0, 30);
  near(p.x, -9.29 - RADIUS, "stopped by the wall below the sill", 1e-3);
  near(p.y, 0, "still on the ground", 1e-9);
});

test("a shut leaf is not a floor and an open one does not catch shots", () => {
  const a = arena([ground]);
  const boxes = a.world.listObstacles();
  near(floorHeight(boxes, -9.3, 37.1, RADIUS, 0), 0, "the 2.1 m leaf is a wall to a pawn on the ground, not a step");
  const eye = { x: -12, y: 1.5, z: 37.1 };
  const shut = traceHitscan(eye, { x: 1, y: 0, z: 0 }, boxes, []);
  assert.equal(shut.hitId, a.blockers.obstacleId("ground"), "a shot at a shut door hits the leaf");
  a.place(-10.2, 0, 37.1);
  a.use();
  assert.deepEqual(a.frames.at(-1), { t: "door", id: "ground", open: true, locked: false });
  const open = traceHitscan(eye, { x: 1, y: 0, z: 0 }, a.world.listObstacles(), []);
  assert.notEqual(open.hitId, a.blockers.obstacleId("ground"), "open: the beam goes through the doorway");
});
