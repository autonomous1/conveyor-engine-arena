// Scratch: the live two-pawn race. Two sessions (bot-1, bot-2) on the remote host,
// shared wall-clock start T = second welcome + 5 s, same retrieve mission, 90 s.
// Writes samples/logs under plan/dsh-tasks/logs/37-<stamp>/ and prints a summary.
// Run: CE_TOKEN=<jwt> node --import ./scripts/ts-ext-register.mjs plan/dsh-tasks/live/race-tworace.ts
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { BotRejected, connectBot, type BotSession } from "../../../packages/bot-client/src/connection.ts";
import { openNodeSocket } from "../../../packages/bot-client/src/node-socket.ts";
import { runMission } from "../../../packages/bot-client/src/brain.ts";
import { parseMission } from "../../../packages/bot-client/src/missions.ts";

const URL_ = "wss://arena.tszakacs.com";
const MISSION_TEXT = "stand:door:brutalist-building-1-cbake-0.door-1-1-9-22-0-7:in";
const TIMEOUT_MS = 90_000;
const START_DELAY_MS = 5_000;
const SAMPLE_MS = 100;
const token = (process.env.CE_TOKEN ?? "").trim() || readFileSync("/home/tim/.config/ce-arena/qa-token.pem", "utf8").trim();
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const dir = `plan/dsh-tasks/logs/37-${stamp}`;
mkdirSync(dir, { recursive: true });
const log = (line: string) => console.log(line);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Bot = { name: string; session: BotSession; welcomeAt: number; samples: string[]; logs: string[] };
const bots: Bot[] = [];

const mission = parseMission(MISSION_TEXT);
if (!mission) throw new Error("bad mission");

try {
  for (const name of ["bot-1", "bot-2"]) {
    const session = await connectBot({
      url: URL_,
      token,
      name,
      role: "qa",
      openSocket: openNodeSocket,
      onLog: (line) => log(`[${name}] ${line}`),
    });
    const started = Date.now();
    while (!session.world.self() && Date.now() - started < 10_000) await sleep(20);
    if (!session.world.self()) throw new Error(`${name} never got a pawn`);
    const welcomeAt = Date.now();
    const self = session.world.self()!;
    log(`${name} welcomed t=${welcomeAt} self=${self.x.toFixed(2)},${self.y.toFixed(2)},${self.z.toFixed(2)} place=${session.world.placeOf(self)?.id} others=${session.world.others().length}`);
    bots.push({ name, session, welcomeAt, samples: [], logs: [] });
  }
  const secondWelcome = Math.max(...bots.map((b) => b.welcomeAt));
  const T = secondWelcome + START_DELAY_MS;
  log(`both welcomed; second=${secondWelcome}; T=${T} (in ${(T - Date.now()) / 1000}s)`);

  // Sampler: both poses + doors + pickups at 10 Hz, from now until the missions end.
  let sampling = true;
  let pickupCount: number | undefined;
  const doorState = new Map<string, string>();
  const eventLines: string[] = [];
  const sampler = (async () => {
    while (sampling) {
      const t = Date.now() - T;
      for (const bot of bots) {
        const w = bot.session.world;
        const p = w.self();
        if (!p) continue;
        const place = w.placeOf(p)?.id ?? "?";
        const doors = w.doors().map((d) => `${d.id}:${d.open ? 1 : 0}:${d.locked ? 1 : 0}`);
        const doorKey = doors.join(",");
        const prev = doorState.get(bot.name);
        if (prev !== undefined && prev !== doorKey) {
          const changed = [...w.doors()].filter((d) => !prev.includes(`${d.id}:${d.open ? 1 : 0}:${d.locked ? 1 : 0}`));
          for (const d of changed) {
            const line = `${t}\t${bot.name}\tdoor\t${d.id} open=${d.open} locked=${d.locked}`;
            bot.logs.push(line);
            eventLines.push(line);
          }
        }
        doorState.set(bot.name, doorKey);
        const pickups = w.pickups().length;
        const keys = w.keys().length;
        bot.samples.push(JSON.stringify({ t, x: p.x, y: p.y, z: p.z, yaw: p.yaw, place, pickups, keys }));
      }
      const first = bots[0]?.session.world.pickups().length;
      if (pickupCount !== undefined && first !== undefined && first !== pickupCount) {
        const line = `${Date.now() - T}\tboth\tpickup\tcount ${pickupCount} -> ${first}`;
        eventLines.push(line);
        log(`pickup event: ${pickupCount} -> ${first} at t=${Date.now() - T}ms`);
      }
      pickupCount = first;
      await sleep(SAMPLE_MS);
    }
  })();

  await sleep(Math.max(0, T - Date.now()));
  log(`START t=${Date.now() - T}ms mission=${MISSION_TEXT}`);
  const codes = await Promise.all(bots.map((bot) => runMission(bot.session, mission, {
    timeoutMs: TIMEOUT_MS,
    log: (line) => {
      const row = `${Date.now() - T}\t${bot.name}\tbrain\t${line}`;
      bot.logs.push(row);
      if (/plan done|start pickup|finish pickup|replan|finish .* failed/.test(line)) log(`  ${bot.name} ${line}`);
    },
    error: (line) => {
      const row = `${Date.now() - T}\t${bot.name}\terror\t${line}`;
      bot.logs.push(row);
      log(`  ${bot.name} ERROR ${line}`);
    },
  })));
  sampling = false;
  await sampler;
  log(`missions done codes=${codes.join(",")} at t=${Date.now() - T}ms`);

  // Write traces.
  for (let i = 0; i < bots.length; i += 1) {
    const bot = bots[i]!;
    writeFileSync(`${dir}/${bot.name}.jsonl`, bot.logs.concat(bot.samples.map((s) => `sample\t${s}`)).join("\n") + "\n");
  }
  writeFileSync(`${dir}/events.txt`, eventLines.join("\n") + "\n");

  // Metrics.
  const summary: Record<string, unknown> = { url: URL_, mission: MISSION_TEXT, timeoutMs: TIMEOUT_MS, startDelayMs: START_DELAY_MS, codes, bots: [] as unknown[] };
  const parsed = bots.map((bot) => bot.samples.map((line) => JSON.parse(line) as { t: number; x: number; z: number; place: string }));
  for (let i = 0; i < bots.length; i += 1) {
    const bot = bots[i]!;
    const rows = parsed[i]!;
    let travelled = 0;
    for (let j = 1; j < rows.length; j += 1) {
      const a = rows[j - 1]!;
      const b = rows[j]!;
      const d = Math.hypot(b.x - a.x, b.z - a.z);
      if (d < 2) travelled += d;
    }
    const first = rows[0];
    const last = rows[rows.length - 1];
    const logLines = bot.logs.filter((l) => l.includes("\tbrain\t"));
    const pickupStart = logLines.filter((l) => l.includes("start pickup"));
    const pickupFinish = logLines.filter((l) => l.includes("finish pickup"));
    summary.bots.push({
      name: bot.name,
      code: codes[i],
      samples: rows.length,
      start: first ? { x: first.x, z: first.z, place: first.place } : null,
      end: last ? { x: last.x, z: last.z, place: last.place } : null,
      travelledM: Number(travelled.toFixed(2)),
      pickupStarts: pickupStart.length,
      pickupFinishes: pickupFinish.map((l) => l.split("\t")[0]),
      pickupFinishCount: pickupFinish.length,
      planDone: logLines.filter((l) => l.includes("plan done")).map((l) => l.split("\t")[0]),
    });
  }
  // Separation.
  const n = Math.min(parsed[0]?.length ?? 0, parsed[1]?.length ?? 0);
  let sum = 0;
  let count = 0;
  let min = Infinity;
  let max = 0;
  for (let j = 0; j < n; j += 1) {
    const a = parsed[0]![j]!;
    const b = parsed[1]![j]!;
    if (Math.abs(a.t - b.t) > SAMPLE_MS * 2) continue;
    const d = Math.hypot(a.x - b.x, a.z - b.z);
    sum += d;
    count += 1;
    min = Math.min(min, d);
    max = Math.max(max, d);
  }
  summary.separation = count > 0 ? { n: count, mean: Number((sum / count).toFixed(2)), min: Number(min.toFixed(2)), max: Number(max.toFixed(2)) } : null;
  summary.doorEvents = eventLines.filter((l) => l.includes("\tdoor\t")).length;
  summary.pickupEvents = eventLines.filter((l) => l.includes("\tpickup\t"));
  writeFileSync(`${dir}/summary.json`, JSON.stringify(summary, null, 2) + "\n");
  log("SUMMARY " + JSON.stringify(summary, null, 2));
} catch (err) {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
} finally {
  for (const bot of bots) bot.session.close();
  await sleep(400);
  log(`EXITED t=${Date.now() - (bots[0]?.welcomeAt ?? Date.now())}ms`);
}
