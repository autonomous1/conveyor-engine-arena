import assert from "node:assert/strict";
import test from "node:test";
import { playerTeams } from "../src/server/players.ts";

test("playerTeams keeps the roster order and omits a teamless pawn", () => {
  const ids = [3, 5];
  const agents = [{ id: 3, team: "b" }, { id: 4 }, { id: 5, team: "a" }];
  assert.deepEqual(playerTeams(ids, agents), [{ id: 3, team: "b" }, { id: 5, team: "a" }]);
  assert.deepEqual(playerTeams([4], agents), []);
  assert.deepEqual(playerTeams([], agents), []);
  assert.deepEqual(ids, [3, 5]);
  assert.deepEqual(agents, [{ id: 3, team: "b" }, { id: 4 }, { id: 5, team: "a" }]);
});

test("playerTeams follows ids order, not agent order", () => {
  assert.deepEqual(
    playerTeams([5, 3], [{ id: 3, team: "b" }, { id: 5, team: "a" }]),
    [{ id: 5, team: "a" }, { id: 3, team: "b" }],
  );
});
