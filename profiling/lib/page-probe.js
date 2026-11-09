// Injected before the page's own scripts (Page.addScriptToEvaluateOnNewDocument).
// Records rAF frame deltas, long tasks, console errors, and in-tab host tick durations (solo build).
(() => {
  if (window.__prof) return;
  const P = (window.__prof = { frames: [], ticks: [], tickGaps: [], longTasks: [], errors: [], recording: false, frameCount: 0, maxGap: 0, tickTimers: 0 });
  let last = 0;
  const loop = (t) => {
    if (last && P.recording) P.frames.push(t - last);
    if (last && t - last > P.maxGap) P.maxGap = t - last;
    last = t;
    P.frameCount++;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  const TICK_MS = 50;
  const realSetInterval = window.setInterval.bind(window);
  let lastTick = 0;
  window.setInterval = function (fn, ms, ...rest) {
    if (typeof fn !== "function" || ms !== TICK_MS) return realSetInterval(fn, ms, ...rest);
    P.tickTimers++;
    return realSetInterval(function () {
      const t0 = performance.now();
      try { return fn.apply(this, arguments); } finally {
        if (P.recording) { P.ticks.push(performance.now() - t0); if (lastTick) P.tickGaps.push(t0 - lastTick); }
        lastTick = t0;
      }
    }, ms, ...rest);
  };
  try {
    new PerformanceObserver((list) => { if (P.recording) for (const e of list.getEntries()) P.longTasks.push(e.duration); }).observe({ type: "longtask", buffered: false });
  } catch {}
  const origError = console.error.bind(console);
  console.error = (...a) => { if (P.errors.length < 50) P.errors.push(a.map((x) => (x instanceof Error ? x.message : String(x))).join(" ").slice(0, 300)); origError(...a); };
  window.addEventListener("error", (e) => { if (P.errors.length < 50) P.errors.push(`uncaught: ${e.message}`); });
  // Count GL work that marks loading (shader compiles, texture uploads) so the driver can wait for it to stop.
  P.gl = { compile: 0, upload: 0 };
  for (const C of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
    if (!C) continue;
    const wrap = (name, field) => {
      const orig = C.prototype[name];
      if (typeof orig !== "function") return;
      C.prototype[name] = function () { P.gl[field]++; return orig.apply(this, arguments); };
    };
    wrap("compileShader", "compile");
    for (const n of ["texImage2D", "texSubImage2D", "compressedTexImage2D", "compressedTexSubImage2D", "texImage3D", "texSubImage3D", "texStorage2D"]) wrap(n, "upload");
  }
  P.keyDowns = 0;
  window.addEventListener("keydown", () => { P.keyDowns++; }, true);
  P.reset = () => { P.gl0 = { ...P.gl }; P.frames = []; P.ticks = []; P.tickGaps = []; P.longTasks = []; last = 0; lastTick = 0; P.recording = true; };
  P.take = () => { P.recording = false; return { frames: P.frames, ticks: P.ticks, tickGaps: P.tickGaps, longTasks: P.longTasks, errors: P.errors, tickTimers: P.tickTimers, keyDowns: P.keyDowns, gl: { compile: P.gl.compile - (P.gl0?.compile ?? 0), upload: P.gl.upload - (P.gl0?.upload ?? 0) }, visibility: document.visibilityState, w: innerWidth, h: innerHeight, dpr: devicePixelRatio }; };
})();
