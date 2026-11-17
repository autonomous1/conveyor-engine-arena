import assert from "node:assert/strict";
import { test } from "node:test";
import { loadArena } from "../src/server/world-loader.ts";
import { stepGrenade, type GrenadeBody } from "../src/shared/grenade.ts";

const loaded = loadArena();
const dag = loaded.spatialDag!;

function body(x: number, y: number, z: number, vx: number): GrenadeBody {
  return { id: 1, owner: 9, x, y, z, vx, vy: 0, vz: 0, yaw: 0, bounced: false, age: 0, impact: "bounce" };
}

test("grenade_sweep_uses_the_static_dag", () => {
  const box = loaded.view.aabbs.find((item) => item.maxX - item.minX > 2 && (item.maxY ?? 0) > 2)!;
  const z = (box.minZ + box.maxZ) / 2;
  const from = box.minX - 2;
  const step = stepGrenade(body(from, 1, z, 60), 0.1, loaded.view.aabbs, [], undefined, dag);
  assert.notEqual(step.kind, "fly");
});

test("grenade_sweep_uses_the_dynamic_door", () => {
  const clear = stepGrenade(body(0, 5, 0, 10), 0.1, [], [], undefined, dag);
  assert.equal(clear.kind, "fly");
  const door = [{ minX: 0.6, maxX: 0.8, minY: 4, maxY: 6, minZ: -1, maxZ: 1 }];
  const shut = stepGrenade(body(0, 5, 0, 10), 0.1, [], [], undefined, dag, door);
  assert.notEqual(shut.kind, "fly");
});
