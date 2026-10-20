import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import * as THREE from "three";
import { WebSocket } from "ws";
import { applyDoorSwing, doorSwingRadians, placeDoorModel } from "../src/client/arena-scene.ts";
import { interpretPlacements } from "../src/server/placements-file.ts";
import { createArenaDoors, createDoorBlockers } from "../dist/server/doors.js";
import { startArenaServer } from "../dist/server/main.js";
import { loadArena } from "../dist/server/world-loader.js";
import type { ArenaView } from "../src/shared/arena-view.ts";
import {
  DOOR_GAP_DEPTH_M,
  DOOR_USE_OUTWARD_M,
  doorFrame,
  doorLeafBox,
  doorUseVolume,
  parseDoor,
  parseDoorSet,
  parseUse,
  pickDoorForUse,
  tryUseDoor,
  useFrame,
  type DoorFrame,
  type DoorRuntime,
} from "../dist/shared/doors.js";
import { createPawnHealth } from "../src/shared/health.ts";
import { createPawnKit, createPickupHost, type PawnBody } from "../src/shared/pickups.ts";

const root = path.join(import.meta.dirname, "..");

function doorView(partial: Partial<ArenaView["doors"][number]> = {}): ArenaView["doors"][number] {
  return {
    id: "gate",
    model: "/assets/models/door1.glb",
    position: [0, 0, 0],
    yaw: 0,
    hinge: "left",
    size: [2, 2.1, 0.08],
    open: false,
    ...partial,
  };
}

function pawn(id: number, x: number, y: number, z: number, alive = true): PawnBody {
  return { id, x, y, z, radius: 0.5, height: 1.8, alive };
}

function keyHost() {
  const health = createPawnHealth();
  health.note(7);
  health.note(8);
  const kit = createPawnKit();
  const keys = createPickupHost([{
    id: "key",
    kind: "key",
    model: "/assets/models/key-1.glb",
    amount: 0,
    minX: 0.5,
    maxX: 1.5,
    minY: 0,
    maxY: 1,
    minZ: -1.5,
    maxZ: -0.5,
  }]);
  return { health, kit, keys };
}

function listen(doors: ArenaView["doors"], pawns: Map<number, PawnBody>, keys: ReturnType<typeof createPickupHost>) {
  const inboxes: DoorFrame[][] = [[], []];
  const sessions = new Map<number, number>([[1, 4], [2, 9]]);
  const owned = new Map<number, number>([[1, 7], [2, 8]]);
  const host = createArenaDoors({
    doors,
    pawnOf: (id) => pawns.get(id),
    keys,
    sendAll(frame) {
      inboxes[0]!.push(structuredClone(frame));
      inboxes[1]!.push(structuredClone(frame));
    },
    ownedPawn: (clientId) => owned.get(clientId),
    sessionId: (clientId) => sessions.get(clientId),
    alive: (id) => pawns.get(id)?.alive !== false,
  });
  return { host, inboxes, sessions };
}

function markedDoor(): THREE.Group {
  const root = new THREE.Group();
  const frame = new THREE.Group();
  frame.name = "frame";
  const panel = new THREE.Mesh(new THREE.BoxGeometry(2, 2.1, 0.08));
  panel.name = "door";
  frame.add(panel);
  root.add(frame);
  return root;
}

test("a locked door stays shut without the key, and both sessions see the unlock", () => {
  const { health, kit, keys } = keyHost();
  const pawns = new Map<number, PawnBody>([[7, pawn(7, 1, 0, -1)]]);
  const { host, inboxes } = listen([
    doorView({ id: "locked", open: true, locked: true, key: "key" }),
    doorView({ id: "other", position: [40, 0, 0], open: false, locked: true, key: "key" }),
    doorView({ id: "free", position: [80, 0, 0], open: false }),
  ], pawns, keys);

  const before = host.snapshot();
  assert.deepEqual(before.find((door) => door.id === "locked"), { id: "locked", open: false, locked: true });
  assert.deepEqual(before.find((door) => door.id === "free"), { id: "free", open: false, locked: false });

  host.onFrame(1, useFrame(1));
  assert.equal(inboxes[0]!.length, 0);
  assert.equal(host.snapshot().find((door) => door.id === "locked")?.open, false);
  assert.equal(keys.hasKey(7, "key"), false);

  assert.equal(keys.take([pawns.get(7)!], health, kit).length, 1);
  assert.equal(keys.hasKey(7, "key"), true);
  assert.equal(keys.hasKey(8, "key"), false);

  host.onFrame(1, useFrame(1));
  assert.equal(inboxes[0]!.length, 0, "a repeated seq does not swing the door");

  host.onFrame(1, useFrame(2));
  assert.equal(inboxes[0]!.length, 1);
  assert.deepEqual(inboxes[0]![0], inboxes[1]![0]);
  assert.deepEqual(inboxes[0]![0], doorFrame("locked", true, false));
  assert.equal(keys.hasKey(7, "key"), false);
  assert.equal(keys.consumeKey(8, "key"), false);

  pawns.set(7, pawn(7, 41, 0, -1));
  host.onFrame(1, useFrame(3));
  assert.equal(inboxes[0]!.length, 1, "the same key id does not open a second lock");
  assert.equal(host.snapshot().find((door) => door.id === "other")?.locked, true);
  assert.equal(host.snapshot().find((door) => door.id === "other")?.open, false);

  const template = markedDoor();
  const left = placeDoorModel(template, doorView({ id: "tab-a", open: false }));
  const right = placeDoorModel(template, doorView({ id: "tab-b", open: false }));
  const shut = left.getObjectByName("frame")!.quaternion.clone();
  const open = inboxes[0]![0]!.open;
  applyDoorSwing(left, "left", open);
  applyDoorSwing(right, "left", open);
  const yaw = left.getObjectByName("hinge")!.rotation.y;
  assert.equal(right.getObjectByName("hinge")!.rotation.y, yaw);
  assert.ok(Math.abs(yaw - doorSwingRadians("left", true)) < 1e-6);
  assert.ok(left.getObjectByName("frame")!.quaternion.angleTo(shut) < 1e-6);
  applyDoorSwing(left, "right", true);
  assert.ok(left.getObjectByName("hinge")!.rotation.y < 0);
});

test("a door with no lock toggles, a dead pawn does not, and disconnect clears the seq", () => {
  const keys = createPickupHost([]);
  const pawns = new Map<number, PawnBody>([[7, pawn(7, 1, 0, -1)]]);
  const { host, inboxes, sessions } = listen([
    doorView({ id: "free", open: true }),
  ], pawns, keys);
  assert.equal(host.snapshot()[0]?.open, true);
  assert.equal(host.snapshot()[0]?.locked, false);

  host.onFrame(1, useFrame(1));
  assert.deepEqual(inboxes[1]![0], doorFrame("free", false, false));
  host.onFrame(1, useFrame(1));
  assert.equal(inboxes[0]!.length, 1);

  host.onFrame(1, { t: "fire", v: 1, seq: 2, yaw: 0, pitch: 0 });
  assert.equal(inboxes[0]!.length, 1);
  host.onFrame(1, useFrame(2));
  assert.deepEqual(inboxes[0]![1], doorFrame("free", true, false));

  pawns.set(7, pawn(7, 1, 0, -1, false));
  host.onFrame(1, useFrame(3));
  assert.equal(inboxes[0]!.length, 2);

  pawns.set(7, pawn(7, 1, 0, -1));
  host.drop(1);
  sessions.set(1, 4);
  host.onFrame(1, useFrame(1));
  assert.deepEqual(inboxes[0]!.at(-1), doorFrame("free", false, false));

  pawns.set(7, pawn(7, 100, 0, 100));
  host.onFrame(1, useFrame(4));
  assert.equal(host.snapshot()[0]?.open, false);
});

test("the use volume matches the door frame and the top-step key can reach the locked door", () => {
  const placed = doorView({ position: [5, 1, 7], yaw: 270, hinge: "left", size: [2, 2.1, 0.08] });
  const group = placeDoorModel(markedDoor(), placed);
  group.updateMatrixWorld(true);
  const frame = group.getObjectByName("frame");
  if (!frame) throw new Error("missing frame");
  const minLX = 0;
  const maxLX = 2;
  const corners: THREE.Vector3[] = [];
  for (const lx of [minLX, maxLX]) {
    for (const lz of [-DOOR_GAP_DEPTH_M, DOOR_USE_OUTWARD_M]) {
      const marker = new THREE.Object3D();
      marker.position.set(lx, 0, lz);
      frame.add(marker);
      group.updateMatrixWorld(true);
      corners.push(marker.getWorldPosition(new THREE.Vector3()));
    }
  }
  const volume = doorUseVolume(placed);
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const corner of corners) {
    minX = Math.min(minX, corner.x);
    maxX = Math.max(maxX, corner.x);
    minZ = Math.min(minZ, corner.z);
    maxZ = Math.max(maxZ, corner.z);
  }
  assert.ok(Math.abs(volume.minX - minX) < 1e-4, `minX ${volume.minX} vs ${minX}`);
  assert.ok(Math.abs(volume.maxX - maxX) < 1e-4, `maxX ${volume.maxX} vs ${maxX}`);
  assert.ok(Math.abs(volume.minZ - minZ) < 1e-4, `minZ ${volume.minZ} vs ${minZ}`);
  assert.ok(Math.abs(volume.maxZ - maxZ) < 1e-4, `maxZ ${volume.maxZ} vs ${maxZ}`);
  assert.ok(Math.abs(volume.minY - placed.position[1]) < 1e-6);
  assert.ok(Math.abs(volume.maxY - (placed.position[1] + placed.size[1])) < 1e-6);

  const doorsFile = JSON.parse(readFileSync(path.join(root, "web/game/doors.placements.json"), "utf8")) as {
    obstacles?: unknown[];
    placements: Array<ArenaView["doors"][number] & { type?: string }>;
  };
  const propsFile = JSON.parse(readFileSync(path.join(root, "web/game/props.placements.json"), "utf8")) as {
    placements: Array<{ id?: string; type?: string; position?: number[] }>;
    obstacles: Array<{ id?: string; min?: number[]; max?: number[] }>;
  };
  assert.deepEqual(doorsFile.obstacles ?? [], []);
  const locked = doorsFile.placements.find((door) => door.id === "door-1-1-9-22");
  assert.ok(locked);
  assert.equal(locked.locked, true);
  assert.equal(locked.key, "key");
  assert.equal(locked.open, false);
  const known = new Set(["door-1", "door-2"]);
  const baked = interpretPlacements(doorsFile, known, new Set());
  assert.deepEqual(baked.issues, []);
  assert.equal(baked.boxes.length, 0);
  assert.equal(baked.buildings.length, 0);
  const bakedLocked = baked.doors.find((door) => door.id === "door-1-1-9-22");
  assert.equal(bakedLocked?.locked, true);
  assert.equal(bakedLocked?.key, "key");
  assert.equal(bakedLocked?.open, false);
  assert.equal(baked.doors.find((door) => door.id === "door-1-1-9")?.locked, undefined);

  const shut = interpretPlacements({
    formatVersion: 1,
    units: "meters",
    placements: [{
      id: "front",
      model: "door-1",
      position: [0, 0, 0],
      yaw: 0,
      hinge: "left",
      size: [2, 2.1, 0.08],
      open: true,
      locked: true,
      key: "key",
    }],
    obstacles: [],
  }, known, new Set());
  assert.equal(shut.boxes.length, 0);
  assert.equal(shut.doors[0]?.open, false);
  assert.equal(shut.doors[0]?.locked, true);

  const bad = interpretPlacements({
    formatVersion: 1,
    units: "meters",
    placements: [{
      id: "front",
      model: "door-1",
      position: [0, 0, 0],
      yaw: 0,
      hinge: "left",
      size: [2, 2.1, 0.08],
      open: false,
      locked: "yes",
    }],
    obstacles: [],
  }, known, new Set());
  assert.equal(bad.doors.length, 0);
  assert.ok(bad.issues.some((issue) => issue.message === "must be true or false"));

  const keyBox = propsFile.obstacles.find((box) => box.id === "key-box");
  assert.ok(keyBox?.min && keyBox.max);
  assert.ok(keyBox.max[0] > keyBox.min[0] && keyBox.max[1] > keyBox.min[1] && keyBox.max[2] > keyBox.min[2]);
  const standing = pawn(
    7,
    (keyBox.min[0] + keyBox.max[0]) / 2,
    keyBox.min[1] - 0.4,
    (keyBox.min[2] + keyBox.max[2]) / 2,
  );
  const runtime: DoorRuntime = {
    id: locked.id,
    hinge: locked.hinge,
    open: false,
    locked: true,
    key: locked.key,
    position: locked.position,
    size: locked.size,
    yaw: locked.yaw,
  };
  assert.equal(pickDoorForUse([runtime], standing)?.id, "door-1-1-9-22");
  assert.equal(pickDoorForUse([runtime], pawn(7, 0, 0, 0)), undefined);

  const alone = { ...runtime, locked: true, key: "key", open: false };
  assert.equal(tryUseDoor(alone, 7, { hasKey: () => false, consumeKey: () => false }), undefined);
  assert.equal(alone.open, false);
  assert.equal(alone.locked, true);
});

type Box = { id: number; minX: number; maxX: number; minY?: number; maxY?: number; minZ: number; maxZ: number };

/** Mid-height point in the middle of the shut leaf: inside the stamped doorway gap. */
function gapProbe(door: ArenaView["doors"][number]): { x: number; y: number; z: number } {
  const leaf = doorLeafBox(door);
  return { x: (leaf.minX + leaf.maxX) / 2, y: door.position[1] + door.size[1] / 2, z: (leaf.minZ + leaf.maxZ) / 2 };
}

function sealing(boxes: readonly Box[], p: { x: number; y: number; z: number }): Box[] {
  return boxes.filter((box) =>
    p.x >= box.minX && p.x <= box.maxX && p.z >= box.minZ && p.z <= box.maxZ &&
    (box.minY === undefined || p.y >= box.minY) && (box.maxY === undefined || p.y <= box.maxY));
}

test("door and use frames parse, and only a shut leaf seals the gap", () => {
  assert.deepEqual(parseUse(useFrame(3)), useFrame(3));
  assert.equal(parseUse({ t: "use", v: 2, seq: 1 }), undefined);
  assert.equal(parseUse({ t: "fire", v: 1, seq: 1, yaw: 0, pitch: 0 }), undefined);
  assert.deepEqual(parseDoor(doorFrame("a", true, false)), doorFrame("a", true, false));
  assert.equal(parseDoor({ t: "door", id: "a", open: 1, locked: false }), undefined);
  assert.deepEqual(parseDoorSet([{ id: "a", open: false, locked: true }]), [doorFrame("a", false, true)]);
  assert.equal(parseDoorSet("nope"), undefined);

  // The blocker adds one box per door through the public kernel API and rewrites it in place:
  // no splice (ARENA-02), no kernel import, no snap envelopes.
  const doors = readFileSync(path.join(root, "src/server/doors.ts"), "utf8");
  const shared = readFileSync(path.join(root, "src/shared/doors.ts"), "utf8");
  const main = readFileSync(path.join(root, "src/server/main.ts"), "utf8");
  assert.equal(/\.splice\(/.test(doors), false);
  assert.equal(/conveyor-engine-world|setClip|enqueue/.test(doors + shared), false);
  assert.match(main, /blockers: createDoorBlockers\(loaded\.world\)/);
  assert.match(main, /welcome\.doors = doorHost\.snapshot\(\)/);
  assert.match(main, /doorHost\.drop\(clientId\)/);
  assert.equal(/envelopes\.get/.test(doors + main), false);

  // The installed arena: baked static boxes leave every doorway open.
  const loaded = loadArena();
  const world = loaded.world;
  const placed = loaded.view.doors;
  assert.ok(placed.length > 0);
  for (const door of placed) {
    assert.deepEqual(sealing(world.listObstacles(), gapProbe(door)).map((box) => box.id), [], `${door.id}: a baked box seals the gap`);
  }

  // Seeding the host shuts every leaf (locked ones start shut whatever the file says).
  const count = world.listObstacles().length;
  const blockers = createDoorBlockers(world);
  const at = new Map<number, PawnBody>();
  const host = createArenaDoors({
    doors: placed,
    pawnOf: (id) => at.get(id),
    keys: { hasKey: () => true, consumeKey: () => true },
    sendAll() {},
    ownedPawn: () => 7,
    sessionId: () => 1,
    blockers,
  });
  assert.equal(world.listObstacles().length, count + placed.length, "one blocker per door");
  const shut = new Map(host.snapshot().map((row) => [row.id, !row.open]));
  let seq = 0;
  for (const door of placed) {
    const id = blockers.obstacleId(door.id);
    assert.ok(id !== undefined, door.id);
    const probe = gapProbe(door);
    const seal = () => sealing(world.listObstacles(), probe).map((box) => box.id);
    const use = () => {
      const reach = doorUseVolume(door);
      at.set(7, pawn(7, (reach.minX + reach.maxX) / 2, door.position[1], (reach.minZ + reach.maxZ) / 2));
      host.onFrame(1, useFrame(++seq));
    };
    if (!shut.get(door.id)) use();
    assert.deepEqual(seal(), [id], `${door.id}: the shut leaf seals the gap`);
    const live = world.listObstacles().find((box) => box.id === id)!;
    const leaf = doorLeafBox(door);
    for (const k of ["minX", "maxX", "minY", "maxY", "minZ", "maxZ"] as const) {
      assert.ok(Math.abs((live[k] ?? NaN) - leaf[k]) < 1e-9, `${door.id} ${k}`);
    }
    use();
    assert.equal(host.snapshot().find((row) => row.id === door.id)?.open, true, door.id);
    assert.deepEqual(seal(), [], `${door.id}: opening unseals the gap`);
    use();
    assert.deepEqual(seal(), [id], `${door.id}: closing seals it again`);
  }
  assert.equal(world.listObstacles().length, count + placed.length, "toggling never adds or removes a box");
});

test("two sockets share the door snapshot and a use away from the door changes nothing", { timeout: 20_000 }, async () => {
  const host = await startArenaServer(0);
  const open: WebSocket[] = [];
  try {
    const page = await fetch(`${host.url}/arena.json`);
    const view = await page.json() as {
      world: string;
      bundleId: string;
      authoritativeHash: string;
      doors: Array<{ id: string; open: boolean; locked?: boolean; key?: string }>;
      pickups?: Array<{ id: string; kind: string; minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number }>;
      aabbs?: Array<{ source?: string }>;
    };
    const listed = view.doors.find((door) => door.id === "door-1-1-9-22");
    assert.ok(listed);
    assert.equal(listed.locked, true);
    assert.equal(listed.key, "key");
    assert.equal(listed.open, false);
    const key = view.pickups?.find((pickup) => pickup.id === "key");
    assert.equal(key?.kind, "key");
    assert.ok(key && key.maxX > key.minX && key.maxY > key.minY && key.maxZ > key.minZ);
    assert.equal(view.aabbs?.some((box) => box.source === "door-1-1-9-22" || box.source === "door-1-1-9-22-box"), false);

    const a = openClient(host.url, view);
    open.push(a.ws);
    const aw = await a.welcome;
    const b = openClient(host.url, view);
    open.push(b.ws);
    const bw = await b.welcome;
    assert.notEqual(aw.ownedEntityId, bw.ownedEntityId);
    assert.deepEqual(aw.doors, bw.doors);
    assert.deepEqual(
      aw.doors.find((door) => door.id === "door-1-1-9-22"),
      { id: "door-1-1-9-22", open: false, locked: true },
    );
    assert.equal(aw.doors.find((door) => door.id === "door-1-1-9")?.locked, false);
    assert.equal(aw.pickups.includes("key"), true);
    assert.equal(bw.pickups.includes("key"), true);

    a.ws.send(JSON.stringify(useFrame(1)));
    await delay(300);
    assert.deepEqual(a.doors, []);
    assert.deepEqual(b.doors, []);

    const late = openClient(host.url, view);
    open.push(late.ws);
    const joined = await late.welcome;
    assert.deepEqual(joined.doors, aw.doors);
    assert.equal(joined.pickups.includes("key"), true);
  } finally {
    for (const ws of open) {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
    }
    await host.close();
  }
});

type Welcome = {
  ownedEntityId: number;
  pickups: string[];
  doors: Array<{ id: string; open: boolean; locked: boolean }>;
};

function openClient(
  url: string,
  view: { world: string; bundleId: string; authoritativeHash: string },
): { ws: WebSocket; welcome: Promise<Welcome>; doors: DoorFrame[] } {
  const doors: DoorFrame[] = [];
  const ws = new WebSocket(url.replace(/^http/, "ws"));
  const welcome = new Promise<Welcome>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no welcome")), 3000);
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data)) as {
        t?: string;
        type?: string;
        reason?: string;
        ownedEntityId?: number;
        pickups?: unknown;
        doors?: unknown;
        id?: unknown;
        open?: unknown;
        locked?: unknown;
      };
      const door = parseDoor(msg);
      if (door) doors.push(door);
      if (msg.type === "reject") {
        clearTimeout(timer);
        reject(new Error(msg.reason ?? "reject"));
      }
      if (msg.type === "welcome") {
        clearTimeout(timer);
        const parsed = parseDoorSet(msg.doors) ?? [];
        const pickups = Array.isArray(msg.pickups) ? msg.pickups.filter((id) => typeof id === "string") : [];
        resolve({
          ownedEntityId: Number(msg.ownedEntityId),
          pickups,
          doors: parsed.map((row) => ({ id: row.id, open: row.open, locked: row.locked })),
        });
      }
    });
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({
        v: 1,
        type: "hello",
        protocol: 1,
        world: view.world,
        bundleId: view.bundleId,
        authoritativeHash: view.authoritativeHash,
      }));
    });
  });
  return { ws, welcome, doors };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
