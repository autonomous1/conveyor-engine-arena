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
async function walkTo(target: { x: number; z: number }, deadline: number): Promise<string> {
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
const TARGET = { x: -30.343295, z: -31.990141 };
const FACE = { x: -30.879795, z: -33.038141 };
const started0 = Date.now();
while (!world.self() && Date.now() - started0 < 8000) await sleep(40);
while (!world.sceneGraph() && Date.now() - started0 < 8000) await sleep(40);
const self0 = world.self()!;
log(`seated ${self0.x.toFixed(2)},${self0.y.toFixed(2)},${self0.z.toFixed(2)} place=${world.placeOf(self0)?.id}`);
for (let i = 0; i < 10; i += 1) {
  session.input.use();
  await sleep(200);
}
log(`used 10x; place=${world.placeOf(poseNow()!)?.["id"]}`);
const south = await walkTo({ x: -34.20, z: -30.90 }, Date.now() + 12000);
const p = poseNow();
log(`south: ${south} at ${p?.x.toFixed(2)},${p?.y.toFixed(2)},${p?.z.toFixed(2)} place=${p ? world.placeOf(p)?.id : "?"}`);
if (south === "arrived") {
  const toDoor = await walkTo(TARGET, Date.now() + 20000);
  const end = poseNow();
  log(`door: ${toDoor} at ${end?.x.toFixed(2)},${end?.y.toFixed(2)},${end?.z.toFixed(2)} place=${world.placeOf(end!)?.id}`);
  for (let i = 0; i < 4; i += 1) {
    const q = poseNow();
    if (q) session.input.sendInput(wishTo(q, FACE, 0));
    await sleep(STEP_MS);
  }
}
for (;;) {
  const q = poseNow();
  log(`HOLD t=${secs()}s self=${q?.x.toFixed(2)},${q?.y.toFixed(2)},${q?.z.toFixed(2)} place=${q ? world.placeOf(q)?.id : "?"} cab=${JSON.stringify(world.cabs().find((c) => c.id === "brutalist-building-1-cbake-0.e1"))}`);
  await sleep(5000);
}
