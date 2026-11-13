import assert from "node:assert/strict";
import test from "node:test";
import { createArenaFire } from "../src/server/fire.ts";
import { createArenaGrenades } from "../src/server/grenade.ts";
import { createPawnHealth, HIT_DAMAGE, MAX_HP } from "../src/shared/health.ts";
import { FIRE_INTERVAL_MS, type LaserFrame } from "../src/shared/hitscan.ts";
import type { GrenadePose } from "../src/shared/grenade.ts";

/** No client owns these. The watcher client owns a different id and has them in `known`. */
const BOT = 7;
const BOT_B = 8;
const TARGET = 9;
const WATCHER = 1;
const WATCHER_PAWN = 99;

type Pawn = {
  id: number;
  position: { x: number; y: number; z: number };
  lifecycle: "alive";
  radius: number;
};

function pawns(): Pawn[] {
  return [
    { id: BOT, position: { x: 0, y: 0, z: 0 }, lifecycle: "alive", radius: 0.5 },
    { id: BOT_B, position: { x: 10, y: 0, z: 0 }, lifecycle: "alive", radius: 0.5 },
    { id: TARGET, position: { x: 0, y: 0, z: 4 }, lifecycle: "alive", radius: 0.5 },
  ];
}

function worldOf(rows: Pawn[]) {
  return {
    store: { view: (id: number) => rows.find((pawn) => pawn.id === id) },
    pawnHeight: 1.8,
    listObstacles: () => [],
    query: () => rows,
  };
}

function serverOf(rows: Pawn[]) {
  return {
    session: () => ({ sessionId: 1 }),
    replicator: {
      get: () => ({
        ownedEntity: WATCHER_PAWN,
        connected: true,
        known: new Set(rows.map((pawn) => pawn.id)),
      }),
    },
    connected: [WATCHER],
  };
}

function fireRig() {
  const rows = pawns();
  const health = createPawnHealth(() => 0);
  for (const row of rows) health.note(row.id);
  const lasers: LaserFrame[] = [];
  const clients: number[] = [];
  let now = 0;
  const fire = createArenaFire({
    world: worldOf(rows) as never,
    server: serverOf(rows) as never,
    now: () => now,
    health,
    send(clientId, frame) {
      clients.push(clientId);
      lasers.push(frame);
    },
  });
  return {
    fire,
    health,
    lasers,
    clients,
    setNow(at: number) {
      now = at;
    },
  };
}

test("fireAsBot on a host-only pawn wounds a capsule and broadcasts a laser", () => {
  const rig = fireRig();
  assert.notEqual(WATCHER_PAWN, BOT);
  assert.equal(rig.fire.fireAsBot(BOT, 0, 0), "accept");
  assert.equal(rig.lasers.length, 1);
  assert.equal(rig.clients[0], WATCHER);
  assert.equal(rig.lasers[0]?.t, "laser");
  assert.equal(rig.lasers[0]?.shooter, BOT);
  assert.equal(rig.health.get(TARGET).hp, MAX_HP - HIT_DAMAGE);
  assert.equal(rig.health.lastDamage(TARGET)?.attacker, BOT);
  assert.equal(rig.health.get(BOT).hp, MAX_HP);
});

test("fireAsBot is fast inside the interval and a dead shooter sends nothing", () => {
  const rig = fireRig();
  assert.equal(rig.fire.fireAsBot(BOT, 0, 0), "accept");
  const sent = rig.lasers.length;
  assert.equal(sent, 1);
  assert.equal(rig.fire.fireAsBot(BOT, 0, 0), "fast");
  assert.equal(rig.lasers.length, sent);

  rig.setNow(FIRE_INTERVAL_MS);
  rig.health.wound(BOT, 0, MAX_HP);
  assert.equal(rig.health.isDead(BOT), true);
  assert.equal(rig.fire.fireAsBot(BOT, 0, 0), "dead");
  assert.equal(rig.lasers.length, sent);
  assert.equal(rig.health.get(TARGET).hp, MAX_HP - HIT_DAMAGE);
});

test("two bots have independent fire gates", () => {
  const rig = fireRig();
  assert.equal(rig.fire.fireAsBot(BOT, 0, 0), "accept");
  assert.equal(rig.fire.fireAsBot(BOT, 0, 0), "fast");
  assert.equal(rig.fire.fireAsBot(BOT_B, 0, 0), "accept");
  assert.equal(rig.fire.fireAsBot(BOT_B, 0, 0), "fast");
  assert.equal(rig.lasers.length, 2);
  assert.equal(rig.lasers[0]?.shooter, BOT);
  assert.equal(rig.lasers[1]?.shooter, BOT_B);
});

test("forgetBot drops that bot's fire gate", () => {
  const rig = fireRig();
  assert.equal(rig.fire.fireAsBot(BOT, 0, 0), "accept");
  assert.equal(rig.fire.fireAsBot(BOT_B, 0, 0), "accept");
  assert.equal(rig.fire.fireAsBot(BOT, 0, 0), "fast");
  assert.equal(rig.fire.fireAsBot(BOT_B, 0, 0), "fast");
  rig.fire.forgetBot(BOT);
  assert.equal(rig.fire.fireAsBot(BOT, 0, 0), "accept");
  assert.equal(rig.fire.fireAsBot(BOT_B, 0, 0), "fast");
});

test("throwAsBot launches a body the next tick advances, owned by the bot", () => {
  const rows = pawns();
  const health = createPawnHealth(() => 0);
  for (const row of rows) health.note(row.id);
  const poses: GrenadePose[] = [];
  const host = createArenaGrenades({
    world: worldOf(rows) as never,
    server: serverOf(rows) as never,
    now: () => 0,
    health,
    send(_clientId, frame) {
      poses.push(frame);
    },
  });
  assert.equal(host.throwAsBot(BOT, 0, 0), "accept");
  assert.equal(host.throwAsBot(BOT, 0, 0), "fast");
  assert.equal(poses.length, 1);
  const spawned = poses[0];
  assert.ok(spawned);
  assert.equal(spawned.t, "grenade");
  host.tick();
  const moved = poses[1];
  assert.ok(moved);
  assert.equal(moved.id, spawned.id);
  assert.ok(moved.z > spawned.z, `tick advanced z from ${spawned.z} to ${moved.z}`);
  for (let i = 0; i < 40 && health.get(TARGET).hp === MAX_HP; i++) host.tick();
  assert.equal(health.lastDamage(TARGET)?.attacker, BOT);
  assert.equal(health.get(BOT).hp, MAX_HP);
});
