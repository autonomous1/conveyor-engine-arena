import assert from "node:assert/strict";
import { test } from "node:test";
import { EngineWsClient, EngineWsServer, memoryPair } from "conveyor-engine-transport-ws";
import { ARENA_INTEREST_RADIUS, noteArenaInterest } from "../dist/server/game.js";
import { startArenaServer } from "../dist/server/main.js";
import { loadArena } from "../dist/server/world-loader.js";

type Pose = { x: number; z: number };

function absorb(poses: Map<number, Pose>, envelope: { spawns?: unknown[]; updates?: unknown[]; despawns?: unknown[] }) {
  const rows = [...(envelope.spawns ?? []), ...(envelope.updates ?? [])] as Array<{ entity?: number; view?: { position?: Pose } }>;
  for (const row of rows) {
    const id = Number(row.entity);
    const position = row.view?.position;
    if (Number.isFinite(id) && position) poses.set(id, { x: position.x, z: position.z });
  }
  for (const row of envelope.despawns ?? []) {
    const id = Number((row as { entity?: number }).entity);
    if (Number.isFinite(id)) poses.delete(id);
  }
}

function hello(url: string, view: { world: string; bundleId: string; authoritativeHash: string }, token?: string) {
  const poses = new Map<number, Pose>();
  let seq = 0;
  const ws = new WebSocket(url.replace(/^http/, "ws"));
  const welcome = new Promise<{ clientId: number; ownedEntityId: number; token: string }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no welcome")), 3000);
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data)) as {
        type?: string;
        clientId?: number;
        ownedEntityId?: number;
        reconnectToken?: string;
        reason?: string;
        envelope?: { spawns?: unknown[]; updates?: unknown[]; despawns?: unknown[] };
      };
      if (msg.type === "reject") {
        clearTimeout(timer);
        reject(Object.assign(new Error(msg.reason ?? "reject"), { reject: true }));
      }
      if (msg.type === "welcome") {
        clearTimeout(timer);
        resolve({
          clientId: Number(msg.clientId),
          ownedEntityId: Number(msg.ownedEntityId),
          token: String(msg.reconnectToken ?? ""),
        });
      }
      if (msg.type === "snapshot" && msg.envelope) absorb(poses, msg.envelope);
    });
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({
        v: 1,
        type: "hello",
        protocol: 1,
        world: view.world,
        bundleId: view.bundleId,
        authoritativeHash: view.authoritativeHash,
        token,
      }));
    });
  });
  return {
    ws,
    poses,
    welcome,
    drive(moveX: number, moveZ: number, yaw: number, entity: number) {
      const timer = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        seq += 1;
        ws.send(JSON.stringify({ v: 1, type: "input", seq, moveX, moveZ, yaw, buttons: 0, entity }));
      }, 40);
      return () => clearInterval(timer);
    },
  };
}

test("arena interest override is wider than the room diagonal", () => {
  assert.ok(ARENA_INTEREST_RADIUS >= 72);
  const server = new EngineWsServer({
    compatibility: { protocol: 1, world: "example-v1" },
    onHello: () => 1,
  });
  const pair = memoryPair();
  server.attach(pair.server);
  const ws = new EngineWsClient(pair.client, { compatibility: { protocol: 1, world: "example-v1" } });
  ws.hello();
  const id = ws.clientId!;
  assert.equal(server.replicator.get(id)?.interestRadius, 48);
  noteArenaInterest(server);
  assert.equal(server.replicator.get(id)?.interestRadius, ARENA_INTEREST_RADIUS);
});

test("full walk input stops on the center cover and stays inside the room", () => {
  const loaded = loadArena();
  const pawn = loaded.agents[0]!.id;
  let x = loaded.world.store.view(pawn)!.position.x;
  let z = loaded.world.store.view(pawn)!.position.z;
  assert.ok(x < -8);
  assert.ok(Math.abs(z) < 0.1);
  let maxX = x;
  for (let tick = 1; tick <= 80; tick++) {
    loaded.world.enqueue({ kind: "applyInput", entity: pawn, seq: tick, moveX: 1, moveZ: 0, yaw: Math.PI / 2 });
    loaded.world.commit(BigInt(tick));
    const pose = loaded.world.store.view(pawn)!.position;
    x = pose.x;
    z = pose.z;
    if (x > maxX) maxX = x;
    assert.ok(x > -23.6 && x < 23.6, `x ${x}`);
    assert.ok(z > -23.6 && z < 23.6, `z ${z}`);
  }
  assert.ok(maxX < 0, `tunneled through cover to ${maxX}`);
  assert.ok(x < -2, `passed the cover face at ${x}`);
  assert.ok(x > -3.2, `stopped short at ${x}`);
  assert.ok(Math.abs(z) < 0.75);
});

test("two players own different pawns and only their own input moves them", async () => {
  const host = await startArenaServer(0);
  try {
    const page = await fetch(host.url + "/arena.json");
    const view = await page.json() as { world: string; bundleId: string; authoritativeHash: string };
    const a = hello(host.url, view);
    const aw = await a.welcome;
    const b = hello(host.url, view);
    const bw = await b.welcome;
    assert.notEqual(aw.ownedEntityId, bw.ownedEntityId);
    assert.ok(Number.isFinite(aw.ownedEntityId));
    assert.ok(Number.isFinite(bw.ownedEntityId));
    const startA = await waitPose(a.poses, aw.ownedEntityId);
    const startB = await waitPose(b.poses, bw.ownedEntityId);
    const stopA = a.drive(1, 0, Math.PI / 2, aw.ownedEntityId);
    const stopB = b.drive(0, 0, Math.PI, bw.ownedEntityId);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const endA = a.poses.get(aw.ownedEntityId);
    const endB = b.poses.get(bw.ownedEntityId);
    assert.ok(endA);
    assert.ok(endB);
    assert.ok(endA.x > startA.x + 1.5, `A ${startA.x} -> ${endA.x}`);
    assert.ok(endA.x < 23.5 && endA.z > -23.5 && endA.z < 23.5);
    assert.ok(Math.abs(endB.x - startB.x) < 1.2, `B x ${startB.x} -> ${endB.x}`);
    assert.ok(Math.abs(endB.z - startB.z) < 1.2, `B z ${startB.z} -> ${endB.z}`);
    stopA();
    stopB();
    a.ws.close();
    const again = hello(host.url, view, aw.token);
    const re = await again.welcome;
    assert.equal(re.ownedEntityId, aw.ownedEntityId);
    assert.notEqual(re.ownedEntityId, bw.ownedEntityId);
    again.ws.close();
    b.ws.close();
  } finally {
    await host.close();
  }
});

test("a hello with no free pawn is refused", async () => {
  const host = await startArenaServer(0);
  const open: WebSocket[] = [];
  try {
    const view = await (await fetch(host.url + "/arena.json")).json() as { world: string; bundleId: string; authoritativeHash: string };
    const seated = [];
    for (let i = 0; i < 5; i++) {
      const client = hello(host.url, view);
      open.push(client.ws);
      seated.push(await client.welcome);
    }
    const ids = new Set(seated.map((row) => row.ownedEntityId));
    assert.equal(ids.size, 5);
    const extra = hello(host.url, view);
    open.push(extra.ws);
    await assert.rejects(extra.welcome, /no free pawn/);
    open[0]!.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const next = hello(host.url, view);
    open.push(next.ws);
    const welcomed = await next.welcome;
    assert.ok(Number.isFinite(welcomed.ownedEntityId));
    assert.ok(!seated.slice(1).some((row) => row.ownedEntityId === welcomed.ownedEntityId));
  } finally {
    for (const ws of open) ws.close();
    await host.close();
  }
});

function waitPose(poses: Map<number, Pose>, id: number): Promise<Pose> {
  return waitUntil(2000, () => poses.get(id));
}

function waitUntil<T>(ms: number, read: () => T | undefined): Promise<T> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      const value = read();
      if (value !== undefined) {
        clearInterval(timer);
        resolve(value);
      } else if (Date.now() - started > ms) {
        clearInterval(timer);
        reject(new Error("timed out"));
      }
    }, 40);
  });
}
