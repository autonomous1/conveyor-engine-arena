import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { createOptionsDialog, loadModelChoice, MODEL_CHOICE_STORAGE_KEY, saveModelChoice, type KeyValueStorage } from "../src/client/options.ts";
import { createPawnLayer } from "../src/client/presentation.ts";
import { helloModel, modelFrame, parseModelFrame } from "../src/shared/model-choice.ts";
import { applyPawnModel, claimClearSpawn, placePawn } from "../dist/server/game.js";
import { startArenaServer } from "../dist/server/main.js";
import { loadArena } from "../dist/server/world-loader.js";

test("hello and model frames keep only a non-empty character id", () => {
  assert.equal(helloModel(undefined), undefined);
  assert.equal(helloModel({ type: "hello" }), undefined);
  assert.equal(helloModel({ model: "" }), undefined);
  assert.equal(helloModel({ model: "player-1" }), "player-1");
  assert.deepEqual(modelFrame("grok-bot"), { t: "model", v: 1, model: "grok-bot" });
  assert.equal(parseModelFrame({ t: "model", v: 1, model: "player-1" }), "player-1");
  assert.equal(parseModelFrame({ t: "fire", v: 1, model: "player-1" }), undefined);
  assert.equal(parseModelFrame({ t: "model", v: 2, model: "player-1" }), undefined);
  assert.equal(parseModelFrame({ t: "model", v: 1, model: "" }), undefined);
});

test("a saved model choice is kept only when it is still offered", () => {
  const storage: KeyValueStorage = {
    getItem(key) {
      return key === MODEL_CHOICE_STORAGE_KEY ? "player-1" : null;
    },
    setItem() {
      throw new Error("read only");
    },
  };
  assert.equal(loadModelChoice(storage, ["grok-bot", "player-1"]), "player-1");
  assert.equal(loadModelChoice(storage, ["grok-bot"]), "grok-bot");
  assert.equal(loadModelChoice(null, ["grok-bot", "player-1"]), "grok-bot");
  const saved: string[] = [];
  saveModelChoice({
    getItem: () => null,
    setItem(_key, value) {
      saved.push(value);
    },
  }, "player-1");
  assert.deepEqual(saved, ["player-1"]);
  saveModelChoice(null, "grok-bot");
});

test("the options select stores the session choice and reports it", () => {
  const rig = installDom();
  const memory = new Map<string, string>([[MODEL_CHOICE_STORAGE_KEY, "player-1"]]);
  const storage: KeyValueStorage = {
    getItem: (key) => memory.get(key) ?? null,
    setItem: (key, value) => {
      memory.set(key, value);
    },
  };
  const seen: string[] = [];
  try {
    const dialog = createOptionsDialog(() => {}, null, () => {}, {
      modelChoices: ["grok-bot", "player-1"],
      modelStorage: storage,
      onModel: (id) => seen.push(id),
    });
    const select = rig.get("model-choice");
    assert.equal(dialog.modelChoice, "player-1");
    assert.equal(select.value, "player-1");
    select.value = "grok-bot";
    select.dispatch("change");
    assert.equal(dialog.modelChoice, "grok-bot");
    assert.deepEqual(seen, ["grok-bot"]);
    assert.equal(memory.get(MODEL_CHOICE_STORAGE_KEY), "grok-bot");
  } finally {
    rig.restore();
  }
});

test("a changed assetKey replaces the pawn object", () => {
  const parent = new THREE.Group();
  const pawns = createPawnLayer(parent, new Map(), 1.8);
  const body = (assetKey: string) => ({
    frame: 1,
    serverTick: 1n,
    snapshotSeq: 1,
    entities: [{
      id: 7,
      render: { assetKey },
      position: { x: 1, y: 0, z: 2 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 1, y: 1, z: 1 },
      clip: "idle",
      speed: 0,
      visible: true,
      lifecycle: "alive" as const,
      predicted: false,
    }],
  });
  pawns.apply(body("grok-bot"), 0.016, () => undefined);
  const first = parent.children[0];
  assert.ok(first);
  pawns.apply(body("grok-bot"), 0.016, () => undefined);
  assert.equal(parent.children[0], first);
  pawns.apply(body("player-1"), 0.016, () => undefined);
  assert.equal(parent.children.length, 1);
  assert.notEqual(parent.children[0], first);
  const report = (globalThis as { __pawnAnim?: Array<{ id: number; assetKey?: string }> }).__pawnAnim ?? [];
  assert.equal(report.find((row) => row.id === 7)?.assetKey, "player-1");
});

test("player pawns stand on player pads and wander pawns stand on spawn points", () => {
  const loaded = loadArena();
  const players = loaded.agents.filter((agent) => agent.role === "player");
  const npcs = loaded.agents.filter((agent) => agent.role !== "player");
  const spawns = loaded.view.spawns ?? [];
  assert.ok(players.length >= 3);
  assert.equal(players.length, loaded.playerSpawns.length);
  assert.equal(npcs.length, spawns.length);
  const bots = loaded.view.npcModelChoices ?? [];
  assert.ok(bots.length >= 1);
  for (const agent of players) {
    const view = loaded.world.store.view(agent.id);
    assert.ok(view);
    assert.equal(near(view.position.x, view.position.z, loaded.playerSpawns), true, `player ${agent.id}`);
    assert.equal(near(view.position.x, view.position.z, spawns), false, `player ${agent.id} on an npc pad`);
    assert.equal(view.render?.assetKey, loaded.view.modelChoices[0]);
  }
  for (const agent of npcs) {
    const view = loaded.world.store.view(agent.id);
    assert.ok(view);
    assert.equal(near(view.position.x, view.position.z, spawns), true, `npc ${agent.id}`);
    assert.equal(near(view.position.x, view.position.z, loaded.playerSpawns), false, `npc ${agent.id} on a player pad`);
    assert.equal(bots.includes(view.render?.assetKey ?? ""), true, view.render?.assetKey);
  }
});

test("two claims before commit take two player pads and ignore an npc skin", () => {
  const loaded = loadArena();
  const seats = loaded.agents.filter((agent) => agent.role === "player");
  assert.ok(seats.length >= 2);
  const pending = new Map<number, { x: number; y: number; z: number; yaw: number }>();
  const first = seats[0]!.id;
  const second = seats[1]!.id;
  const padA = claimClearSpawn(loaded.world, first, loaded.playerSpawns, pending);
  assert.ok(padA);
  placePawn(loaded.world, first, padA);
  pending.set(first, padA);
  const padB = claimClearSpawn(loaded.world, second, loaded.playerSpawns, pending);
  assert.ok(padB);
  assert.ok(Math.hypot(padA.x - padB.x, padA.z - padB.z) > 1);
  placePawn(loaded.world, second, padB);
  applyPawnModel(loaded.world, second, "player-1", loaded.view.modelChoices);
  applyPawnModel(loaded.world, second, "ratty", loaded.view.modelChoices);
  loaded.world.commit(1n);
  const viewA = loaded.world.store.view(first);
  const viewB = loaded.world.store.view(second);
  assert.ok(viewA && viewB);
  assert.equal(viewA.render?.assetKey, loaded.view.modelChoices[0]);
  assert.equal(viewB.render?.assetKey, "player-1");
  assert.ok(Math.hypot(viewA.position.x - padA.x, viewA.position.z - padA.z) < 0.05);
  assert.ok(Math.hypot(viewB.position.x - padB.x, viewB.position.z - padB.z) < 0.05);
});

test("two clients stand on different player pads with the models they sent", async () => {
  const host = await startArenaServer(0);
  const open: WebSocket[] = [];
  try {
    const view = await (await fetch(`${host.url}/arena.json`)).json() as {
      world: string;
      bundleId: string;
      authoritativeHash: string;
      modelChoices?: string[];
      playerSpawns?: Array<{ id: string; x: number; z: number }>;
      spawns?: Array<{ id: string; x: number; z: number }>;
    };
    assert.ok(view.modelChoices?.includes("grok-bot"));
    assert.ok(view.modelChoices?.includes("player-1"));
    const pads = view.playerSpawns ?? [];
    assert.ok(pads.length >= 3);
    const a = hello(host.url, view, "grok-bot");
    const b = hello(host.url, view, "player-1");
    open.push(a.ws, b.ws);
    const [aw, bw] = await Promise.all([a.welcome, b.welcome]);
    assert.notEqual(aw.ownedEntityId, bw.ownedEntityId);
    const placed = await waitFor(3000, () => {
      const poseA = a.poses.get(aw.ownedEntityId);
      const poseB = b.poses.get(bw.ownedEntityId);
      if (!poseA?.assetKey || !poseB?.assetKey) return undefined;
      return { poseA, poseB };
    });
    const padA = pads.find((pad) => Math.hypot(pad.x - placed.poseA.x, pad.z - placed.poseA.z) < 0.75);
    const padB = pads.find((pad) => Math.hypot(pad.x - placed.poseB.x, pad.z - placed.poseB.z) < 0.75);
    assert.ok(padA, `A ${placed.poseA.x},${placed.poseA.z}`);
    assert.ok(padB, `B ${placed.poseB.x},${placed.poseB.z}`);
    assert.notEqual(padA.id, padB.id);
    assert.equal(placed.poseA.assetKey, "grok-bot");
    assert.equal(placed.poseB.assetKey, "player-1");
    for (const pose of [placed.poseA, placed.poseB]) {
      const npc = (view.spawns ?? []).some((pad) => Math.hypot(pad.x - pose.x, pad.z - pose.z) < 1);
      assert.equal(npc, false);
    }
    b.ws.send(JSON.stringify(modelFrame("grok-bot")));
    const swapped = await waitFor(3000, () => {
      const pose = b.poses.get(bw.ownedEntityId);
      return pose?.assetKey === "grok-bot" ? pose : undefined;
    });
    assert.equal(swapped.assetKey, "grok-bot");
    const full = loadArena().agents.filter((agent) => agent.role === "player").length;
    const extra: ReturnType<typeof hello>[] = [];
    for (let i = 2; i < full; i += 1) extra.push(hello(host.url, view, "grok-bot"));
    open.push(...extra.map((client) => client.ws));
    const welcomes = await Promise.all(extra.map((client) => client.welcome));
    const ids = new Set([aw.ownedEntityId, bw.ownedEntityId, ...welcomes.map((row) => row.ownedEntityId)]);
    assert.equal(ids.size, full);
    const refused = hello(host.url, view, "player-1");
    open.push(refused.ws);
    await assert.rejects(refused.welcome, /no free pawn/);
  } finally {
    for (const ws of open) ws.close();
    await host.close();
  }
});

function near(x: number, z: number, pads: readonly { x: number; z: number }[]): boolean {
  return pads.some((pad) => Math.hypot(pad.x - x, pad.z - z) < 0.05);
}

type Pose = { x: number; z: number; assetKey?: string };

function absorb(poses: Map<number, Pose>, envelope: { spawns?: unknown[]; updates?: unknown[] }) {
  const rows = [...(envelope.spawns ?? []), ...(envelope.updates ?? [])] as Array<{
    entity?: number;
    view?: { position?: { x: number; z: number }; render?: { assetKey?: string } };
  }>;
  for (const row of rows) {
    const id = Number(row.entity);
    const position = row.view?.position;
    if (!Number.isFinite(id) || !position) continue;
    const prev = poses.get(id);
    const assetKey = row.view?.render?.assetKey ?? prev?.assetKey;
    poses.set(id, { x: position.x, z: position.z, ...(assetKey ? { assetKey } : {}) });
  }
}

function hello(
  url: string,
  view: { world: string; bundleId: string; authoritativeHash: string },
  model: string,
) {
  const poses = new Map<number, Pose>();
  const ws = new WebSocket(url.replace(/^http/, "ws"));
  const welcome = new Promise<{ ownedEntityId: number }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no welcome")), 3000);
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data)) as {
        type?: string;
        ownedEntityId?: number;
        reason?: string;
        envelope?: { spawns?: unknown[]; updates?: unknown[] };
      };
      if (msg.type === "reject") {
        clearTimeout(timer);
        reject(Object.assign(new Error(msg.reason ?? "reject"), { reject: true }));
      }
      if (msg.type === "welcome") {
        clearTimeout(timer);
        resolve({ ownedEntityId: Number(msg.ownedEntityId) });
      }
      if (msg.type === "snapshot" && msg.envelope) absorb(poses, msg.envelope);
    });
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({
        v: 1,
        type: "hello",
        protocol: 1,
        world: view.world,
        bundleId: view.bundleId,
        authoritativeHash: view.authoritativeHash,
        model,
      }));
    });
  });
  return { ws, poses, welcome };
}

function waitFor<T>(ms: number, read: () => T | undefined): Promise<T> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      try {
        const value = read();
        if (value !== undefined) {
          clearInterval(timer);
          resolve(value);
          return;
        }
      } catch (err) {
        clearInterval(timer);
        reject(err);
        return;
      }
      if (Date.now() - start > ms) {
        clearInterval(timer);
        reject(new Error("timeout"));
      }
    }, 30);
  });
}

type FakeEl = {
  id: string;
  value: string;
  textContent: string;
  hidden: boolean;
  style: { cssText: string };
  children: FakeEl[];
  append(...nodes: FakeEl[]): void;
  setAttribute(name: string, value: string): void;
  addEventListener(type: string, fn: () => void): void;
  dispatch(type: string): void;
};

function installDom() {
  const ids = new Map<string, FakeEl>();
  const previous = { window: globalThis.window, document: globalThis.document };
  function createElement(tag: string): FakeEl {
    const listeners = new Map<string, Array<() => void>>();
    let idValue = "";
    const el: FakeEl = {
      value: "",
      textContent: "",
      hidden: false,
      style: { cssText: "" },
      children: [],
      get id() {
        return idValue;
      },
      set id(value: string) {
        if (idValue) ids.delete(idValue);
        idValue = value;
        if (value) ids.set(value, el);
      },
      append(...nodes) {
        this.children.push(...nodes);
      },
      setAttribute() {},
      addEventListener(type, fn) {
        const list = listeners.get(type) ?? [];
        list.push(fn);
        listeners.set(type, list);
      },
      dispatch(type) {
        for (const fn of listeners.get(type) ?? []) fn();
      },
    };
    void tag;
    return el;
  }
  const body = createElement("body");
  globalThis.window = { addEventListener() {} } as unknown as Window & typeof globalThis;
  globalThis.document = {
    body,
    createElement,
    getElementById: (id: string) => ids.get(id) ?? null,
  } as unknown as Document;
  return {
    get(id: string) {
      const el = ids.get(id);
      assert.ok(el, id);
      return el;
    },
    restore() {
      globalThis.window = previous.window;
      globalThis.document = previous.document;
    },
  };
}
