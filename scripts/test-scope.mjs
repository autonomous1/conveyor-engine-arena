// Scope and related-test selector. The manifest is the single source of scope
// membership; the CLI is a development loop, never the merge gate.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, normalize, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function allTests() {
  return readdirSync("test").filter((file) => file.endsWith(".test.ts")).sort();
}

export function matchScopes(manifest, file) {
  const name = file.replace(/^.*\//, "");
  const out = [];
  for (const [scope, patterns] of Object.entries(manifest.scopes)) {
    if (patterns.some((pattern) => new RegExp(pattern).test(name))) out.push(scope);
  }
  return out;
}

export function pathScopes(file) {
  const path = normalize(file).replace(/\\/g, "/").replace(/^\.\//, "");
  const rules = [
    [/^src\/shared\/nav\//, ["nav"]],
    [/^src\/shared\/doors\.ts$/, ["doors", "nav"]],
    [/^src\/shared\/scene-graph\.ts$/, ["doors", "nav", "shared"]],
    [/^src\/shared\/bots\//, ["bot", "nav"]],
    [/^src\/server\//, ["server", "bot"]],
    [/^src\/client\//, ["client"]],
    [/^src\/shared\//, ["shared"]],
    [/^packages\/bot-client\//, ["bot"]],
    [/^web\/game\//, ["server", "client"]],
    [/^test\//, ["meta"]],
  ];
  for (const [pattern, scopes] of rules) if (pattern.test(path)) return scopes;
  return [];
}

export function selectScope(manifest, scopes) {
  const wanted = new Set(scopes);
  const selected = new Set(manifest.always);
  for (const file of allTests()) {
    if (matchScopes(manifest, file).some((scope) => wanted.has(scope))) selected.add(file);
  }
  return [...selected].sort();
}

function importSpecs(file) {
  const text = readFileSync(file, "utf8");
  const specs = [];
  const re = /(?:from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']/g;
  for (let match = re.exec(text); match; match = re.exec(text)) specs.push(match[1]);
  return specs;
}

function resolveSpec(testFile, spec) {
  if (!spec.startsWith(".")) return undefined;
  const base = resolve(dirname(testFile), spec).replace(/\.js$/, ".ts").replace(/\\/g, "/");
  const withTs = base.endsWith(".ts") ? base : `${base}.ts`;
  const mapped = withTs.startsWith(`${process.cwd()}/dist/`)
    ? withTs.replace(`${process.cwd()}/dist/`, "src/")
    : withTs.startsWith("dist/")
      ? withTs.replace(/^dist\//, "src/")
      : withTs;
  return mapped.replace(new RegExp(`^${process.cwd()}/`), "");
}

export function directImporters(changed, tests = allTests()) {
  const wanted = new Set(changed.map((file) => normalize(file).replace(/\\/g, "/").replace(/^\.\//, "")));
  const out = [];
  for (const file of tests) {
    const testFile = `test/${file}`;
    const imports = importSpecs(testFile).map((spec) => resolveSpec(testFile, spec)).filter(Boolean);
    if (imports.some((item) => wanted.has(item))) out.push(file);
  }
  return out;
}

function modifiedFiles() {
  const run = (args) => spawnSync("git", args, { encoding: "utf8" }).stdout ?? "";
  const rows = [
    ...run(["diff", "--name-only", "HEAD"]).split("\n"),
    ...run(["ls-files", "--others", "--exclude-standard"]).split("\n"),
  ];
  return [...new Set(rows.map((row) => row.trim()).filter(Boolean))]
    .filter((file) => /^(src|packages|test|web|scripts)\//.test(file));
}

function needsDist(file) {
  return /from ["']\.\.\/dist\//.test(readFileSync(`test/${file}`, "utf8"));
}

/** Server-build outputs that are not under `dist/server|shared|bot|util`. */
const SERVER_DIST = /dist\/(?:server|shared|bot|util)\/|dist\/(?:index|arena-assets)\.js/;

function buildCommands(tests) {
  const list = tests.filter((file) => needsDist(file));
  const commands = [];
  if (list.some((file) => /dist\/web/.test(readFileSync(`test/${file}`, "utf8")))) commands.push("npm run build:client");
  if (list.some((file) => SERVER_DIST.test(readFileSync(`test/${file}`, "utf8")))) commands.push("npm run build:server");
  return commands;
}

/** Inputs a command reads and the output that proves it ran. */
const BUILD_INPUTS = {
  "npm run build:server": ["src", "tsconfig.server.json", "package.json"],
  "npm run build:client": ["src", "web", "scripts/build-client.mjs", "package.json"],
};
const BUILD_OUTPUT = {
  "npm run build:server": "dist/server/main.js",
  "npm run build:client": "dist/web/client.js",
};

/** Newest mtime under a file or directory; a missing path is Infinity so it forces a build. */
function newestMtime(target) {
  try {
    const stat = statSync(target);
    if (!stat.isDirectory()) return stat.mtimeMs;
    let newest = 0;
    for (const entry of readdirSync(target, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const mtime = statSync(`${entry.parentPath}/${entry.name}`).mtimeMs;
      if (mtime > newest) newest = mtime;
    }
    return newest;
  } catch {
    return Infinity;
  }
}

/** A command's output is fresh when it is at least as new as every input it reads. */
function isFresh(output, inputs) {
  const out = newestMtime(output);
  if (!Number.isFinite(out)) return false;
  return inputs.every((input) => out >= newestMtime(input));
}

function run(args) {
  const child = spawnSync("npm", ["run", ...args], { stdio: "inherit" });
  if (child.status !== 0) process.exit(child.status ?? 1);
}

function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const dryRun = argv.includes("--dry-run");
  const noBuild = argv.includes("--no-build");
  const args = argv.slice(1).filter((arg) => !arg.startsWith("--"));
  const manifest = JSON.parse(readFileSync("test/scopes.json", "utf8"));
  const tests = allTests();
  let selected;

  if (command === "scope") {
    const scopes = args.flatMap((arg) => arg.split(",")).filter(Boolean);
    selected = selectScope(manifest, scopes);
  } else if (command === "related") {
    const changed = args.length > 0 ? args : modifiedFiles();
    const scopes = [...new Set(changed.flatMap((file) => pathScopes(file)))];
    selected = [...new Set([...selectScope(manifest, scopes), ...directImporters(changed, tests), ...manifest.always])].sort();
  } else {
    console.error("usage: node scripts/test-scope.mjs scope <names> | related <files...> [--dry-run] [--no-build]");
    process.exit(2);
  }

  const commands = buildCommands(selected);
  const pending = commands.filter((command) => !isFresh(BUILD_OUTPUT[command], BUILD_INPUTS[command]));
  console.log(`selected ${selected.length}/${tests.length} (always ${manifest.always.length}); build ${commands.length === 0 ? "no" : pending.length === 0 ? "skipped (fresh)" : "yes"}`);
  if (dryRun) {
    for (const file of selected) console.log(file);
    for (const command of pending) console.log(`build: ${command}`);
    return;
  }
  if (commands.length) {
    if (noBuild) for (const command of commands) console.log(`build skipped: ${command}`);
    else for (const command of pending) run(command.split(" ").slice(2));
  }
  const child = spawnSync(
    process.execPath,
    ["--import", "./scripts/ts-ext-register.mjs", "--test", ...selected.map((file) => `test/${file}`)],
    { stdio: "inherit" },
  );
  process.exit(child.status ?? 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
