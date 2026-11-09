#!/usr/bin/env node
// Client Bottom-Up profile of the solo build (host + client in one tab) over raw CDP. No npm deps.
//
// node profiling/profile-client.mjs [--root <repo>] [--scenario idle|moving|all] [--warmup 8] [--duration 30]
//      [--headed] [--attach 9222] [--chrome /path/to/chrome] [--url http://...] [--width 1280 --height 720]
//      [--out profiling/results/<label>] [--label name] [--query "noclip=1"] [--no-profile-file]
//      [--settle-max 120] [--compressed-textures]
//
// Default: launches Chrome headless (--headless=new). WebGL then runs on SwiftShader (CPU), so frame times and
// renderer CPU are NOT representative of a real GPU; Bottom-Up shares of the JS game code still are useful.
// --headed launches a visible Chrome window (needs a display). --attach <port> uses a Chrome you started yourself:
//   google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/arena-prof-chrome
// The suite opens its own tab there, profiles it, and closes only that tab.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { analyzeProfile, makeSourceMapLoader } from "./lib/bottom-up.mjs";
import { browserWsUrl, connectCdp } from "./lib/cdp.mjs";
import { serveDir } from "./lib/static-server.mjs";
import { writeRun } from "./lib/summary.mjs";
import { buildLabel, buildRoot, machineInfo, parseArgs, round, sleep, stats } from "./lib/util.mjs";

const here = new URL(".", import.meta.url).pathname;
const args = parseArgs(process.argv.slice(2), { scenario: "all", warmup: 8, duration: 30, sampleUs: 500 });
const root = buildRoot(args.root);
const label = buildLabel(root, args.label);
const outDir = resolve(args.out ?? join(here, "results", label));
const scenarios = args.scenario === "all" ? ["idle", "moving"] : String(args.scenario).split(",");
const soloDir = join(root, "dist/solo");
const mode = args.attach ? "attach" : args.headed ? "headed" : "headless";
// Headless renders in software: a smaller default viewport keeps SwiftShader from dominating the box.
args.width ??= mode === "headless" ? 960 : 1280;
args.height ??= mode === "headless" ? 540 : 720;

if (!args.url && !existsSync(join(soloDir, "index.html"))) {
  console.error(`missing ${soloDir}/index.html — run npm run build (or npm run build:solo) first`);
  process.exit(1);
}

function findChrome() {
  if (args.chrome) return args.chrome;
  const c = [process.env.CHROME_PATH, "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].filter(Boolean);
  const hit = c.find((p) => existsSync(p));
  if (!hit) throw new Error("Chrome not found; pass --chrome <path> or set CHROME_PATH");
  return hit;
}

async function launchChrome() {
  const userDir = mkdtempSync(join(tmpdir(), "arena-prof-chrome-"));
  const flags = [
    "--remote-debugging-port=0", `--user-data-dir=${userDir}`, "--no-first-run", "--no-default-browser-check",
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
    "--disable-extensions", "--mute-audio", "--autoplay-policy=no-user-gesture-required", `--window-size=${args.width},${args.height}`,
  ];
  if (mode === "headless") flags.push("--headless=new", "--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--ignore-gpu-blocklist");
  if (process.getuid?.() === 0) flags.push("--no-sandbox");
  const proc = spawn(findChrome(), [...flags, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  const ws = await new Promise((res, rej) => {
    let buf = "";
    const t = setTimeout(() => rej(new Error(`Chrome did not report a DevTools port:\n${buf.slice(-1500)}`)), 30000);
    proc.stderr.on("data", (d) => {
      buf += d;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
      if (m) { clearTimeout(t); res(m[1]); }
    });
    proc.once("exit", (code) => { clearTimeout(t); rej(new Error(`Chrome exited ${code}:\n${buf.slice(-1500)}`)); });
  });
  return { ws, close: async () => { proc.kill("SIGTERM"); await new Promise((r) => { const t = setTimeout(() => { proc.kill("SIGKILL"); r(); }, 5000); proc.once("exit", () => { clearTimeout(t); r(); }); }); await sleep(300); try { rmSync(userDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {} } };
}

// SwiftShader decodes BC/ETC/ASTC uploads in software; one compressedTexSubImage2D took minutes on the box.
// Hiding those extensions makes three's KTX2Loader transcode to RGBA instead (headless default; --compressed-textures keeps them).
const hideCompressed = mode === "headless" && !args.compressedTextures;
const HIDE_COMPRESSED_JS = `(() => {
  for (const C of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
    if (!C) continue;
    const get = C.prototype.getExtension, list = C.prototype.getSupportedExtensions;
    C.prototype.getExtension = function (n) { return /compress/i.test(n) ? null : get.call(this, n); };
    C.prototype.getSupportedExtensions = function () { return (list.call(this) || []).filter((n) => !/compress/i.test(n)); };
  }
})();`;

/**
 * Wait until loading is over: the HUD left "loading arena", and for two 2 s windows in a row there were no shader
 * compiles and no frame > 1 s. (Texture uploads are not used: the game uploads textures every frame in steady state.)
 */
async function settle(evalJs, maxMs) {
  const t0 = Date.now();
  let stableFor = 0, fps;
  while (Date.now() - t0 < maxMs) {
    const a = await evalJs("({ c: window.__prof.frameCount, gl: { ...window.__prof.gl } })");
    await evalJs("window.__prof.maxGap = 0");
    await sleep(2000);
    const b = await evalJs("({ c: window.__prof.frameCount, gl: { ...window.__prof.gl }, gap: window.__prof.maxGap, loading: /loading arena/i.test(document.body.innerText) })");
    fps = (b.c - a.c) / 2;
    const ok = !b.loading && b.gap < 1000 && fps > 0 && b.gl.compile === a.gl.compile;
    stableFor = ok ? stableFor + 1 : 0;
    if (stableFor >= 2) return { settledMs: Date.now() - t0, fps };
  }
  return { settledMs: Date.now() - t0, fps, timedOut: true };
}

const KEYS = { KeyW: 87, KeyA: 65, KeyS: 83, KeyD: 68 };
async function key(page, code, down) {
  await page.send("Input.dispatchKeyEvent", { type: down ? "keyDown" : "keyUp", code, key: code.slice(3).toLowerCase(), windowsVirtualKeyCode: KEYS[code], nativeVirtualKeyCode: KEYS[code] });
}

/** Deterministic WASD pattern for `ms`: forward/back every 6 s, strafe in bursts every 4 s. */
async function drive(page, ms) {
  const held = new Set();
  const want = async (codes) => {
    for (const c of [...held]) if (!codes.includes(c)) { await key(page, c, false); held.delete(c); }
    for (const c of codes) if (!held.has(c)) { await key(page, c, true); held.add(c); }
  };
  const start = Date.now();
  while (Date.now() - start < ms) {
    const t = (Date.now() - start) / 1000;
    const codes = [Math.floor(t / 6) % 2 === 0 ? "KeyW" : "KeyS"];
    if (Math.floor(t / 4) % 3 === 0) codes.push(Math.floor(t / 2) % 2 ? "KeyD" : "KeyA");
    await want(codes);
    await sleep(100);
  }
  await want([]);
}

async function processCpu(browser) {
  try {
    const { processInfo } = await browser.send("SystemInfo.getProcessInfo");
    const out = {};
    for (const p of processInfo) out[p.type] = (out[p.type] ?? 0) + p.cpuTime;
    return out;
  } catch { return undefined; }
}

async function runScenario(browser, pageUrl, scenario) {
  const notes = [];
  if (mode === "headless") notes.push("headless Chrome: WebGL on SwiftShader (software). Frame times, GPU and renderer CPU are not representative of a real GPU.");
  const { targetId } = await browser.send("Target.createTarget", mode === "attach"
    ? { url: "about:blank", newWindow: true, width: Number(args.width), height: Number(args.height) }
    : { url: "about:blank" });
  const { sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: true });
  const page = browser.session(sessionId);
  try {
    await page.send("Page.enable");
    await page.send("Runtime.enable");
    await page.send("Performance.enable");
    await page.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
    if (mode !== "attach") await page.send("Emulation.setDeviceMetricsOverride", { width: Number(args.width), height: Number(args.height), deviceScaleFactor: 1, mobile: false }).catch(() => {});
    await page.send("Page.addScriptToEvaluateOnNewDocument", { source: readFileSync(join(here, "lib/page-probe.js"), "utf8") });
    if (hideCompressed) await page.send("Page.addScriptToEvaluateOnNewDocument", { source: HIDE_COMPRESSED_JS });
    const loaded = new Promise((r) => page.on("Page.loadEventFired", r));
    await page.send("Page.navigate", { url: pageUrl });
    await Promise.race([loaded, sleep(60000)]);
    await page.send("Page.bringToFront").catch(() => {});
    const evalJs = async (expr) => (await page.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result.value;
    // Ready = a canvas exists and frames are flowing.
    const t0 = Date.now();
    while (Date.now() - t0 < 90000) {
      const ok = await evalJs("!!document.querySelector('canvas') && (window.__prof?.frameCount ?? 0) > 30");
      if (ok) break;
      await sleep(500);
    }
    // Click the canvas once (focus; pointer lock is refused without a real gesture, which is fine).
    await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 400, y: 300, button: "left", clickCount: 1 }).catch(() => {});
    await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 400, y: 300, button: "left", clickCount: 1 }).catch(() => {});
    const st = await settle(evalJs, Number(args.settleMax ?? 120) * 1000);
    if (st.timedOut) notes.push(`rendering did not settle within ${args.settleMax ?? 120} s (last fps ${st.fps}); results include load work`);
    else notes.push(`settled after ${round(st.settledMs / 1000, 1)} s at ${st.fps} fps`);
    if (hideCompressed) notes.push("compressed-texture extensions hidden (SwiftShader); KTX2 textures were transcoded to RGBA");
    const warm = Number(args.warmup) * 1000;
    if (scenario === "moving") await drive(page, warm); else await sleep(warm);

    await page.send("Profiler.enable");
    await page.send("Profiler.setSamplingInterval", { interval: Number(args.sampleUs) });
    await evalJs("window.__prof.reset()");
    const perf0 = Object.fromEntries((await page.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
    const cpu0 = await processCpu(browser);
    await page.send("Profiler.start");
    const durationMs = Number(args.duration) * 1000;
    const tStart = Date.now();
    if (scenario === "moving") await drive(page, durationMs); else await sleep(durationMs);
    const { profile } = await page.send("Profiler.stop");
    const wallS = (Date.now() - tStart) / 1000;
    const cpu1 = await processCpu(browser);
    const perf1 = Object.fromEntries((await page.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
    const probe = await evalJs("window.__prof.take()");

    const loader = makeSourceMapLoader({ fsRoot: args.url ? undefined : soloDir });
    const analysis = await analyzeProfile(profile, { sourceMapLoader: loader });
    const d = (k) => (perf1[k] ?? 0) - (perf0[k] ?? 0);
    const frame = stats(probe.frames);
    const metrics = {
      frameMs: frame,
      fps: { n: 1, mean: round(probe.frames.length / wallS, 1) },
      framesOver33ms: { n: 1, mean: probe.frames.filter((x) => x > 33.4).length },
      hostTickMs: stats(probe.ticks),
      hostTickGapMs: stats(probe.tickGaps),
      longTasks: { n: probe.longTasks.length, ...(probe.longTasks.length ? stats(probe.longTasks) : {}) },
      mainThreadTaskPct: { n: 1, mean: round((100 * d("TaskDuration")) / wallS, 2) },
      scriptPct: { n: 1, mean: round((100 * d("ScriptDuration")) / wallS, 2) },
      layoutPlusStylePct: { n: 1, mean: round((100 * (d("LayoutDuration") + d("RecalcStyleDuration"))) / wallS, 2) },
      glShaderCompiles: { n: 1, mean: probe.gl.compile },
      glTextureUploadsPerSec: { n: 1, mean: round(probe.gl.upload / wallS, 1) },
      jsHeapUsedMb: { n: 1, mean: round((perf1.JSHeapUsedSize ?? 0) / 1048576, 1) },
    };
    if (cpu0 && cpu1) {
      for (const [type, t] of Object.entries(cpu1)) metrics[`processCpuPct.${type}`] = { n: 1, mean: round((100 * (t - (cpu0[type] ?? 0))) / wallS, 1) };
      if (mode === "attach") notes.push("processCpuPct.* covers every tab and process of the attached Chrome, not only the profiled tab.");
    }
    if (probe.tickTimers !== 1) notes.push(`tick hook matched ${probe.tickTimers} setInterval(…, 50) timers in the tab`);
    if (probe.visibility !== "visible") notes.push(`tab visibility was ${probe.visibility} — rAF may be throttled`);
    if (probe.errors.length) notes.push(`console.error lines (${probe.errors.length}): ${probe.errors.slice(0, 5).join(" | ")}`);
    if (probe.gl.compile) notes.push(`${probe.gl.compile} shader compiles inside the recording (loading work)`);
    if (scenario === "moving") notes.push(`page saw ${probe.keyDowns} keydown events (WASD driver)`);
    notes.push(`viewport ${probe.w}x${probe.h} @${probe.dpr}x, mode ${mode}`);
    const summary = {
      kind: "client", scenario, build: label, root, recordedAt: Date.now(), machine: await machineInfo(),
      config: { mode, warmupS: warm / 1000, durationS: durationMs / 1000, url: pageUrl, sampleIntervalUs: Number(args.sampleUs) },
      notes, metrics, analysis,
    };
    const base = await writeRun(outDir, summary, profile, { keepProfile: !args.noProfileFile });
    const top = analysis.functions.filter((f) => f.name !== "(idle)" && f.category !== "profiler").slice(0, 5).map((f) => `${f.name} ${f.selfBusyPct}%`).join(", ");
    console.log(`[client ${label}] ${scenario}: fps ${metrics.fps.mean}, frame p50 ${frame.p50} ms p95 ${frame.p95} ms, host tick p50 ${metrics.hostTickMs.p50} ms — top: ${top}`);
    console.log(`  -> ${base}.md`);
  } finally {
    await browser.send("Target.closeTarget", { targetId }).catch(() => {});
  }
}

let server, chrome, browser;
// Watchdog: a stuck page (e.g. a minutes-long GL upload) must not leave Chrome running.
const budgetS = scenarios.length * (Number(args.settleMax ?? 120) + Number(args.warmup) + Number(args.duration) + 150);
const watchdog = setTimeout(async () => {
  console.error(`[client ${label}] watchdog: exceeded ${budgetS} s, aborting`);
  browser?.close(); await chrome?.close(); await server?.close(); process.exit(3);
}, budgetS * 1000);
watchdog.unref();
try {
  let pageUrl = args.url;
  if (!pageUrl) {
    server = await serveDir(soloDir, Number(args.port ?? 0));
    pageUrl = server.url;
  }
  if (args.query) pageUrl += (pageUrl.includes("?") ? "&" : "?") + args.query;
  const wsUrl = mode === "attach" ? await browserWsUrl(Number(args.attach === true ? 9222 : args.attach)) : (chrome = await launchChrome()).ws;
  browser = await connectCdp(wsUrl);
  for (const s of scenarios) await runScenario(browser, pageUrl, s);
} finally {
  browser?.close();
  await chrome?.close();
  await server?.close();
}
