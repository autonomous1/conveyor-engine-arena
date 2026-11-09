// Bottom-Up analysis of a V8 .cpuprofile (Node --cpu-prof, node:inspector or CDP Profiler.stop).
// Self time = sum of sample timeDeltas landing in a node. Total time = time with the function anywhere on
// the stack (recursion counted once), same as DevTools Bottom-Up "Total Time".
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { parseSourceMap, plainSource, nameFromSource } from "./sourcemap.mjs";
import { round } from "./util.mjs";

const SPECIAL = new Set(["(idle)", "(program)", "(garbage collector)", "(root)"]);

/** Strip machine/build specific prefixes so keys match between builds and machines. */
export function normalizeUrl(url) {
  if (!url) return "";
  let u = url.replace(/^file:\/\//, "").replace(/^https?:\/\/[^/]+\//, "/");
  const nm = u.lastIndexOf("/node_modules/");
  if (nm >= 0) return u.slice(nm + 1);
  for (const marker of ["/dist/", "/src/", "/packages/", "/web/"]) {
    const i = u.indexOf(marker);
    if (i >= 0) return u.slice(i + 1);
  }
  u = u.replace(/^(\.\.\/)+/, "").replace(/^\/+/, "");
  return u;
}

/**
 * opts.sourceMaps: Map<url, parsed map> (or a loader `(url) => Promise<map|undefined>`)
 */
export async function analyzeProfile(profile, opts = {}) {
  const nodes = profile.nodes;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of nodes) for (const c of n.children ?? []) parent.set(c, n.id);

  const self = new Map();
  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];
  let totalUs = 0;
  // V8 timeDeltas[i] is the gap before sample i; attribute it to sample i (DevTools does the same, approx).
  for (let i = 0; i < samples.length; i++) {
    const d = Math.max(0, deltas[i] ?? 0);
    totalUs += d;
    self.set(samples[i], (self.get(samples[i]) ?? 0) + d);
  }
  if (totalUs === 0) totalUs = Math.max(1, (profile.endTime ?? 0) - (profile.startTime ?? 0));

  // Resolve a stable key per node.
  const maps = new Map();
  const mapFor = async (url) => {
    if (!opts.sourceMapLoader || !url) return undefined;
    if (!maps.has(url)) maps.set(url, await opts.sourceMapLoader(url).catch(() => undefined));
    return maps.get(url);
  };
  const keyOf = new Map();
  const fnInfo = new Map();
  for (const n of nodes) {
    const cf = n.callFrame;
    let name = cf.functionName || "(anonymous)";
    let file = normalizeUrl(cf.url);
    let line = cf.lineNumber + 1;
    if (SPECIAL.has(name) && !cf.url) {
      keyOf.set(n.id, name);
      fnInfo.set(name, { name, file: "", line: 0, category: name });
      continue;
    }
    const sm = await mapFor(cf.url);
    if (sm?.identity) {
      if (name === "(anonymous)" && cf.lineNumber >= 0) {
        const hit = sm.lookup(cf.lineNumber, cf.columnNumber);
        name = nameFromSource(hit.text, hit.col) ?? name;
      }
    } else if (sm && cf.lineNumber >= 0) {
      const hit = sm.lookup(cf.lineNumber, cf.columnNumber);
      if (hit) {
        file = normalizeUrl(hit.source);
        line = hit.line + 1;
        const guessed = nameFromSource(hit.text, hit.col);
        // Unminified code (Node host via tsc maps): keep V8's name when it has one.
        if (!(opts.trustNames && cf.functionName)) name = guessed ? guessed : opts.trustNames ? name : "(anonymous)";
      }
    }
    if (!cf.url && name === "(anonymous)") name = "(native)";
    // Named functions key by name+file (stable when code moves); anonymous ones need the line to stay distinct.
    const key = name === "(anonymous)" || name === "(native)" && !file ? `${name} ${file}:${line}` : `${name} ${file}`;
    keyOf.set(n.id, key);
    if (!fnInfo.has(key)) fnInfo.set(key, { name, file, line, category: categoryOf(file, cf.url, name) });
  }

  const fnSelf = new Map();
  const fnTotal = new Map();
  const fileSelf = new Map();
  const catSelf = new Map();
  for (const [id, us] of self) {
    if (us === 0) continue;
    const key = keyOf.get(id);
    fnSelf.set(key, (fnSelf.get(key) ?? 0) + us);
    const info = fnInfo.get(key);
    const fileKey = info.file || key;
    fileSelf.set(fileKey, (fileSelf.get(fileKey) ?? 0) + us);
    catSelf.set(info.category, (catSelf.get(info.category) ?? 0) + us);
    const seen = new Set();
    for (let cur = id; cur !== undefined; cur = parent.get(cur)) {
      const k = keyOf.get(cur);
      if (seen.has(k)) continue;
      seen.add(k);
      fnTotal.set(k, (fnTotal.get(k) ?? 0) + us);
    }
  }
  // Idle, and the profiler's own start/stop cost, are excluded from the "busy" base.
  const idleUs = (catSelf.get("(idle)") ?? 0) + (catSelf.get("profiler") ?? 0);
  const busyUs = Math.max(1, totalUs - idleUs);
  const pct = (us, base) => round((100 * us) / base, 2);
  const functions = [...fnSelf.keys()].concat([...fnTotal.keys()].filter((k) => !fnSelf.has(k)))
    .filter((k) => !SPECIAL.has(k) || k !== "(root)")
    .map((k) => {
      const s = fnSelf.get(k) ?? 0;
      const t = fnTotal.get(k) ?? 0;
      const info = fnInfo.get(k);
      return {
        key: k, name: info.name, file: info.file, line: info.line, category: info.category,
        selfMs: round(s / 1000, 2), totalMs: round(t / 1000, 2),
        selfPct: pct(s, totalUs), totalPct: pct(t, totalUs),
        selfBusyPct: info.category === "profiler" ? null : pct(s, busyUs), totalBusyPct: info.category === "profiler" ? null : pct(t, busyUs),
      };
    })
    .filter((f) => f.key !== "(root)")
    .sort((a, b) => b.selfMs - a.selfMs);
  const files = [...fileSelf].map(([file, us]) => ({ file, selfMs: round(us / 1000, 2), selfPct: pct(us, totalUs), selfBusyPct: pct(us, busyUs) }))
    .sort((a, b) => b.selfMs - a.selfMs);
  const categories = Object.fromEntries([...catSelf].map(([c, us]) => [c, { selfMs: round(us / 1000, 2), selfPct: pct(us, totalUs), selfBusyPct: c === "(idle)" || c === "profiler" ? null : pct(us, busyUs) }]));
  return {
    durationMs: round(totalUs / 1000, 1),
    busyMs: round(busyUs / 1000, 1),
    busyPct: pct(busyUs, totalUs),
    sampleCount: samples.length,
    categories,
    functions,
    files,
  };
}

// WebGL entry points show up as url-less native frames; group them so GPU-driver cost is visible as one bucket.
const GL_NAME = /^(?:get(?:Shader|Program|Uniform|Attrib|Parameter|Error|Extension|Supported|ActiveUniform|BufferSubData)\w*|(?:compressed)?[tT]ex(?:Sub)?Image[23]D|texStorage[23]D|texParameter\w*|uniform\w+|draw\w+|bind\w+|buffer(?:Sub)?Data|vertexAttrib\w*|enable\w*|disable\w*|useProgram|clear\w*|blend\w+|depth\w+|colorMask|stencil\w+|viewport|scissor|cullFace|frontFace|framebuffer\w+|readPixels|pixelStorei|generateMipmap|activeTexture|invalidateFramebuffer|create(?:Buffer|Texture|Program|Shader|VertexArray|Framebuffer)|delete\w+|compileShader|linkProgram|shaderSource|attachShader|flush|finish)$/;

function categoryOf(file, url, name) {
  if (!url && name && GL_NAME.test(name)) return "webgl";
  if (file.startsWith("node_modules/three/")) return "three";
  if (file.startsWith("node_modules/conveyor-engine-")) return "engine";
  if (file.startsWith("node_modules/")) return "deps";
  if (file.startsWith("src/") || file.startsWith("dist/") || file.startsWith("packages/")) return "arena";
  if (file.startsWith("node:inspector")) return "profiler";
  if (url?.startsWith("node:") || file.startsWith("node:")) return "node";
  if (!url) return "native";
  return "other";
}

/** Load a sibling .map for a URL (http or file). `fsRoot` maps an http URL's path onto disk. */
export function makeSourceMapLoader({ fsRoot } = {}) {
  return async (url) => {
    let text;
    if (url.startsWith("http")) {
      if (fsRoot) {
        const p = new URL(url).pathname;
        const f = `${fsRoot}${p}.map`;
        if (existsSync(f)) text = await readFile(f, "utf8");
      }
      if (!text) {
        const res = await fetch(`${url}.map`).catch(() => undefined);
        if (res?.ok) text = await res.text();
      }
    } else if (url.startsWith("file://") || url.startsWith("/")) {
      const js = decodeURIComponent(url.replace(/^file:\/\//, ""));
      if (existsSync(`${js}.map`)) text = await readFile(`${js}.map`, "utf8");
      else if (existsSync(js)) return plainSource(await readFile(js, "utf8"));
    }
    return text ? parseSourceMap(JSON.parse(text)) : undefined;
  };
}

export function renderMarkdown(summary, top = 30) {
  const a = summary.analysis;
  const lines = [];
  lines.push(`# ${summary.kind} profile — ${summary.scenario} — ${summary.build}`);
  lines.push("");
  lines.push(`Recorded ${new Date(summary.recordedAt).toISOString()} on ${summary.machine?.host ?? "?"} (${summary.machine?.cpuModel ?? "?"}, ${summary.machine?.cpus ?? "?"} cpus, load ${summary.machine?.loadavg?.join(" ") ?? "?"}).`);
  if (summary.notes?.length) for (const n of summary.notes) lines.push(`> ${n}`);
  lines.push("");
  lines.push(`Profile: ${a.durationMs} ms recorded, busy ${a.busyMs} ms (${a.busyPct}% non-idle), ${a.sampleCount} samples.`);
  lines.push("");
  if (summary.metrics) {
    lines.push("## Metrics");
    lines.push("");
    lines.push("| metric | n | mean | p50 | p95 | p99 | max |");
    lines.push("|---|---|---|---|---|---|---|");
    for (const [k, v] of Object.entries(summary.metrics)) {
      if (v && typeof v === "object" && "n" in v) lines.push(`| ${k} | ${v.n} | ${v.mean ?? ""} | ${v.p50 ?? ""} | ${v.p95 ?? ""} | ${v.p99 ?? ""} | ${v.max ?? ""} |`);
      else lines.push(`| ${k} | ${typeof v === "object" ? JSON.stringify(v) : v} | | | | | |`);
    }
    lines.push("");
  }
  lines.push("## Categories (self time)");
  lines.push("");
  lines.push("`profiler` is the inspector's own start/stop cost; it and `(idle)` are left out of the busy base.");
  lines.push("");
  lines.push("| category | self ms | % of recording | % of busy |");
  lines.push("|---|---|---|---|");
  for (const [c, v] of Object.entries(a.categories).sort((x, y) => y[1].selfMs - x[1].selfMs)) lines.push(`| ${c} | ${v.selfMs} | ${v.selfPct} | ${v.selfBusyPct ?? "-"} |`);
  lines.push("");
  lines.push(`## Bottom-Up: top ${top} functions by self time`);
  lines.push("");
  lines.push("% busy = share of non-idle samples (most stable between runs). % rec = share of the whole recording, as DevTools shows it.");
  lines.push("");
  lines.push("| # | function | file:line | self ms | self % busy | self % rec | total % busy |");
  lines.push("|---|---|---|---|---|---|---|");
  a.functions.filter((f) => f.name !== "(idle)" && f.category !== "profiler").slice(0, top).forEach((f, i) => {
    lines.push(`| ${i + 1} | \`${f.name}\` | ${f.file ? `${f.file}:${f.line}` : "-"} | ${f.selfMs} | ${f.selfBusyPct} | ${f.selfPct} | ${f.totalBusyPct} |`);
  });
  lines.push("");
  lines.push(`## Top ${Math.min(top, 20)} functions by total time (arena + engine code)`);
  lines.push("");
  lines.push("| # | function | file:line | total % busy | self % busy |");
  lines.push("|---|---|---|---|---|");
  a.functions.filter((f) => f.category === "arena" || f.category === "engine").sort((x, y) => y.totalMs - x.totalMs).slice(0, Math.min(top, 20)).forEach((f, i) => {
    lines.push(`| ${i + 1} | \`${f.name}\` | ${f.file}:${f.line} | ${f.totalBusyPct} | ${f.selfBusyPct} |`);
  });
  lines.push("");
  lines.push("## Self time by file (top 20)");
  lines.push("");
  lines.push("| file | self ms | self % busy |");
  lines.push("|---|---|---|");
  for (const f of a.files.filter((f) => f.file !== "(idle)").slice(0, 20)) lines.push(`| ${f.file} | ${f.selfMs} | ${f.selfBusyPct} |`);
  lines.push("");
  return lines.join("\n");
}
