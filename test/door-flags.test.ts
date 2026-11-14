import assert from "node:assert/strict";
import { test } from "node:test";
import { doorFlags, type WanderNav } from "../src/server/game.ts";

function nav(liveDoors?: () => ReadonlyArray<{ id: string; open: boolean; locked?: boolean }>): WanderNav {
  return {
    aabbs: [],
    doors: [{ id: "a", open: false, locked: false }] as unknown as WanderNav["doors"],
    pawnRadius: 0.5,
    pawnHeight: 1.8,
    liveDoors,
  };
}

test("door_flags_prefer_precomputed_rows", () => {
  const flags = doorFlags(nav(() => { throw new Error("liveDoors must not be called"); }), false, [{ id: "a", open: true }]);
  assert.equal(flags.get("a"), true);
});

test("door_flags_fall_back_to_live_doors", () => {
  let calls = 0;
  const flags = doorFlags(nav(() => { calls += 1; return [{ id: "a", open: true }]; }), false);
  assert.equal(calls, 1);
  assert.equal(flags.get("a"), true);
});
