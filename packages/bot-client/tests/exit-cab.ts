// Scratch: in the cab at floor 3 with the doors shut. Re-call floor 3 to open them,
// then step out south and walk to the door.
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
const SHAFT = "brutalist-building-1-cbake-0.e1";
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

try {
  const self0 = await untilSelf();
  await untilGraph();
  log(`seated ${self0.x.toFixed(2)},${self0.y.toFixed(2)},${self0.z.toFixed(2)} place=${world.placeOf(self0)?.id} cab=${JSON.stringify(cab())}`);

  // Open the doors by re-calling the current floor.
  for (let i = 0; i < 3; i += 1) {
    const c = cab();
    if (!c) break;
    log(`call floor ${c.at}: ${session.input.callElevator(SHAFT, c.at)}`);
    const started = Date.now();
    while (Date.now() - started < 8000) {
      const now = cab();
      if (now && now.at === c.at && now.phase === "idle") break;
      await sleep(100);
    }
    const out = await walkTo({ x: -34.20, z: -30.80 }, Date.now() + 6000);
    const p = poseNow();
    log(`step out: ${out} at ${p?.x.toFixed(2)},${p?.y.toFixed(2)},${p?.z.toFixed(2)} place=${p ? world.placeOf(p)?.id : "?"}`);
    if (out === "arrived") break;
  }
  const toDoor = await walkTo(TARGET, Date.now() + 20000);
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

async function untilSelf() {
  const started = Date.now();
  for (;;) {
    const s = world.self();
    if (s) return s;
    if (Date.now() - started > 8000) throw new Error("no owned pawn");
    await sleep(40);
  }
}
async function untilGraph() {
  const started = Date.now();
  for (;;) {
    if (world.sceneGraph()) return;
    if (Date.now() - started > 8000) throw new Error("no scene graph");
    await sleep(40);
  }
}
