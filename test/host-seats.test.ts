import assert from "node:assert/strict";
import { test } from "node:test";
import { connectTestBot, startLiveArena, until } from "./support/live-arena.ts";

test("a_disconnected_pawn_despawns_and_frees_the_seat", { timeout: 30_000 }, async () => {
  const arena = await startLiveArena();
  const a = await connectTestBot(arena, "seat-a");
  const b = await connectTestBot(arena, "seat-b");
  const c = await connectTestBot(arena, "seat-c");
  try {
    const aId = (await until(() => a.world.self(), 5_000, "a pawn")).id;
    const bId = (await until(() => b.world.self(), 5_000, "b pawn")).id;
    await until(() => b.world.others().some((row) => row.id === aId), 5_000, "b sees a");

    a.close();
    await until(() => !b.world.others().some((row) => row.id === aId), 5_000, "a despawned");

    const d = await connectTestBot(arena, "seat-d");
    try {
      assert.ok(await until(() => d.world.self(), 5_000, "d seat"), "D must get a seat");
      await until(() => b.world.others().some((row) => row.id === d.world.self()?.id), 5_000, "b sees d");
      assert.ok(!d.world.others().some((row) => row.id === aId), "D still sees the disconnected pawn");
      assert.equal(d.world.weapon(), undefined);
      assert.deepEqual(d.world.keys(), []);
      const pose = await until(() => d.world.self(), 5_000, "d pose");
      const pads = d.world.playerSpawns;
      assert.ok(pads.some((pad) => Math.hypot(pose.x - pad.x, pose.z - pad.z) < 0.8), "D is not on a player pad");
    } finally {
      d.close();
    }
    const cId = (await until(() => c.world.self(), 5_000, "c pawn")).id;
    assert.notEqual(cId, bId);
  } finally {
    a.close();
    b.close();
    c.close();
    await arena.close();
  }
});
