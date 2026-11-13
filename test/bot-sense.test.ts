import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

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

const { createBotSensor, createExitIndex } = await import("../src/shared/bots/sense.ts");
const { createPawnHealth, RESPAWN_MS } = await import("../src/shared/health.ts");
const { createHostBotSense } = await import("../src/server/bot-sense.ts");
const { createArenaHost } = await import("../src/server/arena-host.ts");
const { loadArena } = await import("../src/server/world-loader.ts");
const { pawnBodies } = await import("../src/server/pickups.ts");

function near(actual: number | undefined, expected: number): void {
  assert.equal(typeof actual, "number");
  assert.ok(Math.abs(actual! - expected) < 1e-9, `${actual} ~= ${expected}`);
}

test("stagger", () => {
  const ids = [1, 2, 3, 4, 5, 6, 7, 8];
  const counts = new Map(ids.map((id) => [id, 0]));
  let batch = 0;
  const sensor = createBotSensor({
    now: () => 0,
    botIds: () => ids,
    pawns: () => ids.map((id) => ({ id, kind: "bot" as const, x: 0, y: 0, z: 0, alive: true })),
    headingOf(id) {
      counts.set(id, (counts.get(id) ?? 0) + 1);
      batch += 1;
      return 0;
    },
    health: () => ({ hp: 100, dead: false }),
    lastDamage: () => undefined,
  });
  let maxBatch = 0;
  for (let i = 0; i < 12; i++) {
    batch = 0;
    sensor.update();
    if (batch > maxBatch) maxBatch = batch;
  }
  assert.equal(sensor.tick, 12);
  assert.deepEqual(sensor.ids(), [1, 2, 3, 4, 5, 6, 7, 8]);
  let total = 0;
  for (const id of ids) {
    assert.equal(counts.get(id), 3);
    total += counts.get(id) ?? 0;
  }
  assert.equal(total, 24);
  assert.ok(maxBatch <= 2);
});

test("cadence", () => {
  let t = 0;
  let pawnCalls = 0;
  let placeCalls = 0;
  let pickupCalls = 0;
  const bots = [
    { id: 1, kind: "bot", x: 0, y: 0, z: 0, alive: true },
    { id: 2, kind: "bot", x: 1, y: 0, z: 0, alive: true },
    { id: 3, kind: "bot", x: 2, y: 0, z: 0, alive: true },
  ];
  const sensor = createBotSensor({
    now: () => t,
    botIds: () => [1, 2, 3],
    pawns() {
      pawnCalls += 1;
      return bots;
    },
    headingOf: () => 0,
    health: () => ({ hp: 100, dead: false }),
    lastDamage: () => undefined,
    placeOf() {
      placeCalls += 1;
      return "hall";
    },
    pickups() {
      pickupCalls += 1;
      return [];
    },
  });
  for (let i = 1; i <= 100; i++) {
    t = i * 50;
    sensor.update();
  }
  assert.ok(pickupCalls >= 5 && pickupCalls <= 6, `pickups ${pickupCalls}`);
  assert.ok(placeCalls <= 12, `placeOf ${placeCalls}`);
  assert.ok(pawnCalls <= 100, `pawns ${pawnCalls}`);
  assert.equal(pawnCalls, 75);
});

test("hp and wound", () => {
  let t = 0;
  const health = createPawnHealth(() => t);
  const sensor = createBotSensor({
    now: () => t,
    botIds: () => [1],
    pawns: () => [
      { id: 1, kind: "bot", x: 0, y: 0, z: 0, alive: !health.isDead(1) },
      { id: 7, kind: "player", x: 0, y: 0, z: 5, alive: true },
    ],
    headingOf: () => Math.PI / 2,
    health: (id) => health.get(id),
    lastDamage: (id) => health.lastDamage(id),
  }, { everyTicks: 1 });
  sensor.update();
  const calm = sensor.get(1);
  assert.ok(calm);
  assert.equal(calm.hp, 100);
  assert.equal(calm.hpFrac, 1);
  assert.equal(calm.damage, undefined);

  health.wound(1, 7);
  sensor.update();
  const hit = sensor.get(1)!;
  assert.equal(hit.hp, 75);
  assert.equal(hit.hpFrac, 0.75);
  assert.equal(hit.damage?.attacker, 7);
  assert.equal(hit.damage?.attackerKind, "player");
  assert.equal(hit.damage?.dist, 5);
  assert.equal(hit.damage?.yawTo, 0);
  near(hit.damage?.relYaw, -Math.PI / 2);
  const firstSeq = hit.damage?.seq;

  health.wound(1);
  sensor.update();
  const anon = sensor.get(1)!;
  assert.equal(anon.damage?.attacker, undefined);
  assert.equal(anon.damage?.dist, undefined);
  assert.equal(anon.damage?.attackerKind, undefined);
  assert.equal(firstSeq, 1);
  assert.equal(anon.damage?.seq, 2);
});

test("two hits 300 ms apart from the same attacker get two seq values", () => {
  let t = 1_000;
  const health = createPawnHealth(() => t);
  const sensor = createBotSensor({
    now: () => t,
    botIds: () => [1],
    pawns: () => [{ id: 1, kind: "bot", x: 0, y: 0, z: 0, alive: true }],
    headingOf: () => 0,
    health: (id) => health.get(id),
    lastDamage: (id) => health.lastDamage(id),
  }, { everyTicks: 1 });
  health.wound(1, 7);
  sensor.update();
  const firstSeq = sensor.get(1)!.damage?.seq;
  t += 300;
  health.wound(1, 7);
  sensor.update();
  const second = sensor.get(1)!.damage;
  assert.equal(firstSeq, 1);
  assert.equal(second?.seq, 2);
  assert.equal(second?.attacker, 7);
  assert.equal(second?.ageMs, 0);
  health.wound(1, undefined, 10, "grenade");
  sensor.update();
  const grenade = sensor.get(1)!.damage;
  assert.equal(grenade?.attacker, undefined);
  assert.equal(grenade?.seq, 3);
  assert.equal(sensor.get(1)!.hp, 40);
});

test("expiry, dead attacker, respawn", () => {
  let t = 0;
  let attackerAlive = true;
  const health = createPawnHealth(() => t);
  const sensor = createBotSensor({
    now: () => t,
    botIds: () => [1],
    pawns: () => [
      { id: 1, kind: "bot", x: 0, y: 0, z: 0, alive: !health.isDead(1) },
      { id: 7, kind: "player", x: 0, y: 0, z: 5, alive: attackerAlive },
    ],
    headingOf: () => 0,
    health: (id) => health.get(id),
    lastDamage: (id) => health.lastDamage(id),
  }, { everyTicks: 1 });

  health.wound(1, 7);
  sensor.update();
  assert.equal(sensor.get(1)!.damage?.ageMs, 0);
  t = 20000;
  sensor.update();
  assert.ok(sensor.get(1)!.damage);
  assert.equal(sensor.get(1)!.damage?.ageMs, 20000);
  t = 20001;
  sensor.update();
  assert.equal(sensor.get(1)!.damage, undefined);

  attackerAlive = false;
  health.wound(1, 7);
  sensor.update();
  const deadFoe = sensor.get(1)!;
  assert.equal(deadFoe.damage?.attacker, 7);
  assert.equal(deadFoe.damage?.dist, undefined);
  assert.equal(deadFoe.damage?.attackerKind, undefined);

  health.wound(1, 7, 100);
  sensor.update();
  assert.equal(sensor.get(1)!.alive, false);
  t = 20001 + RESPAWN_MS;
  assert.deepEqual(health.takeRespawns(), [1]);
  sensor.update();
  const back = sensor.get(1)!;
  assert.equal(back.alive, true);
  assert.equal(back.damage, undefined);
  assert.equal(back.hp, 100);
  assert.equal(back.msInPlace, 0);
  assert.equal(back.msNoProgress, 0);
});

test("nearby", () => {
  const pawns = [
    { id: 1, kind: "bot", x: 0, y: 0, z: 0, alive: true },
    { id: 2, kind: "bot", x: 0, y: 0, z: 1, alive: true },
    { id: 5, kind: "player", x: 0, y: 0, z: 2, alive: true },
    { id: 9, kind: "bot", x: 0, y: 0, z: 3, alive: true },
    { id: 4, kind: "bot", x: 0, y: 0, z: 0.5, alive: false },
    { id: 8, kind: "player", x: 0, y: 0, z: 31, alive: true },
  ];
  for (let id = 10; id <= 18; id++) {
    pawns.push({ id, kind: "bot", x: 0, y: 0, z: id - 6, alive: true });
  }
  const sensor = createBotSensor({
    now: () => 0,
    botIds: () => [1],
    pawns: () => pawns,
    headingOf: () => 0,
    health: () => ({ hp: 100, dead: false }),
    lastDamage: () => undefined,
  }, { everyTicks: 1 });
  sensor.update();
  const nearby = sensor.get(1)!.nearby;
  assert.deepEqual(nearby.slice(0, 3).map((pawn) => [pawn.id, pawn.kind]), [[2, "bot"], [5, "player"], [9, "bot"]]);
  assert.equal(nearby.length, 8);
  assert.equal(nearby.some((pawn) => pawn.id === 8 || pawn.id === 4 || pawn.id === 1), false);
});

test("timers", () => {
  let t = 0;
  let x = 0;
  let place = "hall";
  const sensor = createBotSensor({
    now: () => t,
    botIds: () => [1],
    pawns: () => [{ id: 1, kind: "bot", x, y: 0, z: 0, alive: true }],
    headingOf: () => 0,
    health: () => ({ hp: 100, dead: false }),
    lastDamage: () => undefined,
    placeOf: () => place,
  }, { everyTicks: 1, placeEveryMs: 0 });

  sensor.update();
  assert.equal(sensor.get(1)!.msInPlace, 0);
  assert.equal(sensor.get(1)!.msNoProgress, 0);

  t = 1000;
  sensor.update();
  assert.equal(sensor.get(1)!.msInPlace, 1000);
  assert.equal(sensor.get(1)!.msNoProgress, 1000);

  x = 0.5;
  t = 1600;
  sensor.update();
  assert.equal(sensor.get(1)!.msNoProgress, 1600);
  assert.equal(sensor.get(1)!.msInPlace, 1600);

  x = 2;
  t = 1800;
  sensor.update();
  assert.ok(sensor.get(1)!.msNoProgress < 400);
  assert.equal(sensor.get(1)!.msNoProgress, 0);
  assert.equal(sensor.get(1)!.msInPlace, 1800);

  place = "room";
  t = 2500;
  sensor.update();
  assert.equal(sensor.get(1)!.msInPlace, 0);
  assert.equal(sensor.get(1)!.place, "room");
  assert.equal(sensor.get(1)!.msNoProgress, 700);
});

test("pickups", () => {
  let list = [
    { id: "h-near", kind: "health", x: 0, y: 0, z: 3 },
    { id: "h-far", kind: "health", x: 0, y: 0, z: 10 },
    { id: "h-out", kind: "health", x: 0, y: 0, z: 40 },
    { id: "a-near", kind: "ammo", x: 4, y: 0, z: 0 },
    { id: "a-far", kind: "ammo", x: 12, y: 0, z: 0 },
  ];
  const sensor = createBotSensor({
    now: () => 0,
    botIds: () => [1],
    pawns: () => [{ id: 1, kind: "bot", x: 0, y: 0, z: 0, alive: true }],
    headingOf: () => 0,
    health: () => ({ hp: 100, dead: false }),
    lastDamage: () => undefined,
    pickups: () => list,
  }, { everyTicks: 1, worldEveryTicks: 4 });

  sensor.update();
  assert.equal(sensor.get(1)!.pickups.health?.id, "h-near");
  assert.equal(sensor.get(1)!.pickups.ammo?.id, "a-near");
  assert.equal(sensor.get(1)!.pickups.health?.id === "h-out", false);

  list = list.filter((item) => item.id !== "h-near" && item.id !== "a-near");
  sensor.update();
  sensor.update();
  sensor.update();
  assert.equal(sensor.get(1)!.pickups.health?.id, "h-near");
  assert.equal(sensor.get(1)!.pickups.ammo?.id, "a-near");
  sensor.update();
  assert.equal(sensor.get(1)!.pickups.health?.id, "h-far");
  assert.equal(sensor.get(1)!.pickups.ammo?.id, "a-far");
  assert.equal(sensor.get(1)!.pickups.health?.id === "h-out", false);

  list = [];
  sensor.update();
  sensor.update();
  sensor.update();
  sensor.update();
  assert.equal(sensor.get(1)!.pickups.health, undefined);
  assert.equal(sensor.get(1)!.pickups.ammo, undefined);
});

test("exit index", () => {
  const portals = [
    { id: "p1", kind: "door", a: "outside", b: "hall", door: "d1" },
    { id: "p2", kind: "door", a: "hall", b: "room", door: "d2" },
    { id: "p3", kind: "landing", a: "hall", b: "stairs" },
    { id: "p4", kind: "elevator", a: "stairs", b: "attic" },
    { id: "p5", kind: "door", a: "room", b: "closet", door: "d3" },
  ];
  const index = createExitIndex(portals);
  const open = { open: true, locked: false };
  const rows = (d1, d2, d3) => new Map([
    ["d1", d1],
    ["d2", d2],
    ["d3", d3],
  ]);
  index.update(rows(open, open, open));
  for (const id of ["outside", "hall", "room", "stairs", "closet"]) {
    assert.deepEqual(index.reaches(id), { open: true, unlocked: true }, id);
  }
  assert.deepEqual(index.reaches("attic"), { open: false, unlocked: false });
  assert.deepEqual(index.reaches("missing"), { open: false, unlocked: false });
  index.update(rows(open, open, open));
  assert.equal(index.rebuilds, 1);

  index.update(rows(open, { open: false, locked: false }, open));
  assert.deepEqual(index.reaches("room"), { open: false, unlocked: true });
  assert.deepEqual(index.reaches("closet"), { open: false, unlocked: true });
  assert.deepEqual(index.reaches("hall"), { open: true, unlocked: true });

  index.update(rows(open, { open: false, locked: true }, open));
  assert.deepEqual(index.reaches("room"), { open: false, unlocked: false });
  assert.deepEqual(index.reaches("closet"), { open: false, unlocked: false });
  assert.deepEqual(index.reaches("stairs"), { open: true, unlocked: true });

  index.update(rows({ open: false, locked: true }, open, open));
  assert.deepEqual(index.reaches("hall"), { open: false, unlocked: false });
  assert.deepEqual(index.reaches("outside"), { open: true, unlocked: true });
  assert.deepEqual(index.reaches("room"), { open: false, unlocked: false });
});

test("containment", () => {
  const lines: string[] = [];
  const sensor = createBotSensor({
    now: () => 0,
    botIds: () => [1],
    pawns() {
      throw new Error("boom");
    },
    headingOf: () => 0,
    health: () => ({ hp: 100, dead: false }),
    lastDamage: () => undefined,
    log(line) {
      lines.push(line);
    },
  });
  for (let i = 0; i < 20; i++) sensor.update();
  assert.deepEqual(lines, ["[live] sense boom"]);
  assert.equal(sensor.get(1), undefined);
});

test("no scene graph", () => {
  const health = createPawnHealth(() => 0);
  const sensor = createHostBotSense({
    world: { store: { view: () => ({ rotation: { y: 0, w: 1 } }) } } as never,
    agents: [{ id: 4, heading: 0, gait: "idle", nextTurn: 0, speeds: { idle: 0 } }],
    health,
    doors: () => [],
    pickups: [],
    remainingPickups: () => [],
    ownedEntities: () => [],
    now: () => 0,
    tuning: { everyTicks: 1 },
  });
  sensor.update([{ id: 4, x: 1, y: 2, z: 3, radius: 0.4, height: 1.8, alive: true }]);
  const row = sensor.get(4);
  assert.ok(row);
  assert.equal(row.alive, true);
  assert.equal(row.place, undefined);
  assert.equal(row.routeOut, undefined);
});

test("host adapter on the real arena", { timeout: 60_000 }, () => {
  const loaded = loadArena();
  let t = 0;
  const health = createPawnHealth(() => t);
  let owned: number[] = [];
  const sensor = createHostBotSense({
    world: loaded.world,
    agents: loaded.agents,
    health,
    sceneGraph: loaded.sceneGraph,
    doors: () => loaded.view.doors.map((door) => ({ id: door.id, open: true, locked: false })),
    pickups: loaded.view.pickups ?? [],
    remainingPickups: () => (loaded.view.pickups ?? []).map((pickup) => pickup.id),
    ownedEntities: () => owned,
    now: () => t,
    tuning: { nearRadius: 1e6, maxNearby: 100 },
  });
  const bots = loaded.agents.filter((agent) => agent.role !== "player").map((agent) => agent.id).sort((a, b) => a - b);
  const seat = loaded.agents.find((agent) => agent.role === "player")!.id;
  const world = loaded.world as unknown as { enqueue: (cmd: unknown) => unknown };
  const orig = world.enqueue;
  let enqueued = 0;
  world.enqueue = (cmd: unknown) => {
    enqueued += 1;
    return orig.call(world, cmd);
  };
  const poses = () => JSON.stringify(pawnBodies(loaded.world, health).map((body) => [body.id, body.x, body.y, body.z]));
  const before = poses();
  for (let i = 0; i < 4; i++) sensor.update(pawnBodies(loaded.world, health));
  assert.deepEqual(sensor.ids(), bots);
  for (const id of bots) {
    const row = sensor.get(id);
    assert.ok(row, `bot ${id}`);
    assert.equal(row.alive, true);
    assert.equal(row.hp, 100);
    assert.equal(row.place, "outside");
    assert.deepEqual(row.routeOut, { open: true, unlocked: true });
    assert.equal(row.nearby.length, bots.length - 1);
    for (const other of row.nearby) assert.equal(other.kind, "bot");
  }
  const botA = bots[0]!;
  const botB = bots[1]!;
  health.wound(botA, botB);
  for (let i = 0; i < 4; i++) sensor.update(pawnBodies(loaded.world, health));
  const hit = sensor.get(botA)!;
  assert.equal(hit.hp, 75);
  assert.equal(hit.damage?.attacker, botB);
  assert.equal(hit.damage?.attackerKind, "bot");
  assert.equal(Number.isFinite(hit.damage?.dist), true);

  owned = [seat];
  for (let i = 0; i < 4; i++) sensor.update(pawnBodies(loaded.world, health));
  const player = sensor.get(botA)!.nearby.find((pawn) => pawn.id === seat);
  assert.ok(player);
  assert.equal(player.kind, "player");

  assert.equal(enqueued, 0);
  assert.equal(poses(), before);
  assert.deepEqual(health.get(botB), { hp: 100, dead: false });
  world.enqueue = orig;
});

test("host session exposes a reader", { timeout: 60_000 }, async () => {
  const host = createArenaHost(loadArena(), { holdNpcs: true });
  try {
    const start = Date.now();
    while (host.botSense.ids().length === 0) {
      if (Date.now() - start > 5000) throw new Error("botSense stayed empty");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const row = host.botSense.get(host.botSense.ids()[0]!);
    assert.ok(row);
    assert.equal(row.alive, true);
    assert.equal(row.hp, 100);
    assert.equal(row.place, "outside");
    assert.equal(Object.hasOwn(host.botSense, "update"), false);
  } finally {
    host.stop();
  }
});
