/**
 * Invariant coverage for behavior that already exists on HEAD. These tests
 * document invariants; they do not introduce them. `unlock_keeps_key` passes
 * before and after this task, so the fail-first rule for new invariants does
 * not apply here — do not weaken it looking for a red test.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { unlock } from "../dist/shared/bots/actions.js";
import type { WorldState } from "../dist/shared/bots/goap.js";
import { atDoor, buildWorldState, doorLockedFact, doorOpenFact, hasKeyFact } from "../dist/shared/bots/state.js";

const here = dirname(fileURLToPath(import.meta.url));
const DOOR = "hall-b.door-ext";
const KEY = "key";

type Portal = { id: string; locked?: boolean; key?: string };

test("unlock_keeps_key", () => {
  // Task 05 fixture: the hall-b exterior door is locked and names the key.
  const fixture = JSON.parse(readFileSync(join(here, "fixtures/scene-graph.json"), "utf8")) as { portals: Portal[] };
  const portal = fixture.portals.find((p) => p.id === DOOR);
  assert.ok(portal, "fixture must contain the locked hall-b exterior door");
  assert.equal(portal.locked, true);
  assert.equal(portal.key, KEY);

  const state: WorldState = buildWorldState({
    at: atDoor(DOOR),
    pickups: [],
    heldKeys: [KEY],
    doors: [{ id: DOOR, open: false, locked: true }],
  });
  assert.equal(state[doorLockedFact(DOOR)], true);
  assert.equal(state[hasKeyFact(KEY)], true);

  Object.assign(state, unlock(DOOR, KEY).eff);

  assert.equal(state[doorLockedFact(DOOR)], false);
  assert.equal(state[doorOpenFact(DOOR)], true);
  assert.equal(state[hasKeyFact(KEY)], true, "unlock must not consume the key");
});
