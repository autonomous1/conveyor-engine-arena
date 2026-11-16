// Scratch: seat both bots, walk them to the pads, then WAIT for a go signal
// (file plan/dsh-tasks/live/race-go) before starting the two-claim door race.
// Run: CE_TOKEN=<jwt> node --import ./scripts/ts-ext-register.mjs plan/dsh-tasks/live/race-ready.ts
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { connectBot, type BotSession } from "../../../packages/bot-client/src/connection.ts";
import { openNodeSocket } from "../../../packages/bot-client/src/node-socket.ts";
import { runMission } from "../../../packages/bot-client/src/brain.ts";
import { parseMission } from "../../../packages/bot-client/src/missions.ts";

const URL_ = "wss://arena.tszakacs.com";
const TIMEOUT_MS = 90_000;
const GO_FILE = "plan/dsh-tasks/live/race-go";
const PADS: Record<string, string> = { "bot-1": "stand:-3.243,0,2.307", "bot-2": "stand:3.958,0,2.238" };
const MISSIONS: Record<string, string> = {
  "bot-1": "stand:-38.250,0,-41.100",
  "bot-2": "stand:-35.250,0,-41.100",
};
const token = (process.env.CE_TOKEN ?? "").trim() || readFileSync("/home/tim/.config/ce-arena/qa-token.pem", "utf8").trim();
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const dir = `plan/dsh-tasks/logs/37-ready-${stamp}`;
mkdirSync(dir, { recursive: true });
if (existsSync(GO_FILE)) unlinkSync(GO_FILE);
const log = (line: string) => console.log(line);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const run = (session: BotSession, text: string, tag: string, t0: number) => {
  const mission = parseMission(text);
  if (!mission) throw new Error(`bad mission ${text}`);
  return runMission(session, mission, {
    timeoutMs: TIMEOUT_MS,
    log: (line) => {
      if (/plan done|finish|replan|claim|start standAt/.test(line)) log(`  ${tag} ${Date.now() - t0}ms ${line}`);
    },
    error: (line) => log(`  ${tag} ERROR ${line}`),
  });
};

const bots: Array<{ name: string; session: BotSession }> = [];
try {
  for (const name of ["bot-1", "bot-2"]) {
    const session = await connectBot({ url: URL_, token, name, role: "qa", openSocket: openNodeSocket, onLog: (line) => log(`[${name}] ${line}`) });
    const started = Date.now();
    while (!session.world.self() && Date.now() - started < 10_000) await sleep(20);
    const self = session.world.self();
    log(`${name} welcomed self=${self?.x.toFixed(2)},${self?.y.toFixed(2)},${self?.z.toFixed(2)} place=${self ? session.world.placeOf(self)?.id : "?"}`);
    bots.push({ name, session });
  }

  const t0 = Date.now();
  log("walking both to the pads...");
  const back = await Promise.all(bots.map((bot) => run(bot.session, PADS[bot.name]!, `${bot.name} pad`, t0)));
  for (let i = 0; i < bots.length; i += 1) {
    const p = bots[i]!.session.world.self();
    log(`${bots[i]!.name} pad code=${back[i]} self=${p?.x.toFixed(2)},${p?.z.toFixed(2)}`);
  }
  log(`READY: both bots on the pads. Waiting for go (touch ${GO_FILE}).`);
  while (!existsSync(GO_FILE)) await sleep(200);
  unlinkSync(GO_FILE);
  log(`GO received at ${new Date().toISOString()}`);

  const T = Date.now() + 3000;
  let sampling = true;
  const samples: Record<string, string[]> = { "bot-1": [], "bot-2": [] };
  const sampler = (async () => {
    while (sampling) {
      const t = Date.now() - T;
      for (const bot of bots) {
        const p = bot.session.world.self();
        if (p) samples[bot.name]!.push(JSON.stringify({ t, x: p.x, y: p.y, z: p.z, yaw: p.yaw }));
      }
      await sleep(100);
    }
  })();
  await sleep(Math.max(0, T - Date.now()));
  log(`START t=0 bot-1=${MISSIONS["bot-1"]} bot-2=${MISSIONS["bot-2"]}`);
  const tRace = Date.now();
  const codes = await Promise.all(bots.map((bot) => run(bot.session, MISSIONS[bot.name]!, bot.name, tRace)));
  sampling = false;
  await sampler;
  log(`race done codes=${codes.join(",")} t=${Date.now() - tRace}ms`);
  for (const name of ["bot-1", "bot-2"]) writeFileSync(`${dir}/${name}.jsonl`, samples[name]!.join("\n") + "\n");
  const summary = { missions: MISSIONS, codes, bots: {} as Record<string, unknown>, separation: null as unknown };
  const parsed = Object.fromEntries(Object.entries(samples).map(([k, v]) => [k, v.map((s) => JSON.parse(s))]));
  for (const name of ["bot-1", "bot-2"]) {
    const rows = parsed[name] as Array<{ x: number; z: number }>;
    let travelled = 0;
    for (let j = 1; j < rows.length; j += 1) {
      const d = Math.hypot(rows[j]!.x - rows[j - 1]!.x, rows[j]!.z - rows[j - 1]!.z);
      if (d < 2) travelled += d;
    }
    (summary.bots as Record<string, unknown>)[name] = {
      code: codes[name === "bot-1" ? 0 : 1],
      travelledM: Number(travelled.toFixed(2)),
      end: rows[rows.length - 1] ? { x: Number(rows[rows.length - 1]!.x.toFixed(2)), z: Number(rows[rows.length - 1]!.z.toFixed(2)) } : null,
    };
  }
  const n = Math.min((parsed["bot-1"] as unknown[]).length, (parsed["bot-2"] as unknown[]).length);
  let sum = 0;
  for (let j = 0; j < n; j += 1) {
    const a = (parsed["bot-1"] as Array<{ x: number; z: number }>)[j]!;
    const b = (parsed["bot-2"] as Array<{ x: number; z: number }>)[j]!;
    sum += Math.hypot(a.x - b.x, a.z - b.z);
  }
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
