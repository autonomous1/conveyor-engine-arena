// Scratch: straight waypoint walk (no grid), used when the grid's floor model
// refuses a cell the host can walk (e.g. under a 6 m balcony).
// Run: node --import ./scripts/ts-ext-register.mjs packages/bot-client/tests/walk-via.ts \
//   --via "x,z;x,z" --final "x,y,z" [--face "x,z"] [--timeout-s 120]
import { readFileSync } from "node:fs";
import { connectBot } from "../../../packages/bot-client/src/connection.ts";
import { openNodeSocket } from "../../../packages/bot-client/src/node-socket.ts";
import { INPUT_HZ } from "../../../src/shared/look.ts";
import { wishTo, type Pose } from "../../../src/shared/nav/follow.ts";

const STEP_MS = 1000 / INPUT_HZ;
const args = new Map<string, string>();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i]!;
  if (arg.startsWith("--")) args.set(arg.slice(2), argv[i + 1] ?? "");
}
const parseXZ = (text: string) => text.split(";").filter(Boolean).map((part) => {
  const [x, z] = part.split(",").map(Number);
  return { x: x!, z: z! };
});
const via = args.get("via") ? parseXZ(args.get("via")!) : [];
const final = args.get("final") ? parseXZ(args.get("final")!)[0] : undefined;
if (via.length === 0 && !final) {
  console.error("usage: walk-via.ts --via 'x,z;...' [--final 'x,y,z'] [--face 'x,z']");
  process.exit(1);
}
const face = args.get("face") ? parseXZ(args.get("face")!)[0] : undefined;
const timeoutMs = Number(args.get("timeout-s") ?? 120) * 1000;

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
  const self = world.self();
  return self ? { x: self.x, y: self.y, z: self.z, vx: 0, vz: 0, yaw: self.yaw } : undefined;
};

try {
  const self0 = await until(() => world.self(), 8000, "no owned pawn");
  await until(() => world.sceneGraph(), 8000, "no scene graph");
  log(`seated self=${self0.x.toFixed(2)} ${self0.z.toFixed(2)} place=${world.placeOf(self0)?.id}`);
  const points = [...via, ...(final ? [final] : [])];
  let wp = 0;
  let lastDist = Infinity;
  let lastProgress = Date.now();
  let lastLog = 0;
  while (Date.now() - t0 < timeoutMs && wp < points.length) {
    const p = poseNow();
    if (!p) {
      await sleep(STEP_MS);
      continue;
    }
    const target = points[wp]!;
    const dist = Math.hypot(p.x - target.x, p.z - target.z);
    if (dist <= 0.45) {
      log(`waypoint ${wp} reached at ${p.x.toFixed(2)},${p.z.toFixed(2)}`);
      wp += 1;
      lastDist = Infinity;
      lastProgress = Date.now();
      continue;
    }
    if (dist < lastDist - 0.2) {
      lastDist = dist;
      lastProgress = Date.now();
    }
    if (Date.now() - lastProgress > 2500) {
      log(`STUCK on waypoint ${wp} at ${p.x.toFixed(2)},${p.z.toFixed(2)} dist=${dist.toFixed(2)}`);
      session.close();
      process.exit(3);
    }
    session.input.sendInput(wishTo(p, target, dist < 1.2 ? 0.4 : 1));
    if (Date.now() - lastLog >= 500) {
      lastLog = Date.now();
      log(`t=${secs()}s self=${p.x.toFixed(2)} ${p.y.toFixed(2)} ${p.z.toFixed(2)} place=${world.placeOf(p)?.id} wp=${wp} d=${dist.toFixed(2)}`);
    }
    await sleep(STEP_MS);
  }
  if (wp < points.length) {
    log("NOT ARRIVED");
    session.close();
    process.exit(3);
  }
  if (face) {
    for (let i = 0; i < 4; i += 1) {
      const p = poseNow();
      if (p) session.input.sendInput(wishTo(p, face, 0));
      await sleep(STEP_MS);
    }
  }
  const end = poseNow();
  log(`ARRIVED self=${end?.x.toFixed(2)} ${end?.y.toFixed(2)} ${end?.z.toFixed(2)} place=${end ? world.placeOf(end)?.id : "?"} distToFinal=${end && final ? Math.hypot(end.x - final.x, end.z - final.z).toFixed(2) : "?"}`);
  for (;;) {
    const p = poseNow();
    log(`HOLD t=${secs()}s self=${p?.x.toFixed(2)} ${p?.y.toFixed(2)} ${p?.z.toFixed(2)} place=${p ? world.placeOf(p)?.id : "?"}`);
    await sleep(5000);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  session.close();
  process.exit(3);
}
