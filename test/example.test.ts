import assert from "node:assert/strict";
import { test } from "node:test";
import { EngineWsClient, memoryPair } from "conveyor-engine-transport-ws";
import { ExampleApp, runBench, runNamed } from "../dist/index.js";

test("one client, no faults: pawn moves and first snapshot is full", () => {
  const app = new ExampleApp();
  const a = app.connectClient();
  app.step(new Map([[a.id, { moveX: 1, moveZ: 0 }]]));
  assert.ok(a.snapshots.length >= 1);
  assert.equal(a.snapshots[0]!.kind, "full");
  app.step(new Map([[a.id, { moveX: 1, moveZ: 0 }]]));
  assert.ok(a.snapshots.some((s) => s.kind === "delta"));
  assert.ok(app.world.store.view(a.pawn)!.position.x > 0);
  assert.ok(a.three.binding(a.pawn));
});

test("two clients see each other inside relevance and not a distant crate", () => {
  const app = new ExampleApp({ radius: 16 });
  const a = app.connectClient();
  const b = app.connectClient();
  const far = app.addCrate(400, 0);
  app.step();
  const seenA = new Set(a.snapshots.at(-1)!.spawns.map((s) => s.entity).concat(a.snapshots.at(-1)!.updates.map((u) => u.entity)));
  const seenB = new Set(b.snapshots.at(-1)!.spawns.map((s) => s.entity).concat(b.snapshots.at(-1)!.updates.map((u) => u.entity)));
  assert.ok(seenA.has(a.pawn) && seenA.has(b.pawn));
  assert.ok(seenB.has(a.pawn) && seenB.has(b.pawn));
  assert.ok(!seenA.has(far) && !seenB.has(far));
});

test("crate entering and leaving relevance spawn/despawn on the client", () => {
  const app = new ExampleApp({ radius: 16 });
  const a = app.connectClient();
  const crate = app.addCrate(100, 0);
  app.step();
  assert.ok(!a.pred.authoritative(crate));
  app.world.enqueue({
    kind: "setTransform",
    entity: crate,
    position: { x: 1, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    scale: { x: 1, y: 1, z: 1 },
  });
  app.step();
  assert.ok(a.pred.authoritative(crate));
  app.world.enqueue({
    kind: "setTransform",
    entity: crate,
    position: { x: 100, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    scale: { x: 1, y: 1, z: 1 },
  });
  app.step();
  assert.equal(a.pred.authoritative(crate), undefined);
  assert.equal(a.three.binding(crate), undefined);
});

test("disconnect then reconnect with token requests a full snapshot", () => {
  const app = new ExampleApp();
  const a = app.connectClient();
  app.step();
  const token = a.ws.reconnectToken!;
  app.disconnect(a.id);
  assert.equal(app.server.connected.length, 0);
  const pair = memoryPair();
  app.server.attach(pair.server);
  const kinds: string[] = [];
  const ws = new EngineWsClient(pair.client, {
    compatibility: { protocol: 1, world: app.world.worldVersion },
    token,
    onSnapshot: (env) => kinds.push(env.kind),
  });
  ws.hello();
  assert.equal(ws.clientId, a.id);
  assert.equal(app.replicator.get(a.id)?.needsFull, true);
  app.step();
  assert.ok(kinds.includes("full"));
});

test("identical two-client runs produce equal canonical hashes", () => {
  function run() {
    const app = new ExampleApp();
    const a = app.connectClient();
    const b = app.connectClient();
    for (let i = 0; i < 5; i++) {
      app.step(new Map([
        [a.id, { moveX: 1, moveZ: 0 }],
        [b.id, { moveX: 0, moveZ: 1 }],
      ]));
    }
    return app.diagnostics().hash;
  }
  assert.equal(run(), run());
});

test("metrics fields do not appear in the canonical hash payload", () => {
  const app = new ExampleApp();
  app.connectClient();
  app.step();
  const json = app.world.canonicalJson();
  assert.equal(json.includes("commitDurationMs"), false);
  assert.equal(json.includes("inputSendRate"), false);
});

test("named lossless runners with the same seed share hashes", async () => {
  const a = await runNamed("lossless", 11n, 6);
  const b = await runNamed("lossless", 11n, 6);
  assert.deepEqual(a.hashes, b.hashes);
  assert.equal(a.worldHash, b.worldHash);
  assert.ok(a.deliveries > 0);
});

test("world metrics fields do not change canonicalJson", () => {
  const app = new ExampleApp();
  app.connectClient();
  app.step();
  const before = app.world.canonicalJson();
  app.world.metrics.commitDurationMs = 99999;
  app.world.metrics.queryCount = 99999;
  assert.equal(app.world.canonicalJson(), before);
});

test("M1 bench reports finite timings", () => {
  const r = runBench({ entities: 24, ticks: 4 });
  assert.ok(r.entities >= 24);
  assert.equal(r.ticks, 4);
  assert.equal(r.clients, 2);
  assert.ok(r.commitMs >= 0 && r.publishMs >= 0);
  assert.ok(r.envelopeBytes > 0);
});
