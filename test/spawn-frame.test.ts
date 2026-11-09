import assert from "node:assert/strict";
import test from "node:test";
import { parseSpawn, spawnFrame } from "../src/shared/spawn-frame.ts";

test("a spawn frame round-trips through JSON", () => {
  const frame = spawnFrame(12, 1.5, 0, -3);
  assert.deepEqual(parseSpawn(JSON.parse(JSON.stringify(frame))), { t: "spawn", id: 12, x: 1.5, y: 0, z: -3 });
});

test("other frames and bad fields do not parse as a spawn", () => {
  assert.equal(parseSpawn(undefined), undefined);
  assert.equal(parseSpawn({ t: "door", id: 1, x: 0, y: 0, z: 0 }), undefined);
  assert.equal(parseSpawn({ t: "spawn", id: "1", x: 0, y: 0, z: 0 }), undefined);
  assert.equal(parseSpawn({ t: "spawn", id: 1.5, x: 0, y: 0, z: 0 }), undefined);
  assert.equal(parseSpawn({ t: "spawn", id: 1, x: Number.NaN, y: 0, z: 0 }), undefined);
  assert.equal(parseSpawn({ t: "spawn", id: 1, x: 0, y: 0 }), undefined);
});
