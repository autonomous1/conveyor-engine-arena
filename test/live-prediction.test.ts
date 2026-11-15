import assert from "node:assert/strict";
import { test } from "node:test";
import { createMotionPredictor } from "../packages/bot-client/src/predict.ts";
import { connectTestBot, delay, startLiveArena, until } from "./support/live-arena.ts";

test("live_predictor_tracks_host", { timeout: 60_000 }, async () => {
  const arena = await startLiveArena();
  const session = await connectTestBot(arena, "pred-1");
  try {
    const first = await until(() => session.world.self(), 5_000, "no owned pawn");
    const predictor = createMotionPredictor(true);
    const cmd = { moveX: 0, moveZ: 1, yaw: 0 };
    let maxError = 0;
    const deadline = Date.now() + 1_500;
    while (Date.now() < deadline) {
      session.input.sendInput(cmd);
      const auth = session.world.self();
      const pose = predictor.advance(auth, cmd, session.world.aabbs, session.world.pawnRadius);
      if (auth && pose) maxError = Math.max(maxError, Math.hypot(auth.x - pose.x, auth.z - pose.z));
      await delay(20);
    }
    const last = session.world.self()!;
    assert.ok(Math.abs(last.z - first.z) > 1, `moved ${Math.abs(last.z - first.z)}`);
    assert.ok(maxError < 1.5, `max error ${maxError}`);
  } finally {
    session.close();
    await arena.close();
  }
});

test("live_predictor_off_follows_authority", () => {
  const predictor = createMotionPredictor(false);
  const auth = { x: 3, y: 0, z: -2, yaw: 0.5 };
  const pose = predictor.advance(auth, { moveX: 1, moveZ: 1, yaw: 0 }, [], 0.5);
  assert.deepEqual(pose, { x: 3, y: 0, z: -2, vx: 0, vz: 0, yaw: 0.5 });
});
