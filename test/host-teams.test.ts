import assert from "node:assert/strict";
import { test } from "node:test";
import { loadArena } from "../src/server/world-loader.ts";
import { connectTestBot, startLiveArena } from "./support/live-arena.ts";
import { openRosterTap, type RosterFrame } from "./support/roster-tap.ts";

// The live host boots from the same bake as this load, so each player agent's
// id carries the team its seat must keep: 9–12 a, 13–16 b on the 15:54 bake.
const seatTeams = new Map(
  loadArena().agents.filter((agent) => agent.role === "player").map((agent) => [agent.id, agent.team]),
);

function assertSeatTeams(frame: RosterFrame): void {
  for (const row of frame.teams) {
    assert.equal(row.team, seatTeams.get(row.id), `seat ${row.id} team`);
  }
  for (const id of frame.ids) {
    if (seatTeams.has(id)) assert.ok(frame.teams.some((row) => row.id === id), `seat ${id} has no team row`);
  }
}

function split(frame: RosterFrame): { a: number; b: number } {
  let a = 0;
  let b = 0;
  for (const row of frame.teams) {
    if (row.team === "a") a += 1;
    else if (row.team === "b") b += 1;
  }
  return { a, b };
}

test("the_roster_keeps_each_seats_bake_team", { timeout: 90_000 }, async () => {
  const arena = await startLiveArena();
  const tap = await openRosterTap(arena, "teams-tap", true);
  const bots = [];
  try {
    for (let index = 0; index < 8; index += 1) {
      const bot = await connectTestBot(arena, `teams-${index}`);
      bots.push(bot);
      const self = await untilSelf(bot);
      assert.ok(self > 0);
    }
    const full = await tap.waitFor((frame) => frame.ids.length === 8, 10_000, "full roster");
    assert.deepEqual(full.ids, [9, 10, 11, 12, 13, 14, 15, 16]);
    assertSeatTeams(full);
    assert.deepEqual(split(full), { a: 4, b: 4 });

    // A leave keeps the remaining seats' teams; the freed seat rejoins on team b.
    const leaving = bots.pop()!;
    leaving.close();
    const seven = await tap.waitFor((frame) => frame.ids.length === 7, 10_000, "leave");
    assertSeatTeams(seven);
    assert.deepEqual(split(seven), { a: 4, b: 3 });

    const again = await connectTestBot(arena, "teams-again");
    bots.push(again);
    await untilSelf(again);
    const back = await tap.waitFor((frame) => frame.ids.length === 8, 10_000, "rejoin");
    assertSeatTeams(back);
    assert.deepEqual(split(back), { a: 4, b: 4 });
  } finally {
    for (const bot of bots) bot.close();
    tap.close();
    await arena.close();
  }
});

async function untilSelf(bot: Awaited<ReturnType<typeof connectTestBot>>): Promise<number> {
  const started = Date.now();
  for (;;) {
    const self = bot.world.self();
    if (self) return self.id;
    if (Date.now() - started > 5_000) throw new Error("no seat");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
