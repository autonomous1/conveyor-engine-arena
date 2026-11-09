#!/usr/bin/env node
// Host Bottom-Up profile. Starts dist/server/main.js in a child process (auth off, 127.0.0.1, random port),
// optionally joins scripted players, warms up, records a CPU profile with node:inspector, then analyzes it.
//
// node profiling/profile-host.mjs [--root <repo>] [--scenario wander|stationary|moving|all] [--players 1]
//      [--warmup 5] [--duration 30] [--out profiling/results/<label>] [--label <name>] [--no-profile-file]
import { fork, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { analyzeProfile, makeSourceMapLoader } from "./lib/bottom-up.mjs";
import { writeRun } from "./lib/summary.mjs";
import { buildLabel, buildRoot, machineInfo, parseArgs, round, sleep, stats } from "./lib/util.mjs";

const here = new URL(".", import.meta.url).pathname;
const args = parseArgs(process.argv.slice(2), { scenario: "all", warmup: 5, duration: 30, players: 1 });
const root = buildRoot(args.root);
const label = buildLabel(root, args.label);
const outDir = resolve(args.out ?? join(here, "results", label));
const scenarios = args.scenario === "all" ? ["wander", "stationary", "moving"] : String(args.scenario).split(",");
const warmupMs = Number(args.warmup) * 1000;
const durationMs = Number(args.duration) * 1000;
const players = Number(args.players);

if (!existsSync(join(root, "dist/server/main.js"))) {
  console.error(`missing ${root}/dist/server/main.js — run npm run build in that repo first`);
  process.exit(1);
}

async function bundlePlayer() {
  const conn = join(root, "packages/bot-client/src/connection.ts");
  if (!existsSync(conn)) throw new Error(`no bot client at ${conn}`);
  const require = createRequire(join(root, "package.json"));
  const { build } = await import(require.resolve("esbuild"));
  const outfile = join(root, ".profiling-tmp", "player.mjs");
  await mkdir(join(root, ".profiling-tmp"), { recursive: true });
  const { readFile } = await import("node:fs/promises");
  const src = (await readFile(join(here, "lib/player-entry.template.mjs"), "utf8")).replace("__CONNECTION__", conn);
  await build({
    stdin: { contents: src, resolveDir: root, loader: "js", sourcefile: "player-entry.mjs" },
    bundle: true, format: "esm", platform: "node", target: "node22", outfile, logLevel: "error",
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
    external: ["bufferutil", "utf-8-validate"],
  });
  return outfile;
}

function startHost() {
  const child = fork(join(here, "lib/host-runner.mjs"), [root], { cwd: root, stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...process.env, ARENA_AUTH: "off", PORT: "0" } });
  const log = [];
  child.stdout.on("data", (d) => log.push(String(d)));
  child.stderr.on("data", (d) => log.push(String(d)));
  const waitFor = (pred, ms = 60000) => new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`host timeout; log:\n${log.join("").slice(-2000)}`)), ms);
    const on = (m) => { if (m.error) { clearTimeout(t); child.off("message", on); rej(new Error(m.error)); } else if (pred(m)) { clearTimeout(t); child.off("message", on); res(m); } };
    child.on("message", on);
    child.once("exit", (code) => { clearTimeout(t); rej(new Error(`host exited ${code}; log:\n${log.join("").slice(-2000)}`)); });
  });
  return { child, log, waitFor };
}

async function runScenario(scenario, playerBundle) {
  const notes = [];
  const host = startHost();
  const ready = await host.waitFor((m) => m.ready);
  console.log(`[host ${label}] ${scenario}: host at ${ready.url}`);
  const kids = [];
  try {
    const n = scenario === "wander" ? 0 : players;
    for (let i = 0; i < n; i++) {
      const mode = scenario === "moving" ? "moving" : "stationary";
      const kid = spawn(process.execPath, [playerBundle, ready.url, mode, String((warmupMs + durationMs) / 1000 + 10), String(i + 1)], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
      kids.push(kid);
      const joined = await new Promise((res) => {
        const t = setTimeout(() => res(false), 15000);
        kid.stdout.on("data", (d) => { if (String(d).includes('"joined":true')) { clearTimeout(t); res(true); } });
        kid.stderr.on("data", (d) => process.stderr.write(d));
        kid.once("exit", () => { clearTimeout(t); res(false); });
      });
      if (!joined) notes.push(`player ${i + 1} failed to join`);
    }
    await sleep(warmupMs);
    host.child.send({ cmd: "start" });
    await host.waitFor((m) => m.ok === "start");
    await sleep(durationMs);
    host.child.send({ cmd: "stop" });
    const { profile, metrics } = await host.waitFor((m) => m.ok === "stop", 60000);
    for (const k of kids) if (k.exitCode !== null) notes.push(`a player exited early (code ${k.exitCode})`);
    const analysis = await analyzeProfile(profile, { sourceMapLoader: makeSourceMapLoader(), trustNames: true });
    const tickMs = stats(metrics.tickDurationsMs);
    const gapMs = stats(metrics.tickGapsMs);
    const summary = {
      kind: "host", scenario, build: label, root, recordedAt: Date.now(), machine: await machineInfo(),
      config: { warmupS: warmupMs / 1000, durationS: durationMs / 1000, players: n, sampleIntervalUs: Number(process.env.ARENA_PROFILE_SAMPLE_US ?? 500) },
      notes,
      metrics: {
        tickMs, tickGapMs: gapMs,
        ticksPerSec: { n: 1, mean: round((tickMs.n ?? 0) / (metrics.wallMs / 1000), 2) },
        cpuPctOneCore: { n: 1, mean: round(metrics.cpuPctOneCore, 2) },
        eventLoopDelayMs: { n: 1, mean: round(metrics.eventLoopDelayMs.mean), p50: round(metrics.eventLoopDelayMs.p50), p99: round(metrics.eventLoopDelayMs.p99), max: round(metrics.eventLoopDelayMs.max) },
        rssMb: { n: 1, mean: round(metrics.rssMb, 1) },
        tickIntervalsHooked: metrics.tickIntervals,
      },
      analysis,
    };
    if (metrics.tickIntervals !== 1) summary.notes.push(`tick timer hook matched ${metrics.tickIntervals} setInterval(…, 50) timers; tick stats cover all of them`);
    const base = await writeRun(outDir, summary, profile, { keepProfile: !args.noProfileFile });
    const top = analysis.functions.filter((f) => f.name !== "(idle)" && f.category !== "profiler").slice(0, 5).map((f) => `${f.name} ${f.selfBusyPct}%`).join(", ");
    console.log(`[host ${label}] ${scenario}: tick p50 ${tickMs.p50} ms p95 ${tickMs.p95} ms, cpu ${round(metrics.cpuPctOneCore, 1)}%, busy ${analysis.busyPct}% — top: ${top}`);
    console.log(`  -> ${base}.md`);
  } finally {
    for (const k of kids) k.kill("SIGTERM");
    host.child.send({ cmd: "exit" });
    await new Promise((r) => { const t = setTimeout(() => { host.child.kill("SIGKILL"); r(); }, 5000); host.child.once("exit", () => { clearTimeout(t); r(); }); });
  }
}

const playerBundle = scenarios.some((s) => s !== "wander") ? await bundlePlayer() : undefined;
for (const s of scenarios) await runScenario(s, playerBundle);
