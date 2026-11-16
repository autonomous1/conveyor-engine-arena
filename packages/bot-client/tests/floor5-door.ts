// Scratch: by hand to the floor-5 door. Hall -> around the shaft -> elevator room ->
// call stop 4 -> step out -> walk to the door.
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
const CREW = { x: -33.564772, z: 26.86411 };
const DOOR_STAND = { x: -36.55, z: 22.60 };
const FACE = { x: -37.603705, z: 23.132173 };
const ELEV_DOOR = "brutalist-building-1-cbake.elevator-1-1.door-1-1-9-22";
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
  log(`seated ${self0.x.toFixed(2)},${self0.y.toFixed(2)},${self0.z.toFixed(2)} place=${world.placeOf(self0)?.id}`);

  // 1. Across the plaza to the open hall door, in, north of the shaft, to its west door.
  if (!(await walkVia([{ x: -21.50, z: 27.10 }, { x: -24.90, z: 27.16 }, { x: -30.00, z: 28.80 }, { x: -35.30, z: 28.80 }, { x: -35.30, z: 26.60 }], "approach"))) throw new Error("approach");
  log(`elev door open=${world.door(ELEV_DOOR)?.open}`);
  if (world.door(ELEV_DOOR)?.open === false) await tryOpen(ELEV_DOOR);
  if (!(await walkVia([{ x: CREW.x, z: CREW.z }], "cab"))) throw new Error("cab");

  // 2. Ride to floor 5.
  log(`cab ${JSON.stringify(cab())}`);
  log(`call floor 1: ${session.input.callElevator(SHAFT, 0)}`);
  await waitCab(0, 30_000);
  log(`call floor 5: ${session.input.callElevator(SHAFT, 4)}`);
  const up = await waitCab(4, 60_000);
  log(`ride 5: ${up} cab=${JSON.stringify(cab())} place=${world.placeOf(poseNow()!)?.id} y=${poseNow()?.y.toFixed(2)}`);

  // 3. Out and along the floor-5 hall to the door.
  log(`step out: ${await walkTo({ x: -35.40, z: 26.60 }, Date.now() + 15_000)} place=${world.placeOf(poseNow()!)?.id} y=${poseNow()?.y.toFixed(2)}`);
  const toDoor = await walkTo(DOOR_STAND, Date.now() + 30_000);
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
    log(`HOLD t=${secs()}s self=${p?.x.toFixed(2)},${p?.y.toFixed(2)},${p?.z.toFixed(2)} place=${p ? world.placeOf(p)?.id : "?"} cab=${JSON.stringify(cab())}`);
    await sleep(5000);
  }
} catch (err) {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  session.close();
  process.exit(3);
}
