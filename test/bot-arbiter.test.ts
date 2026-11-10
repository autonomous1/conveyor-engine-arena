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

const { createMind, judge, ESCAPE_PRIORITY, WANDER_PRIORITY } = await import("../src/shared/bots/arbiter.ts");
const { createExitIndex } = await import("../src/shared/bots/sense.ts");
const { createHostBotBrain } = await import("../src/server/bot-brain.ts");
const { splitMix, steerUnownedWander } = await import("../src/server/game.ts");
const { createPawnHealth } = await import("../src/shared/health.ts");
const { createNavCache } = await import("../src/shared/nav/legs.ts");
const { placeAt } = await import("../src/shared/scene-graph.ts");
const { loadArena } = await import("../src/server/world-loader.ts");

const S = 1000;
const calm = { alive: true, place: "hall", msNoProgress: 0, routeOut: { open: true, unlocked: true } };
const walled = { alive: true, place: "hall", msNoProgress: 0, routeOut: { open: false, unlocked: false } };

test("arbiter: trapped after 60 s with no route out, not before", () => {
  const mind = createMind();
  assert.equal(judge(mind, walled, 0).goal, "wander");
  const early = judge(mind, walled, 59_999);
  assert.equal(early.goal, "wander");
  assert.equal(early.priority, WANDER_PRIORITY);
  const late = judge(mind, walled, 60_000);
  assert.equal(late.goal, "escape");
  assert.equal(late.priority, ESCAPE_PRIORITY);
  assert.equal(late.respawn, false);
});

test("arbiter: 60 s of no net movement is trapped too, outside included", () => {
  const mind = createMind();
  assert.equal(judge(mind, { ...calm, msNoProgress: 59_999 }, 0).goal, "wander");
  assert.equal(judge(mind, { ...calm, msNoProgress: 60_000 }, 50).goal, "escape");
  const other = createMind();
  assert.equal(judge(other, { ...calm, place: "outside", msNoProgress: 60_000 }, 0).goal, "escape");
});

test("arbiter: the no-route timer restarts when a route opens or the place changes", () => {
  const mind = createMind();
  judge(mind, walled, 0);
  judge(mind, calm, 50 * S);
  assert.equal(judge(mind, walled, 60 * S).goal, "wander");
  assert.equal(judge(mind, walled, 119 * S).goal, "wander");
  assert.equal(judge(mind, walled, 120 * S).goal, "escape");
  const moved = createMind();
  judge(moved, walled, 0);
  judge(moved, { ...walled, place: "stairs" }, 50 * S);
  assert.equal(judge(moved, { ...walled, place: "stairs" }, 100 * S).goal, "wander");
});

test("arbiter: Escape holds through a place change or an opened door, and ends outside", () => {
  const mind = createMind();
  judge(mind, walled, 0);
  assert.equal(judge(mind, walled, 60 * S).goal, "escape");
  // No flip-flop on the way out: place changes, then the route reads open.
  assert.equal(judge(mind, { ...walled, place: "stairs" }, 61 * S).goal, "escape");
  assert.equal(judge(mind, calm, 62 * S).goal, "escape");
  assert.equal(judge(mind, { ...calm, place: "outside" }, 63 * S).goal, "wander");
  assert.equal(judge(mind, walled, 64 * S).goal, "wander");
  // Outside but still wedged: it keeps the claim and the clock.
  const wedged = createMind();
  judge(wedged, { ...calm, place: "outside", msNoProgress: 60 * S }, 0);
  assert.equal(judge(wedged, { ...calm, place: "outside", msNoProgress: 61 * S }, 1 * S).goal, "escape");
  assert.equal(judge(wedged, { ...calm, place: "outside", msNoProgress: 0 }, 2 * S).goal, "wander");
});

test("arbiter: respawn is due 120 s after it became trapped, and death resets it", () => {
  const mind = createMind();
  judge(mind, walled, 0);
  judge(mind, walled, 60 * S);
  assert.equal(judge(mind, walled, 179_999).respawn, false);
  const due = judge(mind, walled, 180 * S);
  assert.equal(due.goal, "escape");
  assert.equal(due.respawn, true);
  assert.equal(judge(mind, { ...walled, alive: false }, 181 * S).goal, "wander");
  assert.equal(judge(mind, walled, 182 * S).goal, "wander");
});

// ---- a room with one door, a yard outside ----

const RADIUS = 0.5;
const HEIGHT = 1.8;
const SPEEDS = { idle: 0, walk: 1, run: 2, fall: 0, angry: 0 };

function rect(id: string, kind: "room" | "outside", minX: number, maxX: number, minZ: number, maxZ: number) {
  return {
    id,
    kind,
    y: 0,
    polygon: [[minX, minZ], [maxX, minZ], [maxX, maxZ], [minX, maxZ]] as Array<[number, number]>,
    bounds: { minX, maxX, minZ, maxZ },
  };
}

function yardNav(door: { open: boolean }, opts: { elevatorOnly?: boolean } = {}) {
  const places = [rect("room", "room", 0, 4, 0, 4), rect("outside", "outside", -80, 80, -80, 80)];
  const portals = [
    opts.elevatorOnly
      ? { id: "lift", kind: "elevator" as const, a: "room", b: "outside", at: { a: [3.5, 0, 2] as [number, number, number], b: [6.5, 0, 2] as [number, number, number] }, width: 2, cost: 2 }
      : { id: "gap", kind: "door" as const, a: "room", b: "outside", door: "gap", at: { a: [3.5, 0, 2] as [number, number, number], b: [6.5, 0, 2] as [number, number, number] }, width: 2, cost: 2 },
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
  const leaf = {
    id: "gap",
    model: "door.glb",
    position: [4, 0, 3] as [number, number, number],
    yaw: 90,
    hinge: "left" as const,
    size: [2, 2.2, 2] as [number, number, number],
    open: false,
  };
  return {
    sceneGraph,
    regions,
    aabbs: [
      { id: 1, minX: 4, maxX: 6, minY: 0, maxY: 3, minZ: 0, maxZ: 1 },
      { id: 2, minX: 4, maxX: 6, minY: 0, maxY: 3, minZ: 3, maxZ: 4 },
    ],
    doors: [leaf],
    pawnRadius: RADIUS,
    pawnHeight: HEIGHT,
    liveDoors: () => [{ id: "gap", open: door.open }],
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

/** A sensor stand-in. The test sets the fields the brain reads. */
function fakeSense(ids: number[]) {
  const rows = new Map<number, any>(ids.map((id) => [id, { id, tick: 0, alive: true, place: "room", msNoProgress: 0, routeOut: { open: false, unlocked: false } }]));
  return {
    rows,
    get: (id: number) => rows.get(id),
    ids: () => [...rows.keys()],
    fresh(id: number, patch: Record<string, unknown>) {
      const row = rows.get(id);
      Object.assign(row, patch, { tick: row.tick + 1 });
    },
  };
}

test("brain: a trapped bot waits behind a shut door, then walks out when it opens", () => {
  const door = { open: false };
  const nav = yardNav(door);
  const { world, id, agent } = botWorld(2, 2);
  let clock = 0;
  const health = createPawnHealth(() => clock);
  const sense = fakeSense([id]);
  const logs: string[] = [];
  const brain = createHostBotBrain({ world, agents: [agent as never], health, sense, nav, now: () => clock, log: (line) => logs.push(line) });
  const tick = (patch: Record<string, unknown> = {}) => {
    sense.fresh(id, patch);
    brain.update();
  };
  tick();
  for (clock = 1 * S; clock <= 65 * S; clock += 1 * S) tick();
  assert.equal(brain.goalOf(id), "escape");
  assert.equal(agent.override, undefined, "a shut door leaves no plan, so no claim");
  assert.equal(health.isDead(id), false);

  door.open = true;
  clock += 6 * S;
  tick({ routeOut: { open: true, unlocked: true } });
  assert.ok(agent.override, "an open door gives a plan");
  const goal = agent.override.goal;
  assert.ok(goal.x > 6 && goal.x < 10, `goal ${JSON.stringify(goal)} is outside`);

  // Walk it with the real steer and follower, and let the brain watch the place.
  const rng = splitMix(7);
  const cache = createNavCache();
  let x = 2;
  let z = 2;
  let walked = 0;
  for (let t = 1; t <= 600 && brain.goalOf(id) === "escape"; t += 1) {
    steerUnownedWander(world, agent as never, t, rng, nav, cache);
    assert.equal(agent.goal, goal, "the walk follows the claim, not a sampled wander goal");
    x += Math.sin(agent.heading) * 0.12;
    z += Math.cos(agent.heading) * 0.12;
    const view = world.store.view(id)!;
    world.enqueue({ kind: "setTransform", entity: id, position: { x, y: 0, z }, rotation: view.rotation, scale: { x: 1, y: 1, z: 1 } });
    world.commit(BigInt(t));
    clock += 50;
    walked = t;
    tick({ place: placeAt(nav.sceneGraph, x, 0, z).id, routeOut: { open: true, unlocked: true } });
  }
  assert.ok(walked < 600, "never got out");
  // The room ends at x = 4. The brain lets go the moment the place reads outside.
  assert.ok(x > 4 && x < 6, `stopped at ${x}, ${z}`);
  assert.equal(brain.goalOf(id), "wander");
  assert.equal(agent.override, undefined, "released outside");
  assert.equal(health.isDead(id), false);
  assert.deepEqual(logs, []);
});

test("brain: with no route the bot respawns itself 120 s after it became trapped", () => {
  const nav = yardNav({ open: false }, { elevatorOnly: true });
  const { world, id, agent } = botWorld(2, 2);
  let clock = 0;
  const health = createPawnHealth(() => clock);
  const sense = fakeSense([id]);
  const brain = createHostBotBrain({ world, agents: [agent as never], health, sense, nav, now: () => clock });
  const tick = (patch: Record<string, unknown> = {}) => {
    sense.fresh(id, patch);
    brain.update();
  };
  tick();
  // Trapped at 60 s. Elevators are not a route, so there is never a claim.
  for (clock = 1 * S; clock <= 179 * S; clock += 1 * S) {
    tick();
    assert.equal(agent.override, undefined);
    assert.equal(health.isDead(id), false, `died early at ${clock}`);
  }
  clock = 180 * S;
  tick();
  assert.equal(health.isDead(id), true, "the normal death path: hp 0, no attacker");
  assert.equal(health.get(id).hp, 0);
  assert.equal(health.lastDamage(id)?.attacker, undefined);
  // The sensor reads it dead, then alive again after the host respawn. Nothing carries over.
  clock = 181 * S;
  tick({ alive: false });
  clock = 184 * S;
  health.takeRespawns();
  tick({ alive: true });
  assert.equal(brain.goalOf(id), "wander");
  assert.equal(health.isDead(id), false);
  clock = 200 * S;
  tick();
  assert.equal(brain.goalOf(id), "wander");
});

test("brain: a player seat is never claimed or killed, and one bad bot does not stop the rest", () => {
  const door = { open: true };
  const nav = yardNav(door);
  const bot = botWorld(2, 2);
  const botId = bot.id;
  const seatId = botId + 1;
  const seatAgent = { id: seatId, heading: 0, gait: "idle", nextTurn: 1, speeds: { ...SPEEDS }, role: "player" } as Record<string, any>;
  const rows = fakeSense([botId, seatId]);
  let clock = 0;
  const health = createPawnHealth(() => clock);
  const logs: string[] = [];
  let boom = true;
  const reader = {
    get(id: number) {
      if (id === botId && boom) throw new Error("boom");
      return rows.get(id);
    },
    ids: () => rows.ids(),
  };
  const brain = createHostBotBrain({ world: bot.world, agents: [bot.agent as never, seatAgent as never], health, sense: reader, nav, now: () => clock, log: (line) => logs.push(line) });
  for (clock = 0; clock <= 400 * S; clock += 5 * S) {
    rows.fresh(botId, { routeOut: { open: false, unlocked: false } });
    rows.fresh(seatId, { routeOut: { open: false, unlocked: false }, msNoProgress: clock });
    brain.update();
  }
  assert.deepEqual(logs, ["[live] brain boom"], "logged once, not every tick");
  assert.equal(seatAgent.override, undefined);
  assert.equal(brain.goalOf(seatId), undefined);
  assert.equal(health.isDead(seatId), false);
  boom = false;
  for (clock = 500 * S; clock <= 570 * S; clock += 5 * S) {
    rows.fresh(botId, { routeOut: { open: false, unlocked: false } });
    brain.update();
  }
  assert.equal(brain.goalOf(botId), "escape");
  assert.equal(seatAgent.override, undefined);
});

test("seam: a claimed bot walks to the claim and wander does not sample", () => {
  const nav = yardNav({ open: true });
  nav.doors[0]!.open = true;
  const { world, agent } = botWorld(2, 2);
  const cache = createNavCache();
  const goal = { x: 8, y: 0, z: 2 };
  agent.override = { goal };
  // The rng counts rolls. A claimed walk rolls once (the gait); a wander sample rolls more.
  let rolls = 0;
  steerUnownedWander(world, agent as never, 1, () => {
    rolls += 1;
    return 0.1;
  }, nav, cache);
  assert.equal(agent.goal, goal);
  assert.ok(agent.path && agent.path.length > 1);
  assert.equal(rolls, 1, "only the gait roll");
  agent.override = undefined;
  steerUnownedWander(world, agent as never, 2, () => {
    rolls += 1;
    return 0.1;
  }, nav, cache);
  assert.notEqual(agent.goal, goal, "released: wander picks its own goal");
  assert.ok(rolls > 1);
});

// ---- the real arena graph ----

test("real arena: an exit through open doors is planned, an elevator-only floor respawns", () => {
  const loaded = loadArena();
  const graph = loaded.sceneGraph!;
  const regions = loaded.regions!;
  const doors = new Map(loaded.view.doors.map((door) => [door.id, false]));
  const nav = {
    sceneGraph: graph,
    regions,
    aabbs: loaded.view.aabbs,
    doors: loaded.view.doors,
    pawnRadius: loaded.view.pawnRadius,
    pawnHeight: loaded.view.pawnHeight,
    liveDoors: () => [...doors].map(([id, open]) => ({ id, open })),
  };
  const withRegions = new Set(regions.places.filter((place) => place.regions.length > 0).map((place) => place.placeId));
  const allOpen = new Map([...doors.keys()].map((id) => [id, { open: true, locked: false }]));
  const exits = createExitIndex(graph.portals);
  exits.update(allOpen);
  const here = graph.places.map((place) => place.id).filter((id) => id !== "outside" && withRegions.has(id));
  // A hall whose exterior door the walk planner can cross. Some facade doors cannot be crossed today.
  const reachable = "brutalist-building-1-cbake-9.floor-1.hall";
  assert.ok(here.includes(reachable) && exits.reaches(reachable).open);
  const stranded = here.find((id) => !exits.reaches(id).open);
  assert.ok(stranded, "no elevator-only place with regions");

  const spot = (placeId: string) => {
    const region = regions.places.find((place) => place.placeId === placeId)!.regions[0]!;
    return { x: (region.minX + region.maxX) / 2, y: region.y, z: (region.minZ + region.maxZ) / 2 };
  };
  let commits = 0;
  const trap = (placeId: string) => {
    const agent = loaded.agents.find((item) => item.role !== "player")!;
    const at = spot(placeId);
    loaded.world.enqueue({
      kind: "setTransform",
      entity: agent.id,
      position: { x: at.x, y: at.y, z: at.z },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 1, y: 1, z: 1 },
    });
    commits += 1;
    loaded.world.commit(BigInt(commits));
    let clock = 0;
    const health = createPawnHealth(() => clock);
    const sense = fakeSense([agent.id]);
    const brain = createHostBotBrain({ world: loaded.world, agents: [agent], health, sense, nav, now: () => clock });
    sense.fresh(agent.id, { place: placeId });
    brain.update();
    clock = 60 * S;
    sense.fresh(agent.id, { place: placeId });
    brain.update();
    clock = 66 * S;
    sense.fresh(agent.id, { place: placeId });
    brain.update();
    return { agent, health, brain, sense, tick: (to: number) => {
      clock = to;
      sense.fresh(agent.id, { place: placeId });
      brain.update();
    } };
  };

  // Every door shut: nowhere to go.
  const shut = trap(reachable);
  assert.equal(shut.brain.goalOf(shut.agent.id), "escape");
  assert.equal(shut.agent.override, undefined);
  // The doors open: it gets a stand point outside, and no door is ever pressed.
  for (const id of doors.keys()) doors.set(id, true);
  shut.tick(72 * S);
  const claim = shut.agent.override;
  assert.ok(claim, "an exit exists with every door open");
  assert.equal(placeAt(graph, claim.goal.x, claim.goal.y, claim.goal.z).id, "outside");
  shut.agent.override = undefined;

  // All doors open and still no way out: only an elevator links this floor.
  const lost = trap(stranded);
  lost.tick(72 * S);
  assert.equal(lost.agent.override, undefined);
  lost.tick(180 * S);
  assert.equal(lost.health.isDead(lost.agent.id), true);
  assert.equal(lost.health.get(lost.agent.id).hp, 0);
});
