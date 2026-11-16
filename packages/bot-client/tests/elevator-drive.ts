// Scratch: drive the host elevator by hand. Enter, call 5, ride, step out, step in,
// call 1, ride down, exit. No planner; uses the public call frame + cab frames.
// Run: node --import ./scripts/ts-ext-register.mjs packages/bot-client/tests/elevator-drive.ts
import { readFileSync } from "node:fs";
import { connectBot } from "../../../packages/bot-client/src/connection.ts";
import { openNodeSocket } from "../../../packages/bot-client/src/node-socket.ts";
import { INPUT_HZ } from "../../../src/shared/look.ts";
import { wishTo, type Pose } from "../../../src/shared/nav/follow.ts";

const STEP_MS = 1000 / INPUT_HZ;
const token = readFileSync("/home/tim/.config/ce-arena/qa-token.pem", "utf8").trim();
const session = await connectBot({ url: "ws://127.0.0.1:4173", token, name: "dev-1", role: "qa", openSocket: openNodeSocket, onLog: (l) => console.error(l) });
const world = session.world;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const t0 = Date.now();
const secs = () => ((Date.now() - t0) / 1000).toFixed(2);
const log = (line: string) => console.log(line);
const until = async <T>(read: () => T | undefined, ms: number, label: string): Promise<T> => {
  const started = Date.now();
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() - started > ms) throw new Error(label);
    await sleep(40);
  }
};
const poseNow = (): Pose | undefined => {
  const s = world.self();
  return s ? { x: s.x, y: s.y, z: s.z, vx: 0, vz: 0, yaw: s.yaw } : undefined;
};
const DOOR = "brutalist-building-1-cbake.elevator-1-1.door-1-1-9-22";
const SHAFT = "brutalist-building-1-cbake.e1";
const CENTRE = { x: -33.564772, z: 26.86411 };
const OUT = { x: -35.40, z: 26.60 };

async function walkTo(target: { x: number; z: number }, deadline: number): Promise<"arrived" | "stuck" | "timeout"> {
  let lastDist = Infinity;
  let lastProgress = Date.now();
  while (Date.now() < deadline) {
    const p = poseNow();
    if (!p) {
      await sleep(STEP_MS);
      continue;
    }
    const d = Math.hypot(p.x - target.x, p.z - target.z);
    if (d <= 0.45) return "arrived";
    if (d < lastDist - 0.2) {
      lastDist = d;
      lastProgress = Date.now();
    }
    if (Date.now() - lastProgress > 2500) return "stuck";
    session.input.sendInput(wishTo(p, target, d < 1.2 ? 0.4 : 1));
    await sleep(STEP_MS);
  }
  return "timeout";
}
const cab = () => world.cabs().find((item) => item.id === SHAFT);
const waitCab = async (stop: number, ms: number, label: string): Promise<boolean> => {
  const started = Date.now();
  while (Date.now() - started < ms) {
    const c = cab();
    if (c && c.at === stop && c.phase === "idle") {
      log(`  ${label}: cab idle at ${stop}, y=${c.y.toFixed(1)} t=${secs()}s`);
      return true;
    }
    await sleep(200);
  }
  log(`  ${label}: TIMEOUT waiting for stop ${stop}; cab=${JSON.stringify(cab())}`);
  return false;
};

try {
  const self0 = await until(() => world.self(), 8000, "no owned pawn");
  await until(() => world.sceneGraph(), 8000, "no scene graph");
  log(`seated ${self0.x.toFixed(2)},${self0.y.toFixed(2)},${self0.z.toFixed(2)} place=${world.placeOf(self0)?.id}`);
  log(`cab ${JSON.stringify(cab())}`);

  // 1. Into the elevator room if not already on the landing.
  if (world.placeOf(poseNow()!)?.id !== "brutalist-building-1-cbake.e1@0") {
    const front = { x: -35.30, z: 26.60 };
    if (Math.hypot(poseNow()!.x - front.x, poseNow()!.z - front.z) > 1.5) {
      const approach = [{ x: -32.20, z: 28.80 }, { x: -35.30, z: 28.80 }, front];
      for (const point of approach) {
        const walked = await walkTo(point, t0 + 60_000);
        log(`walk ${point.x},${point.z}: ${walked}`);
        if (walked !== "arrived") break;
      }
    }
    for (let i = 0; i < 12 && !world.door(DOOR)?.open; i += 1) {
      session.input.use();
      await sleep(150);
    }
    log(`elevator room door open=${world.door(DOOR)?.open}`);
    const inside = await walkTo(CENTRE, t0 + 90_000);
    log(`walk to cab centre: ${inside} place=${world.placeOf(poseNow()!)?.id} self=${poseNow()?.x.toFixed(2)},${poseNow()?.z.toFixed(2)}`);
  }

  // 2. Call the cab to floor 1 (in case it is elsewhere), then ride up to 5.
  log(`call floor 1 from landing: ${session.input.callElevator(SHAFT, 0)}`);
  await waitCab(0, 30_000, "summon 1");
  const enter = await walkTo(CENTRE, Date.now() + 10_000);
  log(`in cab: ${enter} place=${world.placeOf(poseNow()!)?.id} y=${poseNow()?.y.toFixed(2)}`);
  log(`call floor 5 from cab: ${session.input.callElevator(SHAFT, 4)}`);
  const up = await waitCab(4, 60_000, "ride up");
  log(`after up: place=${world.placeOf(poseNow()!)?.id} self=${poseNow()?.x.toFixed(2)},${poseNow()?.y.toFixed(2)},${poseNow()?.z.toFixed(2)}`);

  // 3. Step out at floor 5, then back in and ride down.
  const out5 = await walkTo(OUT, Date.now() + 15_000);
  log(`step out at 5: ${out5} place=${world.placeOf(poseNow()!)?.id} y=${poseNow()?.y.toFixed(2)}`);
  await sleep(1200);
  const back = await walkTo(CENTRE, Date.now() + 15_000);
  log(`back in cab: ${back} place=${world.placeOf(poseNow()!)?.id} y=${poseNow()?.y.toFixed(2)}`);
  log(`call floor 1 from cab: ${session.input.callElevator(SHAFT, 0)}`);
  const down = await waitCab(0, 60_000, "ride down");
  log(`after down: place=${world.placeOf(poseNow()!)?.id} self=${poseNow()?.x.toFixed(2)},${poseNow()?.y.toFixed(2)},${poseNow()?.z.toFixed(2)}`);
  const out1 = await walkTo(OUT, Date.now() + 15_000);
  log(`exit at floor 1: ${out1} place=${world.placeOf(poseNow()!)?.id} y=${poseNow()?.y.toFixed(2)}`);
  for (;;) {
    const p = poseNow();
    log(`HOLD t=${secs()}s self=${p?.x.toFixed(2)},${p?.y.toFixed(2)},${p?.z.toFixed(2)} place=${p ? world.placeOf(p)?.id : "?"} cab=${JSON.stringify(cab())}`);
    await sleep(5000);
  }
} catch (err) {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  session.close();
  process.exit(3);
}
