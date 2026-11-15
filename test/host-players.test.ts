import assert from "node:assert/strict";
import { test } from "node:test";
import { playerRoster } from "../src/server/players.ts";

test("player_roster_keeps_clients_and_drops_spectators", () => {
  const owned = new Map<number, number | undefined>([[1, 10], [2, 11], [3, undefined]]);
  assert.deepEqual(playerRoster([1, 2, 3, 4], (id) => owned.get(id)), [10, 11]);
  assert.deepEqual(playerRoster([], () => 1), []);
  assert.deepEqual(playerRoster([1, 1], () => 7), [7]);
});
