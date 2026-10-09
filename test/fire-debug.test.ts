import assert from "node:assert/strict";
import test from "node:test";
import {
  FIRE_DEBUG_STORAGE_KEY,
  createOptionsModel,
  loadFireDebug,
  type KeyValueStorage,
} from "../src/client/options.ts";
import { createArenaFire } from "../dist/server/fire.js";
import {
  clientFaultText,
  createFireDebugLog,
  fireShotFrame,
  summarizeInbound,
  type FireDebugSink,
} from "../src/shared/fire-debug.ts";
import { fireFrame, parseFire } from "../src/shared/hitscan.ts";

function memory(initial?: string): KeyValueStorage & { getItem(key: string): string | null } {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set(FIRE_DEBUG_STORAGE_KEY, initial);
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

function captureConsole() {
  const logs: string[] = [];
  const errors: string[] = [];
  const prevLog = console.log;
  const prevErr = console.error;
  const join = (line: unknown, rest: unknown[]) => [line, ...rest].map((part) => String(part)).join(" ");
  console.log = (line?: unknown, ...rest: unknown[]) => {
    logs.push(join(line, rest));
  };
  console.error = (line?: unknown, ...rest: unknown[]) => {
    errors.push(join(line, rest));
  };
  return {
    logs,
    errors,
    restore() {
      console.log = prevLog;
      console.error = prevErr;
    },
  };
}

function sinkOf(lines: string[]): FireDebugSink {
  return {
    log(line) {
      lines.push(line);
    },
    error(line) {
      lines.push(line);
    },
  };
}

function fakeHost(listObstacles: () => unknown[] = () => []) {
  const pos = { x: 1, y: 0, z: 2 };
  const destroyed: number[] = [];
  const store = {
    view(id: number) {
      return { id, position: { ...pos }, lifecycle: "alive" as const };
    },
    setTransform(_id: number, p: { x: number; y: number; z: number }) {
      pos.x = p.x;
      pos.y = p.y;
      pos.z = p.z;
      return true;
    },
    setHealth(_id: number, _health: number) {
      return true;
    },
    destroy(id: number) {
      destroyed.push(id);
      return true;
    },
  };
  const world = {
    store,
    pawnHeight: 1.8,
    listObstacles,
    query: () => [],
  };
  const server = {
    session: () => ({ sessionId: 1 }),
    replicator: {
      get: () => ({ ownedEntity: 3, connected: true, known: new Set<number>() }),
    },
    connected: [1],
  };
  return { world, server, store, destroyed };
}

test("fire debug defaults off and persists only the on value", () => {
  assert.equal(loadFireDebug(null), false);
  assert.equal(loadFireDebug(memory()), false);
  assert.equal(loadFireDebug(memory("off")), false);
  assert.equal(loadFireDebug(memory("true")), false);
  assert.equal(loadFireDebug(memory("on")), true);

  const storage = memory();
  const seen: boolean[] = [];
  const model = createOptionsModel(storage, () => {}, (on) => seen.push(on));
  assert.deepEqual(seen, [false]);
  assert.equal(model.fireDebug, false);
  assert.equal(model.showCollision, false);
  assert.equal(storage.getItem(FIRE_DEBUG_STORAGE_KEY), null);
  model.toggleFireDebug();
  assert.equal(model.fireDebug, true);
  assert.equal(storage.getItem(FIRE_DEBUG_STORAGE_KEY), "on");
  model.toggleShowCollision();
  assert.equal(model.fireDebug, true);
  const restored: boolean[] = [];
  createOptionsModel(storage, () => {}, (on) => restored.push(on));
  assert.deepEqual(restored, [true]);
});

test("one F is quiet when fire debug is off and logs both sides when it is on", () => {
  const plain = fireShotFrame(4, 0.2, -0.1, false);
  assert.deepEqual(plain, fireFrame(4, 0.2, -0.1));
  const flagged = fireShotFrame(4, 0.2, -0.1, true);
  assert.equal(flagged.debug, 1);
  const parsed = parseFire(flagged);
  assert.equal(parsed?.seq, 4);
  assert.equal(parsed?.yaw, 0.2);
  assert.equal(parsed?.pitch, -0.1);
  assert.equal(Object.hasOwn(parsed ?? {}, "debug"), false);
  assert.equal(summarizeInbound({ t: "laser", shooter: 3 }), "laser shooter=3");

  const client: string[] = [];
  const off = createFireDebugLog(() => false, sinkOf(client));
  off.keydown();
  off.frameSent(1, 0.25, -0.5);
  off.frameReceived("laser shooter=3");
  off.camera({ x: 1, y: 2, z: 3 });
  off.pawn(3);
  off.socket("open");
  off.thrown("frame", new Error("hidden"));
  off.thrown("socket", new Error("hidden"));
  assert.deepEqual(client, []);

  const { world, server, store } = fakeHost();
  let now = 0;
  const fire = createArenaFire({
    world: world as never,
    server: server as never,
    now: () => now,
    send() {},
  });
  const cap = captureConsole();
  try {
    fire.onFrame(1, fireShotFrame(1, 0.25, -0.5, false));
    store.setTransform(3, { x: 4, y: 0, z: 5 });
    assert.equal(cap.logs.filter((line) => line.startsWith("fire-debug")).length, 0);
    assert.equal(cap.errors.filter((line) => line.startsWith("fire-debug")).length, 0);
    assert.ok(cap.logs.some((line) => line.startsWith("shot ")));

    const on = createFireDebugLog(() => true, sinkOf(client));
    on.keydown();
    on.frameSent(2, 0.25, -0.5);
    assert.equal(client[0], "fire-debug keydown");
    assert.equal(client[1], "fire-debug frame sent seq=2 yaw=0.25 pitch=-0.5");

    now = 1000;
    fire.onFrame(1, fireShotFrame(2, 0.25, -0.5, true));
    const steps = cap.logs.filter((line) => line.startsWith("fire-debug"));
    assert.ok(steps.some((line) => line.startsWith("fire-debug receive client=1 seq=2")), steps.join(" | "));
    assert.ok(steps.some((line) => line === "fire-debug dedupe accept seq=2"), steps.join(" | "));
    assert.ok(steps.some((line) => line.startsWith("fire-debug trace ")), steps.join(" | "));

    store.setTransform(3, { x: 9, y: 1, z: 8 });
    store.setHealth(3, 0);
    store.destroy(3);
    const writes = cap.logs.filter((line) => line.startsWith("fire-debug write"));
    assert.ok(writes.some((line) => line === "fire-debug write position pawn=3 9.000,1.000,8.000"), writes.join(" | "));
    assert.ok(writes.some((line) => line === "fire-debug write health pawn=3 0"), writes.join(" | "));
    assert.ok(writes.some((line) => line === "fire-debug write life pawn=3 destroyed"), writes.join(" | "));

    const before = cap.logs.filter((line) => line.includes("write position")).length;
    now = 2000;
    fire.onFrame(1, fireShotFrame(3, 0, 0, false));
    store.setTransform(3, { x: 0, y: 0, z: 0 });
    assert.equal(cap.logs.filter((line) => line.includes("write position")).length, before);
    assert.equal(cap.logs.filter((line) => line.startsWith("fire-debug") && line.includes("seq=3")).length, 0);
  } finally {
    cap.restore();
  }
});

test("a thrown fire error is logged with its stack and does not destroy the pawn", () => {
  const rig = fakeHost(() => {
    throw new Error("trace failed");
  });
  const fire = createArenaFire({
    world: rig.world as never,
    server: rig.server as never,
    now: () => 0,
    send() {},
  });
  const cap = captureConsole();
  try {
    assert.throws(() => fire.onFrame(1, fireShotFrame(1, 0, 0, true)), /trace failed/);
    const logged = cap.errors.join("\n");
    assert.match(logged, /fire-debug error fire/);
    assert.match(logged, /trace failed/);
    assert.match(logged, /\bat /);
    assert.deepEqual(rig.destroyed, []);
  } finally {
    cap.restore();
  }

  const lines: string[] = [];
  const client = createFireDebugLog(() => true, sinkOf(lines));
  const frameErr = new Error("frame blew up");
  const socketErr = new Error("socket blew up");
  client.thrown("frame", frameErr);
  client.thrown("socket", socketErr);
  assert.match(lines[0] ?? "", /fire-debug error frame/);
  assert.match(lines[0] ?? "", /frame blew up/);
  assert.match(lines[0] ?? "", /\bat /);
  assert.match(lines[1] ?? "", /fire-debug error socket/);
  assert.match(lines[1] ?? "", /socket blew up/);
  assert.equal(clientFaultText(frameErr), "frame blew up");
  assert.equal(clientFaultText(socketErr), "socket blew up");

  const quiet: string[] = [];
  createFireDebugLog(() => false, sinkOf(quiet)).thrown("frame", frameErr);
  assert.deepEqual(quiet, []);
});
