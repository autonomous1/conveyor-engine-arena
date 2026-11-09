#!/usr/bin/env node
// Host + client scenarios for one build, into profiling/results/<label>/.
// node profiling/run-all.mjs [--root <repo>] [--label name] [--out dir] [--skip-host] [--skip-client]
//      [--duration 30] [--host-warmup 5] [--client-warmup 8] [--headed | --attach 9222] [--repeat 1]
// Any other flags are passed to profile-client.mjs (e.g. --width/--height/--chrome).
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { buildLabel, buildRoot, parseArgs } from "./lib/util.mjs";

const here = new URL(".", import.meta.url).pathname;
const args = parseArgs(process.argv.slice(2), { duration: 30, hostWarmup: 5, clientWarmup: 8, repeat: 1 });
const root = buildRoot(args.root);
const label = buildLabel(root, args.label);
const repeat = Number(args.repeat);
const passthrough = ["headed", "attach", "chrome", "width", "height", "query", "sampleUs", "noProfileFile"]
  .filter((k) => args[k] !== undefined)
  .flatMap((k) => [`--${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`, ...(args[k] === true ? [] : [String(args[k])])]);
let failed = 0;
for (let i = 1; i <= repeat; i++) {
  const out = resolve(args.out ?? join(here, "results", label)) + (repeat > 1 ? `/run${i}` : "");
  const run = (script, extra) => {
    const r = spawnSync(process.execPath, [join(here, script), "--root", root, "--label", label, "--out", out, "--duration", String(args.duration), ...extra], { stdio: "inherit" });
    if (r.status !== 0) { failed++; console.error(`${script} failed (${r.status})`); }
  };
  if (!args.skipHost) run("profile-host.mjs", ["--warmup", String(args.hostWarmup), ...(args.players ? ["--players", String(args.players)] : [])]);
  if (!args.skipClient) run("profile-client.mjs", ["--warmup", String(args.clientWarmup), ...passthrough]);
  console.log(`results: ${out}`);
}
process.exit(failed ? 1 : 0);
