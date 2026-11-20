import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
// The split halves are content; the *-kb.md files are indexes. All of them are
// KB prose with the same no-path:line rule (agents/model-developer-role.md).
const KBS = [
  "host-kb.md",
  "host-flow.md",
  "host-model.md",
  "shared-kb.md",
  "shared-flow.md",
  "shared-model.md",
  "client-kb.md",
] as const;
const pathLine = /[A-Za-z0-9_./-]+\.(?:ts|json|md):\d+/;
const bareLine = /`:\d+(?:-\d+)?`/;

for (const name of KBS) {
  test(`${name} cites symbols, not lines`, () => {
    const text = readFileSync(path.join(root, "agents", name), "utf8");
    assert.equal(pathLine.test(text), false, `${name} has a path:line citation; cite the file and symbol, let the codemap own the line`);
    assert.equal(bareLine.test(text), false, `${name} has a bare :line citation`);
  });
}
