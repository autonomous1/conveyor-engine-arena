import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { createCallsContext, extractCalls, renderCallLines } from "../scripts/codemap.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const fixture = join(here, "fixtures/codemap-calls");
const calleePath = join(fixture, "callee.ts");
const callerPath = join(fixture, "caller.ts");
const ctx = createCallsContext([calleePath, callerPath], new Set([calleePath, callerPath]));

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
}

function functionDecl(sf: ts.SourceFile, name: string): ts.FunctionDeclaration {
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name?.text === name) return st;
  }
  throw new Error(`fixture is missing function ${name}`);
}

test("extract_calls_resolves_local_and_imported", () => {
  const sf = parse(callerPath);
  assert.deepEqual(extractCalls(functionDecl(sf, "run"), "run", callerPath, ctx), ["Counter", "localStep", "reset"]);
  assert.deepEqual(extractCalls(functionDecl(sf, "localStep"), "localStep", callerPath, ctx), ["bump"]);
});

test("extract_calls_skips_shadowed_names", () => {
  const sf = parse(callerPath);
  assert.deepEqual(extractCalls(functionDecl(sf, "shadowed"), "shadowed", callerPath, ctx), []);
});

test("extract_calls_skips_globals_and_properties", () => {
  const sf = parse(callerPath);
  assert.deepEqual(extractCalls(functionDecl(sf, "globals"), "globals", callerPath, ctx), []);
});

test("render_calls_caps_and_formats", () => {
  assert.deepEqual(renderCallLines(["bump", "reset"]), ["  calls: `bump`, `reset`"]);
  const many = Array.from({ length: 30 }, (_, i) => `fn${String(i).padStart(2, "0")}`);
  const line = renderCallLines(many)[0]!;
  assert.match(line, /^  calls: `fn00`, `fn01`/);
  assert.match(line, /… \(\+6 more\)$/);
  assert.deepEqual(renderCallLines([]), []);
});

test("generator_emits_calls_and_is_deterministic", () => {
  const dir = mkdtempSync(join(tmpdir(), "codemap-calls-"));
  const out = join(dir, "codemap.md");
  const run = (): string => {
    execFileSync(process.execPath, [join(root, "scripts/codemap.ts"), "--root", "test/fixtures/codemap-calls", "--out", out], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return readFileSync(out, "utf8");
  };
  try {
    const first = run();
    assert.match(first, /^- `run` fn :\d+ `\(\): number` — Calls three local symbols.*\n  calls: `Counter`, `localStep`, `reset`$/m);
    assert.match(first, /^- `localStep` fn \(local\) :\d+ .*\n  calls: `bump`$/m);
    assert.match(first, /^  - `step` method :\d+ .*\n    calls: `bump`$/m);
    assert.doesNotMatch(first, /^- `shadowed` fn[^\n]*\n  calls:/m);
    assert.equal(run(), first);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
