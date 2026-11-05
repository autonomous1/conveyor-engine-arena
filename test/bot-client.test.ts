import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, type KeyObject } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SignJWT } from "jose";
import WebSocket from "ws";

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

const { loadSigner, mint } = await import("../src/server/auth/tokens.ts");
const { startArenaServer } = await import("../src/server/main.ts");
const { BotAuthRejected, BotRejected, connectBot } = await import("../packages/bot-client/src/connection.ts");
const { createBotWorld } = await import("../packages/bot-client/src/world.ts");
const { createBotInput } = await import("../packages/bot-client/src/input.ts");

const HOUR_S = 60 * 60;
const NODE_FREE = [
  "packages/bot-client/src/world.ts",
  "packages/bot-client/src/input.ts",
  "packages/bot-client/src/connection.ts",
  "packages/bot-client/src/socket.ts",
];

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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function openSocket(url: string) {
  return new WebSocket(url);
}

async function until<T>(read: () => T | undefined, ms: number, label: string): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() - started > ms) throw new Error(label);
    await delay(40);
  }
}

test("bot world and input modules stay free of node and ws", async () => {
  const world = await import("../packages/bot-client/src/world.ts");
  const input = await import("../packages/bot-client/src/input.ts");
  assert.equal(typeof world.createBotWorld, "function");
  assert.equal(typeof input.createBotInput, "function");
  for (const file of NODE_FREE) {
    const text = readFileSync(file, "utf8");
    assert.equal(text.includes("node:"), false, file);
    assert.equal(/from ["']ws["']/.test(text), false, file);
    assert.equal(text.includes("readFileSync"), false, file);
    assert.equal(text.includes("require("), false, file);
  }
  const sent: string[] = [];
  let owned: number | undefined = 7;
  const pad = createBotInput({
    send(text) {
      sent.push(text);
      return true;
    },
    ownedId: () => owned,
  });
  pad.sendInput({ moveX: 0, moveZ: 1, yaw: 0 });
  pad.sendInput({ moveX: 0, moveZ: 1, yaw: 0 });
  assert.equal(sent.length, 1);
  assert.deepEqual(JSON.parse(sent[0]!), {
    v: 1,
    type: "input",
    seq: 1,
    moveX: 0,
    moveZ: 1,
    yaw: 0,
    buttons: 0,
    entity: 7,
  });
  assert.equal(pad.use(), true);
  assert.equal(pad.fire(0, 0), true);
  assert.equal(pad.grenade(0, 0.2), true);
  assert.equal(JSON.parse(sent[1]!).t, "use");
  assert.equal(JSON.parse(sent[2]!).t, "fire");
  assert.equal(JSON.parse(sent[3]!).t, "grenade");
  owned = undefined;
  assert.equal(pad.use(), false);
  const offline = createBotWorld({ aabbs: [], doors: [], playerSpawns: [] });
  assert.equal(offline.self(), undefined);
  assert.equal(offline.placeOf({ x: 0, y: 0, z: 0 }), undefined);
});

test("headless bot connects, models the arena, and moves", { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "arena-bot-client-"));
  const keyFile = path.join(dir, "ed25519.key.pem");
  const pubFile = path.join(dir, "ed25519.pub.pem");
  const pair = generateKeyPairSync("ed25519");
  writeFileSync(keyFile, exportPem(pair.privateKey, "pkcs8"), { mode: 0o600 });
  writeFileSync(pubFile, exportPem(pair.publicKey, "spki"));
  const signer = await loadSigner(keyFile);
  const bot = await mint(signer, { sub: "bot-1", role: "bot", scope: ["scene-graph"], ttlS: HOUR_S });
  const noPlay = await new SignJWT({ role: "bot", scope: ["chat"] })
    .setProtectedHeader({ alg: "EdDSA" })
    .setSubject("no-play")
    .setJti(randomUUID())
    .setIssuer("ce-arena")
    .setAudience("ce-arena")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(signer);

  await withEnv({
    ARENA_AUTH: "required",
    ARENA_VERIFY_KEY_FILE: pubFile,
    ARENA_REVOKED_FILE: path.join(dir, "none.json"),
  }, async () => {
    const host = await startArenaServer(0, true);
    const sessions: Array<{ close(): void }> = [];
    try {
      const missing = await assert.rejects(
        () => connectBot({ url: host.url, token: "", name: "missing", openSocket }),
        (err: unknown) => {
          assert.ok(err instanceof BotAuthRejected);
          assert.equal(err.code, 4401);
          return true;
        },
      );
      assert.equal(missing, undefined);
      await assert.rejects(
        () => connectBot({ url: host.url, token: noPlay, name: "no-play", openSocket }),
        (err: unknown) => {
          assert.ok(err instanceof BotAuthRejected);
          assert.equal(err.code, 4403);
          assert.equal(err.reason, "forbidden");
          return true;
        },
      );

      const view = await (await fetch(`${host.url}/arena.json`)).json() as {
        pickups?: Array<{ id: string }>;
        doors: Array<{ id: string }>;
        playerSpawns?: Array<{ id: string; x: number; z: number }>;
      };
      const session = await connectBot({
        url: host.url,
        token: bot.token,
        name: "bot-1",
        role: "bot",
        openSocket,
        onLog: (line) => console.error(line),
      });
      sessions.push(session);
      const self = await until(() => session.world.self(), 5_000, "no owned pawn");
      assert.equal(self.kind, "pawn");
      const pads = view.playerSpawns ?? [];
      assert.equal(pads.length, 3);
      const near = pads.some((pad) => Math.hypot(self.x - pad.x, self.z - pad.z) <= 0.5);
      assert.equal(near, true, `self ${self.x},${self.z} pads ${JSON.stringify(pads)}`);

      assert.ok(Array.isArray(session.world.keys()));
      assert.equal(session.world.role(), "bot");
      assert.ok(session.world.scope()?.includes("play"));
      assert.ok(session.world.scope()?.includes("scene-graph"));
      const pickupIds = (view.pickups ?? []).map((pickup) => pickup.id).sort();
      assert.deepEqual([...session.world.pickups()].sort(), pickupIds);
      const doorIds = view.doors.map((door) => door.id).sort();
      assert.deepEqual(session.world.doors().map((door) => door.id).sort(), doorIds);
      for (const id of doorIds) assert.ok(session.world.door(id), id);

      const graph = await until(() => session.world.sceneGraph(), 5_000, "no scene graph");
      assert.ok(graph.places.length > 1);
      assert.match(session.world.sceneGraphHash() ?? "", /^[0-9a-f]{64}$/);
      const place = session.world.placeOf(self);
      assert.ok(place, "placeOf");
      assert.equal(typeof place.id, "string");

      const z0 = session.world.self()?.z ?? self.z;
      const started = Date.now();
      while (Date.now() - started < 1_100) {
        session.input.sendInput({ moveX: 0, moveZ: 1, yaw: 0, buttons: 0 });
        await delay(60);
      }
      const moved = await until(() => {
        const pawn = session.world.self();
        if (!pawn || pawn.z - z0 < 3) return undefined;
        return pawn;
      }, 2_000, `moved ${(session.world.self()?.z ?? z0) - z0} m`);
      assert.ok(moved.z - z0 >= 3);

      const second = await connectBot({ url: host.url, token: bot.token, name: "bot-2", openSocket });
      const third = await connectBot({ url: host.url, token: bot.token, name: "bot-3", openSocket });
      sessions.push(second, third);
      await until(() => second.world.self(), 5_000, "second pawn");
      await until(() => third.world.self(), 5_000, "third pawn");
      await assert.rejects(
        () => connectBot({ url: host.url, token: bot.token, name: "bot-4", openSocket }),
        (err: unknown) => {
          assert.ok(err instanceof BotRejected);
          assert.equal(err.code, "SERVER_FULL");
          return true;
        },
      );
    } finally {
      for (const session of sessions) session.close();
      await host.close();
    }
  });
  rmSync(dir, { recursive: true, force: true });
});
