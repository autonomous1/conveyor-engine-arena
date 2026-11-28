import assert from "node:assert/strict";
import test from "node:test";
import { createBotWorld } from "../packages/bot-client/src/world.ts";
import { loadArena } from "../src/server/world-loader.ts";
import { planPath } from "../src/shared/nav/path.ts";
import { pickupBoxSource } from "../src/shared/pickups.ts";

// The live bake's shelf weapon, taken by seat 7 in the trap report. Its box
// (x 54.422–56.057, z −19.267…−19.027) is what a stale nav model keeps.
const TAKEN = "alien-weapon-1-7-3";
const FROM = { x: 55.84, y: 0, z: -18.66 };
const TO = { x: 53.83, y: 0, z: -22.83 };
const gate = () => "open" as const;

const arena = loadArena();
const live = (arena.view.pickups ?? []).map((pickup) => pickup.id);
const world = createBotWorld(arena.view);
world.applyWelcome({ pickups: live, doors: [], ammo: 0, keys: [] });

const nav = () => ({
  aabbs: world.aabbs,
  doors: arena.view.doors,
  pawnRadius: world.pawnRadius,
  pawnHeight: world.pawnHeight,
});

function hasBox(id: string): boolean {
  return world.aabbs.some((box) => box.source === pickupBoxSource(id) || box.source === id);
}

test("a taken pickup's box leaves the nav AABBs and the plan finds a start", () => {
  assert.ok(hasBox(TAKEN), "the welcome's live box is present");
  // Control: with the weapon still on the shelf, the corner pose is blocked.
  const before = planPath(arena.sceneGraph!, FROM, TO, gate, { view: nav() });
  assert.equal(before.ok, false);
  if (!before.ok) assert.equal(before.reason, "start-blocked");

  const untaken = live.find((id) => id !== TAKEN && hasBox(id));
  assert.ok(untaken, "no untaken pickup with a box");

  world.applyPickupGone(TAKEN);
  assert.equal(hasBox(TAKEN), false, "the taken pickup's box is still in the nav model");
  assert.ok(hasBox(untaken), "an untaken pickup's box must stay");

  const after = planPath(arena.sceneGraph!, FROM, TO, gate, { view: nav() });
  assert.ok(after.ok, after.ok ? "" : after.reason);
  assert.ok(after.points.length > 0);
});

test("a pickup that reappears in the welcome restores its box", () => {
  world.applyWelcome({ pickups: [...live, TAKEN], doors: [], ammo: 0, keys: [] });
  assert.ok(hasBox(TAKEN), "the re-added pickup's box must be back");
  world.applyPickupGone(TAKEN);
  assert.equal(hasBox(TAKEN), false);
});
