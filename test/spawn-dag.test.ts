import assert from "node:assert/strict";
import { test } from "node:test";
import { loadArena } from "../src/server/world-loader.ts";
import { claimClearSpawn } from "../src/server/game.ts";

const loaded = loadArena();
const dag = loaded.spatialDag!;
const pad = { id: "probe", x: 10, y: 0, z: 2, yaw: 0 };
const id = loaded.agents[0]!.id;

test("spawn_claim_uses_the_dag_and_dynamic_doors", () => {
  const flat = claimClearSpawn(loaded.world, id, [pad]);
  assert.ok(flat);
  const viaDag = claimClearSpawn(loaded.world, id, [pad], new Map(), dag);
  assert.deepEqual(viaDag, flat);
  const blocked = claimClearSpawn(loaded.world, id, [pad], new Map(), dag, [
    { minX: 8, maxX: 12, minY: 0, maxY: 2, minZ: 0, maxZ: 4 },
  ]);
  assert.equal(blocked, undefined);
});
