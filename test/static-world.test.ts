import assert from "node:assert/strict";
import { test } from "node:test";
import { EngineWsClient, memoryPair } from "conveyor-engine-transport-ws";
import { ExampleApp, arenaStaticWorld } from "../dist/index.js";

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
  assert.equal(d.spawnCount, 5);
  assert.ok((d.aabbCount ?? 0) >= 5);
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
  const app = ExampleApp.arena({ presentation: "skipped" });
  const a = app.connectClient();
  const b = app.connectClient();
  for (let i = 0; i < 40; i++) {
    app.step(new Map([
      [a.id, { moveX: 1, moveZ: 0 }],
      [b.id, { moveX: -1, moveZ: 0 }],
    ]));
  }
  assert.equal(app.world.store.view(a.pawn)!.position.x, -2.5);
  assert.equal(app.world.store.view(b.pawn)!.position.x, 4.5);
});

test("axis slide continues on the free axis", () => {
  const app = ExampleApp.arena({ presentation: "skipped" });
  const a = app.connectClient();
  place(app, a.pawn, -4, 0);
  app.step();
  let zAtTouch: number | undefined;
  for (let i = 0; i < 12; i++) {
    app.step(new Map([[a.id, { moveX: 1, moveZ: 1 }]]));
    const p = app.world.store.view(a.pawn)!.position;
    if (p.x !== -2.5) continue;
    if (zAtTouch === undefined) {
      zAtTouch = p.z;
      continue;
    }
    assert.equal(p.x, -2.5);
    assert.ok(p.z > zAtTouch, `expected +z slide, ${zAtTouch} -> ${p.z}`);
    return;
  }
  assert.ok(zAtTouch !== undefined, "never reached west face of center AABB");
});

test("world bounds clamp escape", () => {
  const app = ExampleApp.arena({ presentation: "skipped" });
  const a = app.connectClient();
  place(app, a.pawn, 23, 0);
  app.step();
  for (let i = 0; i < 20; i++) app.step(new Map([[a.id, { moveX: 1, moveZ: 0 }]]));
  assert.ok(app.world.store.view(a.pawn)!.position.x <= 23.5);
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
