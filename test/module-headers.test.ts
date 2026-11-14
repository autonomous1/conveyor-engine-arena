import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import ts from "typescript";

/** Directories this gate covers. Waves 2 and 3 append theirs. */
const SCOPES = ["src/server", "src/shared", "src/client"];
/** Byte-identical to task 09's appendix; not a header candidate. */
const FROZEN = new Set(["src/shared/bots/goap.ts"]);
const SLOTS = ["ARCHITECTURE", "Wiring", "Order", "Invariants"] as const;
const REQUIRED = ["ARCHITECTURE", "Wiring"] as const;

function* walk(dir: string): Generator<string> {
  for (const ent of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (ent.isFile() && ent.name.endsWith(".ts")) yield join(ent.parentPath, ent.name);
  }
}

function exportsOf(file: string): number {
  const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  let n = 0;
  for (const st of sf.statements) {
    if (ts.isExportDeclaration(st) || ts.isExportAssignment(st)) continue;
    if (!ts.canHaveModifiers(st)) continue;
    if ((ts.getModifiers(st) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) n++;
  }
  return n;
}

/** A module is a file with two or more exported declarations. */
function modules(): string[] {
  return SCOPES.flatMap((dir) => [...walk(dir)])
    .filter((file) => exportsOf(file) >= 2 && !FROZEN.has(relative(".", file)))
    .sort();
}

test("module_headers_present", () => {
  const missing: string[] = [];
  for (const file of modules()) {
    const text = readFileSync(file, "utf8");
    const firstImport = text.search(/^import\s/m);
    for (const slot of REQUIRED) {
      const at = text.search(new RegExp(`^// ${slot}:[ \\t]*\\S`, "m"));
      if (at < 0) missing.push(`${relative(".", file)}: ${slot}`);
      else if (firstImport >= 0 && at > firstImport) missing.push(`${relative(".", file)}: ${slot} after the first import`);
    }
  }
  assert.deepEqual(missing, []);
});

test("module_headers_are_well_formed", () => {
  const bad: string[] = [];
  for (const file of modules()) {
    const text = readFileSync(file, "utf8");
    for (const slot of SLOTS) {
      const m = new RegExp(`^// ${slot}:(.*)$`, "m").exec(text);
      if (m && m[1].trim().length === 0) bad.push(`${relative(".", file)}: empty ${slot}`);
    }
  }
  assert.deepEqual(bad, []);
});
