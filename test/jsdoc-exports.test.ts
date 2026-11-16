import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import ts from "typescript";

const SCOPES = ["src", "packages/bot-client/src", "scripts"];
const FROZEN = new Set(["src/shared/bots/goap.ts"]);

function* walk(dir: string): Generator<string> {
  for (const ent of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (ent.isFile() && ent.name.endsWith(".ts")) yield join(ent.parentPath, ent.name);
  }
}

function jsdocText(text: string, st: ts.Statement): string | undefined {
  const ranges = ts.getLeadingCommentRanges(text, st.getFullStart()) ?? [];
  const doc = [...ranges].reverse().find((range) => text.slice(range.pos, range.end).startsWith("/**"));
  return doc ? text.slice(doc.pos, doc.end) : undefined;
}

test("every_exported_declaration_has_jsdoc", () => {
  const missing: string[] = [];
  const filler: string[] = [];
  for (const file of new Set(SCOPES.flatMap((dir) => [...walk(dir)]))) {
    if (FROZEN.has(relative(".", file)) || file.endsWith(".test.ts")) continue;
    const text = readFileSync(file, "utf8");
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    for (const st of sf.statements) {
      if (ts.isExportDeclaration(st) || ts.isExportAssignment(st)) continue;
      if (!ts.canHaveModifiers(st)) continue;
      if (!(ts.getModifiers(st) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
      const doc = jsdocText(text, st);
      if (!doc) missing.push(relative(".", file));
      else if (/^\s*\*\s*@see\s+.*\.ts\s*$/m.test(doc)) filler.push(`${relative(".", file)}:${st.getText(sf).slice(0, 40)}`);
    }
  }
  assert.deepEqual([...new Set(missing)].sort(), []);
  assert.deepEqual([...new Set(filler)].sort(), [], "@see must name a symbol/test/decision, not a .ts file");
});
