// ARCHITECTURE: the lints' own proof — each lint, run on a fixture that violates
// exactly one thing, must report exactly one finding, and a clean fixture must pass.
// Wiring: `npm --prefix packages/modev run self-check`; builds fixtures under os.tmpdir().
// Order: clean fixture first, then one dirty fixture per lint; the other lints must stay quiet.
// Invariants: the self-check never touches the real repo; every fixture is temporary.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const lints = {};
for (const file of ["kb-length", "kb-section-refs", "kb-count-claims"]) {
  lints[file] = await import(path.join(here, "lints", `${file}.mjs`));
}

const KBS = {
  "host-kb.md": "# Host knowledge base — index\n\nSee `agents/host-flow.md` §1 and `agents/host-model.md` §13.\n",
  "host-flow.md": "# Host flow\n\n## 1. Boot\n\nx\n",
  "host-model.md": "# Host model\n\n## 13. State\n\n| a | b |\n",
  "shared-kb.md": "# Shared knowledge base — index\n\nSee `agents/shared-flow.md` §2 and `agents/shared-model.md` §11.\n",
  "shared-flow.md": "# Shared flow\n\n## 2. Wire\n\nx\n",
  "shared-model.md": "# Shared model\n\n## 11. Invariants\n\nx\n",
  "client-kb.md": "# Client knowledge base\n\n## 13. Client state\n\nx\n",
};

function fixture(overrides = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "modev-"));
  mkdirSync(path.join(root, "agents"));
  mkdirSync(path.join(root, "test"));
  writeFileSync(path.join(root, "test/scopes.json"), JSON.stringify({ always: ["a", "b", "c", "d", "e", "f"] }));
  for (const [name, body] of Object.entries({ ...KBS, ...overrides })) {
    writeFileSync(path.join(root, "agents", name), body);
  }
  return root;
}

function counts(root) {
  return Object.fromEntries(Object.entries(lints).map(([id, lint]) => [id, lint.run(root).length]));
}

const clean = fixture();
assert.deepEqual(counts(clean), { "kb-length": 0, "kb-section-refs": 0, "kb-count-claims": 0 }, "clean fixture");

const long = fixture({ "host-model.md": "# Host model\n\n## 13. State\n\n" + "filler\n".repeat(400) });
assert.deepEqual(counts(long), { "kb-length": 1, "kb-section-refs": 0, "kb-count-claims": 0 }, "length fixture");

const dangling = fixture({ "host-model.md": "# Host model\n\n## 13. State\n\nSee `host-kb.md` §99.\n" });
assert.deepEqual(counts(dangling), { "kb-length": 0, "kb-section-refs": 1, "kb-count-claims": 0 }, "ref fixture");

const claim = fixture({ "client-kb.md": "# Client knowledge base\n\n## 13. State\n\nFive `always` gates.\n" });
assert.deepEqual(counts(claim), { "kb-length": 0, "kb-section-refs": 0, "kb-count-claims": 1 }, "claim fixture");

for (const root of [clean, long, dangling, claim]) rmSync(root, { recursive: true, force: true });
console.log("modev: self-check passed — 4 fixtures, one finding per failure mode");
