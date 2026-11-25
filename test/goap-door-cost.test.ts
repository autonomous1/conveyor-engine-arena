import assert from "node:assert/strict";
import { test } from "node:test";
import { loadReferenceArena } from "./arena-reference.ts";
import { createBotContext, groundActions } from "../src/shared/bots/actions.ts";

const loaded = loadReferenceArena();
const graph = loaded.sceneGraph!;
const doors = loaded.view.doors;
const doorA = doors.find((door) => door.id.startsWith("brutalist-building-1-cbake.door-1-1"))!;
const doorB = doors.find((door) => door.id.startsWith("brutalist-building-1-cbake-9.door-1-1"))!;
const nearA = { x: doorA.position[0] + 2, y: doorA.position[1], z: doorA.position[2] };

test("door_cost_follows_the_pawn", () => {
  // No goals: every place and door is grounded, including both door sides.
  const actions = groundActions(graph, loaded.view.pickups ?? []);
  const pick = (door: string): number => {
    const ctx = createBotContext(graph, [], { position: () => nearA });
    const action = actions.find((item) => item.id === `goToDoor:${door}:outside`)!;
    const cost = typeof action.cost === "function" ? action.cost({ at: "outside" }, ctx) : action.cost;
    return cost;
  };
  const a = pick(doorA.id);
  const b = pick(doorB.id);
  assert.ok(Number.isFinite(a) && Number.isFinite(b));
  assert.ok(a < b, `near ${a} should be cheaper than far ${b}`);
});

test("door_action_ids_name_the_side", () => {
  const actions = groundActions(graph, loaded.view.pickups ?? []);
  const ids = actions.filter((item) => item.id.startsWith("goToDoor:")).map((item) => item.id);
  assert.ok(ids.some((id) => id.endsWith(":outside")));
  assert.equal(new Set(ids).size, ids.length, "duplicate goToDoor ids");
});
