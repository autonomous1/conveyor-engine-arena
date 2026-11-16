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
const cab = () => world.cabs().find((c) => c.id === SHAFT);
const started = Date.now();
while (!world.self() && Date.now() - started < 8000) await sleep(40);
while (!world.sceneGraph() && Date.now() - started < 8000) await sleep(40);
const p = poseNow();
log(`seated ${p?.x.toFixed(2)},${p?.y.toFixed(2)},${p?.z.toFixed(2)} place=${world.placeOf(p!)?.id} cab=${JSON.stringify(cab())}`);
log(`call floor 1: ${session.input.callElevator(SHAFT, 0)}`);
const waitStart = Date.now();
while (Date.now() - waitStart < 60_000) {
  const c = cab();
  if (c && c.at === 0 && c.phase === "idle") break;
  if (Date.now() - waitStart > 0 && Math.round((Date.now() - waitStart) / 1000) !== Math.round((Date.now() - waitStart - 250) / 1000)) {
    log(`  cab ${JSON.stringify(cab())} t=${secs()}s`);
  }
  await sleep(250);
}
const end = poseNow();
log(`parked cab=${JSON.stringify(cab())} self=${end?.x.toFixed(2)},${end?.y.toFixed(2)},${end?.z.toFixed(2)} place=${world.placeOf(end!)?.id}`);
for (;;) {
  const q = poseNow();
  log(`HOLD t=${secs()}s self=${q?.x.toFixed(2)},${q?.y.toFixed(2)},${q?.z.toFixed(2)} place=${q ? world.placeOf(q)?.id : "?"} cab=${JSON.stringify(cab())}`);
  await sleep(5000);
}
