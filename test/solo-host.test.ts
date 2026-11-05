import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { register } from "node:module";
import path from "node:path";
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

const { createArenaHost } = await import("../src/server/arena-host.ts");
const { preloadGameFiles } = await import("../src/server/game-files-fetch.ts");
const { GameManifestError, compileGame } = await import("../src/server/game-manifest.ts");
const { loadInstalledGame, projectRoot, readManifestSources } = await import("../src/server/load-game.ts");
const { placePawn } = await import("../src/server/game.ts");
const { loadArena } = await import("../src/server/world-loader.ts");
const { doorUseVolume } = await import("../src/shared/doors.ts");
const { useFrame } = await import("../src/shared/doors.ts");

function serveWeb(root: string, manifest?: unknown): typeof fetch {
  return async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === "./game/arena.game.json" && manifest !== undefined) {
      return new Response(JSON.stringify(manifest));
    }
    let rel: string | undefined;
    if (url.startsWith("./game/") || url.startsWith("./assets/")) rel = path.join("web", url.slice(2));
    if (!rel) return new Response("missing", { status: 404 });
    const file = path.join(root, rel);
    if (!existsSync(file)) return new Response("missing", { status: 404 });
    return new Response(readFileSync(file));
  };
}

function asConn(sock: TransportSocket) {
  let open = true;
  return {
    send(text) {
      if (open) sock.send(text);
    },
    close() {
      open = false;
      sock.close();
    },
    onText(handler) {
      sock.onMessage(handler);
    },
    onClose(handler) {
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

test("fetched files compile to the same arena json as the node loader", async () => {
  const root = projectRoot();
  const previous = globalThis.fetch;
  globalThis.fetch = serveWeb(root);
  const nodeHost = createArenaHost(loadArena(), { holdNpcs: true });
  let fetchHost: ReturnType<typeof createArenaHost> | undefined;
  try {
    const files = await preloadGameFiles("./");
    fetchHost = createArenaHost(loadArena(files, process.env), { holdNpcs: true });
    assert.equal(fetchHost.arenaJson, nodeHost.arenaJson);
  } finally {
    nodeHost.stop();
    fetchHost?.stop();
    globalThis.fetch = previous;
  }
});

test("in-tab host welcomes, moves, toggles a door, and stop clears the timer", async () => {
  const loaded = loadArena();
  const host = createArenaHost(loaded, { holdNpcs: true });
  const pair = memoryPair();
  const messages: string[] = [];
  pair.client.onMessage((text) => messages.push(text));
  host.attach(asConn(pair.server));
  let owned = 0;
  const ws = new EngineWsClient(pair.client, {
    compatibility: { protocol: 1, world: loaded.view.world },
    bundleId: loaded.view.bundleId,
    authoritativeHash: loaded.view.authoritativeHash,
    onWelcome(msg) {
      owned = msg.ownedEntityId ?? 0;
    },
  });
  try {
    ws.hello();
    const welcome = messages.map((text) => JSON.parse(text) as Record<string, unknown>).find((frame) => frame.type === "welcome");
    assert.ok(welcome);
    assert.equal(typeof welcome.ownedEntityId, "number");
    assert.ok(Array.isArray(welcome.pickups));
    assert.ok(Array.isArray(welcome.doors));
    assert.ok(owned > 0);

    const before = loaded.world.store.view(owned)?.position;
    assert.ok(before);
    ws.sendInput({ seq: 1, moveX: 1, moveZ: 0, yaw: 0 });
    await new Promise((resolve) => setTimeout(resolve, 450));
    const after = loaded.world.store.view(owned)?.position;
    assert.ok(after);
    assert.ok(Math.hypot(after.x - before.x, after.z - before.z) > 0.05, `${before.x},${before.z} -> ${after.x},${after.z}`);

    const door = loaded.view.doors.find((item) => item.locked !== true);
    assert.ok(door);
    const volume = doorUseVolume(door);
    placePawn(loaded.world, owned, {
      id: "solo-door",
      x: (volume.minX + volume.maxX) / 2,
      y: volume.minY,
      z: (volume.minZ + volume.maxZ) / 2,
      yaw: 0,
    });
    loaded.world.commit(1n);
    const mark = messages.length;
    pair.client.send(JSON.stringify(useFrame(1)));
    const toggled = messages.slice(mark).map((text) => JSON.parse(text) as { t?: string; id?: string; open?: boolean }).find((frame) => frame.t === "door");
    assert.ok(toggled, "door use frame");
    assert.equal(toggled.id, door.id);
    assert.equal(toggled.open, !door.open);
  } finally {
    let cleared = 0;
    const orig = globalThis.clearInterval;
    globalThis.clearInterval = ((handle: ReturnType<typeof setInterval>) => {
      cleared += 1;
      return orig(handle);
    }) as typeof clearInterval;
    try {
      host.stop();
    } finally {
      globalThis.clearInterval = orig;
    }
    assert.ok(cleared >= 1);
  }
});

test("fetch loader raises a missing side file on the same path as node", async () => {
  const root = projectRoot();
  const doc = JSON.parse(readFileSync(path.join(root, "web/game/arena.game.json"), "utf8")) as { scene: Record<string, unknown> };
  const missing = "./web/game/does-not-exist.json";
  const broken = { ...doc, scene: { ...doc.scene, bounds: missing } };
  let nodePath = "";
  try {
    readManifestSources(root, broken);
    assert.fail("node loader should throw");
  } catch (err) {
    assert.ok(err instanceof GameManifestError);
    nodePath = err.issues[0]?.path ?? "";
  }
  assert.equal(nodePath, "scene.bounds");
  const previous = globalThis.fetch;
  globalThis.fetch = serveWeb(root, broken);
  try {
    const files = await preloadGameFiles("./");
    assert.throws(() => loadInstalledGame(files, {}), (err: unknown) => {
      assert.ok(err instanceof GameManifestError);
      assert.equal(err.issues[0]?.path, nodePath);
      return true;
    });
  } finally {
    globalThis.fetch = previous;
  }
});

test("wsUrl accepts wss and rejects http", () => {
  const root = projectRoot();
  const doc = JSON.parse(readFileSync(path.join(root, "web/game/arena.game.json"), "utf8")) as Record<string, unknown>;
  const sources = readManifestSources(root, doc);
  const read = (uri: string) => {
    const file = path.join(root, "web", uri.replace(/^\//, ""));
    if (!existsSync(file)) return undefined;
    return new Uint8Array(readFileSync(file));
  };
  const good = compileGame({ ...doc, wsUrl: "wss://arena.example/play" }, read, sources);
  assert.equal(good.view.wsUrl, "wss://arena.example/play");
  assert.throws(() => compileGame({ ...doc, wsUrl: "http://arena.example/play" }, read, sources), (err: unknown) => {
    assert.ok(err instanceof GameManifestError);
    assert.ok(err.issues.some((issue) => issue.path === "wsUrl"));
    return true;
  });
});
