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

const PNG_A = "data:image/png;base64,QQ==";
const PNG_B = "data:image/png;base64,Qg==";

function claims(scope: readonly string[]) {
  return { sub: "qa-snapshot", role: "qa", scope, jti: "jti", iat: 1, exp: 2_000_000_000 };
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

type Host = ReturnType<typeof createArenaHost>;
type Loaded = ReturnType<typeof loadArena>;

function attach(host: Host, loaded: Loaded, scope: readonly string[] | undefined, spectate = false) {
  const pair = memoryPair();
  const messages: string[] = [];
  pair.client.onMessage((text) => messages.push(text));
  host.attach(asConn(pair.server, scope));
  let ws: EngineWsClient | undefined;
  if (spectate) {
    pair.client.send(JSON.stringify({
      v: 1,
      type: "hello",
      protocol: 1,
      world: loaded.view.world,
      bundleId: loaded.view.bundleId,
      authoritativeHash: loaded.view.authoritativeHash,
      spectate: true,
    }));
  } else {
    ws = new EngineWsClient(pair.client, {
      compatibility: { protocol: 1, world: loaded.view.world },
      bundleId: loaded.view.bundleId,
      authoritativeHash: loaded.view.authoritativeHash,
      onWelcome() {},
    });
    ws.hello();
  }
  return {
    messages,
    send(text: string) {
      pair.client.send(text);
    },
    close() {
      if (ws) ws.close();
      else pair.client.close();
    },
  };
}

type Client = ReturnType<typeof attach>;

function parsed(messages: readonly string[], from = 0): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const text of messages.slice(from)) {
    try {
      out.push(JSON.parse(text) as Record<string, unknown>);
    } catch {
      continue;
    }
  }
  return out;
}

function ofType(messages: readonly string[], t: string, from = 0): Record<string, unknown>[] {
  return parsed(messages, from).filter((frame) => frame.t === t);
}

function welcome(messages: readonly string[]): Record<string, unknown> | undefined {
  return parsed(messages).find((frame) => frame.type === "welcome");
}

async function waitFor(ready: () => boolean, ms = 1500): Promise<boolean> {
  const start = Date.now();
  while (!ready()) {
    if (Date.now() - start > ms) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return true;
}

function boot() {
  const loaded = loadArena();
  const host = createArenaHost(loaded, { holdNpcs: true });
  return { loaded, host };
}

test("a qa client receives the first browser PNG of the current view", { timeout: 60_000 }, () => {
  const { loaded, host } = boot();
  const asker = attach(host, loaded, ["play", "qa"]);
  const browser = attach(host, loaded, ["play"], true);
  const watcher = attach(host, loaded, ["qa"], true);
  try {
    assert.equal(typeof welcome(asker.messages)?.ownedEntityId, "number");
    assert.equal(welcome(browser.messages)?.type, "welcome");
    assert.equal(welcome(browser.messages)?.ownedEntityId, undefined);
    assert.equal(welcome(watcher.messages)?.ownedEntityId, undefined);

    const askFrom = asker.messages.length;
    const seeFrom = browser.messages.length;
    asker.send(JSON.stringify({ t: "qaSnapshot" }));
    const captures = ofType(browser.messages, "qaCapture", seeFrom);
    assert.equal(captures.length, 1);
    const capture = captures[0];
    assert.equal(capture?.t, "qaCapture");
    assert.equal(typeof capture?.id, "string");
    assert.ok((capture?.id as string).length > 0);
    assert.equal(capture?.lookFrom, undefined);
    assert.equal(capture?.follow, undefined);
    assert.equal(ofType(asker.messages, "qaCapture", askFrom).length, 0, "requester was asked to capture");
    assert.equal(ofType(watcher.messages, "qaCapture").length, 1);

    browser.send(JSON.stringify({ t: "qaSnapshotData", id: capture?.id, png: PNG_A }));
    const results = ofType(asker.messages, "snapshotResult", askFrom);
    assert.deepEqual(results, [{ t: "snapshotResult", ok: true, id: capture?.id, png: PNG_A }]);

    const namedFrom = asker.messages.length;
    const namedSee = browser.messages.length;
    asker.send(JSON.stringify({ t: "qaSnapshot", id: "pic-1" }));
    assert.deepEqual(ofType(browser.messages, "qaCapture", namedSee), [{ t: "qaCapture", id: "pic-1" }]);
    browser.send(JSON.stringify({ t: "qaSnapshotData", id: "pic-1", png: PNG_B }));
    assert.deepEqual(ofType(asker.messages, "snapshotResult", namedFrom), [
      { t: "snapshotResult", ok: true, id: "pic-1", png: PNG_B },
    ]);

    const specFrom = watcher.messages.length;
    const specSee = browser.messages.length;
    watcher.send(JSON.stringify({ t: "qaSnapshot", id: "spec" }));
    assert.deepEqual(ofType(browser.messages, "qaCapture", specSee), [{ t: "qaCapture", id: "spec" }]);
    browser.send(JSON.stringify({ t: "qaSnapshotData", id: "spec", png: PNG_A }));
    assert.deepEqual(ofType(watcher.messages, "snapshotResult", specFrom), [
      { t: "snapshotResult", ok: true, id: "spec", png: PNG_A },
    ]);
    assert.equal(typeof welcome(watcher.messages)?.ownedEntityId, "undefined");
  } finally {
    asker.close();
    browser.close();
    watcher.close();
    host.stop();
  }
});

test("no connected browser returns noRenderer just after 3s", { timeout: 60_000 }, async () => {
  const { loaded, host } = boot();
  const asker = attach(host, loaded, ["qa"], true);
  try {
    assert.equal(welcome(asker.messages)?.type, "welcome");
    const from = asker.messages.length;
    const start = Date.now();
    asker.send(JSON.stringify({ t: "qaSnapshot", id: "alone" }));
    assert.equal(ofType(asker.messages, "snapshotResult", from).length, 0);
    const arrived = await waitFor(() => ofType(asker.messages, "snapshotResult", from).length > 0, 5_000);
    const elapsed = Date.now() - start;
    assert.equal(arrived, true, "noRenderer did not arrive");
    assert.ok(elapsed >= 2_900, `noRenderer arrived too soon (${elapsed}ms)`);
    assert.deepEqual(ofType(asker.messages, "snapshotResult", from), [
      { t: "snapshotResult", ok: false, id: "alone", reason: "noRenderer" },
    ]);
  } finally {
    asker.close();
    host.stop();
  }
});

test("a second qaSnapshot while one is in flight is busy", { timeout: 60_000 }, async () => {
  const { loaded, host } = boot();
  const asker = attach(host, loaded, ["play", "qa"]);
  const browser = attach(host, loaded, ["play"], true);
  try {
    const from = asker.messages.length;
    const seeFrom = browser.messages.length;
    asker.send(JSON.stringify({ t: "qaSnapshot", id: "one" }));
    asker.send(JSON.stringify({ t: "qaSnapshot", id: "two" }));
    assert.deepEqual(ofType(asker.messages, "snapshotResult", from), [
      { t: "snapshotResult", ok: false, id: "two", reason: "busy" },
    ]);
    assert.deepEqual(ofType(browser.messages, "qaCapture", seeFrom), [{ t: "qaCapture", id: "one" }]);
    browser.send(JSON.stringify({ t: "qaSnapshotData", id: "one", png: PNG_A }));
    assert.deepEqual(ofType(asker.messages, "snapshotResult", from), [
      { t: "snapshotResult", ok: false, id: "two", reason: "busy" },
      { t: "snapshotResult", ok: true, id: "one", png: PNG_A },
    ]);
    asker.send(JSON.stringify({ t: "qaSnapshot", id: "three" }));
    browser.send(JSON.stringify({ t: "qaSnapshotData", id: "three", png: PNG_B }));
    const third = ofType(asker.messages, "snapshotResult", from).find((frame) => frame.id === "three");
    assert.deepEqual(third, { t: "snapshotResult", ok: true, id: "three", png: PNG_B });
  } finally {
    asker.close();
    browser.close();
    host.stop();
  }
});

test("a malformed qaSnapshot is invalid and is not broadcast", { timeout: 60_000 }, () => {
  const { loaded, host } = boot();
  const asker = attach(host, loaded, ["qa"], true);
  const browser = attach(host, loaded, ["play"], true);
  try {
    const cases: unknown[] = [
      { t: "qaSnapshot", lookFrom: { eye: { x: 1 } } },
      { t: "qaSnapshot", id: "", lookFrom: { eye: { x: 0, y: 1, z: 2 }, target: { x: 0, y: 1, z: 3 } } },
      { t: "qaSnapshot", id: "x".repeat(65) },
      { t: "qaSnapshot", follow: { entityId: 1.5 } },
      { t: "qaSnapshot", waitFrames: 1.5 },
      { t: "qaSnapshot", lookFrom: { eye: { x: 0, y: 0, z: 0 }, target: { x: 1, y: 1, z: Number.POSITIVE_INFINITY } } },
    ];
    for (const frame of cases) {
      const askFrom = asker.messages.length;
      const seeFrom = browser.messages.length;
      asker.send(JSON.stringify(frame));
      const results = ofType(asker.messages, "snapshotResult", askFrom);
      assert.equal(results.length, 1, JSON.stringify(frame));
      assert.equal(results[0]?.ok, false);
      assert.equal(results[0]?.reason, "invalid");
      assert.equal(typeof results[0]?.id, "string");
      assert.ok((results[0]?.id as string).length > 0 && (results[0]?.id as string).length <= 64);
      assert.equal(ofType(browser.messages, "qaCapture", seeFrom).length, 0, JSON.stringify(frame));
    }

    const from = asker.messages.length;
    const seeFrom = browser.messages.length;
    asker.send(JSON.stringify({ t: "qaSnapshot", id: "after-bad", follow: { entityId: 4 }, waitFrames: 40 }));
    assert.deepEqual(ofType(browser.messages, "qaCapture", seeFrom), [{
      t: "qaCapture",
      id: "after-bad",
      follow: { entityId: 4, back: 3, up: 1.6 },
      waitFrames: 30,
    }]);
    browser.send(JSON.stringify({ t: "qaSnapshotData", id: "after-bad", png: PNG_A }));
    assert.deepEqual(ofType(asker.messages, "snapshotResult", from), [
      { t: "snapshotResult", ok: true, id: "after-bad", png: PNG_A },
    ]);
  } finally {
    asker.close();
    browser.close();
    host.stop();
  }
});

test("an aimed shot is ignored by a current-view capturer", { timeout: 60_000 }, async () => {
  const { loaded, host } = boot();
  const asker = attach(host, loaded, ["qa"], true);
  const browser = attach(host, loaded, ["play"], true);
  try {
    const from = asker.messages.length;
    const seeFrom = browser.messages.length;
    const start = Date.now();
    asker.send(JSON.stringify({
      t: "qaSnapshot",
      id: "aim",
      lookFrom: { eye: { x: 1, y: 2, z: 3 }, target: { x: 4, y: 5, z: 6 } },
    }));
    const captures = ofType(browser.messages, "qaCapture", seeFrom);
    assert.deepEqual(captures, [{
      t: "qaCapture",
      id: "aim",
      lookFrom: { eye: { x: 1, y: 2, z: 3 }, target: { x: 4, y: 5, z: 6 }, fovDeg: 55 },
    }]);
    let answered = 0;
    for (const frame of captures) {
      if (frame.lookFrom !== undefined || frame.follow !== undefined) continue;
      browser.send(JSON.stringify({ t: "qaSnapshotData", id: frame.id, png: PNG_A }));
      answered += 1;
    }
    assert.equal(answered, 0);
    const arrived = await waitFor(() => ofType(asker.messages, "snapshotResult", from).length > 0, 5_000);
    assert.equal(arrived, true);
    assert.ok(Date.now() - start >= 2_900);
    assert.deepEqual(ofType(asker.messages, "snapshotResult", from), [
      { t: "snapshotResult", ok: false, id: "aim", reason: "noRenderer" },
    ]);
  } finally {
    asker.close();
    browser.close();
    host.stop();
  }
});

test("a client without the qa scope is ignored", { timeout: 60_000 }, async () => {
  const { loaded, host } = boot();
  const seated = attach(host, loaded, ["play"]);
  const spectator = attach(host, loaded, undefined, true);
  const browser = attach(host, loaded, ["play"], true);
  try {
    assert.equal(typeof welcome(seated.messages)?.ownedEntityId, "number");
    assert.equal(welcome(spectator.messages)?.ownedEntityId, undefined);
    const seatFrom = seated.messages.length;
    const specFrom = spectator.messages.length;
    const seeFrom = browser.messages.length;
    seated.send(JSON.stringify({ t: "qaSnapshot", id: "nope" }));
    spectator.send(JSON.stringify({ t: "qaSnapshot" }));
    const quiet = await waitFor(() => false, 3_200);
    assert.equal(quiet, false);
    assert.equal(ofType(seated.messages, "snapshotResult", seatFrom).length, 0);
    assert.equal(ofType(spectator.messages, "snapshotResult", specFrom).length, 0);
    assert.equal(ofType(browser.messages, "qaCapture", seeFrom).length, 0);
  } finally {
    seated.close();
    spectator.close();
    browser.close();
    host.stop();
  }
});

test("a bad or late PNG does not replace the first valid one", { timeout: 60_000 }, () => {
  const { loaded, host } = boot();
  const asker = attach(host, loaded, ["qa"], true);
  const first = attach(host, loaded, ["play"], true);
  const second = attach(host, loaded, ["play"], true);
  try {
    const from = asker.messages.length;
    asker.send(JSON.stringify({ t: "qaSnapshot", id: "race" }));
    assert.equal(ofType(first.messages, "qaCapture").some((frame) => frame.id === "race"), true);
    assert.equal(ofType(second.messages, "qaCapture").some((frame) => frame.id === "race"), true);

    first.send(JSON.stringify({ t: "qaSnapshotData", id: "race", png: "data:image/jpeg;base64,QQ==" }));
    first.send(JSON.stringify({ t: "qaSnapshotData", id: "race", png: "nope" }));
    const prefix = "data:image/png;base64,";
    const oversize = prefix + "A".repeat(4_000_000 - prefix.length + 1);
    assert.ok(oversize.length > 4_000_000);
    second.send(JSON.stringify({ t: "qaSnapshotData", id: "race", png: oversize }));
    assert.equal(ofType(asker.messages, "snapshotResult", from).length, 0);

    first.send(JSON.stringify({ t: "qaSnapshotData", id: "race", png: PNG_A }));
    second.send(JSON.stringify({ t: "qaSnapshotData", id: "race", png: PNG_B }));
    assert.deepEqual(ofType(asker.messages, "snapshotResult", from), [
      { t: "snapshotResult", ok: true, id: "race", png: PNG_A },
    ]);
    assert.equal(ofType(second.messages, "snapshotResult").length, 0);
  } finally {
    asker.close();
    first.close();
    second.close();
    host.stop();
  }
});
