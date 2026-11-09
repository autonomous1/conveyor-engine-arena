#!/usr/bin/env node
// node profiling/analyze.mjs <file.cpuprofile> [--out summary.json] [--top 30] [--solo-root dist/solo]
// Re-analyzes a raw profile (e.g. one saved from DevTools) into the same summary/report format.
import { readFile, writeFile } from "node:fs/promises";
import { analyzeProfile, makeSourceMapLoader, renderMarkdown } from "./lib/bottom-up.mjs";
import { machineInfo, parseArgs } from "./lib/util.mjs";

const args = parseArgs(process.argv.slice(2), { top: 30 });
const file = args._[0];
if (!file) { console.error("usage: analyze.mjs <file.cpuprofile> [--out x.json] [--solo-root dir] [--label build] [--kind host|client (host keeps V8 names)] [--scenario name]"); process.exit(1); }
const profile = JSON.parse(await readFile(file, "utf8"));
const analysis = await analyzeProfile(profile, { sourceMapLoader: makeSourceMapLoader({ fsRoot: args.soloRoot }), trustNames: args.kind === "host" || !!args.trustNames });
const summary = { kind: args.kind ?? "profile", scenario: args.scenario ?? file, build: args.label ?? "?", recordedAt: Date.now(), machine: await machineInfo(), analysis };
const out = args.out ?? file.replace(/\.cpuprofile$/, "") + ".summary.json";
await writeFile(out, JSON.stringify(summary, null, 1));
await writeFile(out.replace(/\.json$/, ".md"), renderMarkdown(summary, Number(args.top)));
console.log(`wrote ${out}`);
