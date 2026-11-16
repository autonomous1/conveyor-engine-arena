// Scratch: join the remote arena, walk 10 m forward, exit.
// Run: node --import ./scripts/ts-ext-register.mjs plan/dsh-tasks/live/visit-remote.ts
import { readFileSync } from "node:fs";
import { connectBot } from "../../../packages/bot-client/src/connection.ts";
import { openNodeSocket } from "../../../packages/bot-client/src/node-socket.ts";
import { INPUT_HZ } from "../../../src/shared/look.ts";
import { wishTo, type Pose } from "../../../src/shared/nav/follow.ts";

const STEP_MS = 1000 / INPUT_HZ;
const URL_ = "wss://arena.tszakacs.com";
const token = (process.env.CE_TOKEN ?? "").trim() || readFileSync("/home/tim/.config/ce-arena/qa-token.pem", "utf8").trim();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const t0 = Date.now();
const secs = () => ((Date.now() - t0) / 1000).toFixed(2);
const log = (line: string) => console.log(line);

const session = await connectBot({
  url: URL_,
  token,
  name: "dev-1",
  role: "qa",
  openSocket: openNodeSocket,
  onLog: (line) => console.error(`[conn] ${line}`),
});
const world = session.world;
try {
  const started = Date.now();
  while (!world.self() && Date.now() - started < 8000) await sleep(40);
  while (!world.sceneGraph() && Date.now() - started < 8000) await sleep(40);
  const self = world.self();
  if (!self) throw new Error("no owned pawn");
  log(`joined ${URL_} t=${secs()}s`);
  log(`role=${world.role() ?? "none"} scope=${world.scope()?.join(",") ?? "none"}`);
  log(`graph places=${world.sceneGraph()?.places.length ?? 0} hash=${(world.sceneGraphHash() ?? "none").slice(0, 12)}`);
  log(`start self=${self.x.toFixed(2)},${self.y.toFixed(2)},${self.z.toFixed(2)} yaw=${self.yaw.toFixed(2)} place=${world.placeOf(self)?.id ?? "?"} health=${world.health()?.hp ?? "?"}`);
  log(`others=${world.others().length}`);

  // Forward = the way the pawn faces (yaw 0 is +Z).
  const fx = Math.sin(self.yaw);
  const fz = Math.cos(self.yaw);
  const target = { x: self.x + fx * 10, z: self.z + fz * 10 };
  log(`forward ${fx.toFixed(2)},${fz.toFixed(2)} target=${target.x.toFixed(2)},${target.z.toFixed(2)}`);

  const deadline = Date.now() + 20_000;
  let last = 0;
  while (Date.now() < deadline) {
    const p: Pose | undefined = (() => {
      const s = world.self();
      return s ? { x: s.x, y: s.y, z: s.z, vx: 0, vz: 0, yaw: s.yaw } : undefined;
    })();
    if (!p) {
      await sleep(STEP_MS);
      continue;
    }
    const d = Math.hypot(p.x - target.x, p.z - target.z);
    if (d <= 0.6) break;
    session.input.sendInput(wishTo(p, target, d < 1.5 ? 0.5 : 1));
    if (Date.now() - last >= 500) {
      last = Date.now();
      log(`  t=${secs()}s self=${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)} d=${d.toFixed(2)}`);
    }
    await sleep(STEP_MS);
  }
  await sleep(300);
  const end = world.self();
  const moved = end ? Math.hypot(end.x - self.x, end.z - self.z) : 0;
  log(`end self=${end?.x.toFixed(2)},${end?.y.toFixed(2)},${end?.z.toFixed(2)} place=${end ? world.placeOf(end)?.id : "?"} moved=${moved.toFixed(2)}m`);
} catch (err) {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
} finally {
  session.close();
  await sleep(300);
  log(`EXITED t=${secs()}s`);
}
