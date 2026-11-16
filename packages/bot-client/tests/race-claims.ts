// Scratch: two-pawn race with distinct claim keys (two stand points beside the door).
// Join, return both to spawn pads, wait 10 s, then start both at the same instant.
// Run: CE_TOKEN=<jwt> node --import ./scripts/ts-ext-register.mjs packages/bot-client/tests/race-claims.ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { connectBot, type BotSession } from "../../../packages/bot-client/src/connection.ts";
import { openNodeSocket } from "../../../packages/bot-client/src/node-socket.ts";
import { runMission } from "../../../packages/bot-client/src/brain.ts";
import { parseMission } from "../../../packages/bot-client/src/missions.ts";
import { INPUT_HZ } from "../../../src/shared/look.ts";
import { wishTo } from "../../../src/shared/nav/follow.ts";

const URL_ = "wss://arena.tszakacs.com";
const STEP_MS = 1000 / INPUT_HZ;
const TIMEOUT_MS = 90_000;
const WAIT_MS = 10_000;
// Door stand is (-36.75, 0, -41.15); two distinct claims at +/-1.5 in x.
const MISSIONS: Record<string, string> = {
  "bot-1": "stand:-38.250,0,-41.100",
  "bot-2": "stand:-35.250,0,-41.100",
};
const PADS = [{ x: -3.243, z: 2.307 }, { x: 3.958, z: 2.238 }];
const token = (process.env.CE_TOKEN ?? "").trim() || readFileSync("/home/tim/.config/ce-arena/qa-token.pem", "utf8").trim();
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const dir = `plan/dsh-tasks/logs/37-claims-${stamp}`;
mkdirSync(dir, { recursive: true });
const log = (line: string) => console.log(line);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Bot = { name: string; session: BotSession; samples: string[]; logs: string[] };
const bots: Bot[] = [];

const walkTo = async (session: BotSession, target: { x: number; z: number }, ms = 20_000): Promise<string> => {
  const deadline = Date.now() + ms;
  let last = Infinity;
  while (Date.now() < deadline) {
    const s = session.world.self();
    if (!s) return "no-pawn";
    const d = Math.hypot(s.x - target.x, s.z - target.z);
    if (d <= 0.5) {
      session.input.sendInput({ moveX: 0, moveZ: 0, yaw: s.yaw });
      await sleep(STEP_MS);
      return "arrived";
    }
    if (d < last - 0.2) last = d;
    session.input.sendInput(wishTo({ x: s.x, y: s.y, z: s.z, vx: 0, vz: 0, yaw: s.yaw }, target, d < 1.5 ? 0.4 : 1));
    await sleep(STEP_MS);
  }
  return "timeout";
};

try {
  for (const name of ["bot-1", "bot-2"]) {
    const session = await connectBot({ url: URL_, token, name, role: "qa", openSocket: openNodeSocket, onLog: (line) => log(`[${name}] ${line}`) });
    const started = Date.now();
    while (!session.world.self() && Date.now() - started < 10_000) await sleep(20);
    const self = session.world.self();
    log(`${name} welcomed self=${self?.x.toFixed(2)},${self?.y.toFixed(2)},${self?.z.toFixed(2)} place=${self ? session.world.placeOf(self)?.id : "?"}`);
    bots.push({ name, session, samples: [], logs: [] });
  }
  // Return each to a pad if it is not already on one.
  for (let i = 0; i < bots.length; i += 1) {
    const bot = bots[i]!;
    const self = bot.session.world.self()!;
    const onPad = PADS.some((p) => Math.hypot(self.x - p.x, self.z - p.z) < 1.0);
    if (onPad) {
      log(`${bot.name} already on a pad (${self.x.toFixed(2)},${self.z.toFixed(2)})`);
      continue;
    }
    const pad = PADS[i % PADS.length]!;
    const walked = await walkTo(bot.session, pad);
    const p = bot.session.world.self()!;
    log(`${bot.name} return to pad ${pad.x},${pad.z}: ${walked} at ${p.x.toFixed(2)},${p.z.toFixed(2)}`);
  }
  await sleep(1000);
  const T = Date.now() + WAIT_MS;
  log(`both at pads; T=${T} in ${(T - Date.now()) / 1000}s`);

  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      const t = Date.now() - T;
      for (const bot of bots) {
        const w = bot.session.world;
        const p = w.self();
        if (!p) continue;
        bot.samples.push(JSON.stringify({ t, x: p.x, y: p.y, z: p.z, yaw: p.yaw, place: w.placeOf(p)?.id ?? "?" }));
      }
      await sleep(100);
    }
  })();

  await sleep(Math.max(0, T - Date.now()));
  log(`START t=0 mission bot-1=${MISSIONS["bot-1"]} bot-2=${MISSIONS["bot-2"]}`);
  const codes = await Promise.all(bots.map((bot) => {
    const mission = parseMission(MISSIONS[bot.name]!);
    if (!mission) throw new Error(`bad mission for ${bot.name}`);
    return runMission(bot.session, mission, {
      timeoutMs: TIMEOUT_MS,
      log: (line) => {
        const row = `${Date.now() - T}\t${bot.name}\tbrain\t${line}`;
        bot.logs.push(row);
        if (/plan done|start standAt|finish standAt|replan|claim/.test(line)) log(`  ${bot.name} ${line}`);
      },
      error: (line) => {
        bot.logs.push(`${Date.now() - T}\t${bot.name}\terror\t${line}`);
      },
    });
  }));
  sampling = false;
  await sampler;
  log(`missions done codes=${codes.join(",")} t=${Date.now() - T}ms`);

  for (const bot of bots) {
    writeFileSync(`${dir}/${bot.name}.jsonl`, bot.logs.concat(bot.samples.map((s) => `sample\t${s}`)).join("\n") + "\n");
  }
  const parsed = bots.map((bot) => bot.samples.map((line) => JSON.parse(line) as { t: number; x: number; z: number; place: string }));
  const summary: Record<string, unknown> = { url: URL_, missions: MISSIONS, codes, bots: [] as unknown[] };
  for (let i = 0; i < bots.length; i += 1) {
    const rows = parsed[i]!;
    let travelled = 0;
    for (let j = 1; j < rows.length; j += 1) {
      const d = Math.hypot(rows[j]!.x - rows[j - 1]!.x, rows[j]!.z - rows[j - 1]!.z);
      if (d < 2) travelled += d;
    }
    const brains = bots[i]!.logs;
    summary.bots.push({
      name: bots[i]!.name,
      code: codes[i],
      travelledM: Number(travelled.toFixed(2)),
      start: rows[0] ? { x: Number(rows[0].x.toFixed(2)), z: Number(rows[0].z.toFixed(2)) } : null,
      end: rows[rows.length - 1] ? { x: Number(rows[rows.length - 1]!.x.toFixed(2)), z: Number(rows[rows.length - 1]!.z.toFixed(2)) } : null,
      claimWait: brains.filter((l) => l.includes("claim wait")).length,
      finishStand: brains.filter((l) => l.includes("finish standAt")).map((l) => l.split("\t")[0]),
      stuckReplans: brains.filter((l) => l.includes("replan stuck")).length,
    });
  }
  const n = Math.min(parsed[0]?.length ?? 0, parsed[1]?.length ?? 0);
  let sum = 0;
  for (let j = 0; j < n; j += 1) sum += Math.hypot(parsed[0]![j]!.x - parsed[1]![j]!.x, parsed[0]![j]!.z - parsed[1]![j]!.z);
  summary.separation = n > 0 ? { n, mean: Number((sum / n).toFixed(2)) } : null;
  writeFileSync(`${dir}/summary.json`, JSON.stringify(summary, null, 2) + "\n");
  log("SUMMARY " + JSON.stringify(summary, null, 2));
} catch (err) {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
} finally {
  for (const bot of bots) bot.session.close();
  await sleep(400);
  log("EXITED");
}
