// Scratch: the user's stuck test at door -1-1-9. From the door, walk 10 m in each of
// N/S/E/W and come back after each leg. A leg that stops making progress is reported
// with the exact pose, so a planner/trap issue shows up as data.
// Run: node --import ./scripts/ts-ext-register.mjs plan/dsh-tasks/live/stuck-test.ts \
//   [--leg 10] [--timeout-s 240]
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { BotRejected, connectBot } from "../../../packages/bot-client/src/connection.ts";
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
const legM = Number(args.get("leg") ?? 10);
const timeoutMs = Number(args.get("timeout-s") ?? 240) * 1000;
const forS = Number(args.get("for-s") ?? 0);
// N = -Z, S = +Z, E = +X, W = -X (yaw 0 faces +Z in this engine).
const DIRECTIONS: Array<{ name: string; dx: number; dz: number }> = [
  { name: "N", dx: 0, dz: -1 },
  { name: "S", dx: 0, dz: 1 },
  { name: "E", dx: 1, dz: 0 },
  { name: "W", dx: -1, dz: 0 },
];

const token = readFileSync("/home/tim/.config/ce-arena/qa-token.pem", "utf8").trim();
let session: Awaited<ReturnType<typeof connectBot>> | undefined;
for (let attempt = 0; attempt < 30; attempt += 1) {
  try {
    session = await connectBot({ url: "ws://127.0.0.1:4173", token, name: "dev-1", role: "qa", openSocket: openNodeSocket, onLog: (l) => console.error(l) });
    break;
  } catch (err) {
    if (err instanceof BotRejected && err.code === "SERVER_FULL") {
      console.log(`no free seat (attempt ${attempt + 1}/30); retrying in 5 s`);
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    throw err;
  }
}
if (!session) {
  console.error("no free seat after 150 s; giving up");
  process.exit(2);
}
const world = session.world;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const t0 = Date.now();
const secs = () => ((Date.now() - t0) / 1000).toFixed(2);
const log = (line: string) => console.log(line);
const dir = "plan/dsh-tasks/live/captures";
mkdirSync(dir, { recursive: true });
const capture = `${dir}/stuck-test-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`;
appendFileSync(capture, JSON.stringify({ event: "start", legM, dirs: DIRECTIONS.map((d) => d.name) }) + "\n");
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

/** Straight walk with a progress guard. Reports where it stopped, not why. */
async function leg(label: string, target: { x: number; z: number }, deadline: number): Promise<{ reached: boolean; x: number; z: number; d: number; why: string; near: number; pushed: number }> {
  let lastCheck = Date.now();
  let lastDist = Infinity;
  let best = Infinity;
  let lastLog = 0;
  let near = 0;
  let pushed = 0;
  let lastX = 0;
  let lastZ = 0;
  for (;;) {
    const p = poseNow();
    if (!p) {
      await sleep(STEP_MS);
      continue;
    }
    const d = Math.hypot(p.x - target.x, p.z - target.z);
    if (d <= 0.6) return { reached: true, x: p.x, z: p.z, d, why: "reached", near, pushed };
    const close = world.others().some((o) => Math.hypot(o.x - p.x, o.z - p.z) < 1.3);
    if (close) near += 1;
    if (Math.hypot(p.x - lastX, p.z - lastZ) > 0.35) pushed += 1;
    lastX = p.x;
    lastZ = p.z;
    if (d < lastDist - 0.05) lastDist = d;
    if (d < best) best = d;
    if (Date.now() - lastCheck > 2500) {
      if (lastDist - d < 0.25) {
        log(`  ${label} BLOCKED at ${p.x.toFixed(2)},${p.z.toFixed(2)} d=${d.toFixed(2)} (best ${best.toFixed(2)})`);
        appendFileSync(capture, JSON.stringify({ t: Number(secs()), event: "blocked", label, x: p.x, z: p.z, d, best }) + "\n");
        return { reached: false, x: p.x, z: p.z, d, why: "blocked", near, pushed };
      }
      lastCheck = Date.now();
      lastDist = d;
    }
    if (Date.now() > deadline) return { reached: false, x: p.x, z: p.z, d, why: "deadline", near, pushed };
    session.input.sendInput(wishTo(p, target, d < 1.2 ? 0.4 : 1));
    if (Date.now() - lastLog >= 500) {
      lastLog = Date.now();
      log(`  t=${secs()}s ${label} self=${p.x.toFixed(2)} ${p.y.toFixed(2)} ${p.z.toFixed(2)} place=${world.placeOf(p)?.id ?? "?"} d=${d.toFixed(2)}`);
    }
    await sleep(STEP_MS);
  }
}

try {
  const self0 = await until(() => world.self(), 8000, "no owned pawn");
  await until(() => world.sceneGraph(), 8000, "no scene graph");
  const origin = { x: self0.x, z: self0.z };
  log(`origin ${origin.x.toFixed(2)},${origin.z.toFixed(2)} place=${world.placeOf(self0)?.id}`);
  const summary: Array<{ dir: string; out: string; back: string }> = [];
  const runUntil = forS > 0 ? Date.now() + forS * 1000 : t0 + timeoutMs;
  let cycle = 0;
  let blocked = 0;
  let collided = 0;
  while (Date.now() < runUntil) {
    cycle += 1;
    log(`=== cycle ${cycle} at t=${secs()}s`);
  for (const d of DIRECTIONS) {
    if (Date.now() >= runUntil) break;
    const target = { x: origin.x + d.dx * legM, z: origin.z + d.dz * legM };
    log(`--- ${d.name} to ${target.x.toFixed(2)},${target.z.toFixed(2)}`);
    const out = await leg(`${d.name} out`, target, t0 + timeoutMs);
    log(`${d.name} out: ${out.why} at ${out.x.toFixed(2)},${out.z.toFixed(2)} d=${out.d.toFixed(2)}`);
    const back = await leg(`${d.name} back`, origin, t0 + timeoutMs);
    log(`${d.name} back: ${back.why} at ${back.x.toFixed(2)},${back.z.toFixed(2)} d=${back.d.toFixed(2)}`);
    summary.push({ dir: d.name, out: `${out.why} (${out.d.toFixed(1)}m short)`, back: `${back.why} (${back.d.toFixed(1)}m short)` });
    if (out.why !== "reached") blocked += 1;
    if (out.near > 0 || back.near > 0) collided += 1;
    appendFileSync(capture, JSON.stringify({ t: Number(secs()), event: "leg", cycle, dir: d.name, out: out.why, back: back.why, outNear: out.near, backNear: back.near }) + "\n");
  }
  }
  log("SUMMARY");
  const tailRows = summary.slice(-8);
  for (const row of tailRows) log(`  ${row.dir}: out=${row.out} back=${row.back}`);
  log(`cycles=${cycle} legs=${summary.length} blockedOut=${blocked} legsWithPawnNear=${collided}`);
  appendFileSync(capture, JSON.stringify({ event: "summary", summary }) + "\n");
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
