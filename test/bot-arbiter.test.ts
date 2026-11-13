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

const { createMind, judge, ESCAPE_PRIORITY, WANDER_PRIORITY, EVADE_HURT_PRIORITY, EVADE_UNDER_FIRE_PRIORITY } = await import("../src/shared/bots/arbiter.ts");
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

test("arbiter: 60 s of no net movement inside a building is trapped", () => {
  const mind = createMind();
  assert.equal(judge(mind, { ...calm, msNoProgress: 59_999 }, 0).goal, "wander");
  assert.equal(judge(mind, { ...calm, msNoProgress: 60_000 }, 50).goal, "escape");
});

test("arbiter: a bot outside is never trapped. Wander retries; a jammed one respawns after 180 s", () => {
  const out = { ...calm, place: "outside" };
  const mind = createMind();
  for (const stuck of [0, 60 * S, 120 * S, 179_999]) {
    const verdict = judge(mind, { ...out, msNoProgress: stuck }, stuck);
    assert.equal(verdict.goal, "wander", `${stuck} ms`);
    assert.equal(verdict.trapped, false);
    assert.equal(verdict.respawn, false);
  }
  const jammed = judge(mind, { ...out, msNoProgress: 180 * S }, 180 * S);
  assert.equal(jammed.goal, "wander", "no Escape: there is nowhere to escape to");
  assert.equal(jammed.respawn, true);
  // A no-route reading never counts outside either.
  const walledOut = createMind();
  judge(walledOut, { ...out, routeOut: { open: false, unlocked: false } }, 0);
  assert.equal(judge(walledOut, { ...out, routeOut: { open: false, unlocked: false } }, 500 * S).goal, "wander");
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
  // Escape never latches outside: a bot that was wedged inside and arrives outside lets go at once.
  const wedged = createMind();
  judge(wedged, { ...calm, msNoProgress: 60 * S }, 0);
  assert.equal(judge(wedged, { ...calm, msNoProgress: 61 * S }, 1 * S).goal, "escape");
  assert.equal(judge(wedged, { ...calm, place: "outside", msNoProgress: 62 * S }, 2 * S).goal, "wander");
  assert.equal(judge(wedged, { ...calm, msNoProgress: 63 * S }, 3 * S).goal, "escape", "inside again and still wedged: a new Escape");
});

type HitSense = {
  alive: boolean;
  place: string;
  msNoProgress: number;
  routeOut: { open: boolean; unlocked: boolean };
  hpFrac: number;
  threatDist: number;
  threatPlace: string;
  damage?: { attacker: number | undefined; ageMs: number; seq?: number };
  damageAt?: number;
  damageSeq?: number;
  threatSeen?: boolean;
  armed?: boolean;
};

function hitSense(now: number, hitAt: number | undefined, extra: Partial<HitSense> = {}): HitSense {
  const row: HitSense = {
    ...calm,
    hpFrac: 1,
    threatDist: 25,
    threatPlace: "hall",
    threatSeen: false,
    ...extra,
  };
  if (hitAt !== undefined) {
    const seq = extra.damage?.seq;
    row.damage = { attacker: extra.damage?.attacker, ageMs: now - hitAt, ...(seq !== undefined ? { seq } : {}) };
    row.damageAt = hitAt;
    if (seq !== undefined) row.damageSeq = seq;
  }
  return row;
}

test("arbiter: a hit, another hit, then 10 s quiet is wander, evade, evade, wander", () => {
  assert.equal(EVADE_UNDER_FIRE_PRIORITY, 9.5);
  assert.equal(EVADE_HURT_PRIORITY, 8.5);
  const mind = createMind();
  const goals: string[] = [];
  const see = (now: number, hitAt: number | undefined) => {
    const verdict = judge(mind, hitSense(now, hitAt), now);
    goals.push(verdict.goal);
    return verdict;
  };
  assert.equal(see(0, undefined).goal, "wander");
  const first = see(1_000, 1_000);
  assert.equal(first.goal, "evade");
  assert.equal(first.priority, 9.5);
  assert.equal(see(1_500, 1_500).goal, "evade");
  const quiet = see(4_000, 1_500);
  assert.equal(quiet.goal, "evade");
  assert.equal(quiet.priority, 8.5);
  // Safe begins once the last hit is 5 s old. It has to hold 3 s.
  assert.equal(see(6_500, 1_500).goal, "evade");
  assert.equal(see(9_499, 1_500).goal, "evade");
  assert.equal(see(9_500, 1_500).goal, "wander");
  assert.equal(see(11_000, 1_500).goal, "wander");
  assert.equal(see(12_000, 1_500).goal, "wander");
  const changes: string[] = [];
  for (const goal of goals) {
    if (changes[changes.length - 1] !== goal) changes.push(goal);
  }
  assert.deepEqual(changes, ["wander", "evade", "wander"]);
});

test("arbiter: cool-down blocks the same damage note, and a new hit starts Evade again", () => {
  const mind = createMind();
  judge(mind, hitSense(0, 0), 0);
  judge(mind, hitSense(5_000, 0), 5_000);
  assert.equal(judge(mind, hitSense(8_000, 0), 8_000).goal, "wander");
  assert.equal(judge(mind, hitSense(9_000, 0), 9_000).goal, "wander");
  const again = judge(mind, hitSense(9_500, 9_500), 9_500);
  assert.equal(again.goal, "evade");
  assert.equal(again.priority, 9.5);
});

test("arbiter: a new seq during cool-down is a new hit even when the timestamp matches", () => {
  const mind = createMind();
  const hit = (now: number, seq: number) => judge(mind, hitSense(now, 0, { damage: { attacker: 4, ageMs: now, seq } }), now);
  hit(0, 1);
  hit(5_000, 1);
  assert.equal(hit(8_000, 1).goal, "wander");
  assert.equal(hit(8_300, 1).goal, "wander");
  assert.equal(hit(8_300, 2).goal, "evade");
});

test("arbiter: Evade does not end while the threat can see the bot, unless it is 35 m away", () => {
  const mind = createMind();
  const seen = { threatSeen: true, threatDist: 10 };
  assert.equal(judge(mind, hitSense(0, 0, seen), 0).goal, "evade");
  assert.equal(judge(mind, hitSense(10_000, 0, seen), 10_000).goal, "evade");
  assert.equal(judge(mind, hitSense(20_000, 0, seen), 20_000).goal, "evade");
  const far = { threatSeen: true, threatDist: 35 };
  assert.equal(judge(mind, hitSense(20_000, 0, far), 20_000).goal, "evade");
  assert.equal(judge(mind, hitSense(22_999, 0, far), 22_999).goal, "evade");
  assert.equal(judge(mind, hitSense(23_000, 0, far), 23_000).goal, "wander");
});

test("arbiter: becoming visible again restarts the safe hold", () => {
  const mind = createMind();
  judge(mind, hitSense(0, 0), 0);
  judge(mind, hitSense(5_000, 0), 5_000);
  judge(mind, hitSense(6_000, 0, { threatDist: 5, threatSeen: true }), 6_000);
  judge(mind, hitSense(7_000, 0), 7_000);
  assert.equal(judge(mind, hitSense(9_999, 0), 9_999).goal, "evade");
  assert.equal(judge(mind, hitSense(10_000, 0), 10_000).goal, "wander");
});

test("arbiter: Escape resumes after Evade with the same timer", () => {
  const mind = createMind();
  judge(mind, walled, 0);
  const started = judge(mind, walled, 60 * S);
  assert.equal(started.goal, "escape");
  assert.equal(started.escapeMs, 0);
  const fled = judge(mind, hitSense(70 * S, 70 * S, { ...walled, threatPlace: "other" }), 70 * S);
  assert.equal(fled.goal, "evade");
  assert.equal(fled.escapeMs, 10 * S);
  assert.equal(judge(mind, hitSense(75 * S, 70 * S, { ...walled, threatPlace: "other" }), 75 * S).goal, "evade");
  const back = judge(mind, hitSense(78 * S, 70 * S, { ...walled, threatPlace: "other" }), 78 * S);
  assert.equal(back.goal, "escape");
  assert.equal(back.escapeMs, 18 * S);
  assert.equal(back.respawn, false);
  const due = judge(mind, { ...walled }, 180 * S);
  assert.equal(due.goal, "escape");
  assert.equal(due.respawn, true);
});

test("arbiter: armed above half hp does not flee, and cornered does not either", () => {
  const armed = createMind();
  const above = judge(armed, hitSense(0, 0, { armed: true, hpFrac: 0.6, threatDist: 3 }), 0);
  assert.equal(above.goal, "wander");
  const atHalf = judge(createMind(), hitSense(0, 0, { armed: true, hpFrac: 0.5, threatDist: 3 }), 0);
  assert.equal(atHalf.goal, "evade");
  const cornered = createMind();
  cornered.cornered = true;
  assert.equal(judge(cornered, hitSense(0, 0, { threatDist: 3 }), 0).goal, "wander");
  assert.equal(cornered.cornered, true);
});

test("arbiter: death clears Evade, including a cool-down and cornered", () => {
  const mind = createMind();
  assert.equal(judge(mind, hitSense(0, 0), 0).goal, "evade");
  judge(mind, hitSense(5_000, 0), 5_000);
  assert.equal(judge(mind, hitSense(8_000, 0), 8_000).goal, "wander");
  mind.cornered = true;
  assert.equal(judge(mind, { ...calm, alive: false }, 8_500).goal, "wander");
  assert.equal(mind.cornered, undefined);
  assert.equal(mind.evadeSince, undefined);
  assert.equal(mind.evadeEndedAt, undefined);
  assert.equal(mind.coolHitAt, undefined);
  // The same note is still inside the old cool-down window. Death dropped it.
  assert.equal(judge(mind, hitSense(9_000, 0), 9_000).goal, "evade");
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

function foeAt(world: AuthoritativeWorld, x: number, z: number): number {
  const id = world.createEntity(0n, { type: "pawn", shape: "capsule" });
  world.enqueue({
    kind: "setTransform",
    entity: id,
    position: { x, y: 0, z },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    scale: { x: 1, y: 1, z: 1 },
  });
  world.commit(1n);
  return id;
}

test("brain: flee is chosen once per entry and per new hit, not per tick", () => {
  const nav = yardNav({ open: true });
  const { world, id, agent } = botWorld(2, 2);
  const foe = foeAt(world, 0, 2);
  let clock = 0;
  const health = createPawnHealth(() => clock);
  const sense = fakeSense([id]);
  let calls = 0;
  let presses = 0;
  const threats: Array<{ x: number; z: number }> = [];
  const brain = createHostBotBrain({
    world,
    agents: [agent as never],
    health,
    sense,
    nav,
    now: () => clock,
    useDoor: () => {
      presses += 1;
      return "opened";
    },
    pickFlee(input) {
      calls += 1;
      threats.push({ x: input.threat.x, z: input.threat.z });
      return { placeId: "room", x: 2, y: 0, z: 3, score: 1 };
    },
  });
  const tick = (patch: Record<string, unknown> = {}) => {
    sense.fresh(id, { at: clock, ...patch });
    brain.update();
  };
  tick();
  assert.equal(calls, 0);
  tick({ damage: { attacker: undefined, ageMs: 0 } });
  assert.equal(calls, 1);
  assert.equal(brain.goalOf(id), "evade");
  assert.deepEqual(threats[0], { x: 2, z: 2 });
  assert.deepEqual(agent.override.goal, { x: 2, y: 0, z: 3 });
  assert.equal(agent.override.gait, "run");
  steerUnownedWander(world, agent as never, 1, () => 0.1, nav, createNavCache());
  assert.equal(agent.gait, "run");
  assert.notEqual(agent.override.openDoors, true);
  for (let i = 0; i < 4; i += 1) {
    clock += 200;
    tick({ damage: { attacker: undefined, ageMs: clock } });
  }
  assert.equal(calls, 1);
  assert.equal(presses, 0);
  clock = 1_000;
  tick({ damage: { attacker: foe, ageMs: 0 } });
  assert.equal(calls, 2);
  assert.equal(brain.goalOf(id), "evade");
  assert.deepEqual(threats[1], { x: 0, z: 2 });
  assert.equal(presses, 0);
});

test("brain: no flee point still runs and does not log cornered", () => {
  const nav = yardNav({ open: false });
  const { world, id, agent } = botWorld(2, 2);
  let clock = 0;
  const health = createPawnHealth(() => clock);
  const sense = fakeSense([id]);
  const logs: string[] = [];
  let calls = 0;
  const brain = createHostBotBrain({
    world,
    agents: [agent as never],
    health,
    sense,
    nav,
    now: () => clock,
    log: (line) => logs.push(line),
    pickFlee() {
      calls += 1;
      return undefined;
    },
  });
  const tick = (patch: Record<string, unknown> = {}) => {
    sense.fresh(id, { at: clock, ...patch });
    brain.update();
  };
  tick({ damage: { attacker: undefined, ageMs: 0 } });
  assert.equal(calls, 1);
  assert.equal(brain.goalOf(id), "evade");
  assert.equal(agent.override?.gait, "run");
  steerUnownedWander(world, agent as never, 1, () => 0.1, nav, createNavCache());
  assert.equal(agent.gait, "run");
  assert.deepEqual(logs, []);
  clock = 500;
  tick({ damage: { attacker: undefined, ageMs: clock } });
  assert.equal(calls, 1);
  assert.equal(brain.goalOf(id), "evade");
  assert.deepEqual(logs, []);
});

test("brain: another hit while fleeing picks again and does not corner", () => {
  const nav = yardNav({ open: true });
  const { world, id, agent } = botWorld(2, 2);
  let clock = 0;
  const health = createPawnHealth(() => clock);
  const sense = fakeSense([id]);
  const logs: string[] = [];
  let calls = 0;
  const brain = createHostBotBrain({
    world,
    agents: [agent as never],
    health,
    sense,
    nav,
    now: () => clock,
    log: (line) => logs.push(line),
    pickFlee() {
      calls += 1;
      return { placeId: "room", x: 2, y: 0, z: 3, score: 1 };
    },
  });
  const hit = (seq: number) => {
    sense.fresh(id, { at: clock, damage: { attacker: undefined, ageMs: 0, seq } });
    brain.update();
  };
  hit(1);
  assert.equal(calls, 1);
  assert.equal(brain.goalOf(id), "evade");
  assert.equal(agent.override.gait, "run");
  clock = 100;
  hit(2);
  assert.equal(calls, 2);
  clock = 200;
  hit(3);
  assert.equal(calls, 3);
  assert.equal(brain.goalOf(id), "evade");
  assert.ok(agent.override);
  assert.deepEqual(logs, []);
});

test("brain: a visible arrival re-picks at most three times, then the bot is cornered", () => {
  const nav = yardNav({ open: true });
  const { world, id, agent } = botWorld(2, 2);
  let clock = 0;
  const health = createPawnHealth(() => clock);
  const sense = fakeSense([id]);
  const logs: string[] = [];
  let calls = 0;
  const brain = createHostBotBrain({
    world,
    agents: [agent as never],
    health,
    sense,
    nav,
    now: () => clock,
    log: (line) => logs.push(line),
    lineOfSight: () => true,
    pickFlee() {
      calls += 1;
      return { placeId: "room", x: 2, y: 0, z: 3, score: 1 };
    },
  });
  const tick = () => {
    sense.fresh(id, { at: clock, damage: { attacker: undefined, ageMs: clock, seq: 1 } });
    brain.update();
  };
  tick();
  assert.equal(calls, 1);
  for (let i = 1; i <= 3; i += 1) {
    agent.followEnd = "arrived";
    tick();
    assert.equal(calls, 1 + i);
    assert.equal(brain.goalOf(id), "evade");
  }
  agent.followEnd = "stuck";
  tick();
  assert.equal(calls, 4, "the fourth leave does not pick again");
  assert.equal(brain.goalOf(id), "wander");
  assert.equal(agent.override, undefined);
  assert.deepEqual(logs, [`[live] brain ${id} cornered`]);
  agent.followEnd = "arrived";
  tick();
  assert.equal(calls, 4);
  assert.deepEqual(logs, [`[live] brain ${id} cornered`]);
});

test("brain: a hidden arrival keeps the claim, and the sight ray is at most 5 Hz", () => {
  const nav = yardNav({ open: true });
  const { world, id, agent } = botWorld(2, 2);
  let clock = 0;
  const health = createPawnHealth(() => clock);
  const sense = fakeSense([id]);
  let calls = 0;
  let rays = 0;
  const brain = createHostBotBrain({
    world,
    agents: [agent as never],
    health,
    sense,
    nav,
    now: () => clock,
    lineOfSight() {
      rays += 1;
      return false;
    },
    pickFlee() {
      calls += 1;
      return { placeId: "room", x: 2, y: 0, z: 3, score: 1 };
    },
  });
  const tick = (seq = 1) => {
    sense.fresh(id, { at: clock, damage: { attacker: undefined, ageMs: clock, seq } });
    brain.update();
  };
  tick();
  assert.equal(calls, 1);
  assert.equal(rays, 1);
  agent.followEnd = "arrived";
  tick();
  assert.equal(calls, 1, "hidden arrival does not re-pick");
  assert.equal(brain.goalOf(id), "evade");
  assert.ok(agent.override);
  for (let i = 0; i < 19; i += 1) {
    clock += 50;
    tick();
  }
  assert.equal(rays, 5, "one ray per 200 ms, from t = 0 through t = 950");
  assert.equal(calls, 1);
});

test("brain: a new seq during cool-down retriggers Evade, and a grenade with no attacker does too", () => {
  const nav = yardNav({ open: true });
  const { world, id, agent } = botWorld(2, 2);
  const foe = foeAt(world, 2, 40);
  let clock = 0;
  const health = createPawnHealth(() => clock);
  const sense = fakeSense([id]);
  const threats: Array<{ x: number; z: number }> = [];
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
      return { placeId: "room", x: 2, y: 0, z: 3, score: 1 };
    },
  });
  const tick = (patch: Record<string, unknown>) => {
    sense.fresh(id, { at: clock, ...patch });
    brain.update();
  };
  tick({ damage: { attacker: foe, ageMs: 0, seq: 1 } });
  assert.equal(brain.goalOf(id), "evade");
  assert.equal(calls, 1);
  clock = 5_000;
  tick({ damage: { attacker: foe, ageMs: 5_000, seq: 1 } });
  assert.equal(brain.goalOf(id), "evade");
  clock = 8_000;
  tick({ damage: { attacker: foe, ageMs: 8_000, seq: 1 } });
  assert.equal(brain.goalOf(id), "wander");
  clock = 8_300;
  tick({ damage: { attacker: foe, ageMs: 8_300, seq: 1 } });
  assert.equal(brain.goalOf(id), "wander");
  assert.equal(calls, 1);
  tick({ damage: { attacker: undefined, ageMs: 8_300, seq: 2 } });
  assert.equal(brain.goalOf(id), "evade");
  assert.equal(calls, 2);
  assert.deepEqual(threats[1], { x: 2, z: 2 });
});

test("brain: a point with no walk still flees, and death lets the next hit flee", () => {
  const nav = yardNav({ open: false });
  const { world, id, agent } = botWorld(2, 2);
  let clock = 0;
  const health = createPawnHealth(() => clock);
  const sense = fakeSense([id]);
  const logs: string[] = [];
  let walkable = false;
  const brain = createHostBotBrain({
    world,
    agents: [agent as never],
    health,
    sense,
    nav,
    now: () => clock,
    log: (line) => logs.push(line),
    pickFlee: () => (walkable ? { placeId: "room", x: 2, y: 0, z: 3, score: 1 } : { placeId: "nowhere", x: 500, y: 0, z: 500, score: 1 }),
  });
  const tick = (patch: Record<string, unknown> = {}) => {
    sense.fresh(id, { at: clock, ...patch });
    brain.update();
  };
  tick({ damage: { attacker: undefined, ageMs: 0 } });
  assert.equal(brain.goalOf(id), "evade");
  assert.ok(agent.override);
  assert.notEqual(agent.override.goal.x, 500);
  assert.equal(agent.override.gait, "run");
  assert.deepEqual(logs, []);
  clock = 1_000;
  tick({ alive: false });
  assert.equal(brain.goalOf(id), "wander");
  assert.equal(agent.override, undefined);
  walkable = true;
  clock = 1_500;
  tick({ alive: true, damage: { attacker: undefined, ageMs: 0 } });
  assert.equal(brain.goalOf(id), "evade");
  assert.deepEqual(agent.override.goal, { x: 2, y: 0, z: 3 });
});

test("brain: Escape resumes after Evade and still respawns on its old timer", () => {
  const door = { open: true };
  const nav = yardNav(door);
  const { world, id, agent } = botWorld(2, 2);
  // Far enough that the bot is already safe on distance, and still inside the room.
  const foe = foeAt(world, 2, 40);
  let clock = 0;
  const health = createPawnHealth(() => clock);
  const sense = fakeSense([id]);
  const brain = createHostBotBrain({
    world,
    agents: [agent as never],
    health,
    sense,
    nav,
    now: () => clock,
    // The yard is shorter than minRunM, so the real picker would corner at once.
    pickFlee: () => ({ placeId: "room", x: 2, y: 0, z: 3, score: 1 }),
  });
  const inside = { place: "room", msNoProgress: 60 * S, routeOut: { open: true, unlocked: true } };
  const tick = (patch: Record<string, unknown>) => {
    clock = typeof patch.at === "number" ? patch.at : clock;
    sense.fresh(id, patch);
    brain.update();
  };
  tick({ ...inside, at: 60 * S });
  assert.equal(brain.goalOf(id), "escape");
  assert.ok(agent.override, "escape has a stand point");
  tick({ ...inside, at: 61 * S, damage: { attacker: foe, ageMs: 0 } });
  assert.equal(brain.goalOf(id), "evade");
  assert.ok(agent.override);
  assert.notEqual(agent.override.openDoors, true);
  tick({ ...inside, at: 66 * S, damage: { attacker: foe, ageMs: 5 * S } });
  assert.equal(brain.goalOf(id), "evade");
  tick({ ...inside, at: 69 * S, damage: { attacker: foe, ageMs: 8 * S } });
  assert.equal(brain.goalOf(id), "escape");
  assert.ok(agent.override);
  tick({ ...inside, at: 179 * S, damage: { attacker: foe, ageMs: 118 * S } });
  assert.equal(brain.goalOf(id), "escape");
  assert.equal(health.isDead(id), false);
  tick({ ...inside, at: 180 * S, damage: { attacker: foe, ageMs: 119 * S } });
  assert.equal(health.isDead(id), true);
});
