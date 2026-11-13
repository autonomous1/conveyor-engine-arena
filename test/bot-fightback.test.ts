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
const { stepUnownedWander, steerUnownedWander } = await import("../src/server/game.ts");
const { FIGHT_PRIORITY, createMind, judge } = await import("../src/shared/bots/arbiter.ts");
const { createPawnHealth, MAX_HP } = await import("../src/shared/health.ts");
const { createNavCache } = await import("../src/shared/nav/legs.ts");

const RADIUS = 0.5;
const HEIGHT = 1.8;
const SPEEDS = { idle: 0, walk: 1, run: 2, fall: 0, angry: 0 };
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

function yardNav() {
  const places = [rect("room", "room", 0, 4, 0, 4), rect("outside", "outside", -80, 80, -80, 80)];
  const portals = [
    { id: "gap", kind: "door" as const, a: "room", b: "outside", door: "gap", at: { a: [3.5, 0, 2] as [number, number, number], b: [6.5, 0, 2] as [number, number, number] }, width: 2, cost: 2 },
  ];
  const portalsOf = new Map<string, typeof portals>();
  for (const portal of portals) {
    for (const id of [portal.a, portal.b]) portalsOf.set(id, [...(portalsOf.get(id) ?? []), portal]);
  }
  return {
    sceneGraph: {
      formatVersion: 1 as const,
      units: "meters" as const,
      places,
      portals,
      placeById: new Map(places.map((item) => [item.id, item])),
      portalsOf,
      shafts: [],
      skip: new Set<string>(),
    },
    regions: {
      version: 1 as const,
      radius: RADIUS,
      height: HEIGHT,
      places: [
        { placeId: "room", regions: [{ id: "r", minX: 0.5, maxX: 3.5, minZ: 0.5, maxZ: 3.5, y: 0 }], portals: [] },
        { placeId: "outside", regions: [{ id: "o", minX: 6.5, maxX: 9.5, minZ: 0.5, maxZ: 3.5, y: 0 }], portals: [] },
      ],
    },
    aabbs: [
      { id: 1, minX: 4, maxX: 6, minY: 0, maxY: 3, minZ: 0, maxZ: 1 },
      { id: 2, minX: 4, maxX: 6, minY: 0, maxY: 3, minZ: 3, maxZ: 4 },
    ],
    doors: [{ id: "gap", model: "door.glb", position: [4, 0, 3] as [number, number, number], yaw: 90, hinge: "left" as const, size: [2, 2.2, 2] as [number, number, number], open: true }],
    pawnRadius: RADIUS,
    pawnHeight: HEIGHT,
    liveDoors: () => [{ id: "gap", open: true }],
  };
}

type Agent = {
  id: number;
  heading: number;
  gait: string;
  nextTurn: number;
  speeds: Record<string, number>;
  role?: "player";
  override?: { goal: { x: number; y: number; z: number }; gait?: "walk" | "run"; stance?: "angry"; openDoors?: boolean };
  path?: unknown;
  goal?: unknown;
  followEnd?: "arrived" | "stuck";
};

function spawn(world: AuthoritativeWorld, x: number, z: number, role?: "player"): Agent {
  const id = world.createEntity(0n, { type: "pawn", shape: "capsule" });
  world.enqueue({
    kind: "setTransform",
    entity: id,
    position: { x, y: 0, z },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    scale: { x: 1, y: 1, z: 1 },
  });
  world.enqueue({ kind: "setBounds", entity: id, radius: RADIUS });
  return { id, heading: 0, gait: "walk", nextTurn: 1, speeds: { ...SPEEDS }, ...(role ? { role } : {}) };
}

function fakeSense(ids: number[]) {
  const rows = new Map<number, any>(ids.map((id) => [id, {
    id,
    tick: 0,
    at: 0,
    alive: true,
    place: "room",
    msNoProgress: 0,
    routeOut: { open: true, unlocked: true },
    hpFrac: 1,
  }]));
  return {
    get: (id: number) => rows.get(id),
    ids: () => [...rows.keys()],
    fresh(id: number, patch: Record<string, unknown>) {
      const row = rows.get(id);
      Object.assign(row, patch, { tick: row.tick + 1 });
    },
  };
}

function rig(opts?: { bots?: number; players?: number; rng?: () => number; see?: () => boolean }) {
  const world = new AuthoritativeWorld();
  const botCount = opts?.bots ?? 1;
  const playerCount = opts?.players ?? 1;
  const bots: Agent[] = [];
  for (let i = 0; i < botCount; i += 1) bots.push(spawn(world, 2, 2));
  const players: Agent[] = [];
  for (let i = 0; i < playerCount; i += 1) players.push(spawn(world, 2 + i * 3, 12));
  world.commit(1n);
  let clock = 0;
  const health = createPawnHealth(() => clock);
  const sense = fakeSense(bots.map((bot) => bot.id));
  const shots: Array<{ at: number; id: number; yaw: number; pitch: number }> = [];
  const forgotten: number[] = [];
  let rays = 0;
  const see = opts?.see ?? (() => true);
  const brain = createHostBotBrain({
    world,
    agents: [...bots, ...players] as never,
    health,
    sense,
    nav: yardNav(),
    now: () => clock,
    rng: opts?.rng,
    lineOfSight() {
      rays += 1;
      return see();
    },
    pickFlee: () => FLEE,
    fireAsBot(id, yaw, pitch) {
      shots.push({ at: clock, id, yaw, pitch });
      return "accept";
    },
    forgetBot(id) {
      forgotten.push(id);
    },
  });
  for (const bot of bots) sense.fresh(bot.id, { at: 0 });
  brain.update();
  return {
    world, bots, players, health, sense, brain, shots, forgotten,
    rays: () => rays,
    get clock() { return clock; },
    set clock(next: number) { clock = next; },
  };
}

function wound(box: ReturnType<typeof rig>, bot: Agent, player: Agent, amount?: number): void {
  box.health.wound(bot.id, player.id, amount, "laser");
  box.sense.fresh(bot.id, {
    at: box.clock,
    damage: { attacker: player.id, ageMs: 0, seq: 1, attackerKind: "player" },
  });
}

const facts = {
  threat: true,
  engageable: true,
  neutralized: false,
  lost: false,
  forgotten: false,
};

test("arbiter: FightBack is 9 while the target is worth shooting", () => {
  const sense = {
    alive: true,
    place: "room",
    msNoProgress: 0,
    routeOut: { open: true, unlocked: true },
    armed: true,
    hpFrac: 0.6,
    damage: { attacker: 2, ageMs: 0 },
    fight: facts,
  };
  const mind = createMind();
  const started = judge(mind, sense, 0);
  assert.equal(started.goal, "fightback");
  assert.equal(started.priority, FIGHT_PRIORITY);
  assert.equal(judge(mind, { ...sense, hpFrac: 0.45 }, 400).goal, "fightback");
  assert.equal(judge(mind, { ...sense, hpFrac: 0.4 }, 500).goal, "evade");
  assert.equal(judge(createMind(), { ...sense, fight: undefined }, 0).goal, "wander");
  assert.notEqual(judge(createMind(), { ...sense, armed: false }, 0).goal, "fightback");
  const corner = createMind();
  corner.cornered = true;
  assert.equal(judge(corner, { ...sense, hpFrac: 0.4 }, 0).goal, "fightback");
  const dead = createMind();
  judge(dead, sense, 0);
  assert.notEqual(judge(dead, { ...sense, fight: { ...facts, threat: false, engageable: false, neutralized: true } }, 100).goal, "fightback");
  const lost = createMind();
  judge(lost, sense, 0);
  const faded = { ...sense, fight: { ...facts, lost: true, engageable: false } };
  assert.equal(judge(lost, faded, 100).goal, "fightback");
  assert.notEqual(judge(lost, faded, 1_500).goal, "fightback");
});

test("fightback: the first shot waits out a seeded reaction and then bursts", () => {
  const low = rig({ rng: () => 0 });
  const bot = low.bots[0]!;
  const player = low.players[0]!;
  wound(low, bot, player);
  low.brain.update();
  assert.equal(low.brain.goalOf(bot.id), "fightback");
  assert.equal(low.shots.length, 0);
  for (let t = 50; t <= 3_000; t += 50) {
    low.clock = t;
    low.brain.update();
  }
  assert.deepEqual(low.shots.map((shot) => shot.at), [350, 850, 2050, 2550]);
  for (let i = 1; i < low.shots.length; i += 1) {
    assert.ok(low.shots[i]!.at - low.shots[i - 1]!.at >= 125);
  }

  const high = rig({ rng: () => 1 });
  wound(high, high.bots[0]!, high.players[0]!);
  high.brain.update();
  for (let t = 50; t <= 650; t += 50) {
    high.clock = t;
    high.brain.update();
  }
  assert.equal(high.shots.length, 0);
  high.clock = 700;
  high.brain.update();
  assert.equal(high.shots.length, 1);
  assert.equal(high.shots[0]!.at, 700);
});

test("fightback: two bots answer one player, and four answer six", () => {
  const one = rig({ bots: 3, players: 1, rng: () => 0 });
  for (const bot of one.bots) wound(one, bot, one.players[0]!);
  one.brain.update();
  assert.deepEqual(one.bots.map((bot) => one.brain.goalOf(bot.id)), ["fightback", "fightback", "evade"]);
  assert.equal(one.shots.length, 0);

  const many = rig({ bots: 6, players: 6, rng: () => 0 });
  many.bots.forEach((bot, index) => wound(many, bot, many.players[index]!));
  many.brain.update();
  assert.deepEqual(many.bots.map((bot) => many.brain.goalOf(bot.id)), [
    "fightback", "fightback", "fightback", "fightback", "evade", "evade",
  ]);
});

test("fightback: a dead pawn, a bystander, and a bot attacker draw no shot", () => {
  const dead = rig({ rng: () => 0 });
  const bot = dead.bots[0]!;
  const player = dead.players[0]!;
  wound(dead, bot, player);
  dead.brain.update();
  assert.equal(dead.brain.goalOf(bot.id), "fightback");
  dead.health.wound(player.id, bot.id, MAX_HP, "laser");
  dead.clock = 400;
  dead.brain.update();
  assert.equal(dead.shots.length, 0);
  assert.notEqual(dead.brain.goalOf(bot.id), "fightback");

  const calm = rig({ rng: () => 0 });
  for (let t = 0; t <= 2_000; t += 50) {
    calm.clock = t;
    calm.brain.update();
  }
  assert.equal(calm.shots.length, 0);
  assert.equal(calm.brain.goalOf(calm.bots[0]!.id), "wander");

  const world = new AuthoritativeWorld();
  const shooter = spawn(world, 2, 2);
  const foe = spawn(world, 2, 12);
  const bystander = spawn(world, 12, 2);
  foe.role = "player";
  bystander.role = "player";
  world.commit(1n);
  let clock = 0;
  const health = createPawnHealth(() => clock);
  const sense = fakeSense([shooter.id]);
  const shots: Array<{ at: number; yaw: number }> = [];
  const brain = createHostBotBrain({
    world,
    agents: [shooter, foe, bystander] as never,
    health,
    sense,
    nav: yardNav(),
    now: () => clock,
    rng: () => 0.5,
    lineOfSight: () => true,
    pickFlee: () => FLEE,
    fireAsBot(_id, yaw) {
      shots.push({ at: clock, yaw });
      return "accept";
    },
    forgetBot() {},
  });
  sense.fresh(shooter.id, { at: 0 });
  brain.update();
  health.wound(shooter.id, foe.id, undefined, "laser");
  sense.fresh(shooter.id, { at: 0, damage: { attacker: foe.id, ageMs: 0, seq: 1, attackerKind: "player" } });
  brain.update();
  clock = 525;
  brain.update();
  assert.equal(shots.length, 1);
  assert.equal(shots[0]!.at, 525);
  assert.ok(Math.abs(shots[0]!.yaw) < Math.abs(shots[0]!.yaw - Math.PI / 2));

  const betrayed = rig({ rng: () => 0 });
  betrayed.health.wound(betrayed.bots[0]!.id, betrayed.players[0]!.id, undefined, "laser");
  betrayed.sense.fresh(betrayed.bots[0]!.id, {
    at: 0,
    damage: { attacker: betrayed.players[0]!.id, ageMs: 0, seq: 1, attackerKind: "bot" },
  });
  betrayed.brain.update();
  betrayed.clock = 700;
  betrayed.brain.update();
  assert.equal(betrayed.shots.length, 0);
  assert.notEqual(betrayed.brain.goalOf(betrayed.bots[0]!.id), "fightback");
});

test("fightback: 40% hp evades, and a cornered bot at 40% shoots", () => {
  const hurt = rig({ rng: () => 0 });
  wound(hurt, hurt.bots[0]!, hurt.players[0]!, 60);
  hurt.brain.update();
  for (let t = 50; t <= 1_000; t += 50) {
    hurt.clock = t;
    hurt.brain.update();
  }
  assert.equal(hurt.brain.goalOf(hurt.bots[0]!.id), "evade");
  assert.equal(hurt.shots.length, 0);

  const boxed = rig({ rng: () => 0 });
  const bot = boxed.bots[0]!;
  wound(boxed, bot, boxed.players[0]!, 60);
  const tick = () => {
    boxed.sense.fresh(bot.id, {
      at: boxed.clock,
      damage: { attacker: boxed.players[0]!.id, ageMs: 0, seq: 1, attackerKind: "player" },
    });
    boxed.brain.update();
  };
  tick();
  assert.equal(boxed.brain.goalOf(bot.id), "evade");
  for (let i = 0; i < 3; i += 1) {
    bot.followEnd = "arrived";
    tick();
    assert.equal(boxed.brain.goalOf(bot.id), "evade");
  }
  bot.followEnd = "stuck";
  tick();
  assert.equal(boxed.brain.goalOf(bot.id), "fightback");
  boxed.clock = 350;
  boxed.brain.update();
  assert.equal(boxed.shots.length, 1);
  assert.equal(boxed.shots[0]!.at, 350);
});

test("fightback: a standing bot keeps its heading and plays angry", () => {
  const box = rig({ rng: () => 0 });
  const bot = box.bots[0]!;
  wound(box, bot, box.players[0]!);
  box.brain.update();
  assert.equal(bot.override?.stance, "angry");
  bot.heading = 0.2;
  steerUnownedWander(box.world, bot as never, 2, () => {
    throw new Error("a standing fight does not roll a heading");
  }, yardNav(), createNavCache());
  assert.equal(bot.heading, 0.2);
  assert.equal(bot.gait, "angry");
  assert.equal(bot.path, undefined);
  stepUnownedWander(box.world, bot as never);
  box.world.commit(2n);
  const view = box.world.store.view(bot.id)!;
  assert.equal(view.clip, "angry");
  assert.ok(Math.hypot(view.velocity.x, view.velocity.z) < 1e-6);
});

test("fightback: sight while shooting stays near 5 Hz, and a lost target is dropped", () => {
  let open = true;
  const box = rig({ rng: () => 0, see: () => open });
  const before = box.rays();
  wound(box, box.bots[0]!, box.players[0]!);
  box.brain.update();
  for (let t = 50; t <= 950; t += 50) {
    box.clock = t;
    box.brain.update();
  }
  const rays = box.rays() - before;
  assert.ok(rays >= 4 && rays <= 8, `rays ${rays}`);
  open = false;
  box.clock = 7_000;
  box.brain.update();
  assert.notEqual(box.brain.goalOf(box.bots[0]!.id), "fightback");
});

test("fightback: death drops the fire gate and the grudge", () => {
  const box = rig({ rng: () => 0 });
  const bot = box.bots[0]!;
  wound(box, bot, box.players[0]!);
  box.brain.update();
  box.health.wound(bot.id, box.players[0]!.id, MAX_HP, "laser");
  box.brain.update();
  assert.ok(box.forgotten.includes(bot.id));
  box.sense.fresh(bot.id, { alive: false, at: box.clock });
  box.health.heal(bot.id, MAX_HP);
  box.brain.update();
  box.clock = 400;
  box.brain.update();
  assert.equal(box.shots.length, 0);
  assert.notEqual(box.brain.goalOf(bot.id), "fightback");
});
