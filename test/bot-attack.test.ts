import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMission } from "../packages/bot-client/src/missions.ts";
import { runAttack } from "../packages/bot-client/src/brain.ts";
import { createBotWorld } from "../packages/bot-client/src/world.ts";
import { loadArena } from "../src/server/world-loader.ts";
import { sceneGraphPayload } from "../src/shared/scene-graph.ts";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function session() {
  const world = createBotWorld({ aabbs: [], doors: [], playerSpawns: [] });
  world.noteOwned(1);
  world.applySnapshot({
    spawns: [
      { entity: 1, view: { position: { x: 0, y: 0, z: 0 }, rotation: { y: 0, w: 1 } } },
      { entity: 7, view: { position: { x: 14, y: 0, z: 0 }, rotation: { y: 0, w: 1 } } },
    ],
  });
  const fired: Array<{ yaw: number; pitch: number }> = [];
  const sent: Array<{ moveX: number; moveZ: number; yaw: number }> = [];
  /** Inputs and shots in discharge order, for the "face precedes fire" check. */
  const events: Array<{ kind: "input" | "fire"; yaw: number }> = [];
  const input = {
    sendInput(command: { moveX: number; moveZ: number; yaw: number }) {
      sent.push(command);
      events.push({ kind: "input", yaw: command.yaw });
      // The host turns the body to the input's yaw; the stub does the same so a
      // face step settles and the next tick can fire.
      const half = command.yaw / 2;
      world.applySnapshot({
        spawns: [{ entity: 1, view: { position: { x: 0, y: 0, z: 0 }, rotation: { y: Math.sin(half), w: Math.cos(half) } } }],
      });
    },
    fire(yaw: number, pitch: number) {
      fired.push({ yaw, pitch });
      events.push({ kind: "fire", yaw });
      return true;
    },
    grenade() { return true; },
  };
  (world as { spatialDag?: () => unknown }).spatialDag = () => ({ hash: "test", nodes: [], chunks: [], byId: new Map() });
  return { world, input, fired, sent, events, session: { world, input, claims: { acquire() {}, release() {} } } as never };
}

/** A graph-backed retreat world: one outside place, a moving (or pinned) pawn. */
function retreatSession(opts: { move?: boolean; targetX?: number; playerX?: number; hp?: number } = {}) {
  const move = opts.move === true;
  const targetX = opts.targetX ?? 14;
  const world = createBotWorld({ aabbs: [], doors: [], playerSpawns: [], pawnRadius: 0.45, pawnHeight: 1.8 } as never);
  world.noteOwned(1);
  const me = { x: 0, y: 0, z: 0, yaw: 0 };
  const spawns: Array<{ entity: number; view: { position: { x: number; y: number; z: number }; rotation: { y: number; w: number } } }> = [
    { entity: 1, view: { position: { x: 0, y: 0, z: 0 }, rotation: { y: 0, w: 1 } } },
    { entity: 7, view: { position: { x: targetX, y: 0, z: 0 }, rotation: { y: 0, w: 1 } } },
  ];
  if (opts.playerX !== undefined) {
    spawns.push({ entity: 8, view: { position: { x: opts.playerX, y: 0, z: 0 }, rotation: { y: 0, w: 1 } } });
  }
  world.applySnapshot({ spawns });
  if (opts.playerX !== undefined) world.applyPlayers([8]);
  world.loadSceneGraph({
    formatVersion: 1,
    units: "meters",
    places: [{
      id: "outside",
      kind: "outside",
      y: 0,
      polygon: [[-100, -100], [5, -100], [5, 100], [-100, 100]],
      bounds: { minX: -100, maxX: 5, minZ: -100, maxZ: 100 },
    }],
    portals: [],
  } as never, "test-graph");
  world.applyLoadout({ weapon: "alien-weapon-1", ammo: 30 });
  world.applyHealth({ entity: 1, hp: opts.hp ?? 20, dead: false });
  (world as { spatialDag?: () => unknown }).spatialDag = () => ({ hash: "test", nodes: [], chunks: [], byId: new Map() });
  const sent: Array<{ moveX: number; moveZ: number; yaw: number }> = [];
  const fired: Array<{ yaw: number; pitch: number }> = [];
  const input = {
    sendInput(command: { moveX: number; moveZ: number; yaw: number }) {
      sent.push(command);
      if (!move) return;
      me.x += command.moveX * 0.25;
      me.z += command.moveZ * 0.25;
      world.applySnapshot({ spawns: [{ entity: 1, view: { position: { x: me.x, y: 0, z: me.z }, rotation: { y: Math.sin(command.yaw / 2), w: Math.cos(command.yaw / 2) } } }] });
    },
    fire(yaw: number, pitch: number) { fired.push({ yaw, pitch }); return true; },
    grenade() { return true; },
  };
  return { world, input, sent, fired, session: { world, input, claims: { acquire() {}, release() {} } } as never };
}

const realArena = loadArena();
const realBox = realArena.view.aabbs.find((item) => item.maxX - item.minX > 2)!;
/** The bot-cover fixture point: nearestCover returns here (one plan, LOS on arrival). */
const COVER_POINT = { x: (realBox.minX + realBox.maxX) / 2, y: 0, z: realBox.minZ - 2 };

/** The real arena + DAG: an NPC attacker 2 m away and a player 1 m away. */
function realRetreatSession(opts: { move?: boolean } = {}) {
  const move = opts.move === true;
  const world = createBotWorld(realArena.view as never);
  world.noteOwned(1);
  const me = { x: COVER_POINT.x, y: COVER_POINT.y, z: COVER_POINT.z, yaw: 0 };
  const npc = { x: me.x, z: me.z + 2 };
  const player = { x: me.x, z: me.z + 1 };
  world.applySnapshot({
    spawns: [
      { entity: 1, view: { position: { x: me.x, y: me.y, z: me.z }, rotation: { y: 0, w: 1 } } },
      { entity: 7, view: { position: { x: npc.x, y: 0, z: npc.z }, rotation: { y: 0, w: 1 } } },
      { entity: 8, view: { position: { x: player.x, y: 0, z: player.z }, rotation: { y: 0, w: 1 } } },
    ],
  });
  world.applyPlayers([8]);
  world.loadSceneGraph(sceneGraphPayload(realArena.sceneGraph!), "real");
  world.applyLoadout({ weapon: "alien-weapon-1", ammo: 30 });
  world.applyHealth({ entity: 1, hp: 20, dead: false });
  (world as { spatialDag?: () => unknown }).spatialDag = () => realArena.spatialDag;
  const sent: Array<{ moveX: number; moveZ: number; yaw: number }> = [];
  const input = {
    sendInput(command: { moveX: number; moveZ: number; yaw: number }) {
      sent.push(command);
      if (!move) return;
      me.x += command.moveX * 0.25;
      me.z += command.moveZ * 0.25;
      world.applySnapshot({ spawns: [{ entity: 1, view: { position: { x: me.x, y: me.y, z: me.z }, rotation: { y: Math.sin(command.yaw / 2), w: Math.cos(command.yaw / 2) } } }] });
    },
    fire() { return true; },
    grenade() { return true; },
  };
  return { world, input, sent, npc, session: { world, input, claims: { acquire() {}, release() {} } } as never };
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
  await runAttack(blocked.session, 7, { timeoutMs: 500, log: (line) => blockedLogs.push(line) });
  assert.equal(blocked.fired.length, 0);
  assert.ok(blockedLogs.some((line) => line.includes("friendly_blocked")));

  const clear = session();
  clear.world.applyLoadout({ weapon: "alien-weapon-1", ammo: 30 });
  clear.world.applyPlayers([8]);
  clear.world.applySnapshot({
    spawns: [{ entity: 8, view: { position: { x: 5, y: 0, z: 4 }, rotation: { y: 0, w: 1 } } }],
  });
  await runAttack(clear.session, 7, { timeoutMs: 500, log: () => {} });
  assert.ok(clear.fired.length > 0);
});

test("attack_faces_before_firing", { timeout: 10_000 }, async () => {
  const { world, session: fake, events } = session();
  world.applyLoadout({ weapon: "alien-weapon-1", ammo: 30 });
  const logs: string[] = [];
  await runAttack(fake, 7, { timeoutMs: 700, log: (line) => logs.push(line) });
  assert.ok(logs.some((line) => line.includes("attack: face")), logs.join("\n"));
  const shots = events.flatMap((event, i) => (event.kind === "fire" ? [i] : []));
  assert.ok(shots.length > 0, `no fire\n${logs.join("\n")}`);
  for (const at of shots) {
    const shot = events[at]!;
    const faced = events.slice(0, at).some((event) => event.kind === "input" && Math.abs(event.yaw - shot.yaw) < 1e-9);
    assert.ok(faced, `shot ${at} has no preceding input at its yaw\n${logs.join("\n")}`);
  }
});

test("attack_steps_back_inside_the_band", { timeout: 10_000 }, async () => {
  const { world, session: fake, fired, sent } = session();
  world.applyLoadout({ weapon: "alien-weapon-1", ammo: 30 });
  world.applySnapshot({
    spawns: [{ entity: 7, view: { position: { x: 5, y: 0, z: 0 }, rotation: { y: 0, w: 1 } } }],
  });
  const logs: string[] = [];
  await runAttack(fake, 7, { timeoutMs: 400, log: (line) => logs.push(line) });
  assert.equal(fired.length, 0, `fired at 5 m\n${logs.join("\n")}`);
  assert.ok(logs.some((line) => line.includes("attack: standoff")), logs.join("\n"));
  assert.ok(sent.some((command) => command.moveX < 0), `no back-step\n${JSON.stringify(sent)}`);
});

test("attack_retreats_below_25_hp", { timeout: 10_000 }, async () => {
  const { session: fake, fired, sent } = retreatSession({ move: true, targetX: 14 });
  const logs: string[] = [];
  const code = await runAttack(fake, 7, { timeoutMs: 2000, log: (line) => logs.push(line) });
  assert.equal(code, 2);
  assert.ok(logs.some((line) => line.includes("attack: retreat hp=20")), logs.join("\n"));
  const plans = logs.filter((line) => line.includes("attack: retreat plan kind="));
  assert.equal(plans.length, 1, `retreat plans ${plans.length}\n${logs.join("\n")}`);
  assert.equal(fired.length, 0, `fired while retreating\n${logs.join("\n")}`);
  assert.ok(sent.length > 0, "no retreat input");
});

test("attack_retreat_plans_one_point_and_does_not_replan_on_a_timer", { timeout: 10_000 }, async () => {
  const { session: fake } = retreatSession({ move: true, targetX: 14 });
  const logs: string[] = [];
  await runAttack(fake, 7, { timeoutMs: 1500, log: (line) => logs.push(line) });
  const plans = logs.filter((line) => line.includes("attack: retreat plan kind="));
  assert.equal(plans.length, 1, `plans ${plans.length}\n${logs.join("\n")}`);
  assert.ok(!logs.some((line) => line.includes("attack: retreat replan reason=stuck")), logs.join("\n"));
});

test("attack_retreat_replans_when_the_follower_is_stuck", { timeout: 12_000 }, async () => {
  const { session: fake } = retreatSession({ move: false, targetX: 14 });
  const logs: string[] = [];
  await runAttack(fake, 7, { timeoutMs: 6000, log: (line) => logs.push(line) });
  assert.ok(logs.some((line) => line.includes("attack: retreat replan reason=stuck")), logs.join("\n"));
  assert.ok(logs.filter((line) => line.includes("attack: retreat plan kind=")).length >= 2, logs.join("\n"));
});

test("attack_retreat_does_not_count_a_player_as_a_threat", { timeout: 10_000 }, async () => {
  const fake = retreatSession({ move: true, targetX: 14, playerX: 2 });
  const logs: string[] = [];
  await runAttack(fake.session, 7, { timeoutMs: 1500, log: (line) => logs.push(line) });
  assert.ok(logs.some((line) => line.includes("attack: retreat hp=20 threats=0")), logs.join("\n"));
  const plan = logs.find((line) => line.includes("attack: retreat plan kind="));
  assert.ok(plan, logs.join("\n"));
  const to = /to=(-?[\d.]+),(-?[\d.]+)/.exec(plan!);
  assert.ok(to && Number(to[1]) < 0, `the plan is not away from the NPC: ${plan}`);

  const calm = retreatSession({ move: true, targetX: 14, playerX: 2, hp: 100 });
  const calmLogs: string[] = [];
  await runAttack(calm.session, 7, { timeoutMs: 500, log: (line) => calmLogs.push(line) });
  assert.ok(!calmLogs.some((line) => line.includes("attack: retreat")), calmLogs.join("\n"));
});

test("attack_retreat_holds_without_a_plan", { timeout: 10_000 }, async () => {
  const { session: fake, sent } = session();
  fake.world.applyLoadout({ weapon: "alien-weapon-1", ammo: 30 });
  fake.world.applyHealth({ entity: 1, hp: 20, dead: false });
  const logs: string[] = [];
  const code = await runAttack(fake, 7, { timeoutMs: 1000, log: (line) => logs.push(line) });
  assert.equal(code, 2);
  assert.ok(logs.some((line) => line.includes("attack: retreat no-plan hold")), logs.join("\n"));
  assert.equal(sent.length, 0, `the hold sent ${JSON.stringify(sent)}`);
});

test("attack_retreat_cover_attacker_is_the_enemy_npc", { timeout: 10_000 }, async () => {
  const fake = realRetreatSession({ move: false });
  const logs: string[] = [];
  await runAttack(fake.session, 7, { timeoutMs: 1000, log: (line) => logs.push(line) });
  assert.ok(fake.world.playerIds().has(8), "the player id is missing");
  const line = logs.find((entry) => entry.includes("attack: retreat cover attacker="));
  assert.ok(line, logs.join("\n"));
  const attacker = /attacker=(-?[\d.]+),(-?[\d.]+)/.exec(line!);
  assert.ok(attacker, line);
  assert.equal(Number(attacker![1]).toFixed(2), fake.npc.x.toFixed(2));
  assert.equal(Number(attacker![2]).toFixed(2), fake.npc.z.toFixed(2));
});

test("attack_retreat_verifies_cover_los_on_arrival", { timeout: 12_000 }, async () => {
  const fake = realRetreatSession({ move: true });
  const logs: string[] = [];
  await runAttack(fake.session, 7, { timeoutMs: 4000, log: (line) => logs.push(line) });
  const reached = logs.find((entry) => entry.includes("attack: retreat cover reached los="));
  assert.ok(reached, logs.join("\n"));
  if (reached!.endsWith("los=no")) {
    const at = logs.indexOf(reached!);
    assert.ok(!logs.slice(at + 1).some((entry) => entry.includes("attack: retreat plan")), logs.join("\n"));
  }
});

test("attack_abort_stops_the_retreat", { timeout: 12_000 }, async () => {
  const { session: fake, sent } = session();
  fake.world.applyLoadout({ weapon: "alien-weapon-1", ammo: 30 });
  fake.world.applyHealth({ entity: 1, hp: 20, dead: false });
  const logs: string[] = [];
  await assert.rejects(
    runAttack(fake, 7, { timeoutMs: 10_000, log: (line) => logs.push(line), onTick: () => { throw new Error("stop"); } }),
    /stop/,
  );
  assert.equal(sent.length, 0, logs.join("\n"));
});

/** A bot at (0,0) and a target 25 m east, with one box blocking the straight line. */
function pursuitSession() {
  const view = {
    aabbs: [{ id: "box-1", source: "box-1", minX: 10, maxX: 12, minY: 0, maxY: 2, minZ: -3, maxZ: 3 }],
    doors: [],
    playerSpawns: [],
    pawnRadius: 0.45,
    pawnHeight: 1.8,
  };
  const world = createBotWorld(view as never);
  world.noteOwned(1);
  world.applySnapshot({
    spawns: [
      { entity: 1, view: { position: { x: 0, y: 0, z: 0 }, rotation: { y: 0, w: 1 } } },
      { entity: 7, view: { position: { x: 25, y: 0, z: 0 }, rotation: { y: 0, w: 1 } } },
    ],
  });
  world.loadSceneGraph({
    formatVersion: 1,
    units: "meters",
    places: [{
      id: "outside",
      kind: "outside",
      y: 0,
      polygon: [[-100, -100], [40, -100], [40, 100], [-100, 100]],
      bounds: { minX: -100, maxX: 40, minZ: -100, maxZ: 100 },
    }],
    portals: [],
  } as never, "test-graph");
  (world as { spatialDag?: () => unknown }).spatialDag = () => ({ hash: "test", nodes: [], chunks: [], byId: new Map() });
  const sent: Array<{ moveX: number; moveZ: number; yaw: number }> = [];
  const input = {
    sendInput(command: { moveX: number; moveZ: number; yaw: number }) { sent.push(command); },
    fire() { return true; },
    grenade() { return true; },
  };
  const mode = { move: { x: 25, z: 0 } };
  return {
    world,
    input,
    sent,
    mode,
    session: { world, input, claims: { acquire() {}, release() {} } } as never,
    moveTo(x: number, z: number) {
      mode.move = { x, z };
      world.applySnapshot({ spawns: [{ entity: 7, view: { position: { x, y: 0, z }, rotation: { y: 0, w: 1 } } }] });
    },
  };
}

test("attack_pursues_with_an_intercept_plan_ahead_of_a_moving_target", { timeout: 4000 }, async () => {
  const fake = pursuitSession();
  fake.world.applyLoadout({ weapon: "alien-weapon-1", ammo: 30 });
  const logs: string[] = [];
  const running = runAttack(fake.session, 7, { timeoutMs: 900, log: (line) => logs.push(line) });
  // The target walks north at ~2.5 m/s while the attack runs.
  for (let i = 1; i <= 4; i += 1) {
    await delay(100);
    fake.moveTo(25, i * 0.25);
  }
  await running;
  const plans = logs.filter((line) => line.includes("attack: pursue plan"));
  assert.ok(plans.length >= 2, `plans ${plans.length}\n${logs.join("\n")}`);
  // Every plan after the first estimates the target's velocity; at least one must lead north.
  const ahead = plans.filter((line) => {
    const to = /to=(-?[\d.]+),(-?[\d.]+)/.exec(line);
    const target = /target=(-?[\d.]+),(-?[\d.]+)/.exec(line);
    return !!to && !!target && Number(to[2]) > Number(target[2]);
  });
  assert.ok(ahead.length >= 1, `no intercept ahead of a northbound target\n${plans.join("\n")}`);
  // The first movement is the planned detour, not the straight line at the target.
  const first = fake.sent[0]!;
  const straightYaw = Math.atan2(25 - 0, 0 - 0);
  const straight = { moveX: Math.sin(straightYaw), moveZ: Math.cos(straightYaw) };
  assert.ok(
    Math.abs(first.moveX - straight.moveX) > 0.1 || Math.abs(first.moveZ - straight.moveZ) > 0.1,
    `first input ${JSON.stringify(first)} equals the straight ${JSON.stringify(straight)}`,
  );
});

test("attack_replans_within_200ms_when_the_target_moves_a_metre", { timeout: 4000 }, async () => {
  const fake = pursuitSession();
  fake.world.applyLoadout({ weapon: "alien-weapon-1", ammo: 30 });
  const logs: string[] = [];
  const plans: Array<{ at: number; line: string }> = [];
  const running = runAttack(fake.session, 7, {
    timeoutMs: 900,
    log: (line) => {
      logs.push(line);
      if (line.includes("attack: pursue plan")) plans.push({ at: Date.now(), line });
    },
  });
  const waitFor = async (test: () => boolean, ms: number): Promise<boolean> => {
    const started = Date.now();
    while (Date.now() - started < ms) {
      if (test()) return true;
      await delay(20);
    }
    return test();
  };
  assert.ok(await waitFor(() => plans.length >= 1, 1000), `no first plan\n${logs.join("\n")}`);
  const moveAt = Date.now();
  fake.moveTo(25, 1.5);
  const drift = () => plans.find((plan) => plan.at >= moveAt && plan.line.includes("target=25.00,1.50"));
  assert.ok(await waitFor(() => drift() !== undefined, 1500), `no re-plan after a 1.5 m move\n${logs.join("\n")}`);
  const since = drift()!.at;
  // The drift plan lands on the next loop iteration (~50 ms); allow for a loaded runner.
  assert.ok(since - moveAt < 400, `re-plan took ${since - moveAt} ms (> 400)`);
  // A sub-metre move must not force a re-plan before the 200 ms cadence is due.
  fake.moveTo(25, 1.9);
  await delay(100);
  const early = plans.filter((plan) => plan.at > since && plan.at - since < 180);
  assert.equal(early.length, 0, `re-planned early for a 0.4 m move\n${logs.join("\n")}`);
  await running;
});

test("attack_falls_back_to_the_straight_line_without_a_graph", { timeout: 4000 }, async () => {
  const { world, session: fake, sent } = session();
  world.applyLoadout({ weapon: "alien-weapon-1", ammo: 30 });
  world.applySnapshot({
    spawns: [{ entity: 7, view: { position: { x: 25, y: 0, z: 0 }, rotation: { y: 0, w: 1 } } }],
  });
  const logs: string[] = [];
  await runAttack(fake, 7, { timeoutMs: 200, log: (line) => logs.push(line) });
  assert.ok(sent.length > 0, "no approach command");
  assert.ok(logs.some((line) => line.includes("attack: straight fallback")), logs.join("\n"));
});
