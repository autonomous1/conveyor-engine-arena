import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import test from "node:test";
import { AuthoritativeWorld } from "conveyor-engine-world";
import {
  MOVE_DT,
  MOVE_SPEED,
  STEP_HEIGHT,
  floorAlongMove,
  floorHeight,
  enqueueOwnedMove,
  gaitForSpeed,
  yawQuaternion,
} from "../src/shared/movements.ts";

// Server modules import siblings as `.js`. Strip-types loads this file from
// source, so those specifiers resolve to the `.ts` files.
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

const { stepUnownedWander } = await import("../src/server/game.ts");

const PAWN_RADIUS = 0.5;
const PAWN_HEIGHT = 1.8;
const SPEEDS = { idle: 0, walk: 1, run: 2, fall: 0, angry: 0 };

type Box = { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number };

function pawn(x: number, z: number, yaw = 0): { world: AuthoritativeWorld; id: number } {
  const world = new AuthoritativeWorld();
  world.pawnHeight = PAWN_HEIGHT;
  const id = world.createEntity(0n, { type: "pawn", shape: "capsule" });
  const rotation = yawQuaternion(yaw);
  world.enqueue({
    kind: "setTransform",
    entity: id,
    position: { x, y: 0, z },
    rotation,
    scale: { x: 1, y: 1, z: 1 },
  });
  world.enqueue({ kind: "setBounds", entity: id, radius: PAWN_RADIUS });
  world.commit(0n);
  return { world, id };
}

function addBox(world: AuthoritativeWorld, id: number, box: Box): void {
  world.addObstacle({ id, ...box });
}

function bodyHits(box: Box, x: number, y: number, z: number): boolean {
  if (y >= box.maxY || y + PAWN_HEIGHT <= box.minY) return false;
  const minX = box.minX - PAWN_RADIUS;
  const maxX = box.maxX + PAWN_RADIUS;
  const minZ = box.minZ - PAWN_RADIUS;
  const maxZ = box.maxZ + PAWN_RADIUS;
  return x > minX && x < maxX && z > minZ && z < maxZ;
}

test("floor samples mount a short band and leave a taller box alone", () => {
  const step = { minX: 0, maxX: 1, minZ: -0.5, maxZ: 0.5, minY: 0, maxY: 0.25 };
  const curb = { minX: 2, maxX: 3, minZ: -1, maxZ: 1, minY: 0, maxY: STEP_HEIGHT };
  const wall = { minX: 4, maxX: 5, minZ: -1, maxZ: 1, minY: 0, maxY: 0.5 };
  assert.equal(floorHeight([step], 0.5, 0, PAWN_RADIUS, 0), 0.25);
  assert.equal(floorHeight([curb], 2.5, 0, PAWN_RADIUS, 0), STEP_HEIGHT);
  assert.equal(floorHeight([wall], 4.5, 0, PAWN_RADIUS, 0), 0);
  assert.equal(floorHeight([{ minX: 0, maxX: 1, minZ: -1, maxZ: 1 }], 0.5, 0, PAWN_RADIUS, 0), 0);
  assert.equal(floorAlongMove([step], 0.5, 0, 0.6, 0, PAWN_RADIUS, 0.25), 0.25);
  assert.equal(floorAlongMove([step], 0.5, 0, 2, 0, PAWN_RADIUS, 0.25), 0);
  const ramp = [
    { minX: 0, maxX: 1, minZ: -1, maxZ: 1, minY: 0, maxY: 0.2 },
    { minX: 1, maxX: 2, minZ: -1, maxZ: 1, minY: 0.2, maxY: 0.4 },
  ];
  assert.equal(floorAlongMove(ramp, 0.2, 0, 1.2, 0, PAWN_RADIUS, 0), 0.4);
  assert.equal(floorAlongMove([wall], -0.2, 0, 0.2, 0, PAWN_RADIUS, 0), 0);
});

test("a 0.3 m box is climbed and a 0.5 m box stops the pawn", () => {
  const curb = { minX: 2, maxX: 4, minY: 0, maxY: STEP_HEIGHT, minZ: -1, maxZ: 1 };
  const low = pawn(0, 0, Math.PI / 2);
  addBox(low.world, 1, curb);
  let mounted = false;
  let tick = 1;
  for (; tick <= 40; tick++) {
    assert.ok(enqueueOwnedMove(low.world, low.id, 1, 0, Math.PI / 2, MOVE_DT));
    low.world.commit(BigInt(tick));
    const view = low.world.store.view(low.id)!;
    if (view.position.x <= curb.minX || view.position.x >= curb.maxX) continue;
    assert.equal(view.position.y, STEP_HEIGHT);
    assert.equal(bodyHits(curb, view.position.x, view.position.y, view.position.z), false);
    assert.equal(view.clip, "walk");
    assert.equal(view.speed, Math.hypot(view.velocity.x, view.velocity.z));
    mounted = true;
    break;
  }
  assert.ok(mounted, "pawn never stood on the 0.3 m box");

  for (tick += 1; tick <= 80; tick++) {
    assert.ok(enqueueOwnedMove(low.world, low.id, -1, 0, -Math.PI / 2, MOVE_DT));
    low.world.commit(BigInt(tick));
  }
  const down = low.world.store.view(low.id)!;
  assert.equal(down.position.y, 0);
  assert.ok(down.position.x < curb.minX - PAWN_RADIUS);

  const high = pawn(0, 0, Math.PI / 2);
  addBox(high.world, 1, { minX: 2, maxX: 3, minY: 0, maxY: 0.5, minZ: -1, maxZ: 1 });
  for (let tick = 1; tick <= 40; tick++) {
    assert.ok(enqueueOwnedMove(high.world, high.id, 1, 0, Math.PI / 2, MOVE_DT));
    high.world.commit(BigInt(tick));
    const view = high.world.store.view(high.id)!;
    assert.equal(view.position.y, 0);
    assert.ok(view.position.x <= 2 - PAWN_RADIUS + 1e-9);
  }
  const stopped = high.world.store.view(high.id)!;
  assert.equal(stopped.position.x, 2 - PAWN_RADIUS);
  assert.equal(stopped.position.y, 0);
  assert.equal(stopped.position.z, 0);
  assert.equal(stopped.velocity.y, 0);
});

type StepObstacle = { id: string; min: number[]; max: number[] };

function placedSteps(): StepObstacle[] {
  const props = JSON.parse(readFileSync(new URL("../web/game/props.placements.json", import.meta.url), "utf8")) as {
    placements: { id: string; model: string }[];
    obstacles: StepObstacle[];
  };
  const ids = new Set(props.placements.filter((placement) => placement.model === "step").map((placement) => `${placement.id}-box`));
  const steps = props.obstacles.filter((obstacle) => ids.has(obstacle.id));
  assert.ok(steps.length >= 2, "arena-1 step props are missing");
  const ordered = [...steps].sort((a, b) => a.max[1] - b.max[1] || b.max[0] - a.max[0]);
  assert.ok(ordered[0].max[1] > 0 && ordered[0].max[1] <= STEP_HEIGHT);
  for (let i = 1; i < ordered.length; i++) {
    const rise = ordered[i].max[1] - ordered[i - 1].max[1];
    assert.ok(rise > 0 && rise <= STEP_HEIGHT, `${ordered[i].id} rises ${rise}`);
  }
  return ordered;
}

function corridorBoxes(steps: StepObstacle[]): StepObstacle[] {
  const minX = Math.min(...steps.map((step) => step.min[0])) - 2;
  const maxX = Math.max(...steps.map((step) => step.max[0])) + 2;
  const minZ = Math.min(...steps.map((step) => step.min[2])) - 1;
  const maxZ = Math.max(...steps.map((step) => step.max[2])) + 1;
  const buildings = JSON.parse(readFileSync(new URL("../web/game/buildings.placements.json", import.meta.url), "utf8")) as {
    obstacles: StepObstacle[];
  };
  return buildings.obstacles.filter((obstacle) =>
    obstacle.max[0] >= minX && obstacle.min[0] <= maxX && obstacle.max[2] >= minZ && obstacle.min[2] <= maxZ);
}

function stepRun(): { steps: Box[]; blockers: Box[]; startX: number; z: number; face: number; top: number } {
  const placed = placedSteps();
  const steps: Box[] = placed.map((step) => ({
    minX: step.min[0],
    minY: step.min[1],
    minZ: step.min[2],
    maxX: step.max[0],
    maxY: step.max[1],
    maxZ: step.max[2],
  }));
  const topStep = steps.reduce((best, step) => (step.maxY > best.maxY ? step : best));
  const z = (topStep.minZ + topStep.maxZ) / 2;
  const startX = Math.max(...steps.map((step) => step.maxX)) + PAWN_RADIUS + 0.35;
  // A 0.5 m box past the top tread. Its top is above the step limit.
  const blocker: Box = {
    minX: topStep.minX - 1.2,
    maxX: topStep.minX - 0.2,
    minY: topStep.maxY,
    maxY: topStep.maxY + 0.5,
    minZ: topStep.minZ - 0.5,
    maxZ: topStep.maxZ + 0.5,
  };
  const nearby = corridorBoxes(placed).map((box) => ({
    minX: box.min[0],
    minY: box.min[1],
    minZ: box.min[2],
    maxX: box.max[0],
    maxY: box.max[1],
    maxZ: box.max[2],
  }));
  return { steps, blockers: [blocker, ...nearby], startX, z, face: blocker.maxX + PAWN_RADIUS, top: topStep.maxY };
}

function walk(
  kind: "player" | "wander",
  run: ReturnType<typeof stepRun>,
): { ys: number[]; x: number; y: number; z: number; speed: number; clip: string } {
  const yaw = -Math.PI / 2;
  const { world, id } = pawn(run.startX, run.z, yaw);
  run.steps.forEach((box, index) => addBox(world, index + 1, box));
  run.blockers.forEach((box, index) => addBox(world, 100 + index, box));
  const agent = { id, heading: yaw, gait: "run", nextTurn: 1_000, speeds: { ...SPEEDS } };
  const ys: number[] = [];
  for (let tick = 1; tick <= 120; tick++) {
    if (kind === "player") assert.ok(enqueueOwnedMove(world, id, -1, 0, yaw, MOVE_DT));
    else assert.ok(stepUnownedWander(world, agent));
    world.commit(BigInt(tick));
    const view = world.store.view(id)!;
    ys.push(view.position.y);
    const solids = [...run.steps, ...run.blockers];
    assert.equal(solids.some((box) => bodyHits(box, view.position.x, view.position.y, view.position.z)), false, `${kind} inside a box at tick ${tick} y ${view.position.y}`);
    assert.ok(view.position.y === 0 || run.steps.some((step) => step.maxY === view.position.y), `${kind} y ${view.position.y} is not a step top`);
    assert.equal(view.velocity.y, 0);
    assert.equal(view.clip, gaitForSpeed(view.speed));
    // Push-out zeros the blocked axis after setClip. Compare them only while
    // the pawn is still clear of the taller box.
    if (view.position.x > run.face + 0.2) {
      assert.equal(view.speed, Math.hypot(view.velocity.x, view.velocity.z));
    }
  }
  const end = world.store.view(id)!;
  const parked = { x: end.position.x, y: end.position.y, z: end.position.z };
  world.enqueue({ kind: "setClip", entity: id, clip: "run", speed: MOVE_SPEED + 1 });
  world.commit(121n);
  const clipped = world.store.view(id)!;
  assert.equal(clipped.position.x, parked.x);
  assert.equal(clipped.position.y, parked.y);
  assert.equal(clipped.position.z, parked.z);
  assert.equal(clipped.clip, "run");
  return { ys, x: parked.x, y: parked.y, z: parked.z, speed: end.speed, clip: end.clip };
}

test("the placed steps are climbed and a taller box stops player and wander", () => {
  const run = stepRun();
  const player = walk("player", run);
  const wander = walk("wander", run);
  for (const who of [player, wander]) {
    for (const step of run.steps) {
      assert.ok(who.ys.includes(step.maxY), `missed step top ${step.maxY}`);
    }
    assert.equal(who.y, run.top);
    assert.notEqual(who.y, 0);
    assert.ok(Math.abs(who.x - run.face) < 1e-9, `x ${who.x} face ${run.face}`);
    assert.equal(who.z, run.z);
    assert.ok(who.x > run.steps.reduce((best, step) => (step.maxY === run.top ? step : best)).minX);
  }
  assert.deepEqual(player.ys, wander.ys);
  assert.equal(player.x, wander.x);
  assert.equal(player.y, wander.y);
});
