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
  const input = {
    sendInput() {},
    fire(yaw: number, pitch: number) { fired.push({ yaw, pitch }); return true; },
    grenade() { return true; },
  };
  return { world, input, fired, session: { world, input, claims: { acquire() {}, release() {} } } as never };
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
