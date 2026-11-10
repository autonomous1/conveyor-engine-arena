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

const { AuthoritativeWorld } = await import("conveyor-engine-world");
const { createHostBotBrain } = await import("../src/server/bot-brain.ts");
const { createHostBotSense } = await import("../src/server/bot-sense.ts");
const { createArenaDoors, createDoorBlockers } = await import("../src/server/doors.ts");
const { doorsOnRoute, planEscapeGoal, splitMix, steerUnownedWander, stepUnownedWander } = await import("../src/server/game.ts");
const { pawnBodies } = await import("../src/server/pickups.ts");
const { loadArena } = await import("../src/server/world-loader.ts");
const { createPawnHealth } = await import("../src/shared/health.ts");
const { createNavCache } = await import("../src/shared/nav/legs.ts");

const S = 1000;
const HALL = "brutalist-building-1-cbake-9.floor-1.hall";
const DOOR = (suffix: string) => `brutalist-building-1-cbake-9.door-1-1-9-22${suffix}`;
/** The four exterior doors of the hall. All start locked in the arena data. */
const EXTERIOR = ["", "-0", "-0-7", "-4"].map(DOOR);

type Rig = ReturnType<typeof rig>;

/**
 * The real arena: real world, real doors with their blockers, real sensor and
 * brain, one bot, and a fake clock that the test advances 50 ms a tick.
 * `unlocked`: exterior doors that start shut and unlocked. `open`: start open.
 */
function rig(opts: {
  x?: number;
  z?: number;
  unlocked?: string[];
  open?: string[];
  /** False: the brain has no `useDoor`, as in 45a. */
  useDoor?: boolean;
  /** True: `useDoor` answers "none" and never presses, as if the bot could not reach the leaf. */
  cannotReach?: boolean;
  spy?: Array<[number, string, string]>;
} = {}) {
  const loaded = loadArena();
  const agent = loaded.agents.find((item) => item.role !== "player")!;
  // `loadArena` shares its view between calls, so a test edits its own copy of the doors.
  const doors = loaded.view.doors.map((door) => ({ ...door }));
  for (const id of [...(opts.unlocked ?? []), ...(opts.open ?? [])]) {
    const door = doors.find((item) => item.id === id)!;
    door.locked = false;
    door.open = (opts.open ?? []).includes(id);
  }
  let clock = 0;
  const health = createPawnHealth(() => clock);
  const doorLog: string[] = [];
  const doorHost = createArenaDoors({
    doors,
    pawnOf: (id) => pawnBodies(loaded.world, health).find((body) => body.id === id),
    keys: { hasKey: () => false, consumeKey: () => false },
    sendAll() {},
    ownedPawn: () => undefined,
    sessionId: () => undefined,
    alive: (id) => !health.isDead(id),
    blockers: createDoorBlockers(loaded.world),
    log: (line) => doorLog.push(line),
  });
  const sense = createHostBotSense({
    world: loaded.world,
    agents: loaded.agents,
    health,
    sceneGraph: loaded.sceneGraph,
    doors: () => doorHost.snapshot(),
    pickups: [],
    remainingPickups: () => [],
    ownedEntities: () => [],
    now: () => clock,
  });
  const nav = {
    sceneGraph: loaded.sceneGraph!,
    regions: loaded.regions!,
    aabbs: loaded.view.aabbs,
    doors,
    pawnRadius: loaded.view.pawnRadius,
    pawnHeight: loaded.view.pawnHeight,
    liveDoors: () => doorHost.snapshot(),
  };
  const logs: string[] = [];
  const brain = createHostBotBrain({
    world: loaded.world,
    agents: [agent],
    health,
    sense,
    nav,
    now: () => clock,
    log: (line) => logs.push(line),
    ...(opts.useDoor === false
      ? {}
      : {
        useDoor: (pawnId: number, door: string) => {
          const result = opts.cannotReach ? "none" : doorHost.useDoorAs(pawnId, { door });
          opts.spy?.push([clock, door, result]);
          return result;
        },
      }),
  });
  const region = loaded.regions!.places.find((place) => place.placeId === HALL)!.regions[6]!;
  const at = { x: opts.x ?? (region.minX + region.maxX) / 2, y: region.y, z: opts.z ?? (region.minZ + region.maxZ) / 2 };
  loaded.world.enqueue({ kind: "setTransform", entity: agent.id, position: at, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } });
  loaded.world.commit(1n);
  const rng = splitMix(5);
  const cache = createNavCache();
  let tick = 1;
  const pos = () => loaded.world.store.view(agent.id)!.position;
  return {
    loaded, agent, doors, health, doorHost, sense, brain, nav, logs, doorLog, pos,
    get clock() { return clock; },
    place: () => sense.get(agent.id)?.place,
    /** Advance `ms` of fake time. Stops early when `until` holds. */
    run(ms: number, until?: () => boolean) {
      const end = clock + ms;
      while (clock < end) {
        tick += 1;
        clock += 50;
        steerUnownedWander(loaded.world, agent, tick, rng, nav, cache, []);
        stepUnownedWander(loaded.world, agent);
        loaded.world.commit(BigInt(tick));
        sense.update(pawnBodies(loaded.world, health));
        brain.update();
        if (until?.()) return true;
      }
      return until ? false : true;
    },
  };
}

const doorOpen = (r: Rig, id: string) => r.doorHost.snapshot().find((row) => row.id === id)!.open;

// ---- useDoorAs ----

function lone(opts: { locked?: boolean; open?: boolean } = {}) {
  const door = {
    id: "gate",
    model: "/assets/models/door1.glb",
    position: [0, 0, 0] as [number, number, number],
    yaw: 0,
    hinge: "left" as const,
    size: [2, 2.1, 0.08] as [number, number, number],
    open: opts.open === true,
    ...(opts.locked ? { locked: true, key: "key" } : {}),
  };
  let held = false;
  const frames: unknown[] = [];
  const logs: string[] = [];
  let body = { id: 7, x: 1, y: 0, z: 0.3, radius: 0.5, height: 1.8, alive: true };
  const host = createArenaDoors({
    doors: [door],
    pawnOf: () => body,
    keys: { hasKey: () => held, consumeKey: () => false },
    sendAll: (frame) => frames.push(frame),
    ownedPawn: () => 7,
    sessionId: () => 1,
    log: (line) => logs.push(line),
  });
  return { host, frames, logs, give: () => { held = true; }, move: (x: number, z: number) => { body = { ...body, x, z }; } };
}

test("useDoorAs: opens a shut unlocked door in reach, broadcasts it, and never closes one", () => {
  const rigged = lone();
  assert.equal(rigged.host.useDoorAs(7, { door: "gate" }), "opened");
  assert.deepEqual(rigged.frames, [{ t: "door", id: "gate", open: true, locked: false }]);
  assert.equal(rigged.host.useDoorAs(7, { door: "gate" }), "open", "an open door is left alone");
  assert.equal(rigged.host.snapshot()[0]!.open, true);
  assert.equal(rigged.frames.length, 1);
  // A player's use frame is unchanged: it toggles.
  assert.equal(rigged.host.onFrame(1, { t: "use", v: 1, seq: 1 }), true);
  assert.equal(rigged.host.snapshot()[0]!.open, false);
});

test("useDoorAs: reach, door choice, locks and keys follow the player rules", () => {
  const rigged = lone({ locked: true });
  assert.equal(rigged.host.useDoorAs(7, { door: "gate" }), "locked");
  assert.equal(rigged.host.snapshot()[0]!.locked, true);
  rigged.give();
  assert.equal(rigged.host.useDoorAs(7, { door: "gate" }), "opened");
  assert.deepEqual(rigged.host.snapshot()[0], { id: "gate", open: true, locked: false });

  const far = lone();
  far.move(20, 20);
  assert.equal(far.host.useDoorAs(7, { door: "gate" }), "none");
  assert.deepEqual(far.logs, [], "a bot out of reach does not log");
  far.move(1, 0.3);
  assert.equal(far.host.useDoorAs(7, { door: "other" }), "none", "only the named door");
  // The player path still answers false for no door in reach, and logs it.
  far.move(20, 20);
  assert.equal(far.host.onFrame(1, { t: "use", v: 1, seq: 1 }), false);
  assert.match(far.logs[0]!, /no door in reach/);
});

// ---- the real arena ----

test("real arena: a shut unlocked exterior door in the cbake-9 hall is pressed once and the bot walks out", () => {
  const spy: Array<[number, string, string]> = [];
  const r = rig({ unlocked: [DOOR("-4")], spy });
  // Every other exterior door is shut and locked: this is the only way out.
  assert.equal(r.run(55 * S, () => r.place() === "outside"), false, "not trapped before 60 s");
  assert.equal(r.brain.goalOf(r.agent.id), "wander");
  assert.deepEqual(spy, [], "Wander never presses a door");
  assert.equal(doorOpen(r, DOOR("-4")), false);

  assert.equal(r.run(30 * S, () => doorOpen(r, DOOR("-4"))), true, "never pressed the door");
  assert.equal(r.brain.goalOf(r.agent.id), "escape");
  assert.equal(r.run(60 * S, () => r.place() === "outside"), true, "never got out");
  assert.equal(doorOpen(r, DOOR("-4")), true);
  // It presses from 2.5 m out, so the early presses are out of reach. Exactly one opens it.
  assert.deepEqual(spy.filter(([, , result]) => result !== "none").map(([, door, result]) => [door, result]), [[DOOR("-4"), "opened"]]);
  assert.ok(spy.every(([, door]) => door === DOOR("-4")), "no other door is ever tried");
  assert.ok(spy[0]![0] >= 60 * S, `pressed at ${spy[0]![0]}`);
  for (const id of EXTERIOR.filter((item) => item !== DOOR("-4"))) assert.equal(doorOpen(r, id), false, id);
  assert.equal(r.health.isDead(r.agent.id), false);
  assert.deepEqual(r.logs, []);
  assert.equal(r.doorLog.length, 1);
  assert.match(r.doorLog[0]!, new RegExp(`\\[door\\] use bot pawn=${r.agent.id} .*: ${DOOR("-4")} open=true locked=false`));
  // Outside it hands back to Wander, and the door stays as it is.
  r.run(2 * S);
  assert.equal(r.brain.goalOf(r.agent.id), "wander");
  assert.equal(r.agent.override, undefined);
  assert.equal(doorOpen(r, DOOR("-4")), true);
});

test("real arena: every exterior door locked means no press, then the 120 s respawn", () => {
  const spy: Array<[number, string, string]> = [];
  const r = rig({ spy });
  assert.equal(r.run(178 * S), true);
  assert.equal(r.brain.goalOf(r.agent.id), "escape");
  assert.equal(r.agent.override, undefined, "no plan through a locked door");
  assert.equal(r.health.isDead(r.agent.id), false);
  r.run(4 * S);
  assert.equal(r.health.isDead(r.agent.id), true);
  assert.deepEqual(spy, [], "a locked door is never pressed");
  for (const id of EXTERIOR) assert.equal(doorOpen(r, id), false);
  assert.deepEqual(r.logs, []);
});

test("real arena: a door that will not open is given up on, and the respawn takes the bot", () => {
  const r = rig({ unlocked: [DOOR("-4")], cannotReach: true });
  assert.equal(r.run(120 * S, () => r.logs.length > 0), true, "never gave up");
  assert.match(r.logs[0]!, /gave up on door .*door-1-1-9-22-4: out of reach/);
  assert.ok(r.clock >= 75 * S, `gave up at ${r.clock}: waits the full 15 s at the leaf`);
  assert.equal(doorOpen(r, DOOR("-4")), false);
  assert.equal(r.agent.override, undefined, "the claim is dropped");
  assert.equal(r.health.isDead(r.agent.id), false);
  assert.equal(r.run(125 * S, () => r.health.isDead(r.agent.id)), true, "falls back to the 45a respawn");
  assert.ok(r.clock <= 185 * S, `died at ${r.clock}`);
  assert.equal(r.logs.length, 1, "one line, not one per tick");
});

test("real arena: without useDoor (45a) a shut unlocked door is left alone and the bot respawns", () => {
  const r = rig({ unlocked: [DOOR("-4")], useDoor: false });
  assert.equal(r.run(178 * S), true);
  assert.equal(r.agent.override, undefined);
  assert.equal(doorOpen(r, DOOR("-4")), false);
  r.run(4 * S);
  assert.equal(r.health.isDead(r.agent.id), true);
});

test("real arena: the nearest exterior door is shut, another is open: the escape walk uses the open one", () => {
  // Beside "-0-7" at the east end of the hall, which stays shut and locked. "-4" is open.
  const r = rig({ x: 0.5, z: -26.5, open: [DOOR("-4")], useDoor: false });
  const goal = planEscapeGoal(r.loaded.world, r.agent, r.nav, createNavCache(), undefined, false);
  assert.ok(goal, "a plan through the open door");
  r.agent.override = { goal };
  let crossed = false;
  const reached = r.run(150 * S, () => {
    const path = r.agent.path;
    if (path && doorsOnRoute(r.doors.filter((door) => door.open !== true), path as never).length > 0) crossed = true;
    return r.place() === "outside";
  });
  assert.equal(crossed, false, "the walk crossed a shut leaf");
  assert.equal(reached, true, `stuck at ${JSON.stringify(r.pos())}`);
  assert.equal(doorOpen(r, DOOR("-0-7")), false);
  assert.equal(r.doorLog.length, 0, "no use pressed");
  assert.ok(r.pos().z > -12, `left through "-4" at z -11.6, was ${r.pos().z}`);
});

test("real arena: a plan never crosses a shut door leaf, and an open exterior door is a way out wherever the bot stands", () => {
  const r = rig({ open: [DOOR("-4")], useDoor: false });
  const cache = createNavCache();
  const regions = r.loaded.regions!.places.find((place) => place.placeId === HALL)!.regions;
  const shut = r.doors.filter((door) => door.open !== true);
  assert.ok(shut.length > 50);
  for (const region of regions.filter((_, index) => index % 4 === 2)) {
    const at = { x: (region.minX + region.maxX) / 2, y: region.y, z: (region.minZ + region.maxZ) / 2 };
    r.loaded.world.enqueue({ kind: "setTransform", entity: r.agent.id, position: at, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } });
    r.loaded.world.commit(BigInt(100 + regions.indexOf(region)));
    const goal = planEscapeGoal(r.loaded.world, r.agent, r.nav, cache, undefined, false);
    assert.ok(goal, `no way out from ${region.id}`);
    r.agent.override = { goal };
    steerUnownedWander(r.loaded.world, r.agent, 1000 + regions.indexOf(region), splitMix(1), r.nav, cache, []);
    assert.ok(r.agent.path && r.agent.path.length > 1, `no walk from ${region.id}`);
    const hit = doorsOnRoute(shut, r.agent.path as never, r.nav.sceneGraph);
    assert.deepEqual(hit, [], `the walk from ${region.id} crosses a shut leaf`);
    r.agent.override = undefined;
  }
});

test("real arena: a Wander bot never presses a door, even one it stands beside", () => {
  const spy: Array<[number, string, string]> = [];
  // Beside "-4", shut and unlocked, for 50 s: under the 60 s trap time, so only Wander runs.
  const r = rig({ x: -5.66, z: -13, unlocked: [DOOR("-4")], spy });
  r.run(50 * S);
  assert.equal(r.brain.goalOf(r.agent.id), "wander");
  assert.deepEqual(spy, []);
  assert.equal(doorOpen(r, DOOR("-4")), false);
  assert.deepEqual(r.doorLog, []);
});

// ---- outside ----

/** A pen with a big far region that nothing connects to. The bot stands in the pen. */
function penNav() {
  const rect = (id: string, kind: "room" | "outside", minX: number, maxX: number, minZ: number, maxZ: number) => ({
    id,
    kind,
    y: 0,
    polygon: [[minX, minZ], [maxX, minZ], [maxX, maxZ], [minX, maxZ]] as Array<[number, number]>,
    bounds: { minX, maxX, minZ, maxZ },
  });
  const places = [rect("pen", "room", 0, 12, 0, 12), rect("far", "room", 30, 100, 30, 100), rect("outside", "outside", -200, 200, -200, 200)];
  const sceneGraph = {
    formatVersion: 1 as const,
    units: "meters" as const,
    places,
    portals: [],
    placeById: new Map(places.map((item) => [item.id, item])),
    portalsOf: new Map(),
    shafts: [],
    skip: new Set<string>(),
  };
  const regions = {
    version: 1 as const,
    radius: 0.5,
    height: 1.8,
    places: [
      { placeId: "pen", regions: [{ id: "p", minX: 0.5, maxX: 11.5, minZ: 0.5, maxZ: 11.5, y: 0 }], portals: [] },
      { placeId: "far", regions: [{ id: "f", minX: 30.5, maxX: 99.5, minZ: 30.5, maxZ: 99.5, y: 0 }], portals: [] },
    ],
  };
  return { sceneGraph, regions, aabbs: [], doors: [], pawnRadius: 0.5, pawnHeight: 1.8 };
}

function penBot(x: number, z: number) {
  const world = new AuthoritativeWorld();
  const id = world.createEntity(0n, { type: "pawn", shape: "capsule" });
  world.enqueue({ kind: "setTransform", entity: id, position: { x, y: 0, z }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } });
  world.enqueue({ kind: "setBounds", entity: id, radius: 0.5 });
  world.commit(0n);
  return { world, agent: { id, heading: 0, gait: "idle", nextTurn: 0, speeds: { idle: 0, walk: 1, run: 2, fall: 0, angry: 0 } } as Record<string, any> };
}

test("wander: nearly every goal sits where the pawn cannot walk, and it still walks the pen", () => {
  const nav = penNav();
  for (let seed = 1; seed <= 25; seed += 1) {
    const { world, agent } = penBot(6, 6);
    steerUnownedWander(world, agent as never, 1, splitMix(seed), nav as never, createNavCache());
    assert.ok(agent.goal, `seed ${seed}: no goal`);
    assert.ok(agent.goal.x < 12 && agent.goal.z < 12, `seed ${seed}: goal ${JSON.stringify(agent.goal)} is not in the pen`);
  }
});

test("wander: a pick with no walkable goal tries again in 2 s, not a whole goal's time", () => {
  const nav = penNav();
  // Off every region: nothing is walkable from here, so every sample fails.
  const { world, agent } = penBot(-50, -50);
  steerUnownedWander(world, agent as never, 100, splitMix(1), nav as never, createNavCache());
  assert.equal(agent.goal, undefined);
  assert.equal(agent.gait, "idle");
  assert.equal(agent.nextTurn, 140, "retry 40 ticks later");
  // Still idle and waiting at tick 139: no new pick.
  const rolls: number[] = [];
  steerUnownedWander(world, agent as never, 139, () => (rolls.push(1), 0.5), nav as never, createNavCache());
  assert.deepEqual(rolls, []);
  // At 140 it picks again. The world has changed: the bot can now walk.
  world.enqueue({ kind: "setTransform", entity: agent.id, position: { x: 6, y: 0, z: 6 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } });
  world.commit(1n);
  steerUnownedWander(world, agent as never, 140, splitMix(2), nav as never, createNavCache());
  assert.ok(agent.goal);
});

test("real arena: a bot wandering outside with every door shut is never trapped, escaping or respawned", () => {
  // Open ground west of the buildings.
  for (const [x, z] of [[-60, 20], [-40, -60], [30, 60]] as const) {
    const r = rig({ x, z });
    let worst = 0;
    let escaped = false;
    r.run(240 * S, () => {
      const sense = r.sense.get(r.agent.id);
      if (sense) worst = Math.max(worst, sense.msNoProgress);
      if (r.brain.goalOf(r.agent.id) === "escape") escaped = true;
      return false;
    });
    assert.equal(r.place(), "outside", `${x},${z}`);
    assert.equal(escaped, false, `${x},${z} latched Escape`);
    assert.ok(worst < 60 * S, `${x},${z} stood still for ${worst} ms`);
    assert.equal(r.health.isDead(r.agent.id), false);
    assert.equal(r.agent.override, undefined);
    assert.deepEqual(r.logs, []);
  }
});

test("real arena: a bot jammed in a door pocket outside never runs Escape, and respawns only after 180 s", () => {
  // The pocket east of a shut leaf in the wall: outside by place, with no walk out.
  const r = rig({ x: 33.4, z: -17.42 });
  let escaped = false;
  let overridden = false;
  assert.equal(r.run(200 * S, () => {
    if (r.brain.goalOf(r.agent.id) === "escape") escaped = true;
    if (r.agent.override) overridden = true;
    return r.health.isDead(r.agent.id);
  }), true, "never respawned");
  assert.equal(escaped, false);
  assert.equal(overridden, false);
  assert.ok(r.clock >= 180 * S, `respawned at ${r.clock}`);
  assert.ok(r.clock < 200 * S);
});
