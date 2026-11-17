import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMission } from "../packages/bot-client/src/missions.ts";
import { runAttack } from "../packages/bot-client/src/brain.ts";
import { createBotWorld } from "../packages/bot-client/src/world.ts";

function session() {
  const world = createBotWorld({ aabbs: [], doors: [], playerSpawns: [] });
  world.noteOwned(1);
  world.applySnapshot({
    spawns: [
      { entity: 1, view: { position: { x: 0, y: 0, z: 0 }, rotation: { y: 0, w: 1 } } },
      { entity: 7, view: { position: { x: 10, y: 0, z: 0 }, rotation: { y: 0, w: 1 } } },
    ],
  });
  const fired: Array<{ yaw: number; pitch: number }> = [];
  const sent: Array<{ moveX: number; moveZ: number; yaw: number }> = [];
  const input = {
    sendInput(command: { moveX: number; moveZ: number; yaw: number }) { sent.push(command); },
    fire(yaw: number, pitch: number) { fired.push({ yaw, pitch }); return true; },
    grenade() { return true; },
  };
  (world as { spatialDag?: () => unknown }).spatialDag = () => ({ hash: "test", nodes: [], chunks: [], byId: new Map() });
  return { world, input, fired, sent, session: { world, input, claims: { acquire() {}, release() {} } } as never };
}

test("attack_mission_parses_positive_ids_only", () => {
  assert.deepEqual(parseMission("attack:7"), { kind: "attack", target: 7 });
  assert.equal(parseMission("attack:0"), undefined);
  assert.equal(parseMission("attack:-1"), undefined);
  assert.equal(parseMission("attack:x"), undefined);
});

test("target_health_comes_from_any_entity", () => {
  const { world } = session();
  assert.equal(world.healthOf(7), undefined);
  world.applyHealth({ entity: 7, hp: 40, dead: false });
  assert.deepEqual(world.healthOf(7), { entity: 7, hp: 40, dead: false });
  assert.equal(world.health(), undefined);
});

test("attack_refuses_self_and_players_and_reports_lost_or_dead", async () => {
  const a = session();
  const logs: string[] = [];
  assert.equal(await runAttack(a.session, 1, { timeoutMs: 200, log: (line) => logs.push(line) }), 2);
  assert.ok(logs.some((line) => line.includes("refused")));

  a.world.applyPlayers([7]);
  assert.equal(await runAttack(a.session, 7, { timeoutMs: 200, log: (line) => logs.push(line) }), 2);
  assert.ok(logs.filter((line) => line.includes("refused")).length >= 2);

  const b = session();
  assert.equal(await runAttack(b.session, 99, { timeoutMs: 200, log: (line) => logs.push(line) }), 2);
  assert.ok(logs.some((line) => line.includes("lost")));

  const c = session();
  c.world.applyHealth({ entity: 7, hp: 0, dead: true });
  assert.equal(await runAttack(c.session, 7, { timeoutMs: 200, log: (line) => logs.push(line) }), 0);
  assert.ok(logs.some((line) => line.includes("dead")));

  const d = session();
  assert.equal(await runAttack(d.session, 7, { timeoutMs: 200, log: (line) => logs.push(line) }), 2);
  assert.ok(logs.some((line) => line.includes("no_ammo")));
});

test("attack_approach_uses_world_space_direction", async () => {
  const east = session();
  east.world.applyLoadout({ weapon: "alien-weapon-1", ammo: 30 });
  east.world.applySnapshot({
    spawns: [{ entity: 7, view: { position: { x: 25, y: 0, z: 0 }, rotation: { y: 0, w: 1 } } }],
  });
  await runAttack(east.session, 7, { timeoutMs: 120, log: () => {} });
  assert.ok(east.sent.length > 0, "no approach command");
  assert.ok(east.sent[0]!.moveX > 0.5, `east moveX ${east.sent[0]!.moveX}`);
  assert.ok(Math.abs(east.sent[0]!.moveZ) < 0.2, `east moveZ ${east.sent[0]!.moveZ}`);
  assert.ok(Math.abs(east.sent[0]!.yaw - Math.PI / 2) < 0.1, `east yaw ${east.sent[0]!.yaw}`);

  const north = session();
  north.world.applyLoadout({ weapon: "alien-weapon-1", ammo: 30 });
  north.world.applySnapshot({
    spawns: [{ entity: 7, view: { position: { x: 0, y: 0, z: 25 }, rotation: { y: 0, w: 1 } } }],
  });
  await runAttack(north.session, 7, { timeoutMs: 120, log: () => {} });
  assert.ok(north.sent.length > 0);
  assert.ok(north.sent[0]!.moveZ > 0.5, `north moveZ ${north.sent[0]!.moveZ}`);
  assert.ok(Math.abs(north.sent[0]!.moveX) < 0.2, `north moveX ${north.sent[0]!.moveX}`);
});

test("attack_reports_a_missing_dag", async () => {
  const { world, session: fake } = session();
  (world as { spatialDag?: () => unknown }).spatialDag = () => undefined;
  const logs: string[] = [];
  assert.equal(await runAttack(fake, 7, { timeoutMs: 200, log: (line) => logs.push(line) }), 2);
  assert.ok(logs.some((line) => line.includes("no_dag")));
});

test("attack_does_not_fire_through_a_player", async () => {
  const blocked = session();
  blocked.world.applyLoadout({ weapon: "alien-weapon-1", ammo: 30 });
  blocked.world.applyPlayers([8]);
  blocked.world.applySnapshot({
    spawns: [{ entity: 8, view: { position: { x: 5, y: 0, z: 0 }, rotation: { y: 0, w: 1 } } }],
  });
  const blockedLogs: string[] = [];
  await runAttack(blocked.session, 7, { timeoutMs: 180, log: (line) => blockedLogs.push(line) });
  assert.equal(blocked.fired.length, 0);
  assert.ok(blockedLogs.some((line) => line.includes("friendly_blocked")));

  const clear = session();
  clear.world.applyLoadout({ weapon: "alien-weapon-1", ammo: 30 });
  clear.world.applyPlayers([8]);
  clear.world.applySnapshot({
    spawns: [{ entity: 8, view: { position: { x: 5, y: 0, z: 4 }, rotation: { y: 0, w: 1 } } }],
  });
  await runAttack(clear.session, 7, { timeoutMs: 180, log: () => {} });
  assert.ok(clear.fired.length > 0);
});
