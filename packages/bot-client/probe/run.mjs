#!/usr/bin/env node
// One probe run against either bot-client tree. The probe keeps its canonical
// `../src/…` imports; BOT_CLIENT_TREE + the register do the switch.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const PROBE_DIR = fileURLToPath(new URL("./", import.meta.url));

const argv = process.argv.slice(2);
let tree = "src";
let cursor = 0;
if (argv[0] === "--tree") {
  tree = argv[1] ?? "";
  cursor = 2;
}
if (tree !== "src" && tree !== "proto") {
  console.error("usage: npm run probe -- [--tree src|proto] [probe.ts] [args...]");
  process.exit(2);
}

const first = argv[cursor];
const script = first === undefined || first.startsWith("--") ? "command-suite.ts" : first;
if (first !== undefined && !first.startsWith("--")) cursor += 1;
const requested = resolve(PROBE_DIR, script);
const probe = existsSync(requested) ? requested : resolve(PROBE_DIR, `${script}.ts`);
if (!existsSync(probe)) {
  console.error(`probe not found: ${probe}`);
  process.exit(2);
}

console.log(`probe tree=${tree} script=${script}`);
const child = spawn(process.execPath, ["--import", "./scripts/probe-register.mjs", probe, ...argv.slice(cursor)], {
  cwd: ROOT,
  env: { ...process.env, BOT_CLIENT_TREE: tree },
  stdio: "inherit",
});
child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
