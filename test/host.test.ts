import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { decodeFrame, encodeFrame } from "conveyor-engine-transport-ws";
import { arenaStaticWorld } from "../dist/arena-assets.js";
import { createHostSocketPaths, hostSnapPath, type HostSnapFrame } from "../dist/server/host-path.js";
import { startArenaServer } from "../dist/server/main.js";

const require = createRequire(import.meta.url);

function walkImports(entry: string, seen = new Set<string>()): Set<string> {
  if (seen.has(entry)) return seen;
  seen.add(entry);
  let src: string;
  try {
    src = readFileSync(entry, "utf8");
  } catch {
    return seen;
  }
  const specs = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]!);
  for (const spec of specs) {
    if (spec.startsWith("node:")) continue;
    if (spec === "conveyor-graph-simulator" || spec.startsWith("conveyor-graph-simulator/")) {
      throw new Error(`production graph imports ${spec} via ${entry}`);
    }
    let resolved: string;
    try {
      resolved = spec.startsWith(".") ? join(dirname(entry), spec) : require.resolve(spec, { paths: [dirname(entry)] });
    } catch {
      continue;
    }
    walkImports(resolved, seen);
  }
  return seen;
}

test("production dependencies keep the simulator off the runtime graph", () => {
  const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  assert.equal(Object.hasOwn(pkg.dependencies, "conveyor-graph-simulator"), false);
  assert.equal(typeof pkg.devDependencies["conveyor-graph-simulator"], "string");
});

test("server sources do not name NetworkScheduler", () => {
  const dir = fileURLToPath(new URL("../src/server/", import.meta.url));
  const names = readdirSync(dir).filter((name) => name.endsWith(".ts"));
  assert.ok(names.includes("host-path.ts"));
  for (const name of names) {
    const text = readFileSync(join(dir, name), "utf8");
    assert.equal(text.includes("NetworkScheduler"), false, name);
  }
});

test("host DirectNetPath delivers a snap frame in the same turn", async () => {
  const seen: HostSnapFrame[] = [];
  let sinkCalls = 0;
  const path = hostSnapPath((clientId, envelope) => {
    sinkCalls += 1;
    seen.push({ type: "snap", clientId, envelope });
  });
  const frame: HostSnapFrame = {
    type: "snap",
    clientId: 1,
    envelope: {
      kind: "full",
      seq: 4,
      tick: 2n,
      baseline: 0,
      lastProcessedInput: 0,
      worldVersion: "example-v1",
      protocol: 1,
      spawns: [],
      updates: [],
      despawns: [],
    },
  };
  const pending = path.send(frame, { to: "client:1", kind: "snap" });
  assert.equal(sinkCalls, 1);
  assert.equal(seen[0]!.envelope, frame.envelope);
  assert.deepEqual(seen[0], frame);
  assert.deepEqual(await pending, { ok: true, seq: 1 });

  const wires: string[] = [];
  const inbound: unknown[] = [];
  let wireCalls = 0;
  const socket = createHostSocketPaths({
    writeWire(text) {
      wireCalls += 1;
      wires.push(text);
    },
    onEngineText(text) {
      inbound.push(decodeFrame(text));
    },
  });
  const snap = { v: 1, type: "snapshot", envelope: { kind: "full", seq: 3, tick: 1n } };
  socket.sendEncoded(encodeFrame(snap));
  assert.equal(wireCalls, 1);
  const written = decodeFrame(wires[0]!) as { type: string; envelope: { kind: string; seq: number } };
  assert.equal(written.type, "snapshot");
  assert.equal(written.envelope.kind, "full");
  assert.equal(written.envelope.seq, 3);

  for (const type of ["welcome", "error"] as const) {
    const before = wireCalls;
    socket.sendEncoded(encodeFrame({ v: 1, type, reason: "x" }));
    assert.equal(wireCalls, before + 1);
    assert.equal((decodeFrame(wires.at(-1)!) as { type: string }).type, type);
  }
  for (const type of ["input", "ack", "resync"] as const) {
    const before = inbound.length;
    socket.deliverEncoded(encodeFrame({ v: 1, type, seq: 1, snapshotSeq: 1 }));
    assert.equal(inbound.length, before + 1);
    assert.equal((inbound.at(-1) as { type: string }).type, type);
  }
  socket.close();
});

test("production server graph does not import the simulator", () => {
  const entry = require.resolve("../dist/server/main.js");
  const files = walkImports(entry);
  assert.ok(files.size > 3);
  for (const file of files) assert.equal(file.includes("conveyor-graph-simulator"), false);
});

test("host serves the bundle and refuses package paths", async () => {
  const host = await startArenaServer(0);
  try {
    const page = await fetch(host.url + "/");
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /client\.js/);
    assert.equal(html.includes("/pkg/"), false);
    assert.equal(html.includes("viewer.mjs"), false);
    assert.equal(html.includes("node_modules"), false);
    const script = await fetch(host.url + "/client.js");
    assert.equal(script.status, 200);
    assert.match(script.headers.get("content-type") ?? "", /javascript/);
    const arena = await fetch(host.url + "/arena.json");
    assert.equal(arena.status, 200);
    const view = await arena.json() as { bundleId: string; authoritativeHash: string; presentationHash: string; walls: unknown[] };
    const expected = arenaStaticWorld();
    assert.equal(view.bundleId, expected.definition.bundleId);
    assert.equal(view.authoritativeHash, expected.hash);
    assert.equal(view.walls.length, 0);
    assert.match(view.presentationHash, /^sha256:/);
    for (const path of ["/pkg/three/index.js", "/node_modules/three/package.json", "/viewer/viewer.mjs", "/src/server/main.ts", "/client.js.map"]) {
      const denied = await fetch(host.url + path);
      assert.equal(denied.status, 404, path);
    }

    const hello = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const ws = new WebSocket(host.url.replace(/^http/, "ws"));
      const timer = setTimeout(() => reject(new Error("no welcome")), 2000);
      ws.addEventListener("message", (ev) => {
        const msg = JSON.parse(String(ev.data)) as Record<string, unknown>;
        if (msg.type === "welcome" || msg.type === "reject") {
          clearTimeout(timer);
          ws.close();
          resolve(msg);
        }
      });
      ws.addEventListener("open", () => {
        ws.send(JSON.stringify({
          v: 1,
          type: "hello",
          protocol: 1,
          world: "example-v1",
          bundleId: view.bundleId,
          authoritativeHash: view.authoritativeHash,
        }));
      });
    });
    assert.equal(hello.type, "welcome");

    const clients = await Promise.all([0, 1].map(() => openUntilSnapshot(host.url, view.bundleId, view.authoritativeHash)));
    assert.equal(clients[0]!.type, "snapshot");
    assert.equal(clients[1]!.type, "snapshot");
    assert.notEqual(clients[0]!.clientId, clients[1]!.clientId);
  } finally {
    await host.close();
  }
});

function openUntilSnapshot(url: string, bundleId: string, authoritativeHash: string): Promise<{ type: string; clientId?: number }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url.replace(/^http/, "ws"));
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("no snapshot"));
    }, 3000);
    let clientId: number | undefined;
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data)) as { type?: string; clientId?: number; envelope?: { kind?: string; spawns?: unknown[] } };
      if (msg.type === "welcome") clientId = msg.clientId;
      if (msg.type === "snapshot" && msg.envelope && (msg.envelope.spawns?.length || msg.envelope.kind)) {
        clearTimeout(timer);
        ws.close();
        resolve({ type: "snapshot", clientId });
      }
      if (msg.type === "reject") {
        clearTimeout(timer);
        ws.close();
        reject(new Error("rejected"));
      }
    });
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({
        v: 1, type: "hello", protocol: 1, world: "example-v1", bundleId, authoritativeHash,
      }));
    });
  });
}
