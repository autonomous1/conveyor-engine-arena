import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, type KeyObject } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
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
const { loadSigner, mint } = await import("../src/server/auth/tokens.ts");
const { placePawn } = await import("../src/server/game.ts");
const { startArenaServer } = await import("../src/server/main.ts");
const { loadArena } = await import("../src/server/world-loader.ts");
const { parseArenaFrame, parseWelcomeExtras } = await import("../src/shared/bot-protocol.ts");
const { doorUseVolume, useFrame } = await import("../src/shared/doors.ts");

const HOUR_S = 60 * 60;

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

function parsed(messages: readonly string[]): Record<string, unknown>[] {
  return messages.map((text) => JSON.parse(text) as Record<string, unknown>);
}

function exportPem(key: KeyObject, type: "pkcs8" | "spki"): string {
  const pem = key.export({ type, format: "pem" });
  if (typeof pem !== "string") throw new Error(`expected ${type} PEM text`);
  return pem;
}

async function withEnv(values: Record<string, string | undefined>, run: () => Promise<void>): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function attachClient(
  host: ReturnType<typeof createArenaHost>,
  loaded: ReturnType<typeof loadArena>,
): { messages: string[]; owned: () => number; send: (text: string) => void; close: () => void } {
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
  ws.hello();
  return {
    messages,
    owned: () => owned,
    send(text) {
      pair.client.send(text);
    },
    close() {
      ws.close();
    },
  };
}

async function waitFor(ready: () => boolean, ms = 1000): Promise<boolean> {
  const start = Date.now();
  while (!ready()) {
    if (Date.now() - start > ms) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return true;
}

test("parseArenaFrame round-trips host frames and drops an unknown t", () => {
  const frames = [
    { t: "loadout", ammo: 30, weapon: "alien-weapon-enh" },
    { t: "loadout", ammo: 0 },
    { t: "pickup", id: "key", gone: true },
    { t: "door", id: "d", open: true, locked: false },
    { t: "elevator", id: "e1", y: 3, doorsOpen: false, stop: 1 },
    { t: "health", entity: 4, hp: 75, dead: false },
    { t: "laser", shooter: 2, from: { x: 0, y: 1, z: 2 }, to: { x: 3, y: 4, z: 5 }, until: 80 },
    { t: "grenade", id: 9, x: 1, y: 2, z: 3, yaw: 0.2 },
    { t: "grenade", id: 9, x: 1, y: 2, z: 3, yaw: 0.2, stop: true },
    { t: "audit", fired: 1, accepted: 1, droppedDuplicate: 0, droppedRate: 0, hits: 1, kills: 0 },
    { t: "inventory", keys: ["key"] },
    {
      t: "sceneGraph",
      v: 1,
      hash: "ab".repeat(32),
      graph: { formatVersion: 1, units: "meters", places: [], portals: [] },
    },
    { t: "teleportResult", ok: true },
    { t: "teleportResult", ok: false, reason: "blocked" },
    { t: "snapshotResult", ok: true, id: "snap-1", png: "data:image/png;base64,QQ==" },
    { t: "snapshotResult", ok: false, id: "snap-1", reason: "noRenderer" },
    { t: "snapshotResult", ok: false, id: "snap-1", reason: "invalid" },
    { t: "snapshotResult", ok: false, id: "snap-1", reason: "busy" },
    { t: "qaCapture", id: "snap-1" },
    {
      t: "qaCapture",
      id: "snap-2",
      lookFrom: { eye: { x: 1, y: 2, z: 3 }, target: { x: 4, y: 5, z: 6 }, fovDeg: 55 },
      follow: { entityId: 7, back: 3, up: 1.6 },
      waitFrames: 2,
    },
  ];
  for (const frame of frames) {
    assert.deepEqual(parseArenaFrame(JSON.stringify(frame)), frame);
  }
  assert.equal(parseArenaFrame(JSON.stringify({ t: "nope" })), undefined);
  assert.equal(parseArenaFrame("{"), undefined);
  assert.equal(parseArenaFrame(JSON.stringify({ t: "snapshotResult", ok: false, id: "snap-1", reason: "nope" })), undefined);
  assert.equal(parseArenaFrame(JSON.stringify({ t: "qaCapture" })), undefined);

  const bare = parseWelcomeExtras({
    type: "welcome",
    pickups: ["a"],
    doors: [{ id: "d", open: false, locked: true }],
    keys: ["key"],
  });
  assert.deepEqual(bare, {
    pickups: ["a"],
    doors: [{ t: "door", id: "d", open: false, locked: true }],
    ammo: 0,
    keys: ["key"],
  });
  assert.equal(bare?.role, undefined);
  assert.equal(bare?.scope, undefined);
  const stamped = parseWelcomeExtras({
    type: "welcome",
    pickups: [],
    doors: [],
    elevators: [{ t: "elevator", id: "e", y: 1, doorsOpen: true, stop: 0 }],
    weapon: "alien-weapon-enh",
    ammo: 10,
    keys: [],
    role: "bot",
    scope: ["play", "chat", "scene-graph"],
    scopes: ["ignored"],
  });
  assert.equal(stamped?.role, "bot");
  assert.deepEqual(stamped?.scope, ["play", "chat", "scene-graph"]);
  assert.equal(stamped?.weapon, "alien-weapon-enh");
  assert.equal(stamped?.ammo, 10);
  assert.equal(stamped?.elevators?.[0]?.id, "e");
  assert.equal(parseWelcomeExtras({ type: "reject" }), undefined);
});

test("shared wire parsers do not import node", () => {
  for (const file of ["src/shared/wire.ts", "src/shared/bot-protocol.ts"]) {
    const text = readFileSync(file, "utf8");
    assert.equal(text.includes("node:"), false, file);
    assert.equal(text.includes("require("), false, file);
    assert.equal(text.includes("readFileSync"), false, file);
    assert.equal(text.includes('from "ws"'), false, file);
    assert.equal(text.includes("from 'ws'"), false, file);
  }
});

test("inventory is owner-only, unlock keeps the key, and welcome repeats it", { timeout: 60_000 }, async () => {
  const loaded = loadArena();
  const key = loaded.view.pickups?.find((pickup) => pickup.id === "key" && pickup.kind === "key");
  assert.ok(key);
  const door = loaded.view.doors.find((item) => item.locked === true && item.key === "key");
  assert.ok(door);
  const host = createArenaHost(loaded, { holdNpcs: true });
  const owner = attachClient(host, loaded);
  const other = attachClient(host, loaded);
  try {
    assert.ok(owner.owned() > 0);
    assert.notEqual(owner.owned(), other.owned());
    const welcome = parsed(owner.messages).find((frame) => frame.type === "welcome");
    assert.ok(welcome);
    assert.deepEqual(parseWelcomeExtras(welcome)?.keys, []);
    assert.equal(welcome.role, undefined);
    assert.equal(welcome.scope, undefined);
    assert.equal(parsed(owner.messages).some((frame) => frame.t === "sceneGraph"), false);

    placePawn(loaded.world, owner.owned(), {
      id: "on-key",
      x: (key.minX + key.maxX) / 2,
      y: key.minY,
      z: (key.minZ + key.maxZ) / 2,
      yaw: 0,
    });
    loaded.world.commit(1n);
    const got = await waitFor(() => parsed(owner.messages).some((frame) => frame.t === "inventory"));
    const at = loaded.world.store.view(owner.owned())?.position;
    assert.equal(got, true, `no inventory at ${at?.x},${at?.y},${at?.z}`);
    const inventory = parsed(owner.messages).filter((frame) => frame.t === "inventory");
    assert.deepEqual(inventory, [{ t: "inventory", keys: ["key"] }]);
    assert.equal(parsed(other.messages).some((frame) => frame.t === "inventory"), false);
    assert.equal(parsed(other.messages).some((frame) => frame.t === "pickup" && frame.id === "key"), true);

    const volume = doorUseVolume(door);
    placePawn(loaded.world, owner.owned(), {
      id: "at-door",
      x: (volume.minX + volume.maxX) / 2,
      y: volume.minY,
      z: (volume.minZ + volume.maxZ) / 2,
      yaw: 0,
    });
    loaded.world.commit(2n);
    const mark = owner.messages.length;
    owner.send(JSON.stringify(useFrame(1)));
    const doorFrame = parsed(owner.messages.slice(mark)).find((frame) => frame.t === "door");
    assert.ok(doorFrame, "door use frame");
    assert.equal(doorFrame.id, door.id);
    assert.equal(doorFrame.open, true);
    assert.equal(doorFrame.locked, false);
    assert.equal(parsed(owner.messages.slice(mark)).some((frame) => frame.t === "inventory"), false);

    owner.close();
    const again = attachClient(host, loaded);
    try {
      const next = parsed(again.messages).find((frame) => frame.type === "welcome");
      assert.equal(again.owned(), owner.owned());
      assert.deepEqual(parseWelcomeExtras(next)?.keys, ["key"]);
    } finally {
      again.close();
    }
  } finally {
    other.close();
    host.stop();
  }
});

test("solo grant sends the scene graph without claims", async () => {
  const loaded = loadArena();
  const host = createArenaHost(loaded, { holdNpcs: true, grantSceneGraph: true });
  await host.sceneGraphReady;
  const client = attachClient(host, loaded);
  try {
    const frames = parsed(client.messages);
    const welcomeAt = frames.findIndex((frame) => frame.type === "welcome");
    assert.ok(welcomeAt >= 0);
    assert.equal(frames[welcomeAt]?.role, undefined);
    assert.equal(frames[welcomeAt]?.scope, undefined);
    const graph = frames[welcomeAt + 1];
    assert.equal(graph?.t, "sceneGraph");
    assert.equal(graph?.v, 1);
    assert.equal(graph?.hash, host.sceneGraphHash);
    assert.equal(createHash("sha256").update(host.sceneGraphJson ?? "").digest("hex"), host.sceneGraphHash);
    assert.deepEqual(graph?.graph, JSON.parse(host.sceneGraphJson ?? ""));
    assert.equal(JSON.stringify(graph?.graph).includes("placeById"), false);
  } finally {
    client.close();
    host.stop();
  }
});

type Wire = { world: string; bundleId: string; authoritativeHash: string };

function hello(view: Wire, auth?: string): Record<string, unknown> {
  return {
    v: 1,
    type: "hello",
    protocol: 1,
    world: view.world,
    bundleId: view.bundleId,
    authoritativeHash: view.authoritativeHash,
    ...(auth !== undefined ? { auth } : {}),
  };
}

function collect(url: string, body: Record<string, unknown>, ms: number): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url.replace(/^http/, "ws"));
    const frames: Record<string, unknown>[] = [];
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // already closing
      }
      if (err) reject(err);
      else resolve(frames);
    };
    const timer = setTimeout(() => finish(), ms);
    ws.addEventListener("error", () => finish(new Error("socket error")));
    ws.addEventListener("message", (ev) => {
      frames.push(JSON.parse(String(ev.data)) as Record<string, unknown>);
      if (frames.some((frame) => frame.t === "sceneGraph")) finish();
    });
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify(body));
    });
  });
}

test("scene graph follows a scoped token and stays off the static host", { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "arena-scene-graph-"));
  const keyFile = path.join(dir, "ed25519.key.pem");
  const pubFile = path.join(dir, "ed25519.pub.pem");
  const pair = generateKeyPairSync("ed25519");
  writeFileSync(keyFile, exportPem(pair.privateKey, "pkcs8"), { mode: 0o600 });
  writeFileSync(pubFile, exportPem(pair.publicKey, "spki"));
  const signer = await loadSigner(keyFile);
  const player = await mint(signer, { sub: "tim-player", role: "player", ttlS: HOUR_S });
  const bot = await mint(signer, { sub: "tim-bot", role: "bot", scope: ["scene-graph"], ttlS: HOUR_S });
  try {
    await withEnv({
      ARENA_AUTH: undefined,
      ARENA_VERIFY_KEY_FILE: undefined,
      ARENA_REVOKED_FILE: undefined,
    }, async () => {
      const host = await startArenaServer(0, true);
      try {
        const view = await (await fetch(`${host.url}/arena.json`)).json() as Wire & Record<string, unknown>;
        assert.equal("sceneGraph" in view, false);
        const frames = await collect(host.url, hello(view), 400);
        assert.equal(frames.some((frame) => frame.type === "welcome"), true);
        assert.equal(frames.some((frame) => frame.t === "sceneGraph"), false);
        assert.equal((await fetch(`${host.url}/scene-graph.json`)).status, 401);
        assert.equal((await fetch(`${host.url}/game/scene-graph.json`)).status, 404);
      } finally {
        await host.close();
      }
    });

    await withEnv({
      ARENA_AUTH: "required",
      ARENA_VERIFY_KEY_FILE: pubFile,
      ARENA_REVOKED_FILE: path.join(dir, "none.json"),
    }, async () => {
      const host = await startArenaServer(0, true);
      try {
        const view = await (await fetch(`${host.url}/arena.json`)).json() as Wire;
        const botFrames = await collect(host.url, hello(view, bot.token), 2_000);
        const welcomeAt = botFrames.findIndex((frame) => frame.type === "welcome");
        assert.ok(welcomeAt >= 0);
        assert.equal(botFrames[welcomeAt]?.role, "bot");
        assert.ok(Array.isArray(botFrames[welcomeAt]?.scope));
        assert.ok((botFrames[welcomeAt]?.scope as string[]).includes("scene-graph"));
        const graph = botFrames[welcomeAt + 1];
        assert.equal(graph?.t, "sceneGraph", JSON.stringify(botFrames.slice(welcomeAt, welcomeAt + 3)));
        const res = await fetch(`${host.url}/scene-graph.json`, { headers: { authorization: `Bearer ${bot.token}` } });
        assert.equal(res.status, 200);
        const body = await res.text();
        const hash = createHash("sha256").update(body).digest("hex");
        assert.equal(graph?.hash, hash);
        assert.equal(res.headers.get("etag"), `"${hash}"`);
        assert.deepEqual(graph?.graph, JSON.parse(body));
        assert.equal(body.includes("placeById"), false);

        const playerFrames = await collect(host.url, hello(view, player.token), 400);
        const playerWelcome = playerFrames.find((frame) => frame.type === "welcome");
        assert.ok(playerWelcome);
        assert.equal(playerWelcome.role, "player");
        assert.deepEqual(playerWelcome.scope, ["play", "chat", "voice"]);
        assert.equal(playerFrames.some((frame) => frame.t === "sceneGraph"), false);
        const denied = await fetch(`${host.url}/scene-graph.json`, { headers: { authorization: `Bearer ${player.token}` } });
        assert.equal(denied.status, 403);
        assert.equal((await denied.text()).includes("places"), false);
        const missing = await fetch(`${host.url}/scene-graph.json`);
        assert.equal(missing.status, 401);
        const leaked = await fetch(`${host.url}/game/scene-graph.json`);
        assert.equal(leaked.status, 404);
        assert.equal((await leaked.text()).includes("\"places\""), false);
      } finally {
        await host.close();
      }
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
