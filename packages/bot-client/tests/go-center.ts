// Scratch: walk back to the arena centre from wherever the pawn is, then hold.
import { connectBot } from "../../../packages/bot-client/src/connection.ts";
import { openNodeSocket } from "../../../packages/bot-client/src/node-socket.ts";
import { wishTo } from "../../../src/shared/nav/follow.ts";
const token = (process.env.CE_TOKEN ?? "").trim();
const CENTER = { x: -2.40, z: 3.00 };
const session = await connectBot({ url: "ws://localhost:4173", token, name: "dev-1", role: "qa", openSocket: openNodeSocket, onLog: (l) => console.error(l) });
const world = session.world;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const t0 = Date.now();
const secs = () => ((Date.now() - t0) / 1000).toFixed(2);
const log = (line: string) => console.log(`t=${secs()}s ${line}`);
const started = Date.now();
while (!world.self() && Date.now() - started < 8000) await sleep(50);
while (!world.sceneGraph() && Date.now() - started < 8000) await sleep(50);
const self = world.self()!;
log(`seated ${self.x.toFixed(2)},${self.y.toFixed(2)},${self.z.toFixed(2)} place=${world.placeOf(self)?.id}`);
const deadline = Date.now() + 90_000;
let last = Infinity;
let lastProgress = Date.now();
let lastLog = 0;
while (Date.now() < deadline) {
  const me = world.self();
  if (!me) { await sleep(50); continue; }
  const d = Math.hypot(me.x - CENTER.x, me.z - CENTER.z);
  if (d <= 0.6) {
    session.input.sendInput({ moveX: 0, moveZ: 0, yaw: me.yaw });
    await sleep(150);
    log(`ARRIVED at ${me.x.toFixed(2)},${me.y.toFixed(2)},${me.z.toFixed(2)} place=${world.placeOf(me)?.id}`);
    break;
  }
  if (d < last - 0.2) { last = d; lastProgress = Date.now(); }
  if (Date.now() - lastProgress > 3000) {
    log(`STUCK at ${me.x.toFixed(2)},${me.y.toFixed(2)},${me.z.toFixed(2)} d=${d.toFixed(2)}`);
    break;
  }
  session.input.sendInput(wishTo({ x: me.x, y: me.y, z: me.z, vx: 0, vz: 0, yaw: me.yaw }, CENTER, 1));
  if (Date.now() - lastLog >= 1000) {
    lastLog = Date.now();
    log(`walking ${me.x.toFixed(2)},${me.y.toFixed(2)},${me.z.toFixed(2)} d=${d.toFixed(2)}`);
  }
  await sleep(50);
}
for (;;) {
  const me = world.self();
  log(`HOLD ${me?.x.toFixed(2)},${me?.y.toFixed(2)},${me?.z.toFixed(2)} place=${me ? world.placeOf(me)?.id : "?"} weapon=${world.weapon() ?? "none"} ammo=${world.ammo()}`);
  await sleep(5000);
}
