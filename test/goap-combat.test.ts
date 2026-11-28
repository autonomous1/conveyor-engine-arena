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
  healGoal,
  regroupGoal,
  threatWatchKey,
  visibleThreat,
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
  dead?: Set<number>;
  players?: Set<number>;
} = {}) {
  const self = opts.self ?? { id: 1, x: 0, y: 0, z: 0 };
  const world = {
    self: () => self,
    health: () => ({ hp: opts.hp ?? 100, dead: false }),
    healthOf: (id: number) => ({ hp: opts.dead?.has(id) ? 0 : 100, dead: opts.dead?.has(id) === true }),
    weapon: () => opts.weapon ?? "",
    ammo: () => opts.ammo ?? 0,
    playerIds: () => opts.players ?? new Set([1]),
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

test("combat_goals_split_survive_and_heal", () => {
  const priorities = (state: WorldState): Record<string, number> =>
    Object.fromEntries(combatGoals(state).map((goal) => [goal.id, goal.priority(state)]));
  // hp 90, nothing in sight: no combat band above idle.
  const healthy = { hpHigh: true } as WorldState;
  assert.deepEqual(
    combatGoals(healthy).filter((goal) => goal.id !== "idle" && goal.priority(healthy) > 0).map((goal) => goal.id),
    [],
  );
  // hp 40, nothing in sight: the heal band at 80, and no survive band.
  const wounded = { hpWounded: true } as WorldState;
  assert.equal(priorities(wounded).heal, 80);
  assert.equal(priorities(wounded).survive, 0);
  // hp 20 against two threats is pressured: survive at 90, heal silent.
  const pressured = { hpWounded: true, hpCritical: true, hpPressured: true } as WorldState;
  assert.equal(priorities(pressured).survive, 90);
  assert.equal(priorities(pressured).heal, 0);
});

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
  // 193/197: survive and heal are disjoint bands; survive keys on the pressure fact.
  assert.equal(priorities({ hpWounded: true }).survive, 0);
  assert.equal(priorities({ hpWounded: true }).heal, 80);
  assert.equal(priorities({ hpWounded: true, hpPressured: true }).survive, 90);
  assert.equal(priorities({ hpWounded: true, hpPressured: true }).heal, 0);
  assert.equal(priorities({ hpHigh: true, underFire: true }).defend, 70);
  assert.equal(priorities({ hpWounded: true, hpCritical: true, underFire: true }).defend, 0);
  // `rearm` is scoped to an assault order (189) or a live fight (198).
  assert.equal(priorities({ hasWeapon: true }).rearm, 0);
  assert.equal(priorities({ hasWeapon: true }, assaultGoal(7)).rearm, 55);
  assert.equal(priorities({ hasWeapon: true, underFire: true }).rearm, 55);
  assert.equal(priorities({ hasWeapon: true, hasAmmo: true }, assaultGoal(7)).rearm, 0);
  assert.equal(priorities({ hpHigh: true }).idle, 10);
  assert.equal(priorities({ hpHigh: true }, assaultGoal(7))["assault:7"], 60);
  assert.equal(assaultGoal(7).want.threatDown, true);
  // 193/200: the forced heal is not the ladder; the regroup anchor yields at 45.
  assert.equal(healGoal().id, "heal");
  assert.equal(healGoal().priority({}), 80);
  assert.equal(regroupGoal("outside").id, "regroup:outside");
  assert.equal(regroupGoal("outside").priority({}), 45);
  assert.equal(combatGoals({}, healGoal()).filter((goal) => goal.id === "heal").length, 1);
  // The floor is the cheapest action whose effect satisfies the goal (189).
  const fire: Action<BotCtx> = { id: "returnFire:7", pre: {}, eff: { threatDown: true }, cost: (s) => (s.hpWounded ? 16 : 8) };
  const ctx = {} as BotCtx;
  assert.equal(combatHeuristic(assaultGoal(7), [fire], ctx)({}), 8);
  assert.equal(combatHeuristic(assaultGoal(7), [fire], ctx)({ hpWounded: true }), 16);
  assert.equal(combatHeuristic({ id: "reach", want: { at: "hall" }, priority: () => 1 }, [], ctx)({}), 0);
});

test("combat_ladder_matrices", () => {
  const crate = "health-crate-1";
  const at = "outside";
  const cases: Array<{ name: string; state: WorldState; actions: Action<BotCtx>[]; mission?: Goal; goal?: string; step?: string; none?: boolean }> = [
    {
      name: "hp30+crate",
      state: { at, hpWounded: true, [`avail:${crate}`]: true },
      actions: [act(`seekHealth:${crate}`, { hpWounded: true, [`avail:${crate}`]: true, at }, { hpHigh: true, [`avail:${crate}`]: false }, 2)],
      goal: "heal",
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
      state: { at, hpWounded: true, hpCritical: true, hpPressured: true, hasWeapon: true, hasAmmo: true, threatVisible: true, [`avail:${crate}`]: true },
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
  assert.deepEqual(seek!.pre, { hpWounded: true, [`avail:${health.id}`]: true, at: placeOfPickup(graph, health), safe: true });
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

test("combat_facts_pressure_safe_and_retreat", () => {
  const now = 10_000;
  const clock = (hp: number, at = -Infinity): HpClock => ({ hp, at });
  const twoThreats: Pawn[] = [{ id: 7, x: 8, y: 0, z: 0 }, { id: 8, x: 8, y: 0, z: 0 }];
  const oneThreat: Pawn[] = twoThreats.slice(0, 1);

  const safeWounded = combatFacts(fakeSession({ hp: 40 }).session, clock(40), now);
  assert.equal(safeWounded.safe, true);
  assert.equal(safeWounded.hpPressured, undefined);
  assert.equal(safeWounded.needsRetreat, undefined);

  // Two hostiles inside 8 m at hp 40: pressured, and the wounded need an exit.
  const pressured = combatFacts(fakeSession({ hp: 40, others: twoThreats }).session, clock(40), now);
  assert.equal(pressured.hpPressured, true);
  assert.equal(pressured.needsRetreat, true);
  assert.equal(pressured.safe, undefined);

  // One hostile: not pressured, but a wounded soldier still breaks contact to heal.
  const inSight = combatFacts(fakeSession({ hp: 40, others: oneThreat }).session, clock(40), now);
  assert.equal(inSight.hpPressured, undefined);
  assert.equal(inSight.safe, undefined);
  assert.equal(inSight.needsRetreat, true);

  // Fresh damage with nothing visible is NOT safe (the hidden shooter stays hot).
  const hidden = combatFacts(fakeSession({ hp: 80 }).session, clock(80, now - 1_000), now);
  assert.equal(hidden.underFire, true);
  assert.equal(hidden.safe, undefined);
  assert.equal(hidden.needsRetreat, undefined);

  // Critical hp alone is pressure, even with nothing in sight.
  const critical = combatFacts(fakeSession({ hp: 20 }).session, clock(20), now);
  assert.equal(critical.hpPressured, true);
  assert.equal(critical.needsRetreat, true);
});

test("threat_watch_key_and_memory_are_per_session", () => {
  const now = 10_000;
  const first = fakeSession({ others: [{ id: 90, x: 4.1, y: 0, z: 3.9 }] }).session;
  const second = fakeSession({ others: [{ id: 91, x: 4.9, y: 0, z: 3.9 }] }).session;
  // 2 m rounding: a 0.8 m walk keeps the same key.
  assert.equal(threatWatchKey(first), "90:2:2");
  assert.equal(threatWatchKey(second), "91:2:2");
  assert.equal(threatWatchKey(fakeSession({}).session), "-");

  // A declared player is hostile; the same player is friendly by default.
  const player = fakeSession({ others: [{ id: 7, x: 8, y: 0, z: 0 }], players: new Set([7]) });
  assert.equal(visibleThreat(player.session), undefined);
  assert.equal(visibleThreat(player.session, new Set([7]))?.id, 7);

  // A's last threat is not B's memory: an aged target that is only a roster
  // pawn (friendly) must not make B "defended" just because A saw it.
  assert.equal(combatFacts(first, { hp: 100, at: -Infinity }, now).threatVisible, true);
  const other = fakeSession({ others: [{ id: 90, x: 8, y: 0, z: 0 }], players: new Set([90]) }).session;
  assert.equal(combatFacts(other, { hp: 100, at: -Infinity }, now, { missionTarget: 90 }).defended, undefined);
});

test("combat_actions_rank_crates_by_route_and_take_a_zero_metre_step", () => {
  const arena = loadArena();
  const graph = arena.sceneGraph!;
  const places = [...graph.placeById.values()].filter((p) => p.bounds);
  const crateAt = (p: (typeof places)[number], id: string): PickupPlacement => {
    const cx = (p.bounds.minX + p.bounds.maxX) / 2;
    const cz = (p.bounds.minZ + p.bounds.maxZ) / 2;
    return {
      id, kind: "health", model: "crate.glb", amount: 1,
      minX: cx - 0.2, maxX: cx + 0.2, minY: 0.2, maxY: 0.6, minZ: cz - 0.2, maxZ: cz + 0.2,
    } as PickupPlacement;
  };
  let reachable: { item: PickupPlacement; place: string } | undefined;
  let banned: { item: PickupPlacement; place: string } | undefined;
  for (const p of places) {
    const item = crateAt(p, "probe");
    const place = placeOfPickup(graph, item);
    if (place === "outside") continue;
    if (!reachable) { reachable = { item, place }; continue; }
    if (place !== reachable.place) { banned = { item, place }; break; }
  }
  assert.ok(reachable && banned, "need one reachable and one other real place");
  const crates: PickupPlacement[] = Array.from({ length: 6 }, (_, i) => ({ ...reachable!.item, id: `health-reach-${i}` }));
  crates.push({ ...banned!.item, id: "health-banned" });
  const self = { id: 1, x: (reachable!.item.minX + reachable!.item.maxX) / 2, y: 0, z: (reachable!.item.minZ + reachable!.item.maxZ) / 2 };
  const session = fakeSession({ crates, graph, self });
  const ctx = { routeCost: (_from: string, to: string) => (to === banned!.place ? Infinity : 0) } as unknown as BotCtx;
  const actions = combatActions(session.session, ctx);
  const seek = actions.filter((action) => action.id.startsWith("seekHealth:"));
  // Six nearest, ranked by route: the Infinity-route crate is last and dropped.
  assert.equal(seek.length, 6);
  assert.equal(seek.some((action) => action.id === "seekHealth:health-banned"), false);
  const first = actions.find((action) => action.id === "seekHealth:health-reach-0");
  assert.ok(first);
  assert.deepEqual(first!.pre, { hpWounded: true, "avail:health-reach-0": true, at: reachable!.place, safe: true });
  const cost = first!.cost as (s: WorldState, c: BotCtx) => number;
  const usable = first!.usable as (s: WorldState, c: BotCtx) => boolean;
  const at = { at: reachable!.place } as WorldState;
  // A 0 m route is valid: the step ends in the place the pawn already stands in.
  assert.equal(usable(at, ctx), true);
  assert.equal(cost({ ...at, hpWounded: true }, ctx), 0.125);
  // The critical heal costs 0.01 (positive) so `survive` 90 still outranks `heal` 80.
  assert.equal(cost({ ...at, hpWounded: true, hpCritical: true }, ctx), 0.01);
});

test("defended_is_live_from_cover_down_and_gone", () => {
  const now = 10_000;
  const self = { id: 1, x: 0, y: 0, z: 0 };
  const target: Pawn = { id: 90, x: 8, y: 0, z: 0 };
  const box = [{ minX: 3, maxX: 4, minY: 0, maxY: 2, minZ: -1, maxZ: 1 }];

  // In cover: a box between the eye and the mission target blocks the sight line.
  const inCover = combatFacts(fakeSession({ self, others: [target], aabbs: box }).session, { hp: 80, at: -Infinity }, now, { missionTarget: 90 });
  assert.equal(inCover.defended, true);
  assert.equal(inCover.targetDown, undefined);

  // The health frame is the only death truth (absence is not death).
  const down = combatFacts(fakeSession({ self, others: [target], dead: new Set([90]) }).session, { hp: 80, at: -Infinity }, now, { missionTarget: 90 });
  assert.equal(down.defended, true);
  assert.equal(down.targetDown, true);
  assert.equal(down.threatDown, true);

  // A hidden shooter with fresh damage is not "gone".
  const hidden = combatFacts(fakeSession({ self }).session, { hp: 80, at: now - 500 }, now);
  assert.equal(hidden.defended, undefined);

  // Nothing visible and the damage memory expired: defended.
  const quiet = combatFacts(fakeSession({ self }).session, { hp: 80, at: now - 5_000 }, now);
  assert.equal(quiet.defended, true);

  // The last visible threat leaving `others()` is gone on the next build.
  const others: Pawn[] = [target];
  const session = fakeSession({ self, others }).session;
  assert.equal(combatFacts(session, { hp: 80, at: -Infinity }, now).threatVisible, true);
  others.length = 0;
  assert.equal(combatFacts(session, { hp: 80, at: -Infinity }, now).defended, true);
});
