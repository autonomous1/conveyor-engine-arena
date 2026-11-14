import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { extractTags, renderTagLines, type ExtractedTag } from "../scripts/codemap.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const fixture = join(here, "fixtures/codemap-tags");
const samplePath = join(fixture, "sample.ts");
const barrelPath = join(fixture, "index.ts");

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
}

function functionDecl(sf: ts.SourceFile, name: string): ts.FunctionDeclaration {
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name?.text === name) return st;
  }
  throw new Error(`fixture is missing function ${name}`);
}

const BUMP_TAGS: ExtractedTag[] = [
  { name: "invariant", text: "`count` is never negative." },
  { name: "pre", text: "`step` is positive." },
  { name: "post", text: "Returns `count` incremented by `step`." },
  { name: "why", text: "Uses a loop so the assertion is trivially checkable." },
];

test("extractTags returns contract tags in fixed order with one-line text", () => {
  const tags = extractTags(functionDecl(parse(samplePath), "bump"));
  assert.deepEqual(tags, BUMP_TAGS);
});

test("tags reach a symbol through the barrel re-export", () => {
  const barrel = parse(barrelPath);
  const exportDecl = barrel.statements.find(ts.isExportDeclaration);
  assert.ok(exportDecl, "fixture barrel must re-export sample.ts");
  assert.ok(exportDecl.moduleSpecifier && ts.isStringLiteral(exportDecl.moduleSpecifier));
  assert.equal(exportDecl.moduleSpecifier.text, "./sample.js");

  // The re-export itself carries no JSDoc; the contract lives on the declaration.
  // The generator reads declarations in their declaring file, which is why a
  // barrel does not hide tags (the ts-morph getAliasedSymbol() trap).
  assert.deepEqual(extractTags(exportDecl), []);
  // Follow the barrel's specifier to the declaring file, the way the walker
  // reaches `bump`: it analyzes declarations where they are declared.
  const target = resolve(dirname(barrelPath), exportDecl.moduleSpecifier.text.replace(/\.js$/, ".ts"));
  assert.equal(target, samplePath);
  assert.deepEqual(extractTags(functionDecl(parse(target), "bump")), BUMP_TAGS);
});

test("only the closed vocabulary (plus @internal) is extracted", () => {
  const source = `/**
 * @param x ignored: the signature already says it
 * @returns ignored too
 * @deprecated not a contract tag
 * @invariant \`x\` stays non-negative.
 * @internal hidden from the rendered map
 */
export function f(x: number): number { return x; }
`;
  const sf = ts.createSourceFile("inline.ts", source, ts.ScriptTarget.Latest, true);
  const fn = functionDecl(sf, "f");
  assert.deepEqual(extractTags(fn), [
    { name: "invariant", text: "`x` stays non-negative." },
    { name: "internal", text: "hidden from the rendered map" },
  ]);
  assert.deepEqual(renderTagLines(extractTags(fn)), ["  `@invariant` `x` stays non-negative."]);
});

test("@internal is extracted but never rendered", () => {
  const helper = functionDecl(parse(samplePath), "helper");
  assert.deepEqual(extractTags(helper), [{ name: "internal", text: "" }]);
  assert.deepEqual(renderTagLines(extractTags(helper)), []);

  assert.deepEqual(renderTagLines(extractTags(functionDecl(parse(samplePath), "bump"))), [
    "  `@invariant` `count` is never negative.",
    "  `@pre` `step` is positive.",
    "  `@post` Returns `count` incremented by `step`.",
    "  `@why` Uses a loop so the assertion is trivially checkable.",
  ]);
});

function runGenerator(out: string): string {
  execFileSync(process.execPath, [join(root, "scripts/codemap.ts"), "--root", "test/fixtures/codemap-tags", "--out", out], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return readFileSync(out, "utf8");
}

test("generator emits tag lines two spaces under the symbol line", () => {
  const dir = mkdtempSync(join(tmpdir(), "codemap-tags-"));
  try {
    const out = runGenerator(join(dir, "codemap.md"));
    assert.match(
      out,
      /^- `bump` fn :\d+ `\(count: number, step: number\): number`\n  `@invariant` `count` is never negative\.\n  `@pre` `step` is positive\.\n  `@post` Returns `count` incremented by `step`\.\n  `@why` Uses a loop so the assertion is trivially checkable\.$/m,
    );
    // The same-file alias `jump` has no JSDoc of its own; it inherits bump's tags.
    assert.match(out, /^- `jump` export :\d+ `= bump`\n  `@invariant` /m);
    assert.match(out, /^  `@why` Exists so the tag extractor is tested without touching real source\.$/m);
    assert.doesNotMatch(out, /@internal/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("generator output is byte-identical across runs on the same tree", () => {
  const dir = mkdtempSync(join(tmpdir(), "codemap-tags-"));
  try {
    const out = join(dir, "codemap.md");
    const first = runGenerator(out);
    const second = runGenerator(out);
    assert.equal(second, first);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("generator source has no clock or randomness", () => {
  const source = readFileSync(join(root, "scripts/codemap.ts"), "utf8");
  assert.doesNotMatch(source, /\bMath\.random\b/);
  assert.doesNotMatch(source, /\bDate\.now\b/);
});
