import assert from "node:assert/strict";
import test from "node:test";
import { AuthoritativeWorld } from "conveyor-engine-world";
import { moveIntent, yawFromQuat } from "../src/shared/look.ts";
import {
  MOVE_ACCEL,
  MOVE_DT,
  MOVE_SPEED,
  MOVE_TICKS,
  approachVelocity,
  enqueueOwnedMove,
  gaitForSpeed,
  wishPlanar,
} from "../src/shared/movements.ts";

function pawn(x = 0, z = 0): { world: AuthoritativeWorld; id: number } {
  const world = new AuthoritativeWorld();
  const id = world.createEntity(0n, { type: "pawn", shape: "capsule" });
  world.enqueue({
    kind: "setTransform",
    entity: id,
    position: { x, y: 0, z },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    scale: { x: 1, y: 1, z: 1 },
  });
  world.enqueue({ kind: "setBounds", entity: id, radius: 0.5 });
  world.commit(0n);
  return { world, id };
}

function step(world: AuthoritativeWorld, id: number, moveX: number, moveZ: number, yaw: number, tick: number): void {
  const moved = enqueueOwnedMove(world, id, moveX, moveZ, yaw, MOVE_DT);
  assert.ok(moved);
  world.commit(BigInt(tick));
}

test("a full forward wish reaches speed in a fixed tick count and a release returns to zero", () => {
  assert.equal(MOVE_TICKS, 4);
  assert.ok(MOVE_TICKS >= 2);
  const { world, id } = pawn();
  for (let tick = 1; tick <= MOVE_TICKS; tick++) {
    step(world, id, 0, 1, 0, tick);
    const view = world.store.view(id)!;
    const expected = Math.min(MOVE_SPEED, tick * MOVE_ACCEL);
    assert.equal(view.velocity.x, 0);
    assert.equal(view.velocity.y, 0);
    assert.equal(view.velocity.z, expected);
    assert.equal(view.position.y, 0);
    assert.equal(view.speed, expected);
    assert.equal(view.clip, gaitForSpeed(expected));
    assert.ok(view.velocity.z < MOVE_SPEED || tick === MOVE_TICKS);
  }
  const cruising = world.store.view(id)!;
  assert.equal(cruising.velocity.z, MOVE_SPEED);
  assert.equal(cruising.position.x, 0);
  assert.ok(cruising.position.z > 0);

  for (let tick = 1; tick <= MOVE_TICKS; tick++) {
    step(world, id, 0, 0, 0, MOVE_TICKS + tick);
    const view = world.store.view(id)!;
    const expected = Math.max(0, MOVE_SPEED - tick * MOVE_ACCEL);
    assert.equal(view.velocity.x, 0);
    assert.equal(view.velocity.z, expected);
    assert.equal(view.position.y, 0);
    assert.equal(view.speed, expected);
    assert.equal(view.clip, gaitForSpeed(expected));
  }
  const stopped = world.store.view(id)!;
  assert.equal(stopped.velocity.x, 0);
  assert.equal(stopped.velocity.z, 0);
  assert.equal(stopped.position.y, 0);
  assert.equal(gaitForSpeed(0), "idle");
  assert.equal(gaitForSpeed(MOVE_SPEED), "run");
  assert.equal(gaitForSpeed(MOVE_SPEED + MOVE_ACCEL), "run");
});

test("a yaw snap does not replace velocity with the new wish", () => {
  const { world, id } = pawn();
  for (let tick = 1; tick <= MOVE_TICKS; tick++) step(world, id, 0, 1, 0, tick);
  const before = world.store.view(id)!;
  assert.equal(before.velocity.z, MOVE_SPEED);

  const yaw = Math.PI / 2;
  const turned = moveIntent(yaw, 1, 0);
  const wish = wishPlanar(turned.moveX, turned.moveZ);
  step(world, id, turned.moveX, turned.moveZ, yaw, MOVE_TICKS + 1);
  const after = world.store.view(id)!;
  const gap = Math.hypot(after.velocity.x - wish.x, after.velocity.z - wish.z);
  assert.ok(gap > MOVE_ACCEL, `velocity snapped to the new wish, gap ${gap}`);
  assert.ok(after.velocity.z > after.velocity.x);
  assert.deepEqual(
    { x: after.velocity.x, z: after.velocity.z },
    approachVelocity({ x: before.velocity.x, z: before.velocity.z }, wish),
  );
  assert.equal(after.velocity.y, 0);
  assert.equal(after.position.y, 0);
  assert.ok(Math.abs(yawFromQuat(after.rotation) - yaw) < 1e-9);

  const held = pawn();
  for (let tick = 1; tick <= MOVE_TICKS; tick++) step(held.world, held.id, 0, 1, 0, tick);
  step(held.world, held.id, 0, 1, yaw, MOVE_TICKS + 1);
  const sameWish = held.world.store.view(held.id)!;
  assert.equal(sameWish.velocity.x, 0);
  assert.equal(sameWish.velocity.z, MOVE_SPEED);
  assert.equal(sameWish.position.y, 0);
  assert.ok(Math.abs(yawFromQuat(sameWish.rotation) - yaw) < 1e-9);
});

test("the capsule step hits the AABB and setClip does not write position", () => {
  const { world, id } = pawn();
  const parked = world.store.view(id)!;
  const position = { ...parked.position };
  const velocity = { ...parked.velocity };
  world.enqueue({ kind: "setClip", entity: id, clip: "run", speed: 9 });
  world.commit(1n);
  const clipped = world.store.view(id)!;
  assert.deepEqual(clipped.position, position);
  assert.deepEqual(clipped.velocity, velocity);
  assert.equal(clipped.clip, "run");
  assert.equal(clipped.position.y, 0);

  world.addObstacle({ id: 1, minX: 2, maxX: 3, minZ: -1, maxZ: 1 });
  for (let tick = 2; tick <= 17; tick++) {
    step(world, id, 1, 0, Math.PI / 2, tick);
    const view = world.store.view(id)!;
    assert.equal(view.position.y, 0);
    assert.equal(view.velocity.y, 0);
    assert.ok(view.position.x <= 1.5 + 1e-9, `x ${view.position.x}`);
  }
  const stopped = world.store.view(id)!;
  assert.equal(stopped.position.x, 1.5);
  assert.equal(stopped.position.y, 0);
  assert.equal(stopped.position.z, 0);
});
