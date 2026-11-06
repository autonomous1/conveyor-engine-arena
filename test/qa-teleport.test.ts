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

const { createArenaHost } = await import("../src/server/arena-host.ts");
const { teleportBlockReason } = await import("../src/server/game.ts");
const { loadArena } = await import("../src/server/world-loader.ts");
const { doorLeafBox } = await import("../src/shared/doors.ts");

const DOOR_ID = "brutalist-building-3-bake.door-1-1-9-22";

function claims(scope: readonly string[]) {
  return { sub: "qa-teleport", role: "qa", scope, jti: "jti", iat: 1, exp: 2_000_000_000 };
}

function asConn(sock: TransportSocket, scope: readonly string[] | undefined) {
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
    ...(scope ? { claims: claims(scope) } : {}),
  };
}

function attach(
  host: ReturnType<typeof createArenaHost>,
  loaded: ReturnType<typeof loadArena>,
  scope: readonly string[] | undefined,
) {
  const pair = memoryPair();
  const messages: string[] = [];
  pair.client.onMessage((text) => messages.push(text));
  host.attach(asConn(pair.server, scope));
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
    send(text: string) {
      pair.client.send(text);
    },
    close() {
      ws.close();
    },
  };
}

function parsed(messages: readonly string[]): Record<string, unknown>[] {
  return messages.map((text) => JSON.parse(text) as Record<string, unknown>);
}

async function waitFor(ready: () => boolean, ms = 1500): Promise<boolean> {
  const start = Date.now();
  while (!ready()) {
    if (Date.now() - start > ms) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return true;
}

type Pos = { x: number; y: number; z: number };

function dist(a: Pos, b: Pos): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function snapshotPosition(messages: readonly string[], id: number, from: number): Pos | undefined {
  let found: Pos | undefined;
  for (const text of messages.slice(from)) {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(text) as Record<string, unknown>;
    } catch {
      continue;
    }
    const envelope = frame.envelope;
    if (!envelope || typeof envelope !== "object") continue;
    const env = envelope as { spawns?: unknown[]; updates?: unknown[] };
    for (const list of [env.spawns, env.updates]) {
      if (!Array.isArray(list)) continue;
      for (const row of list) {
        if (!row || typeof row !== "object") continue;
        const rec = row as { entity?: unknown; view?: { position?: Pos } };
        const pos = rec.view?.position;
        if (rec.entity !== id || !pos) continue;
        if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) continue;
        found = { x: pos.x, y: pos.y, z: pos.z };
      }
    }
  }
  return found;
}

function storePosition(loaded: ReturnType<typeof loadArena>, id: number): Pos {
  const pos = loaded.world.store.view(id)?.position;
  assert.ok(pos);
  return { x: pos.x, y: pos.y, z: pos.z };
}

test("a teleport scope moves only onto a free landing", { timeout: 60_000 }, async () => {
  const loaded = loadArena();
  const host = createArenaHost(loaded, { holdNpcs: true });
  const client = attach(host, loaded, ["play", "qa", "teleport"]);
  try {
    const id = client.owned();
    assert.ok(id > 0);
    const view = loaded.world.store.view(id);
    assert.ok(view);
    const radius = view.radius > 0 ? view.radius : 0.5;
    const height = Number.isFinite(loaded.world.pawnHeight) ? loaded.world.pawnHeight : 1.8;
    const here = storePosition(loaded, id);
    const bodies = loaded.world.query().filter((entity) => entity.radius > 0 && entity.id !== id);
    const clearOfPawns = (x: number, z: number) => bodies.every((pawn) => {
      const dx = pawn.position.x - x;
      const dz = pawn.position.z - z;
      const reach = radius + (pawn.radius > 0 ? pawn.radius : 0.5);
      return dx * dx + dz * dz > reach * reach;
    });
    // The other seated pawns already stand on the listed pads. Step away from
    // this pawn's pad until the capsule is free of boxes and of those bodies.
    let pad: { x: number; y: number; z: number; yaw: number } | undefined;
    for (let step = 2; step <= 12 && !pad; step += 1) {
      for (const sign of [1, -1]) {
        const candidate = { x: here.x, y: here.y, z: here.z + sign * step, yaw: 0.4 };
        if (teleportBlockReason(loaded.world, loaded.view.bounds, id, candidate.x, candidate.y, candidate.z)) continue;
        if (!clearOfPawns(candidate.x, candidate.z)) continue;
        pad = candidate;
        break;
      }
    }
    assert.ok(pad, "free landing near the spawn pad");

    const mark = client.messages.length;
    client.send(JSON.stringify({ t: "teleport", x: pad.x, y: pad.y, z: pad.z, yaw: pad.yaw }));
    const replied = await waitFor(() => parsed(client.messages.slice(mark)).some((frame) => frame.t === "teleportResult"));
    assert.equal(replied, true);
    const result = parsed(client.messages.slice(mark)).find((frame) => frame.t === "teleportResult");
    assert.deepEqual(result, { t: "teleportResult", ok: true });
    const saw = await waitFor(() => {
      const pos = snapshotPosition(client.messages, id, mark);
      return pos !== undefined && dist(pos, pad) < 0.05;
    });
    const landed = snapshotPosition(client.messages, id, mark);
    assert.equal(saw, true, `snapshot ${JSON.stringify(landed)} wanted ${pad.x},${pad.y},${pad.z}`);

    const stay = storePosition(loaded, id);

    const wall = loaded.world.listObstacles().find((box) => {
      if (typeof box.minY !== "number" || typeof box.maxY !== "number") return false;
      if (box.minY < -100) return false;
      if (box.maxY - box.minY < height) return false;
      if (box.maxX - box.minX < 1 || box.maxZ - box.minZ < 1) return false;
      const x = (box.minX + box.maxX) / 2;
      const z = (box.minZ + box.maxZ) / 2;
      const y = box.minY;
      const bounds = loaded.view.bounds;
      if (x - radius < bounds.minX || x + radius > bounds.maxX) return false;
      if (z - radius < bounds.minZ || z + radius > bounds.maxZ) return false;
      if (y < bounds.minY || y + height > bounds.maxY) return false;
      return true;
    });
    assert.ok(wall && typeof wall.minY === "number");
    const blockedAt = {
      x: (wall.minX + wall.maxX) / 2,
      y: wall.minY,
      z: (wall.minZ + wall.maxZ) / 2,
    };
    const wallMark = client.messages.length;
    client.send(JSON.stringify({ t: "teleport", ...blockedAt, yaw: 0 }));
    const wallReply = await waitFor(() => parsed(client.messages.slice(wallMark)).some((frame) => frame.t === "teleportResult"));
    assert.equal(wallReply, true);
    assert.deepEqual(parsed(client.messages.slice(wallMark)).find((frame) => frame.t === "teleportResult"), {
      t: "teleportResult",
      ok: false,
      reason: "blocked",
    });
    assert.ok(dist(storePosition(loaded, id), stay) < 0.05);

    const door = loaded.view.doors.find((item) => item.id === DOOR_ID);
    assert.ok(door);
    assert.equal(door.locked, true);
    assert.equal(door.open, false);
    const leaf = doorLeafBox(door);
    const leafAt = {
      x: (leaf.minX + leaf.maxX) / 2,
      y: leaf.minY,
      z: (leaf.minZ + leaf.maxZ) / 2,
    };
    const beforeLeaf = storePosition(loaded, id);
    const leafMark = client.messages.length;
    client.send(JSON.stringify({ t: "teleport", ...leafAt, yaw: 0 }));
    const leafReply = await waitFor(() => parsed(client.messages.slice(leafMark)).some((frame) => frame.t === "teleportResult"));
    assert.equal(leafReply, true);
    assert.deepEqual(parsed(client.messages.slice(leafMark)).find((frame) => frame.t === "teleportResult"), {
      t: "teleportResult",
      ok: false,
      reason: "blocked",
    });
    assert.ok(dist(storePosition(loaded, id), beforeLeaf) < 0.05);

    const outside = { x: loaded.view.bounds.minX - 5, y: 0, z: 0, yaw: 0 };
    const beforeBounds = storePosition(loaded, id);
    const boundsMark = client.messages.length;
    client.send(JSON.stringify({ t: "teleport", ...outside }));
    const boundsReply = await waitFor(() => parsed(client.messages.slice(boundsMark)).some((frame) => frame.t === "teleportResult"));
    assert.equal(boundsReply, true);
    assert.deepEqual(parsed(client.messages.slice(boundsMark)).find((frame) => frame.t === "teleportResult"), {
      t: "teleportResult",
      ok: false,
      reason: "bounds",
    });
    assert.ok(dist(storePosition(loaded, id), beforeBounds) < 0.05);
  } finally {
    client.close();
    host.stop();
  }
});

test("a seated token without teleport is ignored", { timeout: 60_000 }, async () => {
  const loaded = loadArena();
  const host = createArenaHost(loaded, { holdNpcs: true });
  const client = attach(host, loaded, ["play", "qa"]);
  try {
    const id = client.owned();
    assert.ok(id > 0);
    const before = storePosition(loaded, id);
    const pad = loaded.playerSpawns.find((spawn) => dist(spawn, before) > 1) ?? loaded.playerSpawns[0];
    assert.ok(pad);
    const mark = client.messages.length;
    client.send(JSON.stringify({ t: "teleport", x: pad.x, y: pad.y, z: pad.z, yaw: pad.yaw }));
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(parsed(client.messages.slice(mark)).some((frame) => frame.t === "teleportResult"), false);
    assert.ok(dist(storePosition(loaded, id), before) < 0.05, "pawn moved without teleport scope");
  } finally {
    client.close();
    host.stop();
  }
});
