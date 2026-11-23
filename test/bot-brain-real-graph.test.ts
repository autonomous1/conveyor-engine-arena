import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";

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

const { createBotContext, estimateSeconds, groundActions, placeOfPickup } = await import("../src/shared/bots/actions.ts");
const { chooseGoal } = await import("../src/shared/bots/goap.ts");
const { reach, retrieve } = await import("../src/shared/bots/goals.ts");
const { buildWorldState } = await import("../src/shared/bots/state.ts");
const { doorLeafBox } = await import("../src/shared/doors.ts");
const { approachVelocity, MOVE_DT, wishPlanar } = await import("../src/shared/movements.ts");
const { isElevatorShaft, placeAt } = await import("../src/shared/scene-graph.ts");
const { capsuleOverlapsAabb } = await import("../src/shared/pickups.ts");
const { loadArena } = await import("../src/server/world-loader.ts");
const { runMission } = await import("../packages/bot-client/src/brain.ts");
const { parseMission } = await import("../packages/bot-client/src/missions.ts");
const { createCommandHost } = await import("../packages/bot-client/src/commands.ts");

const HALL = "brutalist-building-2-cbake.floor-1.hall";
const SPAWN = { x: 0.5407, y: 0, z: -1.7784 };

const loaded = loadArena();
const graph = loaded.sceneGraph;
assert.ok(graph, "real scene graph missing");
const baked = JSON.parse(readFileSync(new URL("../web/game/scene-graph.json", import.meta.url), "utf8")) as {
  places: unknown[];
  portals: unknown[];
};
assert.equal(baked.places.length, 174);
assert.equal(graph.places.length, baked.places.length);
assert.equal(graph.portals.length, baked.portals.length);
const pickups = loaded.view.pickups ?? [];
assert.ok(pickups.some((item) => item.kind === "key"));

const at = placeAt(graph, SPAWN.x, SPAWN.y, SPAWN.z).id;

function doorFacts(source: NonNullable<typeof graph>): { id: string; open: boolean; locked: boolean }[] {
  const byId = new Map<string, { id: string; open: boolean; locked: boolean }>();
  for (const portal of source.portals) {
    if (portal.kind !== "door") continue;
    const id = portal.door ?? portal.id;
    if (!byId.has(id)) byId.set(id, { id, open: false, locked: portal.locked === true });
  }
  return [...byId.values()];
}

function world() {
  return buildWorldState({
    at,
    pickups: pickups.map((item) => item.id),
    doors: doorFacts(graph!),
  });
}

function plannerOpts(goal: { want: Record<string, string | number | boolean> }, ctx: ReturnType<typeof createBotContext>) {
  return {
    minCost: ctx.minActionS,
    heuristic: estimateSeconds(goal, ctx, pickups),
  };
}

test("reach the floor-1 hall from the outside spawn plans in under 500 ms", () => {
  const goal = reach(HALL);
  const actions = groundActions(graph!, pickups, [goal]);
  const ctx = createBotContext(graph!, pickups);
  const state = world();
  const started = performance.now();
  const result = chooseGoal(state, [goal], actions, ctx, plannerOpts(goal, ctx));
  const ms = performance.now() - started;
  assert.ok(result, `no plan from ${at} in ${ms.toFixed(0)} ms`);
  assert.ok(ms < 500, `plan took ${ms.toFixed(0)} ms, expanded ${result.expanded}, steps ${result.steps.join(" ")}`);
});

test("a retrieve that needs the key plans in under 1 s", () => {
  const probe = createBotContext(graph!, pickups);
  const state = world();
  const item = pickups.find((pickup) => {
    if (pickup.kind === "key") return false;
    const place = placeOfPickup(graph!, pickup);
    const strict = probe.routeCost(at, place, state);
    if (Number.isFinite(strict)) return false;
    return Number.isFinite(probe.routeBound(at, place, state));
  });
  assert.ok(item, "no locked-away pickup in the current game data");
  const place = placeOfPickup(graph!, item);
  const goal = retrieve(item.id, place);
  const actions = groundActions(graph!, pickups, [goal]);
  const ctx = createBotContext(graph!, pickups);
  const started = performance.now();
  const result = chooseGoal(state, [goal], actions, ctx, plannerOpts(goal, ctx));
  const ms = performance.now() - started;
  assert.ok(result, `no plan for ${item.id} at ${place} in ${ms.toFixed(0)} ms`);
  assert.ok(ms < 1_000, `plan took ${ms.toFixed(0)} ms, expanded ${result.expanded}`);
  assert.ok(result.steps.some((step) => step.startsWith("pickup:") && pickups.some((pickup) => pickup.kind === "key" && step === `pickup:${pickup.id}`)), result.steps.join(" "));
  assert.ok(result.steps.some((step) => step.startsWith("unlock:")), result.steps.join(" "));
});

test("an elevator shaft has no plan in under 500 ms", () => {
  const shaft = graph!.places.find((place) => isElevatorShaft(place));
  assert.ok(shaft);
  const goal = reach(shaft.id);
  const actions = groundActions(graph!, pickups, [goal]);
  const ctx = createBotContext(graph!, pickups);
  const started = performance.now();
  const result = chooseGoal(world(), [goal], actions, ctx, plannerOpts(goal, ctx));
  const ms = performance.now() - started;
  assert.equal(result, undefined, `shaft ${shaft.id} planned in ${ms.toFixed(0)} ms`);
  assert.ok(ms < 500, `no-plan took ${ms.toFixed(0)} ms`);
});

test("routeCost compiles once for the same door facts", () => {
  const ctx = createBotContext(graph!, pickups);
  const state = world();
  const hall = ctx.routeCost(at, HALL, state);
  assert.ok(hall > 0 && Number.isFinite(hall), `hall route ${hall}`);
  const again = ctx.routeCost(at, HALL, state);
  assert.equal(again, hall);
  const other = pickups.map((item) => placeOfPickup(graph!, item)).find((place) => place !== at);
  assert.ok(other);
  ctx.routeCost(at, other, state);
  const moved = { ...state, at: other };
  ctx.routeCost(other, HALL, moved);
  assert.equal(ctx.compiles, 1, "same doors compiled more than once");
  const door = doorFacts(graph!)[0];
  assert.ok(door);
  const opened = { ...state, [`doorOpen:${door.id}`]: true, [`doorLocked:${door.id}`]: false };
  ctx.routeCost(at, HALL, opened);
  assert.equal(ctx.compiles, 2);
});

const HALL_1 = "brutalist-building-1-cbake.floor-1.hall";
const HALL_1_DOOR = "brutalist-building-1-cbake.door-1-1-9-22-0";
const HALL_1_INNER_DOOR = "brutalist-building-1-cbake.door-1-1-9-22-4";
const HALL_0 = "brutalist-building-1-cbake-0.floor-1.hall";
const HALL_0_DOOR = "brutalist-building-1-cbake-0.door-1-1-9-22-0";
/** The 132 R1 wedge pose: outside the open `-0` leaf, 0.94 m from it (report finding 3). */
const WEDGE = { x: -21.83, z: 27.12 };
/** The 132 kp4 stand: kp5's end state, inside the base hall with the key held. */
const HALL_POSE = { x: -28.99, y: 0, z: 27.0, yaw: 0 };

type MovingPawn = { x: number; y: number; z: number; vx: number; vz: number; yaw: number };

/**
 * One 20 Hz host step: the wish, the host's acceleration, and the axis rejection
 * a wall gives a pawn. An open leaf is parked out of the world, so only the shut
 * leaves are colliders.
 */
function integrate(pawn: MovingPawn, input: { moveX: number; moveZ: number; yaw: number }, hits: (x: number, z: number) => boolean): void {
  const wish = wishPlanar(input.moveX, input.moveZ);
  const vel = approachVelocity({ x: pawn.vx, z: pawn.vz }, wish);
  let nx = pawn.x + vel.x * MOVE_DT;
  let nz = pawn.z + vel.z * MOVE_DT;
  if (hits(nx, nz)) {
    if (!hits(nx, pawn.z)) nz = pawn.z;
    else if (!hits(pawn.x, nz)) nx = pawn.x;
    else {
      nx = pawn.x;
      nz = pawn.z;
      vel.x = 0;
      vel.z = 0;
    }
  }
  pawn.x = nx;
  pawn.z = nz;
  pawn.vx = vel.x;
  pawn.vz = vel.z;
  pawn.yaw = input.yaw;
}

const SNAPPED = { x: -23.31, y: 2.0, z: 16.42 };
const RAW_STAND = "stand:-23.90,0,16.50";

/** The 152 probe session: a pawn at a stand point over the real arena AABBs. */
function standProbe(pawn: MovingPawn) {
  const radius = loaded.view.pawnRadius;
  const height = loaded.view.pawnHeight;
  const obstacles = loaded.view.aabbs;
  const hits = (x: number, z: number): boolean =>
    obstacles.some((box) => {
      const lo = box.minY ?? -Infinity;
      const hi = box.maxY ?? Infinity;
      if (hi <= 0 || lo >= height) return false;
      const dx = x - Math.min(box.maxX, Math.max(box.minX, x));
      const dz = z - Math.min(box.maxZ, Math.max(box.minZ, z));
      return dx * dx + dz * dz <= (radius + 1e-3) ** 2;
    });
  const doors = loaded.view.doors;
  return {
    pawn,
    session: {
      spectate: false,
      close() {},
      input: {
        sendInput: (input: { moveX: number; moveZ: number; yaw: number }) => integrate(pawn, input, hits),
        use: () => false,
        fire: () => false,
        grenade: () => false,
        resetSeq() {},
        callElevator() {},
      },
      claims: { acquire() {}, release() {} },
      messages: { say: () => true },
      world: {
        aabbs: obstacles,
        pawnRadius: radius,
        pawnHeight: height,
        self: () => pawn,
        others: () => [],
        cabs: () => [],
        door: (id: string) => doors.find((door) => door.id === id),
        doors: () => doors,
        doorBody: (id: string) => doors.find((door) => door.id === id),
        pickups: () => pickups.map((item) => item.id),
        pickupPlacements: () => pickups,
        keys: () => [],
        weapon: () => "alien-weapon-enh",
        ammo: () => 0,
        scope: () => ["scene-graph"],
        sceneGraph: () => graph,
        sceneGraphHash: () => "real",
        regions: () => loaded.regions,
        placeOf: (pos: { x: number; y: number; z: number }) => {
          const place = placeAt(graph!, pos.x, pos.y, pos.z);
          return { id: place.id, kind: place.kind };
        },
      },
    },
  };
}

test("the stand fact and the walk agree on the plan's snapped point", async () => {
  // The 152 probe: the raw stand is 0.60 m from the plan's snapped cell on the
  // crate top. The action finishes at the snap; the fact must latch there too.
  const { pawn, session } = standProbe({ ...SNAPPED, vx: 0, vz: 0, yaw: 0 });
  const logs: string[] = [];
  const started = Date.now();
  const code = await runMission(session as never, parseMission(RAW_STAND)!, {
    timeoutMs: 5_000,
    planMs: 2_000,
    predictOwned: false,
    log: (line) => logs.push(line),
  });
  const wall = Date.now() - started;
  assert.equal(code, 0, `code ${code} after ${wall} ms\n${logs.join("\n")}`);
  const finishes = logs.filter((line) => line.startsWith("finish standAt")).length;
  assert.equal(finishes, 1, `finish count ${finishes}\n${logs.join("\n")}`);
  assert.equal(
    logs.filter((line) => line.startsWith("replan standAt") && line.includes("finished")).length,
    0,
    logs.join("\n"),
  );
  assert.ok(Math.hypot(pawn.x - SNAPPED.x, pawn.z - SNAPPED.z) <= 0.35, `pawn at ${pawn.x.toFixed(2)},${pawn.z.toFixed(2)}`);
});

test("a stand above the plan's floor fails instead of finishing", async () => {
  // The live 151 pose: the pawn is at the snapped goal's XZ but 4 m above the
  // plan's floor (y=6 vs y=2). The action must fail, not finish at the wrong y,
  // and the brain's fail streak must return the mission well before the timeout.
  const { session } = standProbe({ x: SNAPPED.x, y: 6.0, z: SNAPPED.z, vx: 0, vz: 0, yaw: 0 });
  const logs: string[] = [];
  const started = Date.now();
  const code = await runMission(session as never, parseMission(RAW_STAND)!, {
    timeoutMs: 5_000,
    planMs: 2_000,
    predictOwned: false,
    log: (line) => logs.push(line),
  });
  const wall = Date.now() - started;
  assert.equal(code, 2, `code ${code} after ${wall} ms\n${logs.join("\n")}`);
  assert.ok(wall < 2_500, `returned after ${wall} ms, not at the fail streak\n${logs.join("\n")}`);
  const finishes = logs.filter((line) => line.startsWith("finish standAt")).length;
  assert.ok(finishes <= 2, `finish count ${finishes}\n${logs.join("\n")}`);
  assert.equal(
    logs.filter((line) => line.startsWith("replan standAt") && line.includes("finished")).length,
    0,
    logs.join("\n"),
  );
});

const ARM_SPAWN = { x: -6.85, y: 0, z: 2.31 };

/** The 155 session: the arm-up spawn, the weapon on the map, a pawn that never moves. */
function armSession() {
  const pawn: MovingPawn = { ...ARM_SPAWN, vx: 0, vz: 0, yaw: 0 };
  const doors = loaded.view.doors;
  return {
    spectate: false,
    close() {},
    input: {
      sendInput() {},
      use: () => false,
      fire: () => false,
      grenade: () => false,
      resetSeq() {},
      callElevator() {},
    },
    claims: { acquire() {}, release() {} },
    messages: { say: () => true },
    world: {
      aabbs: loaded.view.aabbs,
      pawnRadius: loaded.view.pawnRadius,
      pawnHeight: loaded.view.pawnHeight,
      self: () => pawn,
      others: () => [],
      cabs: () => [],
      door: (id: string) => doors.find((door) => door.id === id),
      doors: () => doors,
      doorBody: (id: string) => doors.find((door) => door.id === id),
      pickups: () => pickups.map((item) => item.id),
      pickupPlacements: () => pickups,
      keys: () => [],
      weapon: () => undefined,
      ammo: () => 0,
      playerIds: () => [1],
      scope: () => ["scene-graph"],
      sceneGraph: () => graph,
      sceneGraphHash: () => "real",
      regions: () => loaded.regions,
      placeOf: (pos: { x: number; y: number; z: number }) => {
        const place = placeAt(graph!, pos.x, pos.y, pos.z);
        return { id: place.id, kind: place.kind };
      },
    },
  };
}

async function waitUntil(predicate: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

test("the arm command plans its point walks instead of a raw wishTo", async () => {
  // The 132 `stand` command stays wishTo; the arm's east/climb/step-off must run
  // the 151 POC's plan-based `stand:` mission (the 152 goal fix makes it latch).
  // This pins the wiring, not the walk: 154's live run is the end-to-end proof.
  const logs: string[] = [];
  const host = createCommandHost({ session: armSession() as never, log: (line) => logs.push(line) });
  const done = host.dispatch({ id: "t1", name: "arm" });
  const planned = await waitUntil(
    () => logs.some((line) => line.includes("plan done")) && logs.some((line) => line.includes("start standAt")),
    5_000,
  );
  host.abort();
  await done;
  assert.ok(planned, `the arm never planned a stand\n${logs.join("\n")}`);
  assert.ok(
    logs.some((line) => /arm east plan done/.test(line)),
    `no east plan line\n${logs.join("\n")}`,
  );
  assert.ok(
    logs.some((line) => /arm east start standAt:point:-13\.900,0\.000,16\.500/.test(line)),
    `no east standAt start\n${logs.join("\n")}`,
  );
  assert.ok(
    !logs.some((line) => /arm (east|climb|step-off): (STUCK|timeout)/.test(line)),
    `raw wishTo lines in the arm log\n${logs.join("\n")}`,
  );
});

test("a crate-top pickup stays on the crate instead of stepping off", async () => {
  // The 154 pose: the pawn on the weapon crate's top. The pickup must walk the
  // top to the weapon, not plan a ground route around the crate (the 154 fall
  // was x -23.20 / z 17.15 -> x -24.15 / z 17.45 at y 0).
  const PICKUP_POSE = { x: -23.2, y: 2.0, z: 17.15 };
  const weapon = pickups.find((item) => item.id === "alien-weapon-1");
  assert.ok(weapon, "alien-weapon-1 is not on the map");
  const radius = loaded.view.pawnRadius;
  const height = loaded.view.pawnHeight;
  const doors = loaded.view.doors;
  // The pickup volume is a trigger, not a wall: the brain's nav view omits it
  // (`pickupBoxSource`), so a pawn can stand in it to take the item.
  const obstacles = loaded.view.aabbs.filter((box) => box.source !== `${weapon.id}-box`);
  const pawn: MovingPawn = { ...PICKUP_POSE, vx: 0, vz: 0, yaw: 0 };
  // The mini-host: a 0.25 m riser is climbed, a taller face is a wall, and the
  // feet follow the floor (the 154 pawn stood on the top when the pickup began).
  const STEP = 0.3;
  const floorUnder = (x: number, z: number, feet: number): number => {
    let top = 0;
    for (const box of obstacles) {
      const hi = box.maxY ?? Infinity;
      if (!Number.isFinite(hi) || hi > feet + STEP + 1e-3) continue;
      const dx = x - Math.min(box.maxX, Math.max(box.minX, x));
      const dz = z - Math.min(box.maxZ, Math.max(box.minZ, z));
      if (dx * dx + dz * dz <= (radius + 1e-3) ** 2 && hi > top) top = hi;
    }
    return top;
  };
  const hits = (x: number, z: number): boolean =>
    obstacles.some((box) => {
      const lo = box.minY ?? -Infinity;
      const hi = box.maxY ?? Infinity;
      if (hi <= pawn.y + 1e-3) return false; // the floor under the feet
      if (hi <= pawn.y + STEP + 1e-3) return false; // a climbable riser, not a wall
      if (lo >= pawn.y + height) return false; // above the head
      const dx = x - Math.min(box.maxX, Math.max(box.minX, x));
      const dz = z - Math.min(box.maxZ, Math.max(box.minZ, z));
      return dx * dx + dz * dz <= (radius + 1e-3) ** 2;
    });
  let taken = false;
  const samples: Array<[number, number, number]> = [];
  const session = {
    spectate: false,
    close() {},
    input: {
      sendInput: (input: { moveX: number; moveZ: number; yaw: number }) => {
        integrate(pawn, input, hits);
        pawn.y = floorUnder(pawn.x, pawn.z, pawn.y);
        samples.push([pawn.x, pawn.y, pawn.z]);
        if (!taken && capsuleOverlapsAabb(pawn.x, pawn.y, pawn.z, radius, height, weapon)) taken = true;
      },
      use: () => false,
      fire: () => false,
      grenade: () => false,
      resetSeq() {},
      callElevator() {},
    },
    claims: { acquire() {}, release() {} },
    messages: { say: () => true },
    world: {
      aabbs: obstacles,
      pawnRadius: radius,
      pawnHeight: height,
      self: () => pawn,
      others: () => [],
      cabs: () => [],
      door: (id: string) => doors.find((door) => door.id === id),
      doors: () => doors,
      doorBody: (id: string) => doors.find((door) => door.id === id),
      pickups: () => (taken ? pickups.filter((item) => item.id !== weapon.id).map((item) => item.id) : pickups.map((item) => item.id)),
      pickupPlacements: () => pickups,
      keys: () => [],
      weapon: () => undefined,
      ammo: () => 0,
      scope: () => ["scene-graph"],
      sceneGraph: () => graph,
      sceneGraphHash: () => "real",
      regions: () => loaded.regions,
      placeOf: (pos: { x: number; y: number; z: number }) => {
        const place = placeAt(graph!, pos.x, pos.y, pos.z);
        return { id: place.id, kind: place.kind };
      },
    },
  };
  const logs: string[] = [];
  const code = await runMission(session as never, parseMission("retrieve:alien-weapon-1@outside")!, {
    timeoutMs: 20_000,
    planMs: 2_000,
    predictOwned: false,
    log: (line) => logs.push(line),
  });
  const off = samples.filter(([x, y, z]) => y < 1.5 || x > -22.5 || x < -25.8 || z > 17.6 || z < 14.6);
  assert.equal(off.length, 0, `the walk left the crate top\n${logs.join("\n")}\noff: ${off.slice(0, 6).map((s) => s.map((n) => n.toFixed(2)).join(",")).join(" ")}`);
  assert.ok(taken, `the weapon was never taken; last=${samples.at(-1)?.map((n) => n.toFixed(2)).join(",")}\n${logs.join("\n")}`);
  assert.equal(code, 0, `code ${code}\n${logs.join("\n")}`);
});

test("an open hall door does not wedge the goTo executor at the leaf", async () => {
  const doors = loaded.view.doors.map((door) => (door.id === HALL_1_DOOR ? { ...door, open: true, locked: false } : door));
  const bodies = new Map(doors.map((door) => [door.id, door]));
  const radius = loaded.view.pawnRadius;
  const height = loaded.view.pawnHeight;
  const obstacles = [...loaded.view.aabbs, ...doors.filter((door) => !door.open).map((door) => doorLeafBox(door))];
  const hits = (x: number, z: number): boolean =>
    obstacles.some((box) => {
      const lo = box.minY ?? -Infinity;
      const hi = box.maxY ?? Infinity;
      if (hi <= 0 || lo >= height) return false;
      const dx = x - Math.min(box.maxX, Math.max(box.minX, x));
      const dz = z - Math.min(box.maxZ, Math.max(box.minZ, z));
      return dx * dx + dz * dz <= (radius + 1e-3) ** 2;
    });
  const pawn: MovingPawn = { ...WEDGE, y: 0, vx: 0, vz: 0, yaw: 0 };
  const session = {
    spectate: false,
    close() {},
    input: {
      sendInput: (input: { moveX: number; moveZ: number; yaw: number }) => integrate(pawn, input, hits),
      use: () => false,
      fire: () => false,
      grenade: () => false,
      resetSeq() {},
      callElevator() {},
    },
    world: {
      aabbs: loaded.view.aabbs,
      pawnRadius: radius,
      pawnHeight: height,
      self: () => pawn,
      others: () => [],
      cabs: () => [],
      door: (id: string) => doors.find((door) => door.id === id),
      doors: () => doors,
      doorBody: (id: string) => bodies.get(id),
      pickups: () => pickups.map((item) => item.id),
      pickupPlacements: () => pickups,
      keys: () => ["key"],
      weapon: () => undefined,
      ammo: () => 0,
      scope: () => ["scene-graph"],
      sceneGraph: () => graph,
      sceneGraphHash: () => "real",
      regions: () => loaded.regions,
      placeOf: (pos: { x: number; y: number; z: number }) => {
        const place = placeAt(graph!, pos.x, pos.y, pos.z);
        return { id: place.id, kind: place.kind };
      },
    },
  };
  const logs: string[] = [];
  const started = Date.now();
  const code = await runMission(session as never, { kind: "goal", goal: reach(HALL_1) }, {
    timeoutMs: 20_000,
    // The first plan compiles the route net (132's correction); the live goto planned in 192 ms warm.
    planMs: 2_000,
    predictOwned: false,
    log: (line) => logs.push(line),
  });
  const wall = Date.now() - started;
  const wedged = logs.filter((line) => line.startsWith("replan stuck")).length;
  assert.equal(wedged, 0, `the goTo executor wedged at the open leaf\n${logs.join("\n")}`);
  assert.equal(code, 0, `code ${code} after ${wall} ms\n${logs.join("\n")}`);
  assert.ok(wall < 20_000, `took ${wall} ms, goal not reached`);
  assert.equal(placeAt(graph!, pawn.x, pawn.y, pawn.z).id, HALL_1);
});

test("a path mission routes around a low box instead of the straight line", async () => {
  // Task 149 probe fixture: a 0.9 m box below the 1.6 m eye line (so the 3D
  // sight line is clear) straddles the straight segment. The plan-based stand
  // mission behind `path:` must detour around the box's footprint.
  const box = { id: "probe-low-wall", minX: -8.2, maxX: -5.4, minY: 0, maxY: 0.9, minZ: 4.4, maxZ: 5.6 };
  const START = { x: -6.85, y: 0, z: 2.31 };
  const TARGET = { x: -6.85, y: 0, z: 8.0 };
  const doors = loaded.view.doors;
  const radius = loaded.view.pawnRadius;
  const height = loaded.view.pawnHeight;
  const obstacles = [...loaded.view.aabbs, box];
  const hits = (x: number, z: number): boolean =>
    obstacles.some((item) => {
      const lo = item.minY ?? -Infinity;
      const hi = item.maxY ?? Infinity;
      if (hi <= 0 || lo >= height) return false;
      const dx = x - Math.min(item.maxX, Math.max(item.minX, x));
      const dz = z - Math.min(item.maxZ, Math.max(item.minZ, z));
      return dx * dx + dz * dz <= (radius + 1e-3) ** 2;
    });
  const pawn: MovingPawn = { ...START, vx: 0, vz: 0, yaw: 0 };
  const samples: Array<[number, number]> = [];
  const session = {
    spectate: false,
    close() {},
    input: {
      sendInput: (input: { moveX: number; moveZ: number; yaw: number }) => {
        integrate(pawn, input, hits);
        samples.push([pawn.x, pawn.z]);
      },
      use: () => false,
      fire: () => false,
      grenade: () => false,
      resetSeq() {},
      callElevator() {},
    },
    claims: { acquire() {}, release() {} },
    messages: { say: () => true },
    world: {
      aabbs: obstacles,
      pawnRadius: radius,
      pawnHeight: height,
      self: () => pawn,
      others: () => [],
      cabs: () => [],
      door: (id: string) => doors.find((door) => door.id === id),
      doors: () => doors,
      doorBody: (id: string) => doors.find((door) => door.id === id),
      pickups: () => pickups.map((item) => item.id),
      pickupPlacements: () => pickups,
      keys: () => [],
      weapon: () => undefined,
      ammo: () => 0,
      scope: () => ["scene-graph"],
      sceneGraph: () => graph,
      sceneGraphHash: () => "real",
      regions: () => loaded.regions,
      placeOf: (pos: { x: number; y: number; z: number }) => {
        const place = placeAt(graph!, pos.x, pos.y, pos.z);
        return { id: place.id, kind: place.kind };
      },
    },
  };
  const mission = parseMission("path:-6.85,0,8");
  assert.ok(mission, "path: is not a mission");
  assert.equal(mission.kind, "stand");
  const logs: string[] = [];
  const code = await runMission(session as never, mission, {
    timeoutMs: 20_000,
    planMs: 2_000,
    predictOwned: false,
    log: (line) => logs.push(line),
  });
  assert.equal(code, 0, `code ${code}\n${logs.join("\n")}`);
  const d = Math.hypot(pawn.x - TARGET.x, pawn.z - TARGET.z);
  assert.ok(d <= 0.4, `ended ${d.toFixed(2)} m from the target\n${logs.join("\n")}`);
  assert.equal(logs.filter((line) => line.startsWith("replan stuck")).length, 0, logs.join("\n"));
  // The straight segment is blocked by the box ...
  assert.equal(hits(TARGET.x, (box.minZ + box.maxZ) / 2), true, "the straight segment is not blocked");
  // ... and the walk is outside the box's footprint where it crosses its z-band.
  const atBand = samples.filter(([, z]) => z > box.minZ && z < box.maxZ);
  assert.ok(atBand.length > 0, `the walk never crossed the box's z-band\n${samples.join(" ")}`);
  const minX = Math.min(...atBand.map(([x]) => x));
  assert.ok(minX < box.minX, `the route crosses the box: xMin ${minX.toFixed(2)} vs box ${box.minX}`);
});

type HallDoor = (typeof loaded.view.doors)[number];

/** The 134 fixture: the run's end state — base hall, key held, only the `-0` leaf open. */
function baseHallDoors(): HallDoor[] {
  return loaded.view.doors.map((door) => (door.id === HALL_1_DOOR ? { ...door, open: true, locked: false } : door));
}

/** A session that never moves: the executor plans, walks in place, and the follower reports stuck. */
function baseHallSession(doors: readonly HallDoor[]) {
  const bodies = new Map(doors.map((door) => [door.id, door]));
  return {
    spectate: false,
    close() {},
    input: {
      sendInput() {},
      use: () => false,
      fire: () => false,
      grenade: () => false,
      resetSeq() {},
      callElevator() {},
    },
    world: {
      aabbs: loaded.view.aabbs,
      pawnRadius: loaded.view.pawnRadius,
      pawnHeight: loaded.view.pawnHeight,
      self: () => HALL_POSE,
      others: () => [],
      cabs: () => [],
      door: (id: string) => doors.find((door) => door.id === id),
      doors: () => doors,
      doorBody: (id: string) => bodies.get(id),
      pickups: () => pickups.map((item) => item.id),
      pickupPlacements: () => pickups,
      keys: () => ["key"],
      weapon: () => undefined,
      ammo: () => 0,
      scope: () => ["scene-graph"],
      sceneGraph: () => graph,
      sceneGraphHash: () => "real",
      regions: () => loaded.regions,
      placeOf: (pos: { x: number; y: number; z: number }) => {
        const place = placeAt(graph!, pos.x, pos.y, pos.z);
        return { id: place.id, kind: place.kind };
      },
    },
  };
}

test("the base-hall patrol reach plans inside the brain's default budget", async () => {
  const doors = baseHallDoors();
  const session = baseHallSession(doors);
  const goal = reach(HALL_0);
  const logs: string[] = [];
  // The fake session cannot walk, so only the mission's first plan is under test.
  await runMission(session as never, { kind: "goal", goal }, {
    timeoutMs: 4_000,
    predictOwned: false,
    log: (line) => logs.push(line),
  });
  const planned = logs.findIndex((line) => line.startsWith("plan done") && line.includes("steps=5"));
  assert.ok(planned >= 0, `no 5-step plan at the default planMs\n${logs.join("\n")}`);
  assert.ok(!logs.slice(0, planned).some((line) => line.startsWith("no plan")), logs.join("\n"));
  // The logged five steps are the two-door route; plan the same state directly.
  const state = buildWorldState({ at: HALL_1, pickups: pickups.map((item) => item.id), heldKeys: ["key"], doors });
  const ctx = createBotContext(graph!, pickups, { position: () => HALL_POSE });
  const actions = groundActions(graph!, pickups, [goal]);
  const heuristic = estimateSeconds(goal, ctx, pickups);
  assert.ok(Number.isFinite(heuristic(state)), `the start heuristic is not finite: ${heuristic(state)}`);
  const plan = chooseGoal(state, [goal], actions, ctx, {
    minCost: ctx.minActionS,
    heuristic,
    deadlineMs: Date.now() + 2_000,
    now: () => Date.now(),
  });
  assert.ok(plan, "the same state does not plan at 2 s");
  assert.deepEqual(plan.steps, [
    `goToDoor:${HALL_1_INNER_DOOR}:${HALL_1}`,
    `unlock:${HALL_1_INNER_DOOR}`,
    `goToDoor:${HALL_0_DOOR}:outside`,
    `unlock:${HALL_0_DOOR}`,
    `goTo:${HALL_0}`,
  ]);
});

test("the first stuck replan after the first plan gets the cold budget", async () => {
  const doors = baseHallDoors();
  const session = baseHallSession(doors);
  const logs: string[] = [];
  // The static session cannot walk: the goToDoor follower reports stuck after
  // ~2 s, which is the first state-changing replan. 9 s leaves that plan its
  // full cold cap even after a slow first plan. Only the *second* plan is
  // asserted; a later one can be cut by the mission deadline itself.
  await runMission(session as never, { kind: "goal", goal: reach(HALL_0) }, {
    timeoutMs: 9_000,
    predictOwned: false,
    log: (line) => logs.push(line),
  });
  const plans = logs.filter((line) => line.startsWith("plan done"));
  assert.ok(plans.length >= 2, `the mission never replanned\n${logs.join("\n")}`);
  assert.ok(plans.some((line) => line.includes("steps=5")), logs.join("\n"));
  const second = plans[1]!;
  assert.ok(!second.includes("steps=0"), `the first replan was cut at the budget\n${logs.join("\n")}`);
  assert.ok(second.includes("steps=5"), `the first replan is not the 5-step plan: ${second}\n${logs.join("\n")}`);
});

test("a huge expand budget still returns before the mission timeout", async () => {
  const goal = reach("no-such-place");
  const pawn = { id: 1, x: SPAWN.x, y: SPAWN.y, z: SPAWN.z, yaw: 0 };
  const doors = doorFacts(graph!);
  const session = {
    spectate: false,
    close() {},
    input: {
      sendInput() {},
      use: () => false,
      fire: () => false,
      grenade: () => false,
      resetSeq() {},
    },
    world: {
      aabbs: [],
      pawnRadius: 0.4,
      pawnHeight: 1.8,
      self: () => pawn,
      others: () => [],
      door: (id: string) => doors.find((door) => door.id === id),
      doors: () => doors,
      doorBody: () => undefined,
      pickups: () => pickups.map((item) => item.id),
      pickupPlacements: () => pickups,
      keys: () => [],
      weapon: () => undefined,
      ammo: () => 0,
      scope: () => ["scene-graph"],
      sceneGraph: () => graph,
      sceneGraphHash: () => "real",
      placeOf: (pos: { x: number; y: number; z: number }) => {
        const place = placeAt(graph!, pos.x, pos.y, pos.z);
        return { id: place.id, kind: place.kind };
      },
    },
  };
  const logs: string[] = [];
  const started = Date.now();
  const code = await runMission(session as never, { kind: "goal", goal }, {
    timeoutMs: 2_000,
    maxExpand: 1_000_000_000,
    predictOwned: false,
    log: (line) => logs.push(line),
  });
  const wall = Date.now() - started;
  assert.ok(code === 2 || code === 3, `code ${code}\n${logs.join("\n")}`);
  assert.ok(wall < 3_000, `hung for ${wall} ms\n${logs.join("\n")}`);
  assert.ok(logs.includes("plan start"), logs.join("\n"));
  assert.ok(logs.some((line) => line.startsWith("plan done ")), logs.join("\n"));
});
