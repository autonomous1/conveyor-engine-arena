import assert from "node:assert/strict";
import test from "node:test";
import { shadowSettings } from "../src/shared/shadows.ts";

test("realistic shadows are the heaviest map", () => {
  const off = shadowSettings("off");
  const basic = shadowSettings("basic");
  const soft = shadowSettings("soft");
  const realistic = shadowSettings("realistic");
  assert.equal(off.enabled, false);
  assert.equal(basic.algorithm, "basic");
  assert.equal(soft.algorithm, "pcf");
  assert.equal(realistic.algorithm, "vsm");
  assert.ok(basic.mapSize < soft.mapSize);
  assert.ok(soft.mapSize < realistic.mapSize);
});
