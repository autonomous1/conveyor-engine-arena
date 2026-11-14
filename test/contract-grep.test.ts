/**
 * Convention gate: every JSDoc `@invariant` in `src/` must name an existing
 * test with `(test: <name>)`, or explicitly defer with `(test lands …)`.
 *
 * Scope is JSDoc tags only, matching the codemap extractor. `// Invariants:`
 * prose in a four-slot module header is not a tag and is not checked. The
 * check is line-based on purpose: importing `scripts/codemap.ts` would couple
 * this gate to the generator's internals.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

function* walkTs(dir: string): Generator<string> {
  for (const ent of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (ent.isFile() && ent.name.endsWith(".ts")) {
      yield join(ent.parentPath, ent.name);
    }
  }
}

function findInvariants(file: string): { file: string; line: number; text: string }[] {
  const lines = readFileSync(file, "utf8").split("\n");
  const out: { file: string; line: number; text: string }[] = [];
  let inJsdoc = false;
  let current: { line: number; parts: string[] } | null = null;
  const flush = (): void => {
    if (current) {
      out.push({ file, line: current.line, text: current.parts.join(" ").replace(/\s+/g, " ").trim() });
      current = null;
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!inJsdoc && line.includes("/**")) inJsdoc = true;
    if (inJsdoc) {
      const stripped = line.replace(/\s*\*\/\s*$/, "");
      const tagMatch = /@(\w+)\b\s*(.*)$/.exec(stripped);
      if (tagMatch) {
        flush();
        if (tagMatch[1] === "invariant") current = { line: i + 1, parts: [tagMatch[2]] };
      } else if (current) {
        current.parts.push(stripped.replace(/^\s*\*\s*/, ""));
      }
      if (line.includes("*/")) {
        flush();
        inJsdoc = false;
      }
    }
  }
  flush();
  return out;
}

function findTestNames(): Set<string> {
  const names = new Set<string>();
  for (const ent of readdirSync("test", { withFileTypes: true })) {
    if (!ent.isFile() || !ent.name.endsWith(".test.ts")) continue;
    const src = readFileSync(join("test", ent.name), "utf8");
    for (const m of src.matchAll(/\btest\(\s*["']([^"']+)["']/g)) names.add(m[1]);
  }
  return names;
}

test("every @invariant names a test or defers", () => {
  const names = findTestNames();
  const failures: string[] = [];
  for (const file of walkTs("src")) {
    for (const inv of findInvariants(file)) {
      const testRef = /\(test:\s*([a-zA-Z_][a-zA-Z0-9_]*)\)/.exec(inv.text);
      const deferral = /\(test lands [^)]+\)/.test(inv.text);
      if (testRef) {
        if (!names.has(testRef[1])) {
          failures.push(`${inv.file}:${inv.line} — @invariant names "${testRef[1]}" which does not exist`);
        }
      } else if (!deferral) {
        failures.push(`${inv.file}:${inv.line} — @invariant has no (test: name) and no (test lands …) deferral: "${inv.text}"`);
      }
    }
  }
  assert.deepEqual(failures, [], `@invariant without test pairing:\n${failures.join("\n")}`);
});
