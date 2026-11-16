// Scratch: ride down from floor 5 to floor 1, out of the hall, across the plaza to
// the spawn area.
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
const poseNow = (): Pose | undefined => {
  const s = world.self();
  return s ? { x: s.x, y: s.y, z: s.z, vx: 0, vz: 0, yaw: s.yaw } : undefined;
};
const SHAFT = "brutalist-building-1-cbake.e1";
const CAB = { x: -33.564772, z: 26.86411 };
const OUT = { x: -35.40, z: 26.60 };
const ELEV_DOOR = "brutalist-building-1-cbake.elevator-1-1.door-1-1-9-22";
const SPAWN = { x: -2.40, z: 3.00 };
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
    const result = await walkTo(point, Date.now() + 45_000);
    const p = poseNow();
    log(`${label} ${point.x.toFixed(2)},${point.z.toFixed(2)}: ${result} at ${p?.x.toFixed(2)},${p?.y.toFixed(2)},${p?.z.toFixed(2)} place=${p ? world.placeOf(p)?.id : "?"}`);
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
  const started = Date.now();
  while (!world.self() && Date.now() - started < 8000) await sleep(40);
  while (!world.sceneGraph() && Date.now() - started < 8000) await sleep(40);
  const self0 = world.self()!;
  log(`seated ${self0.x.toFixed(2)},${self0.y.toFixed(2)},${self0.z.toFixed(2)} place=${world.placeOf(self0)?.id} cab=${JSON.stringify(cab())}`);

  // 1. Back into the cab at floor 5.
  if (world.placeOf(poseNow()!)?.id !== SHAFT) {
    if (!(await walkVia([{ x: OUT.x, z: OUT.z }, { x: CAB.x, z: CAB.z }], "back-in"))) throw new Error("back-in");
  }
  log(`in cab place=${world.placeOf(poseNow()!)?.id} y=${poseNow()?.y.toFixed(2)}`);
  // 2. Ride down to floor 1.
  log(`call floor 1: ${session.input.callElevator(SHAFT, 0)}`);
  const down = await waitCab(0, 60_000);
  log(`ride 1: ${down} cab=${JSON.stringify(cab())} place=${world.placeOf(poseNow()!)?.id} y=${poseNow()?.y.toFixed(2)}`);
  // 3. Out of the room, the hall, the plaza, to the spawn.
  log(`step out: ${await walkTo(OUT, Date.now() + 15_000)} place=${world.placeOf(poseNow()!)?.id}`);
  if (!(await walkVia([{ x: -24.90, z: 27.16 }, { x: -21.50, z: 27.10 }, { x: -15.00, z: 21.00 }, { x: SPAWN.x, z: SPAWN.z }], "plaza"))) throw new Error("plaza");
  const end = poseNow();
  log(`ARRIVED self=${end?.x.toFixed(2)},${end?.y.toFixed(2)},${end?.z.toFixed(2)} place=${world.placeOf(end!)?.id}`);
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
