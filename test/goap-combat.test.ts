import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  assaultGoal,
  chooseCombatGoal,
  combatActions,
  combatFacts,
  combatGoals,
  combatHeuristic,
  type HpClock,
} from "../packages/bot-client/src/combat.ts";
import { createBotContext, groundActions, placeOfPickup, type BotCtx } from "../src/shared/bots/actions.ts";
import type { Action, Goal, WorldState } from "../src/shared/bots/goap.ts";
import { plan } from "../src/shared/bots/goap.ts";
import type { PickupPlacement } from "../src/shared/pickups.ts";
import { parseSceneGraph } from "../src/shared/scene-graph.ts";
import { buildWorldState } from "../src/shared/bots/state.ts";
import { loadArena } from "../src/server/world-loader.ts";

type Pawn = { id: number; x: number; y: number; z: number };
type Crate = PickupPlacement;

function fakeSession(opts: {
  hp?: number;
  weapon?: string;
  ammo?: number;
  others?: Pawn[];
  crates?: Crate[];
  aabbs?: unknown[];
  graph?: unknown;
  self?: { id: number; x: number; y: number; z: number };
  place?: string;
} = {}) {
  const self = opts.self ?? { id: 1, x: 0, y: 0, z: 0 };
  const world = {
    self: () => self,
    health: () => ({ hp: opts.hp ?? 100, dead: false }),
    healthOf: () => ({ hp: 100, dead: false }),
    weapon: () => opts.weapon ?? "",
    ammo: () => opts.ammo ?? 0,
    playerIds: () => new Set([1]),
    others: () => opts.others ?? [],
    aabbs: opts.aabbs ?? [],
    pickups: () => (opts.crates ?? []).map((crate) => crate.id),
    pickupPlacements: () => opts.crates ?? [],
    placeOf: () => ({ id: opts.place ?? "outside" }),
    sceneGraph: () => opts.graph,
  };
  return { world, session: { world } as never };
}

const act = (id: string, pre: WorldState, eff: WorldState, cost: number): Action<BotCtx> => ({ id, pre, eff, cost });
const DEADLINE_MS = 600;

function choose(state: WorldState, actions: Action<BotCtx>[], mission?: Goal) {
  return chooseCombatGoal(state, combatGoals(state, mission), actions, undefined as unknown as BotCtx, () => ({
    deadlineMs: Date.now() + DEADLINE_MS,
    now: () => Date.now(),
    heuristic: (s: WorldState) => (s.hpHigh ? 0 : 1),
  }));
}

test("combat_facts_follow_the_bands_and_the_clock", () => {
  const now = 10_000;
  const at70 = combatFacts(fakeSession({ hp: 70, weapon: "laser", ammo: 5 }).session, { hp: 70, at: -Infinity }, now);
  assert.equal(at70.hpHigh, true);
  assert.equal(at70.hpWounded, undefined);
  assert.equal(at70.hasWeapon, true);
  assert.equal(at70.hasAmmo, true);

  const at50 = combatFacts(fakeSession({ hp: 50 }).session, { hp: 50, at: -Infinity }, now);
  assert.equal(at50.hpWounded, true);
  assert.equal(at50.hpHigh, undefined);
  assert.equal(combatFacts(fakeSession({ hp: 25 }).session, { hp: 25, at: -Infinity }, now).hpCritical, undefined);
  assert.equal(combatFacts(fakeSession({ hp: 24 }).session, { hp: 24, at: -Infinity }, now).hpCritical, true);

  const clock: HpClock = { hp: 100, at: now - 1_000 };
  assert.equal(combatFacts(fakeSession({ hp: 100 }).session, clock, now).underFire, true);
  assert.equal(combatFacts(fakeSession({ hp: 100 }).session, { hp: 100, at: now - 2_000 }, now).underFire, undefined);

  const crate = { id: "health-1", kind: "health", minX: 0, maxX: 0.4, minY: 0, maxY: 0.4, minZ: 0, maxZ: 0.4 } as Crate;
  assert.equal(combatFacts(fakeSession({ hp: 60, crates: [crate] }).session, { hp: 60, at: -Infinity }, now).canHeal, true);

  const threat = combatFacts(fakeSession({ hp: 100, others: [{ id: 7, x: 10, y: 0, z: 0 }] }).session, { hp: 100, at: -Infinity }, now);
  assert.equal(threat.threatVisible, true);
  assert.equal(threat.threatNear, true);
  // A visible threat's sight line is clear by construction, so the inCover band is off.
  assert.equal(threat.inCover, undefined);
});

test("combat_ladder_priorities_and_the_assault_order", () => {
  const priorities = (state: WorldState, mission?: Goal) =>
    Object.fromEntries(combatGoals(state, mission).map((goal) => [goal.id, goal.priority(state)]));
  assert.equal(priorities({ hpWounded: true }).survive, 80);
  assert.equal(priorities({ hpWounded: true, hpCritical: true }).survive, 90);
  assert.equal(priorities({ hpHigh: true, underFire: true }).defend, 70);
  assert.equal(priorities({ hpWounded: true, hpCritical: true, underFire: true }).defend, 0);
  assert.equal(priorities({ hasWeapon: true }).rearm, 55);
  assert.equal(priorities({ hasWeapon: true, hasAmmo: true }).rearm, 0);
  assert.equal(priorities({ hpHigh: true }).idle, 10);
  assert.equal(priorities({ hpHigh: true }, assaultGoal(7))["assault:7"], 60);
  assert.equal(assaultGoal(7).want.threatDown, true);
  assert.equal(combatHeuristic(assaultGoal(7))({}), 8);
  assert.equal(combatHeuristic(assaultGoal(7))({ hpWounded: true }), 16);
  assert.equal(combatHeuristic({ id: "reach", want: { at: "hall" }, priority: () => 1 })({}), 0);
});

test("combat_ladder_matrices", () => {
  const crate = "health-crate-1";
  const at = "outside";
  const cases: Array<{ name: string; state: WorldState; actions: Action<BotCtx>[]; mission?: Goal; goal?: string; step?: string; none?: boolean }> = [
    {
      name: "hp30+crate",
      state: { at, hpWounded: true, [`avail:${crate}`]: true },
      actions: [act(`seekHealth:${crate}`, { hpWounded: true, [`avail:${crate}`]: true, at }, { hpHigh: true, [`avail:${crate}`]: false }, 2)],
      goal: "survive",
      step: `seekHealth:${crate}`,
    },
    {
      name: "hp80+underFire",
      state: { at, hpHigh: true, underFire: true, threatVisible: true },
      actions: [
        act("takeCover:1.0,1.0", { underFire: true, threatVisible: true }, { inCover: true, defended: true }, 1.5),
        act("returnFire:7", { hasWeapon: true, hasAmmo: true, threatVisible: true }, { threatDown: true, defended: true }, 8),
      ],
      goal: "defend",
      step: "takeCover:1.0,1.0",
    },
    {
      name: "hp100+threat",
      state: { at, hpHigh: true, threatVisible: true, hasWeapon: true, hasAmmo: true },
      actions: [
        act("returnFire:7", { hasAmmo: true, hasWeapon: true }, { threatDown: true, defended: true }, 8),
        act("takeCover:1.0,1.0", { underFire: true, threatVisible: true }, { inCover: true, defended: true }, 1.5),
      ],
      mission: assaultGoal(7),
      goal: "assault:7",
      step: "returnFire:7",
    },
    { name: "hp100+none", state: { at, hpHigh: true }, actions: [], none: true },
    {
      name: "critical+order",
      state: { at, hpWounded: true, hpCritical: true, hasWeapon: true, hasAmmo: true, threatVisible: true, [`avail:${crate}`]: true },
      actions: [
        act(`seekHealth:${crate}`, { hpWounded: true, [`avail:${crate}`]: true, at }, { hpHigh: true, [`avail:${crate}`]: false }, 2),
        act("returnFire:7", { hasAmmo: true, hasWeapon: true }, { threatDown: true, defended: true }, 16),
      ],
      mission: assaultGoal(7),
      goal: "survive",
      step: `seekHealth:${crate}`,
    },
    { name: "no-crate", state: { at, hpWounded: true }, actions: [], none: true },
    {
      name: "flip-hp80",
      state: { at, underFire: true, threatVisible: true, hasWeapon: true, hasAmmo: true, hpHigh: true },
      actions: [
        act("takeCover:9.0,9.0", { underFire: true, threatVisible: true }, { inCover: true, defended: true }, 10),
        act("returnFire:7", { hasWeapon: true, hasAmmo: true, threatVisible: true }, { threatDown: true, defended: true }, 8),
      ],
      goal: "defend",
      step: "returnFire:7",
    },
    {
      name: "flip-hp40",
      state: { at, underFire: true, threatVisible: true, hasWeapon: true, hasAmmo: true, hpWounded: true },
      actions: [
        act("takeCover:9.0,9.0", { underFire: true, threatVisible: true }, { inCover: true, defended: true }, 6),
        act("returnFire:7", { hasWeapon: true, hasAmmo: true, threatVisible: true }, { threatDown: true, defended: true }, 16),
      ],
      goal: "defend",
      step: "takeCover:9.0,9.0",
    },
  ];
  for (const item of cases) {
    const found = choose(item.state, item.actions, item.mission);
    if (item.none) {
      assert.equal(found, undefined, item.name);
      continue;
    }
    assert.ok(found, `${item.name}: no plan`);
    assert.equal(found!.goal, item.goal, item.name);
    if (item.step) assert.equal(found!.steps[0], item.step, item.name);
  }
});

test("combat_actions_route_costs_and_the_wounded_fire_multiplier", () => {
  const arena = loadArena();
  const graph = arena.sceneGraph!;
  const health = { id: "health-hall", kind: "health", minX: -30, maxX: -29.6, minY: 0.2, maxY: 0.6, minZ: 27.2, maxZ: 27.6 } as PickupPlacement;
  const ammo = { id: "ammo-hall", kind: "ammo", minX: -30, maxX: -29.6, minY: 0.2, maxY: 0.6, minZ: 28.2, maxZ: 28.6 } as PickupPlacement;
  const fake = fakeSession({
    hp: 100,
    weapon: "laser",
    ammo: 0,
    others: [{ id: 7, x: -20, y: 0, z: 27.4 }],
    crates: [health, ammo],
    graph,
    self: { id: 1, x: -30, y: 0, z: 27.4 },
  });
  const ctx = { routeCost: () => 8 } as unknown as BotCtx;
  const actions = combatActions(fake.session, ctx);
  const byId = new Map(actions.map((action) => [action.id, action]));
  const seek = byId.get(`seekHealth:${health.id}`);
  const reload = byId.get(`reload:${ammo.id}`);
  const fire = byId.get("returnFire:7");
  const retreat = [...actions].find((action) => action.id.startsWith("retreat:"));
  assert.ok(seek && reload && fire && retreat, [...byId.keys()].join(","));
  assert.equal(typeof seek!.cost, "function");
  assert.equal((seek!.cost as (s: WorldState, c: BotCtx) => number)({ at: placeOfPickup(graph, health) }, ctx), 2);
  assert.equal((reload!.cost as (s: WorldState, c: BotCtx) => number)({ at: placeOfPickup(graph, ammo) }, ctx), 2);
  assert.deepEqual(seek!.pre, { hpWounded: true, [`avail:${health.id}`]: true, at: placeOfPickup(graph, health) });
  assert.deepEqual(reload!.pre, { hasAmmo: false, [`avail:${ammo.id}`]: true, at: placeOfPickup(graph, ammo) });
  assert.equal((fire!.cost as (s: WorldState, c: BotCtx) => number)({ hpHigh: true }, ctx), 8);
  assert.equal((fire!.cost as (s: WorldState, c: BotCtx) => number)({ hpWounded: true }, ctx), 16);
  assert.deepEqual(fire!.pre, { hasWeapon: true, hasAmmo: true, threatVisible: true });
});

test("a_locked_hall_crate_still_has_a_grounded_route", () => {
  const arena = loadArena();
  const graph = parseSceneGraph(JSON.parse(readFileSync("web/game/scene-graph.json", "utf8")), arena.view.doors).graph;
  assert.ok(graph);
  const key = {
    id: "key", kind: "key", model: "key.glb", amount: 1,
    minX: -7.1, maxX: -6.7, minY: 0.8, maxY: 1.2, minZ: 27.2, maxZ: 27.6,
  } as PickupPlacement;
  const hallCrate = {
    id: "health-crate-hall", kind: "health", model: "crate.glb", amount: 1,
    minX: -30, maxX: -29.6, minY: 0.2, maxY: 0.6, minZ: 27.2, maxZ: 27.6,
  } as PickupPlacement;
  const pickups = [key, hallCrate];
  const doors = arena.view.doors.map((door) => ({ id: door.id, open: false, locked: door.locked === true }));
  const base = buildWorldState({ at: "outside", pickups: pickups.map((item) => item.id), doors });
  const state: WorldState = { ...base, hpWounded: true };
  const ctx = createBotContext(graph!, pickups);
  const cratePlace = placeOfPickup(graph!, hallCrate);
  // The union the brain grounds with: the crate's place must be in it, or no goTo.
  const grounded = groundActions(graph!, pickups, [{ want: { at: cratePlace } }]);
  const seek = act(`seekHealth:${hallCrate.id}`, { hpWounded: true, [`avail:${hallCrate.id}`]: true, at: cratePlace }, { hpHigh: true, [`avail:${hallCrate.id}`]: false }, 1);
  assert.ok(grounded.some((action) => action.id === `goTo:${cratePlace}`), "the union is missing the crate place");
  assert.ok(grounded.some((action) => action.id === "pickup:key"), "the key pickup is missing");
  assert.ok(grounded.some((action) => action.id.startsWith("unlock:")), "the locked route has no unlock");
  const found = plan(state, { id: "survive", want: { hpHigh: true }, priority: () => 80 }, [...grounded, seek], ctx, {
    deadlineMs: Date.now() + 4_000,
    now: () => Date.now(),
    heuristic: () => 0,
  });
  assert.ok(found, "the locked-hall crate does not plan");
  assert.equal(found!.steps[0], "pickup:key");
});
