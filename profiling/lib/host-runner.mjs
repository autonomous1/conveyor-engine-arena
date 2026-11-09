// Child process: runs the arena host from <root>/dist/server/main.js and profiles itself with node:inspector.
// Controlled over IPC by profile-host.mjs so the players and the driver never appear in the host profile.
// argv: <root> ; env ARENA_PROFILE_TICK_MS (default 50)
import { Session } from "node:inspector/promises";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const root = resolve(process.argv[2]);
const TICK_MS = Number(process.env.ARENA_PROFILE_TICK_MS ?? 50);
process.env.ARENA_AUTH = "off";

// Time the host tick: wrap setInterval callbacks scheduled at the tick period. Overhead: two performance.now() per tick.
const tick = { durations: [], gaps: [], last: 0, recording: false, count: 0 };
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = function (fn, ms, ...rest) {
  if (typeof fn !== "function" || ms !== TICK_MS) return realSetInterval(fn, ms, ...rest);
  tick.count++;
  return realSetInterval(function () {
    const t0 = performance.now();
    try { return fn.apply(this, arguments); } finally {
      const t1 = performance.now();
      if (tick.recording) {
        tick.durations.push(t1 - t0);
        if (tick.last) tick.gaps.push(t0 - tick.last);
      }
      tick.last = t0;
    }
  }, ms, ...rest);
};

const { startArenaServer } = await import(pathToFileURL(resolve(root, "dist/server/main.js")).href);
const host = await startArenaServer(0, false);
const session = new Session();
session.connect();
await session.post("Profiler.enable");
await session.post("Profiler.setSamplingInterval", { interval: Number(process.env.ARENA_PROFILE_SAMPLE_US ?? 500) });
const eld = monitorEventLoopDelay({ resolution: 5 });
let cpu0, t0;

process.on("message", async (msg) => {
  try {
    if (msg.cmd === "start") {
      tick.durations = []; tick.gaps = []; tick.recording = true;
      eld.reset(); eld.enable();
      cpu0 = process.cpuUsage(); t0 = performance.now();
      await session.post("Profiler.start");
      process.send({ ok: "start" });
    } else if (msg.cmd === "stop") {
      const { profile } = await session.post("Profiler.stop");
      tick.recording = false; eld.disable();
      const wallMs = performance.now() - t0;
      const cpu = process.cpuUsage(cpu0);
      process.send({
        ok: "stop", profile,
        metrics: {
          wallMs, tickIntervals: tick.count,
          cpuPctOneCore: (100 * (cpu.user + cpu.system)) / 1000 / wallMs,
          eventLoopDelayMs: { mean: eld.mean / 1e6, p50: eld.percentile(50) / 1e6, p99: eld.percentile(99) / 1e6, max: eld.max / 1e6 },
          rssMb: process.memoryUsage().rss / 1048576,
          heapUsedMb: process.memoryUsage().heapUsed / 1048576,
          tickDurationsMs: tick.durations, tickGapsMs: tick.gaps,
        },
      });
    } else if (msg.cmd === "exit") {
      await host.close().catch(() => {});
      session.disconnect();
      process.exit(0);
    }
  } catch (err) {
    process.send({ error: String(err?.stack ?? err) });
  }
});
process.send({ ready: true, url: host.url });
