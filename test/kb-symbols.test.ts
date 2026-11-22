import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
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
  "bot-kb.md",
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

// A backticked identifier in a KB must exist somewhere in the tree: a symbol, a
// local, a method, or a string the code uses. A typo or a renamed symbol fails
// here; a wrong *file* attribution is `modev drift`'s job, not this gate's.
const WORDS = new Set<string>();
for (const dir of [path.join(root, "src"), path.join(root, "packages")]) {
  for (const ent of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!ent.isFile() || !ent.name.endsWith(".ts")) continue;
    const text = readFileSync(path.join(ent.parentPath, ent.name), "utf8");
    for (const word of text.split(/[^A-Za-z0-9_]+/)) if (word) WORDS.add(word);
  }
}
const ALLOWED = new Set(["RangeError"]);

for (const name of KBS) {
  test(`${name} identifiers exist in the tree`, () => {
    const text = readFileSync(path.join(root, "agents", name), "utf8");
    const missing: string[] = [];
    for (const [index, line] of text.split("\n").entries()) {
      for (const match of line.matchAll(/`([A-Za-z_][A-Za-z0-9_]*)`/g)) {
        const token = match[1];
        if (token.length < 3 || WORDS.has(token) || ALLOWED.has(token)) continue;
        missing.push(`${name}:${index + 1} ${token}`);
      }
    }
    assert.deepEqual(missing, [], `KB identifiers not found in src/ or packages/:\n${missing.join("\n")}`);
  });
}
