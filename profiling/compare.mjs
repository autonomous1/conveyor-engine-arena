#!/usr/bin/env node
// Compare two profile summaries (or two result directories, matched by <kind>-<scenario>).
// node profiling/compare.mjs <baseline.summary.json|dir> <current.summary.json|dir>
//      [--out compare.md] [--threshold-pp 2] [--ratio 1.5] [--min-pct 1] [--top 25] [--fail-on-regress]
// Percentages are self % of busy (non-idle) samples, which is the most stable number between runs and machines.
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseArgs, round } from "./lib/util.mjs";

const args = parseArgs(process.argv.slice(2), { thresholdPp: 2, ratio: 1.5, minPct: 1, top: 25, metricRatio: 1.5 });
const [aPath, bPath] = args._;
if (!aPath || !bPath) { console.error("usage: compare.mjs <baseline> <current> [--out file.md] [--threshold-pp 2] [--ratio 1.5] [--min-pct 1] [--fail-on-regress]"); process.exit(1); }
const TH = Number(args.thresholdPp), RATIO = Number(args.ratio), MIN = Number(args.minPct), TOP = Number(args.top), MRATIO = Number(args.metricRatio);

async function load(p) {
  if ((await stat(p)).isDirectory()) {
    const out = new Map();
    for (const f of (await readdir(p)).filter((f) => f.endsWith(".summary.json")).sort()) {
      const s = JSON.parse(await readFile(join(p, f), "utf8"));
      out.set(`${s.kind}-${s.scenario}`, s);
    }
    return out;
  }
  const s = JSON.parse(await readFile(p, "utf8"));
  return new Map([[`${s.kind}-${s.scenario}`, s]]);
}

const A = await load(aPath), B = await load(bPath);
let pairs = [...A.keys()].filter((k) => B.has(k)).map((k) => [k, A.get(k), B.get(k)]);
if (pairs.length === 0 && A.size === 1 && B.size === 1) pairs = [[`${[...A.keys()][0]} vs ${[...B.keys()][0]}`, [...A.values()][0], [...B.values()][0]]];
const unmatched = [...A.keys(), ...B.keys()].filter((k) => !(A.has(k) && B.has(k)));
const fmt = (x) => (x === undefined || x === null ? "-" : x);
const sign = (x) => (x > 0 ? `+${x}` : `${x}`);
const allFlags = [];
const lines = [];
const first = pairs[0];
lines.push(`# Profile compare: ${first?.[1].build ?? basename(aPath)} → ${first?.[2].build ?? basename(bPath)}`);
lines.push("");
lines.push(`Flags: self % busy up by ≥ ${TH} pp, or ≥ ${RATIO}x when the current share is ≥ ${MIN}%; metric p95/mean up ≥ ${MRATIO}x. Exit code is 0 unless --fail-on-regress.`);
lines.push("");

const metricKeys = ["tickMs", "hostTickMs", "frameMs", "cpuPctOneCore", "mainThreadTaskPct", "scriptPct"];

for (const [key, a, b] of pairs) {
  const flags = [];
  lines.push(`## ${key}`);
  lines.push("");
  lines.push(`baseline **${a.build}** (${new Date(a.recordedAt).toISOString().slice(0, 16)}Z, ${a.machine?.host ?? "?"}, ${a.config?.mode ?? a.kind}) vs current **${b.build}** (${new Date(b.recordedAt).toISOString().slice(0, 16)}Z, ${b.machine?.host ?? "?"}, ${b.config?.mode ?? b.kind})`);
  if (a.machine?.host !== b.machine?.host) lines.push("> Different machines: absolute timings are not comparable; use the % busy columns.");
  lines.push("");
  lines.push(`Busy (non-idle): ${a.analysis.busyPct}% → ${b.analysis.busyPct}% of the recording.`);
  lines.push("");
  // Metrics
  lines.push("### Metrics");
  lines.push("");
  lines.push("| metric | base mean | cur mean | base p50 | cur p50 | base p95 | cur p95 | p95 (or mean) ratio |");
  lines.push("|---|---|---|---|---|---|---|---|");
  const mk = [...new Set([...Object.keys(a.metrics ?? {}), ...Object.keys(b.metrics ?? {})])];
  for (const k of mk) {
    const x = a.metrics?.[k], y = b.metrics?.[k];
    if (!x || !y || typeof x !== "object" || typeof y !== "object") continue;
    const bx = x.p95 ?? x.mean, by = y.p95 ?? y.mean;
    const r = bx > 0 && by !== undefined ? round(by / bx, 2) : undefined;
    const hot = r !== undefined && r >= MRATIO && metricKeys.some((m) => k.startsWith(m)) && by - bx > 0.5;
    if (hot) flags.push(`metric ${k}: ${bx} → ${by} (${r}x)`);
    lines.push(`| ${k} | ${fmt(x.mean)} | ${fmt(y.mean)} | ${fmt(x.p50)} | ${fmt(y.p50)} | ${fmt(x.p95)} | ${fmt(y.p95)} | ${fmt(r)}${hot ? " ⚠" : ""} |`);
  }
  lines.push("");
  // Categories
  lines.push("### Categories (self % busy)");
  lines.push("");
  lines.push("| category | base | current | Δ pp |");
  lines.push("|---|---|---|---|");
  const cats = [...new Set([...Object.keys(a.analysis.categories), ...Object.keys(b.analysis.categories)])].filter((c) => c !== "(idle)" && c !== "profiler");
  for (const c of cats.sort((p, q) => (b.analysis.categories[q]?.selfBusyPct ?? 0) - (b.analysis.categories[p]?.selfBusyPct ?? 0))) {
    const x = a.analysis.categories[c]?.selfBusyPct ?? 0, y = b.analysis.categories[c]?.selfBusyPct ?? 0;
    lines.push(`| ${c} | ${x} | ${y} | ${sign(round(y - x, 2))} |`);
  }
  lines.push("");
  // Functions
  const fa = new Map(a.analysis.functions.filter((f) => f.selfBusyPct !== null).map((f) => [f.key, f]));
  const fb = new Map(b.analysis.functions.filter((f) => f.selfBusyPct !== null).map((f) => [f.key, f]));
  const rows = [...new Set([...fa.keys(), ...fb.keys()])].filter((k) => k !== "(idle)").map((k) => {
    const x = fa.get(k), y = fb.get(k);
    const base = x?.selfBusyPct ?? 0, cur = y?.selfBusyPct ?? 0;
    const d = round(cur - base, 2);
    const ratio = base > 0 ? round(cur / base, 2) : cur > 0 ? Infinity : 1;
    const f = y ?? x;
    const isNew = !x || base < 0.1;
    const regress = d >= TH || (cur >= MIN && ratio >= RATIO && d >= 0.5);
    return { key: k, name: f.name, file: f.file, line: f.line, base, cur, d, ratio, isNew, regress, totalBase: x?.totalBusyPct ?? 0, totalCur: y?.totalBusyPct ?? 0 };
  });
  for (const r of rows) if (r.regress) flags.push(`${r.name} (${r.file}): ${r.base}% → ${r.cur}% (${sign(r.d)} pp${Number.isFinite(r.ratio) ? `, ${r.ratio}x` : ", new"})`);
  const fileRow = (r) => `\`${r.name}\` | ${r.file ? `${r.file}:${r.line}` : "-"}`;
  lines.push(`### Biggest self % increases (top ${TOP})`);
  lines.push("");
  lines.push("| function | file:line | base self % | cur self % | Δ pp | ratio | base total % | cur total % |");
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const r of rows.filter((r) => r.d > 0).sort((p, q) => q.d - p.d).slice(0, TOP)) lines.push(`| ${fileRow(r)} | ${r.base} | ${r.cur} | ${sign(r.d)}${r.regress ? " ⚠" : ""} | ${Number.isFinite(r.ratio) ? r.ratio : "new"} | ${r.totalBase} | ${r.totalCur} |`);
  lines.push("");
  lines.push(`### Biggest self % decreases (top ${Math.min(TOP, 15)})`);
  lines.push("");
  lines.push("| function | file:line | base self % | cur self % | Δ pp |");
  lines.push("|---|---|---|---|---|");
  for (const r of rows.filter((r) => r.d < 0).sort((p, q) => p.d - q.d).slice(0, Math.min(TOP, 15))) lines.push(`| ${fileRow(r)} | ${r.base} | ${r.cur} | ${r.d} |`);
  lines.push("");
  const fresh = rows.filter((r) => r.isNew && r.cur >= MIN / 2).sort((p, q) => q.cur - p.cur);
  lines.push("### New hot functions (absent or < 0.1% in baseline)");
  lines.push("");
  if (fresh.length === 0) lines.push("None.");
  else { lines.push("| function | file:line | cur self % | cur total % |"); lines.push("|---|---|---|---|"); for (const r of fresh.slice(0, TOP)) lines.push(`| ${fileRow(r)} | ${r.cur} | ${r.totalCur} |`); }
  lines.push("");
  // Files
  const ga = new Map(a.analysis.files.map((f) => [f.file, f.selfBusyPct])), gb = new Map(b.analysis.files.map((f) => [f.file, f.selfBusyPct]));
  const frows = [...new Set([...ga.keys(), ...gb.keys()])].filter((f) => f !== "(idle)" && !f.startsWith("node:inspector")).map((f) => ({ f, x: ga.get(f) ?? 0, y: gb.get(f) ?? 0 })).map((r) => ({ ...r, d: round(r.y - r.x, 2) }));
  lines.push("### Files with the largest |Δ| self % busy (top 15)");
  lines.push("");
  lines.push("| file | base | current | Δ pp |");
  lines.push("|---|---|---|---|");
  for (const r of frows.sort((p, q) => Math.abs(q.d) - Math.abs(p.d)).slice(0, 15)) lines.push(`| ${r.f} | ${r.x} | ${r.y} | ${sign(r.d)} |`);
  lines.push("");
  lines.push(`### Flags: ${flags.length === 0 ? "none" : flags.length}`);
  lines.push("");
  for (const f of flags) lines.push(`- ⚠ ${f}`);
  lines.push("");
  allFlags.push(...flags.map((f) => `${key}: ${f}`));
}
if (unmatched.length) { lines.push(`Unmatched scenarios (only in one side): ${unmatched.join(", ")}`); lines.push(""); }
lines.splice(4, 0, `**Summary:** ${pairs.length} scenario(s) compared, ${allFlags.length} flag(s).`, "", ...allFlags.slice(0, 20).map((f) => `- ⚠ ${f}`), ...(allFlags.length ? [""] : []));
const md = lines.join("\n");
if (args.out) { await writeFile(args.out, md); console.log(`wrote ${args.out} (${allFlags.length} flags)`); } else process.stdout.write(md + "\n");
if (args.failOnRegress && allFlags.length) process.exit(2);
