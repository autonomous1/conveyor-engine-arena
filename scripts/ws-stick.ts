#!/usr/bin/env node
/**
 * Feed stick-style input to a live arena over websocket.
 *
 *   /home/tim/.nvm/versions/node/v24.0.2/bin/node --experimental-strip-types \
 *     scripts/ws-stick.ts --url https://arena.tszakacs.com --forward 2 --hz 20 --stay 10
 */
import {
  delay,
  fetchArenaHello,
  openWsStick,
  waitForPose,
  type StickAxes,
} from "../test/helpers/ws-stick.ts";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i < 0) return fallback;
  return process.argv[i + 1] ?? fallback;
}

function num(name: string, fallback: number): number {
  const raw = arg(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

async function main(): Promise<void> {
  const url = arg("--url", "http://127.0.0.1:8080");
  if (!url) throw new Error("--url required");
  const hz = num("--hz", 20);
  const yaw = num("--yaw", 0);
  /** Keep the socket open this many seconds after the last burst (watch in-browser). */
  const stay = num("--stay", 0);

  const bursts: Array<{ axes: StickAxes; seconds: number; label: string }> = [];
  const forward = num("--forward", 0);
  const back = num("--back", 0);
  const left = num("--left", 0);
  const right = num("--right", 0);
  if (forward > 0) bursts.push({ axes: { stickX: 0, stickY: -1 }, seconds: forward, label: "forward" });
  if (back > 0) bursts.push({ axes: { stickX: 0, stickY: 1 }, seconds: back, label: "back" });
  if (left > 0) bursts.push({ axes: { stickX: -1, stickY: 0 }, seconds: left, label: "left" });
  if (right > 0) bursts.push({ axes: { stickX: 1, stickY: 0 }, seconds: right, label: "right" });

  const seconds = num("--seconds", 0);
  if (bursts.length === 0 && seconds > 0) {
    bursts.push({
      axes: { stickX: num("--stick-x", 0), stickY: num("--stick-y", -1) },
      seconds,
      label: "stick",
    });
  }
  if (bursts.length === 0) {
    bursts.push({ axes: { stickX: 0, stickY: -1 }, seconds: 1.5, label: "forward (default 1.5s)" });
  }

  const hello = await fetchArenaHello(url);
  console.log(`hello world=${hello.world} bundle=${hello.bundleId} hash=${hello.authoritativeHash.slice(0, 12)}…`);

  const stick = openWsStick({ url, hello, hz });
  try {
    const { clientId, ownedEntityId } = await stick.welcome;
    stick.setYaw(yaw);
    console.log(`welcome client=${clientId} owned=${ownedEntityId} yaw=${yaw}`);

    // Hello assigns a free wander pawn (entity id ≈ spawn index + 1). Pose
    // arrives on the first snapshot after welcome — not in the welcome frame.
    const spawn = await waitForPose(stick.poses, ownedEntityId);
    console.log(
      `pose start entity=${ownedEntityId} x=${spawn.x.toFixed(3)} y=${spawn.y.toFixed(3)} z=${spawn.z.toFixed(3)}`
      + ` (authored spawn slot ~index ${ownedEntityId - 1}; live pose may have wandered)`,
    );
    for (const burst of bursts) {
      console.log(`hold ${burst.label} stick=(${burst.axes.stickX},${burst.axes.stickY}) ${burst.seconds}s @ ${hz}Hz`);
      stick.hold(burst.axes);
      await delay(Math.round(burst.seconds * 1000));
      stick.release();
      // One more tick + snapshot after release.
      await delay(250);
    }

    const end = stick.poses.get(ownedEntityId) ?? await waitForPose(stick.poses, ownedEntityId, 1500);
    const dx = end.x - spawn.x;
    const dy = end.y - spawn.y;
    const dz = end.z - spawn.z;
    console.log(
      `pose end   entity=${ownedEntityId} x=${end.x.toFixed(3)} y=${end.y.toFixed(3)} z=${end.z.toFixed(3)}`,
    );
    console.log(`pose Δxyz=(${dx.toFixed(3)}, ${dy.toFixed(3)}, ${dz.toFixed(3)}) distXZ=${Math.hypot(dx, dz).toFixed(3)}`);
    if (stay > 0) {
      console.log(`stay connected ${stay}s (Ctrl-C to drop sooner)`);
      await delay(Math.round(stay * 1000));
    }
  } finally {
    stick.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
