import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { arenaStaticWorld } from "../dist/arena-assets.js";
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
    assert.equal(view.walls.length, 4);
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
