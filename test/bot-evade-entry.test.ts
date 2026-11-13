import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { AuthoritativeWorld } from "conveyor-engine-world";

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

const { createHostBotBrain } = await import("../src/server/bot-brain.ts");
const { steerUnownedWander } = await import("../src/server/game.ts");
const { createPawnHealth, HIT_DAMAGE, MAX_HP } = await import("../src/shared/health.ts");
const { createNavCache } = await import("../src/shared/nav/legs.ts");
const { loadArena } = await import("../src/server/world-loader.ts");

const S = 1000;
const RADIUS = 0.5;
const HEIGHT = 1.8;
const SPEEDS = { idle: 0, walk: 1, run: 2, fall: 0, angry: 0 };
const HALL = "brutalist-building-1-cbake-9.floor-1.hall";
const FLEE = { placeId: "room", x: 2, y: 0, z: 3, score: 1 };

function rect(id: string, kind: "room" | "outside", minX: number, maxX: number, minZ: number, maxZ: number) {
  return {
    id,
    kind,
    y: 0,
    polygon: [[minX, minZ], [maxX, minZ], [maxX, maxZ], [minX, maxZ]] as Array<[number, number]>,
    bounds: { minX, maxX, minZ, maxZ },
  };
}

function yardNav(open: boolean) {
  const places = [rect("room", "room", 0, 4, 0, 4), rect("outside", "outside", -80, 80, -80, 80)];
  const portals = [
    { id: "gap", kind: "door" as const, a: "room", b: "outside", door: "gap", at: { a: [3.5, 0, 2] as [number, number, number], b: [6.5, 0, 2] as [number, number, number] }, width: 2, cost: 2 },
  ];
  const portalsOf = new Map<string, typeof portals>();
  for (const portal of portals) {
    for (const id of [portal.a, portal.b]) portalsOf.set(id, [...(portalsOf.get(id) ?? []), portal]);
  }
  const sceneGraph = {
    formatVersion: 1 as const,
    units: "meters" as const,
    places,
    portals,
    placeById: new Map(places.map((item) => [item.id, item])),
    portalsOf,
    shafts: [],
    skip: new Set<string>(),
  };
  const regions = {
    version: 1 as const,
    radius: RADIUS,
    height: HEIGHT,
    places: [
      { placeId: "room", regions: [{ id: "r", minX: 0.5, maxX: 3.5, minZ: 0.5, maxZ: 3.5, y: 0 }], portals: [] },
      { placeId: "outside", regions: [{ id: "o", minX: 6.5, maxX: 9.5, minZ: 0.5, maxZ: 3.5, y: 0 }], portals: [] },
    ],
  };
  return {
    sceneGraph,
    regions,
    aabbs: [
      { id: 1, minX: 4, maxX: 6, minY: 0, maxY: 3, minZ: 0, maxZ: 1 },
      { id: 2, minX: 4, maxX: 6, minY: 0, maxY: 3, minZ: 3, maxZ: 4 },
    ],
    doors: [{ id: "gap", model: "door.glb", position: [4, 0, 3] as [number, number, number], yaw: 90, hinge: "left" as const, size: [2, 2.2, 2] as [number, number, number], open }],
    pawnRadius: RADIUS,
    pawnHeight: HEIGHT,
    liveDoors: () => [{ id: "gap", open }],
  };
}

function botWorld(x: number, z: number) {
  const world = new AuthoritativeWorld();
  const id = world.createEntity(0n, { type: "pawn", shape: "capsule" });
  world.enqueue({
    kind: "setTransform",
    entity: id,
    position: { x, y: 0, z },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    scale: { x: 1, y: 1, z: 1 },
  });
  world.enqueue({ kind: "setBounds", entity: id, radius: RADIUS });
  world.commit(0n);
  return { world, id, agent: { id, heading: 0, gait: "walk", nextTurn: 1, speeds: { ...SPEEDS } } as Record<string, any> };
}

function put(world: AuthoritativeWorld, id: number, x: number, z: number): void {
  world.enqueue({
    kind: "setTransform",
    entity: id,
    position: { x, y: 0, z },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    scale: { x: 1, y: 1, z: 1 },
  });
  world.commit(1n);
}

/** A sensor stand-in. `fresh` bumps the sense tick. A bare `brain.update` does not. */
function fakeSense(ids: number[]) {
  const rows = new Map<number, any>(ids.map((id) => [id, { id, tick: 0, at: 0, alive: true, place: "room", msNoProgress: 0, routeOut: { open: true, unlocked: true }, hpFrac: 1 }]));
  return {
    get: (id: number) => rows.get(id),
    ids: () => [...rows.keys()],
    fresh(id: number, patch: Record<string, unknown>) {
      const row = rows.get(id);
      Object.assign(row, patch, { tick: row.tick + 1 });
    },
  };
}

type Threat = { x: number; z: number };

function rig(open = true) {
  const nav = yardNav(open);
  const { world, id, agent } = botWorld(2, 2);
  let clock = 0;
  const health = createPawnHealth(() => clock);
  const sense = fakeSense([id]);
  const threats: Threat[] = [];
  let calls = 0;
  const brain = createHostBotBrain({
    world,
    agents: [agent as never],
    health,
    sense,
    nav,
    now: () => clock,
    lineOfSight: () => true,
    pickFlee(input) {
      calls += 1;
      threats.push({ x: input.threat.x, z: input.threat.z });
      return FLEE;
    },
  });
  sense.fresh(id, { at: 0 });
  brain.update();
  return {
    world, id, agent, nav, health, sense, brain, threats,
    calls: () => calls,
    get clock() { return clock; },
    set clock(next: number) { clock = next; },
  };
}

test("hp drop during a wander leg evades, and a second hit 300 ms later re-picks", () => {
  const bot = rig(true);
  const foe = bot.world.createEntity(0n, { type: "pawn", shape: "capsule" });
  put(bot.world, foe, 2, 0);
  steerUnownedWander(bot.world, bot.agent as never, 1, () => 0.1, bot.nav, createNavCache());
  assert.ok(bot.agent.path && bot.agent.path.length > 0, "mid-leg");
  const leg = bot.agent.goal;
  // No sense tick. The wound is the same call fire.ts makes.
  const hit = bot.health.wound(bot.id, foe, undefined, "laser");
  assert.equal(hit?.hp, MAX_HP - HIT_DAMAGE);
  bot.brain.update();
  assert.equal(bot.brain.goalOf(bot.id), "evade");
  assert.equal(bot.calls(), 1);
  assert.deepEqual(bot.threats[0], { x: 2, z: 0 });
  assert.deepEqual(bot.agent.override.goal, { x: FLEE.x, y: FLEE.y, z: FLEE.z });
  assert.equal(bot.agent.override.gait, "run");
  assert.notEqual(bot.agent.override.openDoors, true);
  assert.notEqual(bot.agent.goal, leg, "the wander leg is dropped");
  steerUnownedWander(bot.world, bot.agent as never, 2, () => 0.1, bot.nav, createNavCache());
  assert.equal(bot.agent.gait, "run");
  bot.brain.update();
  assert.equal(bot.calls(), 1, "the same hp does not re-pick");
  bot.clock = 300;
  bot.health.wound(bot.id, foe, undefined, "laser");
  bot.brain.update();
  assert.equal(bot.brain.goalOf(bot.id), "evade");
  assert.equal(bot.calls(), 2);
});

test("hp drop during Escape evades without opening a door", () => {
  const door = { open: false };
  const nav = yardNav(false);
  nav.liveDoors = () => [{ id: "gap", open: door.open }];
  const { world, id, agent } = botWorld(2, 2);
  let clock = 0;
  const health = createPawnHealth(() => clock);
  const sense = fakeSense([id]);
  let calls = 0;
  const brain = createHostBotBrain({
    world,
    agents: [agent as never],
    health,
    sense,
    nav,
    now: () => clock,
    pickFlee: () => {
      calls += 1;
      return FLEE;
    },
  });
  const inside = { place: "room", msNoProgress: 0, routeOut: { open: false, unlocked: false } };
  const tick = () => {
    sense.fresh(id, { at: clock, ...inside });
    brain.update();
  };
  tick();
  for (clock = S; clock <= 65 * S; clock += S) tick();
  assert.equal(brain.goalOf(id), "escape");
  door.open = true;
  nav.doors[0]!.open = true;
  clock += 6 * S;
  sense.fresh(id, { at: clock, place: "room", msNoProgress: 60 * S, routeOut: { open: true, unlocked: true } });
  brain.update();
  assert.equal(brain.goalOf(id), "escape");
  assert.ok(agent.override, "escape has a stand point");
  const stand = agent.override.goal;
  const foe = world.createEntity(0n, { type: "pawn", shape: "capsule" });
  put(world, foe, 0, 2);
  health.wound(id, foe, undefined, "laser");
  brain.update();
  assert.equal(brain.goalOf(id), "evade");
  assert.equal(calls, 1);
  assert.deepEqual(agent.override.goal, { x: FLEE.x, y: FLEE.y, z: FLEE.z });
  assert.notDeepEqual(agent.override.goal, stand);
  assert.equal(agent.override.gait, "run");
  assert.notEqual(agent.override.openDoors, true);
});

test("hp drop right after a cornered Evade starts Evade again", () => {
  const bot = rig(true);
  const foe = bot.world.createEntity(0n, { type: "pawn", shape: "capsule" });
  put(bot.world, foe, 2, 0);
  const tick = () => {
    bot.sense.fresh(bot.id, { at: bot.clock, damage: { attacker: foe, ageMs: 0, seq: 1 } });
    bot.brain.update();
  };
  tick();
  assert.equal(bot.brain.goalOf(bot.id), "evade");
  for (let i = 0; i < 3; i += 1) {
    bot.agent.followEnd = "arrived";
    tick();
  }
  bot.agent.followEnd = "stuck";
  tick();
  assert.equal(bot.brain.goalOf(bot.id), "wander");
  assert.equal(bot.agent.override, undefined);
  const picks = bot.calls();
  bot.health.wound(bot.id, foe, undefined, "laser");
  bot.brain.update();
  assert.equal(bot.brain.goalOf(bot.id), "evade");
  assert.equal(bot.calls(), picks + 1);
  assert.equal(bot.agent.override.gait, "run");
  assert.deepEqual(bot.threats.at(-1), { x: 2, z: 0 });
});

test("a grenade with no attacker evades from the bot's own position", () => {
  const bot = rig(true);
  bot.health.wound(bot.id, undefined, undefined, "grenade");
  bot.brain.update();
  assert.equal(bot.brain.goalOf(bot.id), "evade");
  assert.equal(bot.calls(), 1);
  assert.deepEqual(bot.threats[0], { x: 2, z: 2 });
  assert.equal(bot.agent.override.gait, "run");
});

test("ten laser hits in the hallway each produce Evade", () => {
  const loaded = loadArena();
  const agent = loaded.agents.find((item) => item.role !== "player")!;
  const region = loaded.regions!.places.find((place) => place.placeId === HALL)!.regions[6]!;
  const at = { x: (region.minX + region.maxX) / 2, y: region.y, z: (region.minZ + region.maxZ) / 2 };
  loaded.world.enqueue({
    kind: "setTransform",
    entity: agent.id,
    position: at,
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    scale: { x: 1, y: 1, z: 1 },
  });
  const foe = loaded.world.createEntity(0n, { type: "pawn", shape: "capsule" });
  loaded.world.enqueue({
    kind: "setTransform",
    entity: foe,
    position: { x: at.x, y: at.y, z: at.z + 3 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    scale: { x: 1, y: 1, z: 1 },
  });
  loaded.world.commit(1n);
  let clock = 0;
  const health = createPawnHealth(() => clock);
  const sense = fakeSense([agent.id]);
  sense.fresh(agent.id, { place: HALL, at: 0 });
  const doors = loaded.view.doors.map((door) => ({ ...door }));
  const nav = {
    sceneGraph: loaded.sceneGraph!,
    regions: loaded.regions!,
    aabbs: loaded.view.aabbs,
    doors,
    pawnRadius: loaded.view.pawnRadius,
    pawnHeight: loaded.view.pawnHeight,
    liveDoors: () => doors.map((door) => ({ id: door.id, open: door.open === true })),
  };
  const brain = createHostBotBrain({
    world: loaded.world,
    agents: [agent],
    health,
    sense,
    nav,
    now: () => clock,
  });
  brain.update();
  assert.equal(brain.goalOf(agent.id), "wander");
  const goals: string[] = [];
  for (let shot = 0; shot < 10; shot += 1) {
    if (health.get(agent.id).hp <= HIT_DAMAGE) {
      health.heal(agent.id, MAX_HP);
      brain.update();
    }
    clock += 300;
    const next = health.wound(agent.id, foe, undefined, "laser");
    assert.equal(next?.dead, false, `shot ${shot + 1} killed`);
    brain.update();
    goals.push(brain.goalOf(agent.id) ?? "none");
  }
  assert.deepEqual(goals, Array.from({ length: 10 }, () => "evade"));
});
