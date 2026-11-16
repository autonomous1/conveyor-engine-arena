// Scratch: get into the elevator room, ride up with the mission, then ride down with
// the public call API (the planner has no downward ride edge).
// Run: node --import ./scripts/ts-ext-register.mjs packages/bot-client/tests/elevator-ride.ts
import { readFileSync } from "node:fs";
import { connectBot } from "../../../packages/bot-client/src/connection.ts";
import { openNodeSocket } from "../../../packages/bot-client/src/node-socket.ts";
import { runMission } from "../../../packages/bot-client/src/brain.ts";
import { reach } from "../../../src/shared/bots/goals.ts";
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

const DOOR = "brutalist-building-1-cbake.elevator-1-1.door-1-1-9-22";
const SHAFT = "brutalist-building-1-cbake.e1";
const LANDING = { x: -33.564772, z: 26.86411 };
const UP = "brutalist-building-1-cbake.e1@4";
const DOWN = "brutalist-building-1-cbake.e1@0";

try {
  const self0 = await until(() => world.self(), 8000, "no owned pawn");
  await until(() => world.sceneGraph(), 8000, "no scene graph");
  log(`seated ${self0.x.toFixed(2)},${self0.z.toFixed(2)} place=${world.placeOf(self0)?.id}`);

  // 1. In front of the elevator room door (west side of the shaft).
  if (!["brutalist-building-1-cbake.e1@0", "brutalist-building-1-cbake.elevator-1-1"].includes(world.placeOf(self0)?.id ?? "")) {
    // Around the shaft room: north of it first, then west, then south to its door.
    const approach = [{ x: -32.20, z: 28.80 }, { x: -35.30, z: 28.80 }, { x: -35.30, z: 26.60 }];
    let walked = "arrived";
    for (const point of approach) {
      walked = await walkTo(point, t0 + 60_000);
      log(`walk ${point.x.toFixed(2)},${point.z.toFixed(2)}: ${walked} at ${poseNow()?.x.toFixed(2)},${poseNow()?.z.toFixed(2)}`);
      if (walked !== "arrived") break;
    }
    if (walked !== "arrived") {
      session.close();
      process.exit(3);
    }
    for (let i = 0; i < 12 && !world.door(DOOR)?.open; i += 1) {
      session.input.use();
      await sleep(150);
    }
    log(`door ${DOOR} open=${world.door(DOOR)?.open} locked=${world.door(DOOR)?.locked}`);
    const inside = await walkTo(LANDING, t0 + 80_000);
    log(`walk to landing: ${inside} place=${world.placeOf(poseNow()!)?.id} self=${poseNow()?.x.toFixed(2)},${poseNow()?.z.toFixed(2)}`);
  }
  log(`at ${world.placeOf(poseNow()!)?.id} y=${poseNow()?.y.toFixed(2)}`);

  // 2. Ride up with the mission (the planner edge).
  const upCode = await runMission(session, { kind: "goal", goal: reach(UP) }, {
    timeoutMs: 90_000,
    log: (line) => log(`  brain ${line}`),
    error: (line) => console.error(`  brain ${line}`),
  });
  log(`up mission code=${upCode} self=${poseNow()?.x.toFixed(2)},${poseNow()?.y.toFixed(2)},${poseNow()?.z.toFixed(2)} place=${world.placeOf(poseNow()!)?.id}`);

  // 3. Ride down with the public call API.
  const cab = () => world.cabs().find((item) => item.id === SHAFT);
  log(`cab before down: ${JSON.stringify(cab())}`);
  const called = session.input.callElevator(SHAFT, 0);
  log(`callElevator(${SHAFT}, 0) -> ${called}`);
  const downStart = Date.now();
  while (Date.now() - downStart < 60_000) {
    const c = cab();
    if (c && c.at === 0 && c.phase === "idle") break;
    await sleep(200);
  }
  log(`cab at floor 1: ${JSON.stringify(cab())}`);
  const out = await walkTo({ x: -35.30, z: 26.60 }, Date.now() + 20_000);
  const end = poseNow();
  log(`down exit: ${out} self=${end?.x.toFixed(2)},${end?.y.toFixed(2)},${end?.z.toFixed(2)} place=${world.placeOf(end!)?.id}`);
  for (;;) {
    const p = poseNow();
    log(`HOLD t=${secs()}s self=${p?.x.toFixed(2)},${p?.y.toFixed(2)},${p?.z.toFixed(2)} place=${p ? world.placeOf(p)?.id : "?"}`);
    await sleep(5000);
  }
} catch (err) {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  session.close();
  process.exit(3);
}
