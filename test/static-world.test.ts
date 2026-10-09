import assert from "node:assert/strict";
import { test } from "node:test";
import { EngineWsClient, memoryPair } from "conveyor-engine-transport-ws";
import { ARENA_PAWN_HEIGHT, ExampleApp, arenaStaticWorld } from "../dist/index.js";

const PAWN_RADIUS = 0.5;

type XzBox = { minX: number; maxX: number; minZ: number; maxZ: number; minY?: number; maxY?: number };

/** Feet are y=0. A span above the head, or a slab at or below the feet, does not stop a walk. */
function blocksPawn(box: XzBox, height: number): boolean {
  if (box.minY === undefined || box.maxY === undefined) return true;
  return !(0 >= box.maxY || height <= box.minY);
}

/** An obstacle whose west and east faces can be walked into, with room to slide north along the west face. */
function approachBox(): XzBox {
  const world = arenaStaticWorld().definition;
  const { bounds, aabbs } = world;
  const radius = PAWN_RADIUS;
  const height = ARENA_PAWN_HEIGHT;
  const solid = aabbs.filter((box) => blocksPawn(box, height));
  const found = solid.find((box) => {
    const z = (box.minZ + box.maxZ) / 2;
    const westStart = box.minX - radius - 2;
    const eastStart = box.maxX + radius + 2;
    if (box.maxX - box.minX < 0.05 || box.maxZ - box.minZ < 0.3) return false;
    if (westStart <= bounds.minX + radius || eastStart >= bounds.maxX - radius) return false;
    if (z <= bounds.minZ + radius || z >= bounds.maxZ - radius) return false;
    const blocked = (from: number, to: number) => solid.some((other) =>
      other !== box
      && z > other.minZ - radius && z < other.maxZ + radius
      && other.maxX + radius > Math.min(from, to) && other.minX - radius < Math.max(from, to));
    if (blocked(westStart, box.minX - radius) || blocked(box.maxX + radius, eastStart)) return false;
    const west = box.minX - radius;
    const slideClear = (dz: number) => z + dz < box.maxZ && !solid.some((other) =>
      other !== box
      && west + 0.05 > other.minX - radius && west + 0.05 < other.maxX + radius
      && z + dz > other.minZ - radius && z + dz < other.maxZ + radius);
    return slideClear(0.25) && slideClear(0.5);
  });
  if (!found) throw new Error("no isolated obstacle inside the room");
  return found;
}

test("arena fixture has required authoritative content", () => {
  const arena = arenaStaticWorld();
  assert.equal(arena.definition.bundleId, "arena.one-room.v1");
  assert.ok(arena.definition.spawnPoints.length >= 2);
  assert.ok(arena.definition.aabbs.length >= 4);
  assert.match(arena.hash, /^sha256:[0-9a-f]{64}$/);
});

test("arena app welcome carries bundle identity and distinct spawns", () => {
  const app = ExampleApp.arena({ presentation: "ready" });
  const a = app.connectClient();
  const b = app.connectClient();
  app.step();
  assert.equal(a.pred.acceptedBundleId, "arena.one-room.v1");
  assert.equal(a.pred.acceptedAuthoritativeHash, app.authoritativeHash);
  assert.equal(a.pred.visualStatus, "ready");
  const pa = app.world.store.view(a.pawn)!.position;
  const pb = app.world.store.view(b.pawn)!.position;
  assert.notEqual(pa.x, pb.x);
  const d = app.diagnostics();
  assert.equal(d.bundleId, "arena.one-room.v1");
  assert.ok((d.spawnCount ?? 0) >= 2);
  assert.ok((d.aabbCount ?? 0) >= 4);
});

test("visual miss uses fallback and does not change server hash", () => {
  const ready = ExampleApp.arena({ presentation: "ready" });
  const miss = ExampleApp.arena({ presentation: "missing" });
  ready.connectClient();
  miss.connectClient();
  ready.step();
  miss.step();
  assert.equal(ready.world.canonicalJson(), miss.world.canonicalJson());
  const client = [...miss.clients.values()][0]!;
  assert.equal(client.pred.visualStatus, "degraded");
  assert.equal(client.pred.visualFallbackAssetId, "primitive/box");
});

test("authoritative hash mismatch rejects before activation", () => {
  const app = ExampleApp.arena();
  const pair = memoryPair();
  app.server.attach(pair.server);
  let code: string | undefined;
  const ws = new EngineWsClient(pair.client, {
    compatibility: { protocol: 1, world: app.world.worldVersion },
    bundleId: "arena.one-room.v1",
    authoritativeHash: "sha256:" + "00".repeat(32),
    onReject: (msg) => {
      code = msg.code;
    },
  });
  ws.hello();
  assert.equal(code, "AUTHORITATIVE_CONTENT_MISMATCH");
  assert.equal(app.server.connected.length, 0);
  assert.equal(app.clients.size, 0);
});

function place(app: ExampleApp, entity: number, x: number, z: number) {
  app.world.enqueue({
    kind: "setTransform",
    entity,
    position: { x, y: 0, z },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    scale: { x: 1, y: 1, z: 1 },
  });
  app.world.enqueue({ kind: "setVelocity", entity, linear: { x: 0, y: 0, z: 0 } });
}

test("head-on wall stop matches expected clearance", () => {
  const crate = approachBox();
  const west = crate.minX - PAWN_RADIUS;
  const east = crate.maxX + PAWN_RADIUS;
  const z = (crate.minZ + crate.maxZ) / 2;
  const app = ExampleApp.arena({ presentation: "skipped" });
  const a = app.connectClient();
  const b = app.connectClient();
  place(app, a.pawn, west - 2, z);
  place(app, b.pawn, east + 2, z);
  app.step();
  for (let i = 0; i < 40; i++) {
    app.step(new Map([
      [a.id, { moveX: 1, moveZ: 0 }],
      [b.id, { moveX: -1, moveZ: 0 }],
    ]));
  }
  assert.equal(app.world.store.view(a.pawn)!.position.x, west);
  assert.equal(app.world.store.view(b.pawn)!.position.x, east);
});

test("axis slide continues on the free axis", () => {
  const crate = approachBox();
  const west = crate.minX - PAWN_RADIUS;
  const z = (crate.minZ + crate.maxZ) / 2;
  const app = ExampleApp.arena({ presentation: "skipped" });
  const a = app.connectClient();
  place(app, a.pawn, west - 0.2, z);
  app.step();
  let zAtTouch: number | undefined;
  for (let i = 0; i < 12; i++) {
    app.step(new Map([[a.id, { moveX: 1, moveZ: 1 }]]));
    const p = app.world.store.view(a.pawn)!.position;
    if (p.x !== west) continue;
    if (zAtTouch === undefined) {
      zAtTouch = p.z;
      continue;
    }
    assert.equal(p.x, west);
    assert.ok(p.z > zAtTouch, `expected +z slide, ${zAtTouch} -> ${p.z}`);
    return;
  }
  assert.ok(zAtTouch !== undefined, "never reached west face of cover crate");
});

test("world bounds clamp escape", () => {
  const bounds = arenaStaticWorld().definition.bounds;
  const app = ExampleApp.arena({ presentation: "skipped" });
  const a = app.connectClient();
  const limit = bounds.maxX - PAWN_RADIUS;
  const z = Math.min(bounds.maxZ - PAWN_RADIUS, Math.max(bounds.minZ + PAWN_RADIUS, 0));
  place(app, a.pawn, limit - 1, z);
  app.step();
  for (let i = 0; i < 20; i++) app.step(new Map([[a.id, { moveX: 1, moveZ: 0 }]]));
  assert.ok(app.world.store.view(a.pawn)!.position.x <= limit + 1e-4);
});

test("spawns sit outside all AABBs plus radius", () => {
  const arena = arenaStaticWorld();
  const r = 0.5;
  for (const spawn of arena.definition.spawnPoints) {
    for (const box of arena.definition.aabbs) {
      const inside =
        spawn.x > box.minX - r &&
        spawn.x < box.maxX + r &&
        spawn.z > box.minZ - r &&
        spawn.z < box.maxZ + r;
      assert.equal(inside, false, `${spawn.id} overlaps aabb ${box.id}`);
    }
  }
});

test("bundle id mismatch rejects", () => {
  const app = ExampleApp.arena();
  const pair = memoryPair();
  app.server.attach(pair.server);
  let code: string | undefined;
  const ws = new EngineWsClient(pair.client, {
    compatibility: { protocol: 1, world: app.world.worldVersion },
    bundleId: "other.world",
    authoritativeHash: app.authoritativeHash,
    onReject: (msg) => {
      code = msg.code;
    },
  });
  ws.hello();
  assert.equal(code, "WORLD_BUNDLE_MISMATCH");
});
