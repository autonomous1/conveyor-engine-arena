import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export function parseArgs(argv, defaults = {}) {
  const out = { ...defaults, _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { out._.push(a); continue; }
    const eq = a.indexOf("=");
    const key = (eq > 0 ? a.slice(2, eq) : a.slice(2)).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (eq > 0) { out[key] = a.slice(eq + 1); continue; }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Repo root of the build to profile. Default: the repo this profiling/ folder lives in. */
export function buildRoot(arg) {
  const root = resolve(arg ?? new URL("../..", import.meta.url).pathname);
  if (!existsSync(resolve(root, "package.json"))) throw new Error(`not a repo root: ${root}`);
  return root;
}

export function buildLabel(root, explicit) {
  if (explicit) return explicit;
  try {
    const sha = execFileSync("git", ["-C", root, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["-C", root, "status", "--porcelain", "--untracked-files=no", "--", "src", "packages", "scripts"], { encoding: "utf8" }).trim();
    return dirty ? `${sha}-dirty` : sha;
  } catch {
    return "unknown";
  }
}

export function stats(values) {
  const v = values.filter((x) => Number.isFinite(x)).slice().sort((a, b) => a - b);
  if (v.length === 0) return { n: 0 };
  const q = (p) => v[Math.min(v.length - 1, Math.floor(p * (v.length - 1)))];
  const mean = v.reduce((s, x) => s + x, 0) / v.length;
  return { n: v.length, mean: round(mean), p50: round(q(0.5)), p95: round(q(0.95)), p99: round(q(0.99)), max: round(v[v.length - 1]) };
}

export const round = (x, d = 3) => Math.round(x * 10 ** d) / 10 ** d;

export function machineInfo() {
  return import("node:os").then((os) => ({
    host: os.hostname(), cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model, platform: `${os.platform()} ${os.release()}`, node: process.version,
    loadavg: os.loadavg().map((x) => round(x, 2)),
  }));
}
