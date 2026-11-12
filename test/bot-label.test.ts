import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { createBotLabelLayer, LABEL_ABOVE_M, LABEL_SCALE_X, LABEL_SCALE_Y } from "../src/client/bot-label.ts";
import { createClientDiag, type DiagRecord } from "../src/client/diag.ts";
import { BOT_LABEL_MAX, botLabelText, parseBotLabel } from "../src/shared/bot-label.ts";
import { createBotLabelHost } from "../src/server/bot-label.ts";

const BOTS = 13;
const EVERY = 4;
const TICKS_PER_SEC = 20;
const MINUTE = TICKS_PER_SEC * 60;

test("botLabelText capitalises the goal and rounds hp", () => {
  assert.equal(botLabelText("wander", 100), "Wander 100");
  assert.equal(botLabelText("evade", 40), "Evade 40");
  assert.equal(botLabelText("escape", 40.4), "Escape 40");
  assert.equal(botLabelText("fightback", 40.6), "Fightback 41");
  assert.equal(botLabelText("wander", 75.2), "Wander 75");
  assert.equal(botLabelText("wander", 0), "Dead");
  assert.equal(botLabelText("escape", 40, true), "Dead");
  assert.equal(botLabelText("evade", Number.NaN), "Dead");
});

test("parseBotLabel accepts a short label and rejects a bad frame", () => {
  assert.deepEqual(parseBotLabel({ t: "botLabel", id: 4, text: "Wander 100" }), {
    t: "botLabel",
    id: 4,
    text: "Wander 100",
  });
  assert.deepEqual(parseBotLabel({ t: "botLabel", id: 1, text: "D".repeat(BOT_LABEL_MAX) }), {
    t: "botLabel",
    id: 1,
    text: "D".repeat(BOT_LABEL_MAX),
  });
  assert.equal(parseBotLabel({ t: "botLabel", id: 1.5, text: "Wander 100" }), undefined);
  assert.equal(parseBotLabel({ t: "botLabel", id: Number.NaN, text: "Wander 100" }), undefined);
  assert.equal(parseBotLabel({ t: "botLabel", id: Number.POSITIVE_INFINITY, text: "Wander 100" }), undefined);
  assert.equal(parseBotLabel({ t: "botLabel", id: "4", text: "Wander 100" }), undefined);
  assert.equal(parseBotLabel({ t: "botLabel", id: 4, text: 100 }), undefined);
  assert.equal(parseBotLabel({ t: "botLabel", id: 4, text: null }), undefined);
  assert.equal(parseBotLabel({ t: "botLabel", id: 4, text: "D".repeat(BOT_LABEL_MAX + 1) }), undefined);
  assert.equal(parseBotLabel({ t: "botLabel", id: 4 }), undefined);
  assert.equal(parseBotLabel({ t: "health", id: 4, text: "Wander 100" }), undefined);
  assert.equal(parseBotLabel(null), undefined);
  assert.equal(parseBotLabel([{ t: "botLabel", id: 4, text: "Wander 100" }]), undefined);
});

type Sent = { t?: string; id?: number; text?: string };

function fakeServer() {
  const clients = new Map<number, { sessionId: number; sent: Sent[]; known: Set<number> }>();
  let nextSession = 1;
  const server = {
    get connected() {
      return [...clients.keys()];
    },
    session(id: number) {
      const client = clients.get(id);
      if (!client) return undefined;
      return {
        sessionId: client.sessionId,
        socket: { send: (text: string) => client.sent.push(JSON.parse(text) as Sent) },
      };
    },
    replicator: {
      get(id: number) {
        const client = clients.get(id);
        if (!client) return undefined;
        return { connected: true, ownedEntity: undefined as number | undefined, known: client.known };
      },
    },
    join(id: number, known: Iterable<number> = []) {
      const client = { sessionId: nextSession++, sent: [] as Sent[], known: new Set(known) };
      clients.set(id, client);
      return client;
    },
    leave(id: number) {
      clients.delete(id);
    },
  };
  return server;
}

function labelsOf(sent: Sent[]): Sent[] {
  return sent.filter((frame) => frame.t === "botLabel");
}

/** Sensor stagger: bot `slot` is re-read when `(tick + slot) % every === 0`. */
function scriptedSense(botCount: number) {
  const rows = new Map<number, { tick: number }>();
  let sensorTick = 0;
  let gets = 0;
  const ids = Array.from({ length: botCount }, (_, index) => index + 1);
  return {
    ids,
    gets: () => gets,
    advance() {
      sensorTick += 1;
      for (let slot = 0; slot < botCount; slot++) {
        if ((sensorTick + slot) % EVERY !== 0) continue;
        const id = ids[slot]!;
        let row = rows.get(id);
        if (!row) rows.set(id, (row = { tick: 0 }));
        row.tick = sensorTick;
      }
    },
    get(id: number) {
      gets += 1;
      return rows.get(id);
    },
  };
}

test("flag off sends no botLabel frames and does not change the host frame count", () => {
  const sense = scriptedSense(BOTS);
  let goals = 0;
  let vitals = 0;
  const server = fakeServer();
  const client = server.join(1, sense.ids);
  const labels = createBotLabelHost({
    enabled: false,
    server: server as never,
    ids: sense.ids,
    brain: { goalOf() { goals += 1; return "wander"; } },
    health: { get() { vitals += 1; return { hp: 100, dead: false }; } },
    sense,
  });
  const base = fakeServer();
  const baseClient = base.join(1, sense.ids);
  for (let tick = 0; tick < MINUTE; tick++) {
    sense.advance();
    labels.update();
    client.sent.push({ t: "snap" });
    baseClient.sent.push({ t: "snap" });
  }
  assert.equal(labelsOf(client.sent).length, 0);
  assert.equal(goals, 0);
  assert.equal(vitals, 0);
  assert.equal(sense.gets(), 0);
  assert.equal(client.sent.length, baseClient.sent.length);
  assert.equal(client.sent.length, MINUTE);
});

test("flag on sends one label per bot per client, only when the text changes", () => {
  const sense = scriptedSense(BOTS);
  let goals = 0;
  let hp = 100;
  let dead = false;
  const server = fakeServer();
  const client = server.join(1, sense.ids);
  const labels = createBotLabelHost({
    enabled: true,
    server: server as never,
    ids: sense.ids,
    brain: { goalOf() { goals += 1; return "wander"; } },
    health: { get() { return { hp, dead }; } },
    sense,
  });
  for (let tick = 0; tick < MINUTE; tick++) {
    sense.advance();
    labels.update();
    client.sent.push({ t: "snap" });
  }
  const first = labelsOf(client.sent);
  assert.equal(first.length, BOTS, "one frame per wandering bot in the minute");
  assert.deepEqual(first.map((frame) => frame.text).sort(), Array.from({ length: BOTS }, () => "Wander 100"));
  assert.equal(client.sent.length, MINUTE + BOTS);
  assert.equal(goals, BOTS * (MINUTE / EVERY), "text is built at the sensor rate, not every host tick");

  const before = first.length;
  hp = 40.4;
  labels.update();
  assert.equal(labelsOf(client.sent).length, before, "hp is not read again until the sensor ticks");
  for (let tick = 0; tick < EVERY; tick++) {
    sense.advance();
    labels.update();
  }
  const changed = labelsOf(client.sent).slice(before);
  assert.equal(changed.length, BOTS);
  assert.ok(changed.every((frame) => frame.text === "Wander 40"));

  const steady = labelsOf(client.sent).length;
  for (let tick = 0; tick < EVERY * 3; tick++) {
    sense.advance();
    labels.update();
  }
  assert.equal(labelsOf(client.sent).length, steady, "the same text twice sends once");

  dead = true;
  for (let tick = 0; tick < EVERY; tick++) {
    sense.advance();
    labels.update();
  }
  const died = labelsOf(client.sent).slice(steady);
  assert.equal(died.length, BOTS);
  assert.ok(died.every((frame) => frame.text === "Dead"));
});

test("a new session and a newly visible bot each get the current label once", () => {
  const sense = scriptedSense(2);
  const server = fakeServer();
  const first = server.join(1, []);
  const labels = createBotLabelHost({
    enabled: true,
    server: server as never,
    ids: sense.ids,
    brain: { goalOf: () => "escape" },
    health: { get: () => ({ hp: 80.2, dead: false }) },
    sense,
  });
  for (let tick = 0; tick < EVERY; tick++) {
    sense.advance();
    labels.update();
  }
  assert.equal(labelsOf(first.sent).length, 0, "outside interest: nothing");
  for (const id of sense.ids) first.known.add(id);
  labels.update();
  assert.deepEqual(labelsOf(first.sent).map((frame) => frame.text), ["Escape 80", "Escape 80"]);

  const second = server.join(2, sense.ids);
  labels.update();
  assert.equal(labelsOf(second.sent).length, 2);
  assert.equal(labelsOf(first.sent).length, 2, "the first session is not resent");

  server.leave(2);
  const again = server.join(2, sense.ids);
  labels.update();
  assert.equal(labelsOf(again.sent).length, 2, "a new session starts empty");
  assert.equal(labelsOf(first.sent).length, 2);
});

function canvas(): HTMLCanvasElement {
  const ctx = {
    clearRect() {},
    fillRect() {},
    fillText() {},
    font: "",
    fillStyle: "",
    textAlign: "",
    textBaseline: "",
  };
  return { width: 128, height: 32, getContext: () => ctx } as unknown as HTMLCanvasElement;
}

test("bot label sprites follow the option, and the same text does not redraw", () => {
  const parent = new THREE.Group();
  const errors: DiagRecord[] = [];
  const diag = createClientDiag({
    sink: {
      error(_error, fields) { errors.push(fields); },
      warn(fields) { errors.push(fields); },
    },
  });
  const layer = createBotLabelLayer(parent, 1.8, diag, canvas);
  const pawn = { id: 3, position: { x: 1, y: 2, z: 3 } };
  const frame = { t: "botLabel", id: 3, text: "Wander 100" };

  layer.offer(frame);
  layer.sync([pawn]);
  assert.equal(layer.count, 0);
  assert.equal(layer.redraws, 0);
  assert.equal(parent.children.length, 0);
  assert.equal(errors.length, 0);

  layer.setEnabled(true);
  layer.sync([pawn]);
  assert.equal(layer.count, 0, "a frame received while off is ignored");

  layer.offer(frame);
  layer.sync([pawn]);
  assert.equal(layer.count, 1);
  assert.equal(layer.redraws, 1);
  const sprite = parent.children[0] as THREE.Sprite;
  const material = sprite.material as THREE.SpriteMaterial;
  assert.equal(material.depthTest, true);
  assert.equal(sprite.scale.x, LABEL_SCALE_X);
  assert.equal(sprite.scale.y, LABEL_SCALE_Y);
  assert.equal(sprite.position.y, pawn.position.y + 1.8 + LABEL_ABOVE_M);
  let disposed = 0;
  material.addEventListener("dispose", () => { disposed += 1; });

  layer.offer(frame);
  layer.sync([pawn, { id: 9, position: { x: 0, y: 0, z: 0 } }]);
  assert.equal(layer.redraws, 1, "the same text does not redraw");
  assert.equal(layer.count, 1);
  assert.equal((parent.children[0] as THREE.Sprite).material, material);

  layer.offer({ t: "botLabel", id: 3, text: "Escape 40" });
  assert.equal(layer.redraws, 2);
  assert.equal(parent.children.length, 1);
  assert.equal((parent.children[0] as THREE.Sprite).material, material);
  assert.equal(material.map, (sprite.material as THREE.SpriteMaterial).map);

  layer.sync([]);
  assert.equal(layer.count, 0, "leaving replication removes the sprite");
  assert.equal(disposed, 1);

  layer.sync([pawn]);
  assert.equal(layer.count, 1, "the kept text comes back with the pawn");
  assert.equal(layer.redraws, 3);

  layer.setEnabled(false);
  assert.equal(layer.count, 0);
  assert.equal(parent.children.length, 0);
  layer.setEnabled(true);
  layer.sync([pawn]);
  assert.equal(layer.count, 0, "turning the option off drops the remembered text");

  layer.offer({ t: "botLabel", id: "nope", text: "Wander 100" });
  layer.sync([pawn]);
  assert.equal(layer.count, 0);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.category, "parse");
});

test("a canvas that will not draw is reported and creates no sprite", () => {
  const parent = new THREE.Group();
  const errors: DiagRecord[] = [];
  const diag = createClientDiag({
    sink: {
      error(_error, fields) { errors.push(fields); },
      warn() {},
    },
  });
  const blank = { width: 128, height: 32, getContext: () => null } as unknown as HTMLCanvasElement;
  const layer = createBotLabelLayer(parent, 1.8, diag, () => blank);
  layer.setEnabled(true);
  layer.offer({ t: "botLabel", id: 3, text: "Wander 100" });
  layer.sync([{ id: 3, position: { x: 0, y: 0, z: 0 } }]);
  assert.equal(layer.count, 0);
  assert.equal(parent.children.length, 0);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.category, "draw");
});
