import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { AuthoritativeWorld } from "conveyor-engine-world";
import { moveIntent, yawFromQuat } from "../src/shared/look.ts";
import {
  MOVE_ACCEL,
  MOVE_DT,
  MOVE_SPEED,
  MOVE_TICKS,
  PAWN_YAW_STEP,
  approachVelocity,
  approachYaw,
  enqueueOwnedMove,
  gaitForSpeed,
  wishPlanar,
  yawQuaternion,
} from "../src/shared/movements.ts";

// Server modules import their siblings as `.js`. Strip-types loads this test
// from source, so those specifiers have to resolve to the `.ts` files.
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

const SPEEDS = { idle: 0, walk: 1, run: 2, fall: 0, angry: 0 };

function pawn(): { world: AuthoritativeWorld; id: number; agent: { id: number; heading: number; gait: string; nextTurn: number; speeds: Record<string, number> } } {
  const world = new AuthoritativeWorld();
  const id = world.createEntity(0n, { type: "pawn", shape: "capsule" });
  world.enqueue({
    kind: "setTransform",
    entity: id,
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    scale: { x: 1, y: 1, z: 1 },
  });
  world.enqueue({ kind: "setBounds", entity: id, radius: 0.5 });
  world.commit(0n);
  return { world, id, agent: { id, heading: 0, gait: "run", nextTurn: 1_000, speeds: { ...SPEEDS } } };
}

function stepWander(world: AuthoritativeWorld, agent: { id: number; heading: number; gait: string; nextTurn: number; speeds: Record<string, number> }, tick: number): void {
  assert.ok(stepUnownedWander(world, agent));
  world.commit(BigInt(tick));
}

function stepPlayer(world: AuthoritativeWorld, id: number, moveX: number, moveZ: number, yaw: number, tick: number): void {
  assert.ok(enqueueOwnedMove(world, id, moveX, moveZ, yaw, MOVE_DT));
  world.commit(BigInt(tick));
}

test("a 90° wander change takes several ticks and does not take the new wish", () => {
  const { world, id, agent } = pawn();
  for (let tick = 1; tick <= MOVE_TICKS; tick++) stepWander(world, agent, tick);
  const before = world.store.view(id)!;
  assert.equal(before.velocity.x, 0);
  assert.equal(before.velocity.z, MOVE_SPEED);
  assert.equal(before.clip, "run");
  assert.equal(before.speed, MOVE_SPEED);

  const yaw = Math.PI / 2;
  agent.heading = yaw;
  const turned = moveIntent(yaw, 1, 0);
  const wish = wishPlanar(turned.moveX, turned.moveZ);
  const capped = approachYaw(yawFromQuat(before.rotation), yaw);
  const cappedIntent = moveIntent(capped, 1, 0);
  const cappedWish = wishPlanar(cappedIntent.moveX, cappedIntent.moveZ);
  const steps = Math.ceil(yaw / PAWN_YAW_STEP);
  assert.ok(steps >= 3);
  assert.ok(Math.abs(capped - yaw) > PAWN_YAW_STEP * 0.5);
  const at = { ...before.position };
  stepWander(world, agent, MOVE_TICKS + 1);
  const after = world.store.view(id)!;
  const gap = Math.hypot(after.velocity.x - wish.x, after.velocity.z - wish.z);
  assert.ok(gap > MOVE_ACCEL, `velocity snapped to the new wish, gap ${gap}`);
  assert.ok(Math.hypot(after.velocity.x - cappedWish.x, after.velocity.z - cappedWish.z) > 0);
  assert.ok(after.velocity.z > after.velocity.x);
  assert.deepEqual(
    { x: after.velocity.x, z: after.velocity.z },
    approachVelocity({ x: before.velocity.x, z: before.velocity.z }, cappedWish),
  );
  assert.equal(after.position.x, at.x + after.velocity.x * MOVE_DT);
  assert.equal(after.position.z, at.z + after.velocity.z * MOVE_DT);
  assert.equal(after.position.y, 0);
  assert.equal(after.velocity.y, 0);
  assert.equal(after.speed, Math.hypot(after.velocity.x, after.velocity.z));
  assert.equal(after.clip, gaitForSpeed(after.speed));
  assert.notEqual(after.speed, agent.speeds.run);
  assert.ok(Math.abs(yawFromQuat(after.rotation) - capped) < 1e-9);
  assert.ok(Math.abs(yawFromQuat(after.rotation) - yaw) > 1e-3);

  const player = pawn();
  for (let tick = 1; tick <= MOVE_TICKS; tick++) stepPlayer(player.world, player.id, 0, 1, 0, tick);
  const playerBefore = player.world.store.view(player.id)!;
  stepPlayer(player.world, player.id, turned.moveX, turned.moveZ, yaw, MOVE_TICKS + 1);
  const owned = player.world.store.view(player.id)!;
  assert.deepEqual(
    { x: owned.velocity.x, z: owned.velocity.z },
    approachVelocity({ x: playerBefore.velocity.x, z: playerBefore.velocity.z }, wish),
  );
  assert.ok(Math.abs(yawFromQuat(owned.rotation) - yaw) < 1e-9);
  assert.notEqual(owned.velocity.x, after.velocity.x);

  const parked = { ...after.position };
  const velocity = { ...after.velocity };
  world.enqueue({ kind: "setClip", entity: id, clip: "run", speed: agent.speeds.run ?? 2 });
  world.commit(BigInt(MOVE_TICKS + 2));
  const clipped = world.store.view(id)!;
  assert.deepEqual(clipped.position, parked);
  assert.deepEqual(clipped.velocity, velocity);
  assert.equal(clipped.position.y, 0);

  for (let n = 2; n < steps; n += 1) {
    stepWander(world, agent, MOVE_TICKS + 1 + n);
    const mid = yawFromQuat(world.store.view(id)!.rotation);
    assert.ok(Math.abs(mid - yaw) > 1e-6, `yaw finished on tick ${n}`);
  }
  stepWander(world, agent, MOVE_TICKS + 1 + steps);
  const done = world.store.view(id)!;
  assert.ok(Math.abs(yawFromQuat(done.rotation) - yaw) < 1e-9);
  assert.equal(done.clip, gaitForSpeed(done.speed));
  assert.equal(done.speed, Math.hypot(done.velocity.x, done.velocity.z));
});

test("a pawn yaw step takes the short arc and lands inside one step", () => {
  assert.equal(PAWN_YAW_STEP, (Math.PI * 2) / 10);
  assert.equal(approachYaw(0, Math.PI / 2), PAWN_YAW_STEP);
  assert.equal(approachYaw(0, -Math.PI / 2), -PAWN_YAW_STEP);
  assert.equal(approachYaw(0.2, 0.2 + PAWN_YAW_STEP / 2), 0.2 + PAWN_YAW_STEP / 2);
  const from = Math.PI - 0.05;
  const to = -Math.PI + PAWN_YAW_STEP + 0.2;
  const turned = approachYaw(from, to);
  const wrapped = yawFromQuat(yawQuaternion(turned));
  const expected = yawFromQuat(yawQuaternion(from + PAWN_YAW_STEP));
  const longWay = yawFromQuat(yawQuaternion(from - PAWN_YAW_STEP));
  assert.ok(Math.abs(wrapped - expected) < 1e-9);
  assert.ok(Math.abs(wrapped - longWay) > 0.1);
});

test("ten ticks of full input label the owned clip run", () => {
  const { world, id } = pawn();
  for (let tick = 1; tick <= 10; tick++) stepPlayer(world, id, 0, 1, 0, tick);
  const view = world.store.view(id)!;
  assert.equal(view.speed, MOVE_SPEED);
  assert.equal(view.clip, "run");
  assert.equal(gaitForSpeed(MOVE_SPEED), "run");
  assert.equal(gaitForSpeed(0.04), "idle");
  assert.equal(gaitForSpeed(1), "walk");
  assert.equal(gaitForSpeed(2.6), "walk");
  assert.equal(gaitForSpeed(2.7), "run");
});

test("releasing a wander wish stops in the same tick count as the player", () => {
  assert.equal(MOVE_TICKS, 4);
  assert.ok(MOVE_TICKS >= 2);
  const bot = pawn();
  const player = pawn();
  for (let tick = 1; tick <= MOVE_TICKS; tick++) {
    stepWander(bot.world, bot.agent, tick);
    stepPlayer(player.world, player.id, 0, 1, 0, tick);
    const wandered = bot.world.store.view(bot.id)!;
    const owned = player.world.store.view(player.id)!;
    assert.equal(wandered.velocity.x, owned.velocity.x);
    assert.equal(wandered.velocity.z, owned.velocity.z);
    assert.equal(wandered.velocity.y, 0);
    assert.equal(wandered.position.y, 0);
    assert.equal(wandered.speed, owned.speed);
    assert.equal(wandered.clip, owned.clip);
  }
  assert.equal(bot.world.store.view(bot.id)!.velocity.z, MOVE_SPEED);

  bot.agent.gait = "idle";
  for (let tick = 1; tick <= MOVE_TICKS; tick++) {
    stepWander(bot.world, bot.agent, MOVE_TICKS + tick);
    stepPlayer(player.world, player.id, 0, 0, 0, MOVE_TICKS + tick);
    const wandered = bot.world.store.view(bot.id)!;
    const owned = player.world.store.view(player.id)!;
    const expected = Math.max(0, MOVE_SPEED - tick * MOVE_ACCEL);
    assert.equal(wandered.velocity.x, 0);
    assert.equal(wandered.velocity.z, expected);
    assert.equal(wandered.velocity.x, owned.velocity.x);
    assert.equal(wandered.velocity.z, owned.velocity.z);
    assert.equal(wandered.speed, owned.speed);
    assert.equal(wandered.clip, owned.clip);
    assert.equal(wandered.position.y, 0);
    assert.equal(wandered.speed > 0, tick < MOVE_TICKS);
  }
  const stopped = bot.world.store.view(bot.id)!;
  assert.equal(stopped.velocity.x, 0);
  assert.equal(stopped.velocity.z, 0);
  assert.equal(stopped.clip, "idle");
  assert.equal(stopped.speed, 0);
});
