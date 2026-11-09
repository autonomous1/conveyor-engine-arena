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
const { loadArena } = await import("../src/server/world-loader.ts");

const { parseSpawn } = await import("../src/shared/spawn-frame.ts");

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


function join(host: ReturnType<typeof createArenaHost>, loaded: ReturnType<typeof loadArena>) {
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
  const spawns = () => messages.flatMap((text) => {
    const frame = parseSpawn(JSON.parse(text));
    return frame ? [frame] : [];
  });
  return { ws, pair, spawns, owned: () => owned };
}

test("a join sends one spawn frame to everyone at the pawn's pad; welcome and a late joiner replay nothing", () => {
  const loaded = loadArena();
  const host = createArenaHost(loaded, { holdNpcs: true });
  try {
    const first = join(host, loaded);
    assert.ok(first.owned() > 0);
    const own = first.spawns();
    assert.equal(own.length, 1, "the joiner is told once, for its own pawn");
    assert.equal(own[0]!.id, first.owned());
    const pawn = loaded.world.store.view(first.owned())!.position;
    assert.ok(Math.hypot(own[0]!.x - pawn.x, own[0]!.z - pawn.z) < 1e-6, "at the pad it was placed on");
    assert.ok(Math.abs(own[0]!.y - pawn.y) < 1e-6);

    const second = join(host, loaded);
    assert.notEqual(second.owned(), first.owned());
    assert.deepEqual(first.spawns().map((frame) => frame.id), [first.owned(), second.owned()], "the earlier client sees the newcomer beam in");
    assert.deepEqual(second.spawns().map((frame) => frame.id), [second.owned()], "the newcomer is not told about the character that was already there");
  } finally {
    host.stop();
  }
});
