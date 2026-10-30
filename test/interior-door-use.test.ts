/**
 * Room-only leaves live in rooms.placements.json and have no twin in
 * doors.placements.json. KeyE must toggle one from the doorway. A locked
 * leaf still stays shut without its key. Exterior doors keep the 2 m gap.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createArenaDoors, createDoorBlockers } from "../dist/server/doors.js";
import { loadArena } from "../dist/server/world-loader.js";
import {
  DOOR_GAP_DEPTH_M,
  DOOR_USE_OUTWARD_M,
  doorLeafBox,
  doorUseVolume,
  doorYawRadians,
  pickDoorForUse,
  useFrame,
  type DoorFrame,
  type DoorRuntime,
} from "../dist/shared/doors.js";
import { enqueuePlanarMove } from "../dist/shared/movements.js";
import type { ArenaView } from "../src/shared/arena-view.ts";
import type { PawnBody } from "../src/shared/pickups.ts";

const root = path.join(import.meta.dirname, "..");
/** Floor-2 room leaf: the building hull does not fill this opening. */
const PASSAGE = "brutalist-building-2-cbake.room-b-1-3.door-1-1-9-22";
/** Ground room leaf: same use path. */
const GROUND = "brutalist-building-2-cbake.room-a-1-5-8.door-1-1-9-22-5";
/** Locked exterior leaf. The stamped gap stays 2 m. */
const EXTERIOR = "brutalist-building-3-bake.door-1-1-9-22";

function asRuntime(door: ArenaView["doors"][number]): DoorRuntime {
  return {
    id: door.id,
    hinge: door.hinge,
    open: door.open === true,
    locked: door.locked === true,
    ...(door.key ? { key: door.key } : {}),
    position: door.position,
    size: door.size,
    yaw: door.yaw,
  };
}

/** Local +Z (outward) and the opening center, in world XZ. */
function doorAxes(door: Pick<DoorRuntime, "position" | "yaw" | "hinge" | "size">): {
  outX: number;
  outZ: number;
  cx: number;
  cz: number;
} {
  const yaw = doorYawRadians(door.yaw);
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const mid = door.hinge === "left" ? door.size[0] / 2 : -door.size[0] / 2;
  return {
    outX: s,
    outZ: c,
    cx: door.position[0] + mid * c,
    cz: door.position[2] - mid * s,
  };
}

test("a room-only door toggles on use and a shut leaf blocks the opening", () => {
  const rooms = JSON.parse(readFileSync(path.join(root, "web/game/rooms.placements.json"), "utf8")) as {
    placements: Array<{ id?: string; hinge?: string }>;
  };
  const exteriorFile = JSON.parse(readFileSync(path.join(root, "web/game/doors.placements.json"), "utf8")) as {
    placements: Array<{ id?: string }>;
  };
  const roomIds = rooms.placements.filter((item) => item.hinge).map((item) => item.id);
  const exteriorIds = new Set(exteriorFile.placements.map((item) => item.id));
  assert.ok(roomIds.includes(PASSAGE));
  assert.equal(exteriorIds.has(PASSAGE), false);
  assert.equal(exteriorIds.has(GROUND), false);

  const loaded = loadArena();
  const radius = loaded.view.pawnRadius;
  const height = loaded.view.pawnHeight;
  const passage = loaded.view.doors.find((door) => door.id === PASSAGE);
  const ground = loaded.view.doors.find((door) => door.id === GROUND);
  const exterior = loaded.view.doors.find((door) => door.id === EXTERIOR);
  assert.ok(passage);
  assert.ok(ground);
  assert.ok(exterior);
  assert.notEqual(passage.locked, true);
  assert.notEqual(ground.locked, true);
  assert.equal(exterior.locked, true);

  const ext = doorUseVolume(exterior);
  const alongZ = exterior.yaw % 180 === 0;
  const depth = alongZ ? ext.maxZ - ext.minZ : ext.maxX - ext.minX;
  assert.ok(Math.abs(depth - (DOOR_GAP_DEPTH_M + DOOR_USE_OUTWARD_M)) < 1e-4, `exterior gap ${depth}`);

  const rows = loaded.view.doors.map(asRuntime);
  for (const door of [passage, ground]) {
    const axes = doorAxes(door);
    const y = door.position[1];
    const roomSide: PawnBody = {
      id: 7,
      x: axes.cx - axes.outX * (radius + 0.15),
      y,
      z: axes.cz - axes.outZ * (radius + 0.15),
      radius,
      height,
      alive: true,
    };
    const farSide: PawnBody = {
      id: 7,
      x: axes.cx + axes.outX * (radius + 0.05),
      y,
      z: axes.cz + axes.outZ * (radius + 0.05),
      radius,
      height,
      alive: true,
    };
    assert.equal(pickDoorForUse(rows, roomSide)?.id, door.id, `${door.id} room side`);
    assert.equal(pickDoorForUse(rows, farSide)?.id, door.id, `${door.id} far side`);
  }

  const world = loaded.world;
  const pawn = world.createEntity(0n, { type: "pawn", shape: "capsule", assetKey: "a" }, 50);
  world.enqueue({ kind: "setBounds", entity: pawn, radius });
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
  const step = (moveX: number, moveZ: number) => {
    enqueuePlanarMove(world, pawn, moveX, moveZ, 0);
    world.commit(tick++);
    return world.store.view(pawn)!.position;
  };
  const body = (): PawnBody => {
    const p = world.store.view(pawn)!.position;
    return { id: pawn, x: p.x, y: p.y, z: p.z, radius, height, alive: true };
  };

  const frames: DoorFrame[] = [];
  const blockers = createDoorBlockers(world);
  let seq = 0;
  const host = createArenaDoors({
    doors: loaded.view.doors,
    pawnOf: () => body(),
    keys: { hasKey: () => false, consumeKey: () => false },
    sendAll: (frame) => frames.push(frame),
    ownedPawn: () => pawn,
    sessionId: () => 1,
    blockers,
  });
  const snap = (id: string) => host.snapshot().find((door) => door.id === id);
  assert.ok(snap(PASSAGE));
  assert.equal(snap(PASSAGE)?.open, false);
  assert.equal(snap(PASSAGE)?.locked, false);
  assert.equal(snap(EXTERIOR)?.locked, true);

  const axes = doorAxes(passage);
  const leaf = doorLeafBox(passage);
  place(axes.cx - axes.outX * 1.6, passage.position[1], axes.cz - axes.outZ * 1.6);
  let pos = world.store.view(pawn)!.position;
  for (let i = 0; i < 40; i += 1) {
    const next = step(axes.outX, axes.outZ);
    if (Math.hypot(next.x - pos.x, next.z - pos.z) < 1e-4) break;
    pos = next;
  }
  assert.ok(pos.x > leaf.maxX, `shut leaf should stop the pawn short of the opening, x=${pos.x}`);
  assert.ok(pos.x < leaf.maxX + radius + 0.25, `pawn should be against the shut leaf, x=${pos.x}`);
  assert.equal(pickDoorForUse(rows, body())?.id, PASSAGE);

  host.onFrame(1, useFrame(++seq));
  assert.equal(snap(PASSAGE)?.open, true);
  assert.equal(frames.at(-1)?.id, PASSAGE);
  assert.equal(frames.at(-1)?.open, true);
  host.onFrame(1, useFrame(++seq));
  assert.equal(snap(PASSAGE)?.open, false, "second use closes the room door");
  host.onFrame(1, useFrame(++seq));
  assert.equal(snap(PASSAGE)?.open, true);

  pos = world.store.view(pawn)!.position;
  for (let i = 0; i < 25; i += 1) pos = step(axes.outX, axes.outZ);
  assert.ok(pos.x < leaf.minX, `open room door lets the pawn through, x=${pos.x}`);

  const groundAxes = doorAxes(ground);
  const groundVol = doorUseVolume(ground);
  place((groundVol.minX + groundVol.maxX) / 2, ground.position[1], groundAxes.cz);
  host.onFrame(1, useFrame(++seq));
  assert.equal(snap(GROUND)?.open, true);
  host.onFrame(1, useFrame(++seq));
  assert.equal(snap(GROUND)?.open, false);
});

test("a locked room door does not open without its key", () => {
  const door: ArenaView["doors"][number] = {
    id: "room-only-locked",
    model: "/assets/models/door1.glb",
    position: [0, 0, 0],
    yaw: 90,
    hinge: "left",
    size: [1.073, 2.1, 0.08],
    open: false,
    locked: true,
    key: "key",
  };
  const volume = doorUseVolume(door);
  const pawn: PawnBody = {
    id: 7,
    x: (volume.minX + volume.maxX) / 2,
    y: 0,
    z: (volume.minZ + volume.maxZ) / 2,
    radius: 0.5,
    height: 1.8,
    alive: true,
  };
  let held = false;
  const frames: DoorFrame[] = [];
  const host = createArenaDoors({
    doors: [door],
    pawnOf: () => pawn,
    keys: {
      hasKey: () => held,
      consumeKey: () => {
        if (!held) return false;
        held = false;
        return true;
      },
    },
    sendAll: (frame) => frames.push(frame),
    ownedPawn: () => 7,
    sessionId: () => 1,
  });
  assert.equal(host.snapshot()[0]?.open, false);
  assert.equal(host.snapshot()[0]?.locked, true);
  host.onFrame(1, useFrame(1));
  assert.equal(frames.length, 0);
  assert.equal(host.snapshot()[0]?.open, false);
  assert.equal(host.snapshot()[0]?.locked, true);
  held = true;
  host.onFrame(1, useFrame(2));
  assert.equal(host.snapshot()[0]?.open, true);
  assert.equal(host.snapshot()[0]?.locked, false);
  assert.equal(held, true, "key stays held after unlock");
});
