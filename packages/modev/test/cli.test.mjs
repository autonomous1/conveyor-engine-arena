// ARCHITECTURE: the modev query contract — exact symbols, bounded sections, the
// stitched entity row, and the drift report each defect once.
// Wiring: `node --test test/*.test.mjs` from packages/modev; fixtures are local.
// Order: pure-parser tests use the fixture directly; the drift test copies it
// first so the injected defects never touch the committed fixture.
// Invariants: a miss is exit 1 and no output; drift names one place per defect.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { drift, findFiles, findSymbols, findText, loadIndex, queryEntity, querySection } from "../lib/index.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "fixtures");
const CLI = path.join(HERE, "..", "cli.mjs");
// Every spawn logs through MODEV_CACHE, so the suite never touches the package's
// real .cache — a test must not pollute the query history a session reads.
const CACHE = path.join(os.tmpdir(), "modev-test-cache");

function tempFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "modev-test-"));
  cpSync(FIXTURE, root, { recursive: true });
  return root;
}

test("symbol lookup is exact and carries its contract", () => {
  const index = loadIndex(FIXTURE);
  const [plan] = findSymbols(index, "plan");
  assert.equal(plan.kind, "async fn");
  assert.deepEqual(plan.calls, ["satisfies", "unmet"]);
  assert.equal(plan.tags[0].tag, "@why");
  assert.deepEqual(index.codemap.files.get(plan.file).usedBy, ["src/server/bot-brain.ts"]);
  assert.equal(findSymbols(index, "pla").length, 0);
});

test("a local symbol keeps its locality", () => {
  const index = loadIndex(FIXTURE);
  const [local] = findSymbols(index, "LOCAL");
  assert.equal(local.local, true);
});

test("a numbered section stops at the next unnumbered heading", () => {
  const index = loadIndex(FIXTURE);
  const [entities] = querySection(index, "shared", "§13.6");
  assert.match(entities.text, /Domain entities/);
  assert.doesNotMatch(entities.text, /Ownership and authority graph/);
});

test("a chapter section keeps its unnumbered subsections", () => {
  const index = loadIndex(FIXTURE);
  const [chapter] = querySection(index, "host", "13");
  assert.match(chapter.text, /Ownership graph/);
});

test("an entity row is the stitched view", () => {
  const index = loadIndex(FIXTURE);
  const [pawn] = queryEntity(index, "Pawn");
  assert.match(pawn.factory, /createPawnHealth/);
  assert.match(pawn.host, /health\.rows/);
  assert.match(pawn.test, /health\.test\.ts/);
});

test("find is the substring entry point", () => {
  const index = loadIndex(FIXTURE);
  const hits = findText(index, "pla");
  assert.ok(hits.some((hit) => hit.name === "plan"));
});

test("drift is clean on the fixture and one finding per defect", () => {
  const root = tempFixture();
  assert.deepEqual(drift(loadIndex(root)), []);

  const flow = path.join(root, "agents/host-flow.md");
  writeFileSync(flow, readFileSync(flow, "utf8") + "\nSee `src/gone.ts` and `host-kb.md` §99.\n");
  const shared = path.join(root, "agents/shared-model.md");
  writeFileSync(shared, readFileSync(shared, "utf8").replace("`health.test.ts`", "`ghost.test.ts`"));

  const findings = drift(loadIndex(root));
  const messages = findings.map((f) => f.message);
  assert.equal(findings.length, 3, messages.join("\n"));
  assert.ok(messages.some((m) => m.includes("src/gone.ts does not exist")));
  assert.ok(messages.some((m) => m.includes("§99 is not in the host KB")));
  assert.ok(messages.some((m) => m.includes("ghost.test.ts")));
  rmSync(root, { recursive: true, force: true });
});

test("the CLI contract: found is 0, a miss is 1, usage is 2", () => {
  const ok = spawnSync(process.execPath, [CLI, "query", "symbol", "plan", "--root", FIXTURE], { encoding: "utf8", env: { ...process.env, MODEV_CACHE: CACHE } });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /^plan {2}async fn/m);

  const miss = spawnSync(process.execPath, [CLI, "query", "symbol", "nope", "--root", FIXTURE], { encoding: "utf8", env: { ...process.env, MODEV_CACHE: CACHE } });
  assert.equal(miss.status, 1);

  const usage = spawnSync(process.execPath, [CLI, "query", "symbol", "--root", FIXTURE], { encoding: "utf8", env: { ...process.env, MODEV_CACHE: CACHE } });
  assert.equal(usage.status, 2);
});

test("query file lists a module's contract", () => {
  const index = loadIndex(FIXTURE);
  const [file] = findFiles(index, "src/shared/bots/goap.ts");
  assert.equal(file.doc, "A planner sketch.");
  assert.deepEqual(file.imports, ["src/shared/bots/state.ts"]);
  assert.deepEqual(file.symbols.map((s) => s.name), ["Fact", "plan", "LOCAL", "Aabb"]);
  assert.equal(findFiles(index, "goap.ts").length, 1);
  assert.equal(findFiles(index, "nope.ts").length, 0);
});

test("the query log records the session", () => {
  const result = spawnSync(process.execPath, [CLI, "query", "symbol", "plan", "--root", FIXTURE], {
    encoding: "utf8",
    env: { ...process.env, MODEV_SESSION: "test-cli", MODEV_CACHE: CACHE },
  });
  assert.equal(result.status, 0, result.stderr);
  const log = path.join(CACHE, "queries.jsonl");
  const lines = readFileSync(log, "utf8").trim().split("\n");
  const last = JSON.parse(lines[lines.length - 1]);
  assert.equal(last.session, "test-cli");
  assert.equal(last.command, "symbol");
  assert.equal(last.arg, "plan");
});

test("a file newer than the codemap is flagged stale, and a miss says why", () => {
  const root = tempFixture();
  const future = new Date(Date.now() + 60_000);
  utimesSync(path.join(root, "src/shared/bots/goap.ts"), future, future);

  const hit = spawnSync(process.execPath, [CLI, "query", "symbol", "plan", "--root", root], { encoding: "utf8", env: { ...process.env, MODEV_CACHE: CACHE } });
  assert.equal(hit.status, 0);
  assert.match(hit.stdout, /stale: src\/shared\/bots\/goap\.ts changed after/);

  const miss = spawnSync(process.execPath, [CLI, "query", "symbol", "nope", "--root", root], { encoding: "utf8", env: { ...process.env, MODEV_CACHE: CACHE } });
  assert.equal(miss.status, 1);
  assert.match(miss.stderr, /run npm run codemap/);
  rmSync(root, { recursive: true, force: true });
});
