// Scratch: by hand to a floor-3 door in building-1-cbake-0: hall out, plaza, building-0
// door in, elevator to stop 2, walk to the door and face it.
// Run: node --import ./scripts/ts-ext-register.mjs packages/bot-client/tests/door-far.ts
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
const SHAFT = "brutalist-building-1-cbake-0.e1";
const LANDING = { x: -34.611732, z: -28.999208 };
const TARGET = { x: -30.343295, z: -31.990141 };
const FACE = { x: -30.879795, z: -33.038141 };
const cab = () => world.cabs().find((item) => item.id === SHAFT);

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
async function walkVia(points: Array<{ x: number; z: number }>, label: string): Promise<boolean> {
  for (const point of points) {
    const result = await walkTo(point, Date.now() + 60_000);
    const p = poseNow();
    log(`${label} ${point.x.toFixed(1)},${point.z.toFixed(1)}: ${result} at ${p?.x.toFixed(2)},${p?.y.toFixed(2)},${p?.z.toFixed(2)} place=${p ? world.placeOf(p)?.id : "?"}`);
    if (result !== "arrived") return false;
  }
  return true;
}
async function tryOpen(doorId: string): Promise<boolean> {
  for (let i = 0; i < 12; i += 1) {
    if (world.door(doorId)?.open) return true;
    const body = world.doorBody(doorId);
    const p = poseNow();
    if (!body || !p || Math.hypot(p.x - body.position[0], p.z - body.position[2]) > 3.2) return false;
    session.input.use();
    await sleep(150);
  }
  return world.door(doorId)?.open === true;
}
const waitCab = async (stop: number, ms: number): Promise<boolean> => {
  const started = Date.now();
  while (Date.now() - started < ms) {
    const c = cab();
    if (c && c.at === stop && c.phase === "idle") return true;
    await sleep(200);
  }
  return false;
};

try {
  const self0 = await until(() => world.self(), 8000, "no owned pawn");
  await until(() => world.sceneGraph(), 8000, "no scene graph");
  log(`seated ${self0.x.toFixed(2)},${self0.y.toFixed(2)},${self0.z.toFixed(2)} place=${world.placeOf(self0)?.id}`);

  // A. Out of building-1-cbake through its open hall door.
  if (!(await walkVia([{ x: -37.50, z: 24.60 }, { x: -24.90, z: 24.60 }, { x: -24.90, z: 27.16 }], "hall"))) throw new Error("hall walk");
  log(`exterior door open=${world.door("brutalist-building-1-cbake.door-1-1-9-22-0")?.open}`);
  if (world.door("brutalist-building-1-cbake.door-1-1-9-22-0")?.open === false) await tryOpen("brutalist-building-1-cbake.door-1-1-9-22-0");
  if (!(await walkVia([{ x: -21.60, z: 27.16 }, { x: -21.00, z: 20.00 }, { x: -21.00, z: -10.00 }, { x: -30.00, z: -16.00 }, { x: -35.20, z: -17.10 }], "plaza"))) throw new Error("plaza walk");

  // B. Into building-1-cbake-0.
  if (world.door("brutalist-building-1-cbake-0.door-1-1-9-22-0")?.open === false) await tryOpen("brutalist-building-1-cbake-0.door-1-1-9-22-0");
  log(`building-0 door open=${world.door("brutalist-building-1-cbake-0.door-1-1-9-22-0")?.open}`);
  if (!(await walkVia([{ x: -35.44, z: -19.60 }, { x: -34.90, z: -24.00 }, { x: LANDING.x, z: LANDING.z }], "hall-0"))) throw new Error("hall-0 walk");

  // C. Elevator to floor 3 (stop 2), then the door.
  log(`cab ${JSON.stringify(cab())}`);
  log(`call floor 1: ${session.input.callElevator(SHAFT, 0)}`);
  await waitCab(0, 30_000);
  const enter = await walkTo(LANDING, Date.now() + 10_000);
  log(`in cab: ${enter} place=${world.placeOf(poseNow()!)?.id}`);
  log(`call floor 3: ${session.input.callElevator(SHAFT, 2)}`);
  const up = await waitCab(2, 60_000);
  log(`ride floor 3: ${up} cab=${JSON.stringify(cab())} place=${world.placeOf(poseNow()!)?.id} y=${poseNow()?.y.toFixed(2)}`);
  const out = await walkTo({ x: -36.40, z: -29.00 }, Date.now() + 15_000);
  log(`step out: ${out} place=${world.placeOf(poseNow()!)?.id} y=${poseNow()?.y.toFixed(2)}`);
  const toDoor = await walkTo(TARGET, Date.now() + 30_000);
  const end = poseNow();
  log(`door walk: ${toDoor} self=${end?.x.toFixed(2)},${end?.y.toFixed(2)},${end?.z.toFixed(2)} place=${world.placeOf(end!)?.id}`);
  for (let i = 0; i < 4; i += 1) {
    const p = poseNow();
    if (p) session.input.sendInput(wishTo(p, FACE, 0));
    await sleep(STEP_MS);
  }
  log(`ARRIVED self=${poseNow()?.x.toFixed(2)},${poseNow()?.y.toFixed(2)},${poseNow()?.z.toFixed(2)} place=${world.placeOf(poseNow()!)?.id}`);
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
