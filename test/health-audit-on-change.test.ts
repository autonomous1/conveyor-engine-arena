import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { EngineWsClient, memoryPair, type TransportSocket } from "conveyor-engine-transport-ws";

register(
  "data:text/javascript," +
    encodeURIComponent(`
      import { existsSync } from "node:fs";
      import { fileURLToPath } from "node:url";
      export async function resolve(specifier, context, nextResolve) {
        const parent = context.parentURL ?? "";
        if ((specifier.startsWith("./") || specifier.startsWith("../")) && specifier.endsWith(".js") && parent.includes("/src/")) {
          const ts = specifier.slice(0, -3) + ".ts";
          if (existsSync(fileURLToPath(new URL(ts, parent)))) return nextResolve(ts, context);
        }
        return nextResolve(specifier, context);
      }
    `),
);

const { deliverHealthFrames } = await import("../src/server/health.ts");
const { deliverAuditFrame } = await import("../src/server/audit.ts");
const { createPawnHealth } = await import("../src/shared/health.ts");
const { createAudit } = await import("../src/shared/audit.ts");
const { createArenaHost } = await import("../src/server/arena-host.ts");
const { loadArena } = await import("../src/server/world-loader.ts");

type Client = { sessionId: number; sent: { t?: string; entity?: number; hp?: number }[]; known: Set<number> };

/** Just the EngineWsServer surface the deliver helpers read. */
function fakeServer(pawns: number[]) {
  const clients = new Map<number, Client>();
  let nextSession = 1;
  const server = {
    get connected() {
      return [...clients.keys()];
    },
    session(id: number) {
      const c = clients.get(id);
      return c && { sessionId: c.sessionId, socket: { send: (text: string) => c.sent.push(JSON.parse(text)) } };
    },
    replicator: {
      get(id: number) {
        const c = clients.get(id);
        return c && { connected: true, ownedEntity: undefined, known: c.known };
      },
    },
    join(id: number) {
      clients.set(id, { sessionId: nextSession++, sent: [], known: new Set(pawns) });
      return clients.get(id)!;
    },
    leave(id: number) {
      clients.delete(id);
    },
  };
  return server;
}

const healthOf = (c: Client) => c.sent.filter((f) => f.t === "health");
const auditOf = (c: Client) => c.sent.filter((f) => f.t === "audit");

test("unchanged health sends nothing after the first tick; one hit sends exactly one frame", () => {
  const server = fakeServer([1, 2, 3]);
  const health = createPawnHealth(() => 0);
  for (const id of [1, 2, 3]) health.note(id);
  const a = server.join(10);
  const tick = () => deliverHealthFrames(server as never, server.connected, health.frames());
  tick();
  assert.equal(healthOf(a).length, 3, "first tick: every visible pawn once");
  for (let i = 0; i < 20; i++) tick();
  assert.equal(healthOf(a).length, 3, "20 unchanged ticks: no more health frames");

  health.wound(2);
  for (let i = 0; i < 5; i++) tick();
  assert.equal(healthOf(a).length, 4);
  assert.deepEqual(healthOf(a)[3], { t: "health", entity: 2, hp: 75, dead: false });
});

test("an immediate hit send is not repeated by the next tick", () => {
  const server = fakeServer([1]);
  const health = createPawnHealth(() => 0);
  health.note(1);
  const a = server.join(10);
  deliverHealthFrames(server as never, server.connected, health.frames());
  const next = health.wound(1)!;
  deliverHealthFrames(server as never, server.connected, [{ t: "health", entity: 1, hp: next.hp, dead: next.dead }]);
  deliverHealthFrames(server as never, server.connected, health.frames());
  assert.equal(healthOf(a).length, 2);
});

test("a late joiner or a new session gets current health and audit once", () => {
  const server = fakeServer([1, 2]);
  const health = createPawnHealth(() => 0);
  health.note(1);
  health.note(2);
  health.wound(1);
  const audit = createAudit();
  audit.gate("accept");
  const a = server.join(10);
  const tick = () => {
    deliverHealthFrames(server as never, server.connected, health.frames());
    deliverAuditFrame(server as never, audit.frame());
  };
  tick();
  tick();
  assert.equal(healthOf(a).length, 2);
  assert.equal(auditOf(a).length, 1);

  const b = server.join(11);
  tick();
  tick();
  assert.deepEqual(healthOf(b).map((f) => [f.entity, f.hp]), [[1, 75], [2, 100]]);
  assert.equal(auditOf(b).length, 1);
  assert.equal(healthOf(a).length, 2, "existing client is not resent");
  assert.equal(auditOf(a).length, 1);

  audit.gate("repeat");
  tick();
  assert.equal(auditOf(a).length, 2, "changed counters go to everyone");
  assert.equal(auditOf(b).length, 2);

  // Same client id, new hello: the session id changes, so state is resent.
  server.leave(10);
  tick();
  const again = server.join(10);
  tick();
  assert.equal(healthOf(again).length, 2);
  assert.equal(auditOf(again).length, 1);
});

test("a pawn outside interest is sent when it becomes visible", () => {
  const server = fakeServer([]);
  const health = createPawnHealth(() => 0);
  health.note(1);
  const a = server.join(10);
  deliverHealthFrames(server as never, server.connected, health.frames());
  assert.equal(healthOf(a).length, 0);
  a.known.add(1);
  deliverHealthFrames(server as never, server.connected, health.frames());
  assert.equal(healthOf(a).length, 1);
});

function asConn(sock: TransportSocket) {
  let open = true;
  return {
    send(text: string) {
      if (open) sock.send(text);
    },
    close() {
      open = false;
      sock.close();
    },
    onText(handler: (text: string) => void) {
      sock.onMessage(handler);
    },
    onClose(handler: () => void) {
      sock.onClose(() => {
        open = false;
        handler();
      });
    },
    isOpen() {
      return open;
    },
  };
}

function join(host: ReturnType<typeof createArenaHost>, loaded: ReturnType<typeof loadArena>) {
  const pair = memoryPair();
  const frames: { t?: string; type?: string; entity?: number }[] = [];
  pair.client.onMessage((text) => frames.push(JSON.parse(text)));
  host.attach(asConn(pair.server));
  const ws = new EngineWsClient(pair.client, {
    compatibility: { protocol: 1, world: loaded.view.world },
    bundleId: loaded.view.bundleId,
    authoritativeHash: loaded.view.authoritativeHash,
  });
  ws.hello();
  return frames;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("live host loop: health and audit are not resent every tick; a second joiner still gets them", async () => {
  const loaded = loadArena();
  const host = createArenaHost(loaded, { holdNpcs: true });
  try {
    const first = join(host, loaded);
    await sleep(300);
    const firstHealth = first.filter((f) => f.t === "health").length;
    const firstAudit = first.filter((f) => f.t === "audit").length;
    assert.ok(firstHealth > 0, "first joiner got health");
    assert.equal(firstAudit, 1, "first joiner got the audit once");
    const seen = new Set(first.filter((f) => f.t === "health").map((f) => f.entity));
    assert.equal(seen.size, firstHealth, "each pawn's health sent once");

    await sleep(500); // ~10 ticks, nothing changes
    assert.equal(first.filter((f) => f.t === "health").length, firstHealth);
    assert.equal(first.filter((f) => f.t === "audit").length, 1);

    const second = join(host, loaded);
    await sleep(300);
    assert.ok(second.some((f) => f.type === "welcome"));
    assert.ok(second.filter((f) => f.t === "health").length > 0, "late joiner got health");
    assert.equal(second.filter((f) => f.t === "audit").length, 1, "late joiner got the audit once");
    assert.equal(first.filter((f) => f.t === "health").length, firstHealth, "first joiner not resent");
  } finally {
    host.stop();
  }
});
