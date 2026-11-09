#!/usr/bin/env node
// Bottom-Up drill-down: who calls a hot function? Like expanding a row in DevTools Bottom-Up.
// node profiling/callers.mjs <file.cpuprofile> <functionName> [--depth 4] [--top 12] [--solo-root dist/solo]
import { readFile } from "node:fs/promises";
import { makeSourceMapLoader, normalizeUrl } from "./lib/bottom-up.mjs";
import { nameFromSource } from "./lib/sourcemap.mjs";
import { parseArgs, round } from "./lib/util.mjs";

const args = parseArgs(process.argv.slice(2), { depth: 4, top: 12 });
const [file, target] = args._;
if (!file || !target) { console.error("usage: callers.mjs <file.cpuprofile> <functionName> [--depth 4] [--top 12] [--solo-root dir]"); process.exit(1); }
const profile = JSON.parse(await readFile(file, "utf8"));
const loader = makeSourceMapLoader({ fsRoot: args.soloRoot });
const maps = new Map();
const label = new Map();
for (const n of profile.nodes) {
  const cf = n.callFrame;
  let name = cf.functionName || "(anonymous)", where = `${normalizeUrl(cf.url)}:${cf.lineNumber + 1}`;
  if (cf.url) {
    if (!maps.has(cf.url)) maps.set(cf.url, await loader(cf.url).catch(() => undefined));
    const sm = maps.get(cf.url);
    if (sm && !sm.identity) {
      const h = sm.lookup(cf.lineNumber, cf.columnNumber);
      if (h) { where = `${normalizeUrl(h.source)}:${h.line + 1}`; if (!(args.soloRoot === undefined && cf.functionName)) name = nameFromSource(h.text, h.col) ?? "(anonymous)"; }
    } else if (sm?.identity && name === "(anonymous)") name = nameFromSource(sm.lookup(cf.lineNumber, cf.columnNumber).text, cf.columnNumber) ?? name;
  }
  label.set(n.id, { name, where });
}
const parent = new Map();
for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
const self = new Map();
let total = 0;
profile.samples.forEach((s, i) => { const d = profile.timeDeltas[i] ?? 0; total += d; self.set(s, (self.get(s) ?? 0) + d); });
const paths = new Map();
let hit = 0;
for (const [id, us] of self) {
  if (label.get(id).name !== target) continue;
  hit += us;
  const chain = [];
  for (let cur = parent.get(id); cur !== undefined && chain.length < Number(args.depth); cur = parent.get(cur)) {
    const l = label.get(cur);
    if (l.name === "(root)") break;
    chain.push(`${l.name} (${l.where})`);
  }
  const k = chain.join("  <-  ") || "(top level)";
  paths.set(k, (paths.get(k) ?? 0) + us);
}
console.log(`${target}: self ${round(hit / 1000, 1)} ms (${round((100 * hit) / total, 2)}% of recording). Callers, ${args.depth} frames up:`);
for (const [k, us] of [...paths].sort((a, b) => b[1] - a[1]).slice(0, Number(args.top))) console.log(`  ${round((100 * us) / Math.max(1, hit), 1)}%  ${k}`);
