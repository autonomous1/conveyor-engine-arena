// Task 206: a player pad's `team` rides the bake into the host and survives a
// respawn. The reference fixture is the arena-1 bake (test/arena-reference.ts);
// the live arena-2 bake under web/ is not a test input.
import assert from "node:assert/strict";
import test from "node:test";
import { loadReferenceArena } from "./arena-reference.ts";
import { createHeldInputs, placePawn, startWanderLoop } from "../src/server/game.ts";
import { createPawnHealth, RESPAWN_MS } from "../src/shared/health.ts";

const near = (x: number, z: number, pad: { x: number; z: number }): boolean => Math.hypot(x - pad.x, z - pad.z) < 0.05;

test("the reference pads carry their team onto the player pawns", () => {
  const loaded = loadReferenceArena();
  const pads = loaded.playerSpawns;
  assert.deepEqual(pads.map((pad) => pad.team), ["a", "b", "c"]);
  const players = loaded.agents.filter((agent) => agent.role === "player");
  assert.equal(players.length, pads.length);
  for (const player of players) {
    const view = loaded.world.store.view(player.id);
    assert.ok(view);
    const pad = pads.find((candidate) => near(view.position.x, view.position.z, candidate));
    assert.ok(pad, `player ${player.id} is not on a pad`);
    assert.equal(player.team, pad.team, `player ${player.id} team`);
  }
});

test("a_dead_player_respawns_on_a_pad_of_its_own_team", { timeout: 10_000 }, async () => {
  const loaded = loadReferenceArena();
  // The reference fixture is baked in SVG order: pad 0 is team a, pad 1 team b, pad 2 team c. Test 1 locks that order.
  const [aPad, bPad, cPad] = [loaded.playerSpawns[0]!, loaded.playerSpawns[1]!, loaded.playerSpawns[2]!];
  const players = loaded.agents.filter((agent) => agent.role === "player");
  const onPad = (pad: { x: number; z: number }) => players.find((agent) => {
    const view = loaded.world.store.view(agent.id);
    return view !== undefined && near(view.position.x, view.position.z, pad);
  })!;
  const dead = onPad(bPad);
  // Clear the team-a pad: an unfiltered claim would pick it first, the filtered claim must not.
  // (0,0,10) is open floor. A probe inside geometry is no good: the kernel depenetrates a
  // pawn on the next commit, so a "moved off the probe" poll would fire before the respawn.
  const probe = { x: 0, y: 0, z: 10, yaw: 0 };
  placePawn(loaded.world, onPad(aPad).id, probe);
  placePawn(loaded.world, dead.id, probe);
  loaded.world.commit(0n);

  let now = 1_000;
  const health = createPawnHealth(() => now);
  for (const player of players) health.note(player.id);
  health.wound(dead.id, players[0]!.id, 100);
  assert.equal(health.get(dead.id).dead, true);
  now += RESPAWN_MS;

  const server = {
    connected: [],
    gateway: { drainTimeouts: () => [], get: () => undefined },
    replicator: { get: () => undefined, publish: () => new Map() },
    setTick: () => {},
    sendSnapshot: () => {},
  };
  const stop = startWanderLoop(loaded.world, loaded.agents, server as never, createHeldInputs(), () => {}, health, undefined, undefined, false, loaded.playerSpawns, true);
  try {
    const start = Date.now();
    let at: { x: number; z: number } | undefined;
    while (Date.now() - start < 2_000) {
      const view = loaded.world.store.view(dead.id);
      if (view && Math.hypot(view.position.x - probe.x, view.position.z - probe.z) > 0.5) {
        at = { x: view.position.x, z: view.position.z };
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(at, "the dead player never left the probe point");
    assert.equal(near(at.x, at.z, bPad), true, `respawned at ${at.x.toFixed(2)},${at.z.toFixed(2)}`);
    assert.equal(near(at.x, at.z, aPad), false, "respawned on the team-a pad");
    assert.equal(near(at.x, at.z, cPad), false, "respawned on the team-c pad");
  } finally {
    stop();
  }
});
