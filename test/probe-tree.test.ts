import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

/** The real resolver: the register loads the tree hook for this child only. */
function probe(tree: "src" | "proto") {
  return spawnSync(
    process.execPath,
    ["--import", "./scripts/probe-register.mjs", "packages/bot-client/probe/tree.ts"],
    { cwd: ROOT, encoding: "utf8", env: { ...process.env, BOT_CLIENT_TREE: tree } },
  );
}

test("probe_tree_resolves_src_connection", () => {
  const run = probe("src");
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /tree=src connection=.*\/packages\/bot-client\/src\/connection\.ts/);
});

test("probe_tree_resolves_proto_connection", () => {
  const run = probe("proto");
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /tree=proto connection=.*\/packages\/bot-client\/proto\/connection\.ts/);
});
