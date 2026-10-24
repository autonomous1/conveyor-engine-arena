#!/usr/bin/env node
/**
 * Codemap generator: writes a compact, deterministic map of a TypeScript repo
 * (files, imports, every top-level function/type/const/class with line numbers,
 * exported or local, plus a symbol index) for coding agents.
 *
 * Usage (run from the repo root, Node >= 22.18):
 *   node scripts/codemap.ts                      # writes agents/codemap.md from src/
 *   node scripts/codemap.ts --check              # exit 1 if agents/codemap.md is stale
 *   node scripts/codemap.ts --root src --root test --out agents/codemap.md
 *   node scripts/codemap.ts --exports-only         # public API only (smaller map)
 *   node scripts/codemap.ts --project tsconfig.json   # take the file list from a tsconfig
 *
 * Only dependency: `typescript` (parser only; no type checking, so broken types never block it).
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep, posix } from "node:path";
import ts from "typescript";

type Options = {
  roots: string[];
  projects: string[];
  out: string;
  all: boolean;
  check: boolean;
  maxSig: number;
};

type Entry = {
  name: string;
  kind: string;
  line: number;
  sig: string;
  doc: string;
  exported: boolean;
  members: Entry[];
};

type FileInfo = {
  path: string;
  lines: number;
  doc: string;
  localImports: string[];
  packages: string[];
  reexports: string[];
  entries: Entry[];
};

const SOURCE_EXT = [".ts", ".tsx", ".mts", ".cts"];
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "coverage", "build"]);

function usage(): never {
  console.log(`codemap: map TypeScript symbols (exported and local) for coding agents

  --root <dir>      source dir to scan (repeatable, default: src)
  --project <file>  use the file list of a tsconfig instead of --root (repeatable)
  --out <file>      output file (default: agents/codemap.md)
  --exports-only    list exported declarations only (default: all top-level)
  --all             accepted for compatibility; this is the default
  --check           do not write; exit 1 if <out> is missing or stale
  --max-sig <n>     truncate signatures to n chars (default: 160)`);
  process.exit(0);
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { roots: [], projects: [], out: "agents/codemap.md", all: true, check: false, maxSig: 160 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`missing value for ${arg}`);
      return value;
    };
    if (arg === "--root") opts.roots.push(next());
    else if (arg === "--project" || arg === "-p") opts.projects.push(next());
    else if (arg === "--out") opts.out = next();
    else if (arg === "--all") opts.all = true;
    else if (arg === "--exports-only") opts.all = false;
    else if (arg === "--check") opts.check = true;
    else if (arg === "--max-sig") opts.maxSig = Number(next());
    else if (arg === "--help" || arg === "-h") usage();
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (opts.roots.length === 0 && opts.projects.length === 0) opts.roots.push("src");
  return opts;
}

const toPosix = (p: string): string => p.split(sep).join("/");
const rel = (p: string): string => toPosix(relative(process.cwd(), p));
const isSource = (p: string): boolean => SOURCE_EXT.some((ext) => p.endsWith(ext)) && !/\.d\.[mc]?ts$/.test(p);

function walk(dir: string, out: string[]): void {
  if (!existsSync(dir)) throw new Error(`root not found: ${dir}`);
  for (const name of readdirSync(dir).sort()) {
    if (SKIP_DIRS.has(name) || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (isSource(full)) out.push(resolve(full));
  }
}

function projectFiles(project: string): string[] {
  const read = ts.readConfigFile(project, ts.sys.readFile);
  if (read.error) throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(resolve(project)));
  return parsed.fileNames.filter(isSource).map((f) => resolve(f));
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").replace(/\[\s/g, "[").replace(/\s\]/g, "]").replace(/\(\s/g, "(").replace(/\s\)/g, ")").replace(/,\s?\)/g, ")").trim();
}

function clip(text: string, max: number): string {
  const flat = collapse(text);
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function firstSentence(text: string): string {
  const flat = collapse(text);
  const match = /^(.+?[.!?])(\s|$)/.exec(flat);
  const sentence = match?.[1] ?? flat;
  return sentence.length > 140 ? `${sentence.slice(0, 139)}…` : sentence;
}

/** Position of the current file's header doc, so it is not repeated on the first declaration. */
let fileDocPos = -1;

function docOf(node: ts.Node): string {
  const docs = ts.getJSDocCommentsAndTags(node).filter((d): d is ts.JSDoc => ts.isJSDoc(d) && d.pos !== fileDocPos);
  const last = docs[docs.length - 1];
  if (!last) return "";
  const text = ts.getTextOfJSDocComment(last.comment);
  return text ? firstSentence(text) : "";
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []).some((m) => m.kind === kind) : false;
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });

/** Source text of a node without comments (nested JSDoc in type literals would bloat signatures). */
function text(sf: ts.SourceFile, node: ts.Node | undefined): string {
  if (!node) return "";
  const raw = node.getText(sf);
  return raw.includes("/*") || raw.includes("//") ? printer.printNode(ts.EmitHint.Unspecified, node, sf) : raw;
}

function typeParams(sf: ts.SourceFile, list: ts.NodeArray<ts.TypeParameterDeclaration> | undefined): string {
  return list && list.length ? `<${list.map((p) => text(sf, p)).join(", ")}>` : "";
}

function callSig(sf: ts.SourceFile, node: ts.SignatureDeclarationBase): string {
  const params = node.parameters.map((p) => text(sf, p)).join(", ");
  const ret = node.type ? `: ${text(sf, node.type)}` : "";
  return `${typeParams(sf, node.typeParameters)}(${params})${ret}`;
}

function heritage(sf: ts.SourceFile, clauses: ts.NodeArray<ts.HeritageClause> | undefined): string {
  return clauses ? ` ${clauses.map((c) => text(sf, c)).join(" ")}` : "";
}

function memberName(sf: ts.SourceFile, name: ts.PropertyName | undefined): string {
  return name ? text(sf, name) : "";
}

function classMembers(sf: ts.SourceFile, node: ts.ClassDeclaration, max: number): Entry[] {
  const out: Entry[] = [];
  for (const m of node.members) {
    if (hasModifier(m, ts.SyntaxKind.PrivateKeyword) || hasModifier(m, ts.SyntaxKind.ProtectedKeyword)) continue;
    if (m.name && ts.isPrivateIdentifier(m.name)) continue;
    const isStatic = hasModifier(m, ts.SyntaxKind.StaticKeyword) ? "static " : "";
    let entry: Entry | undefined;
    const base = { line: lineOf(sf, m), doc: docOf(m), exported: true, members: [] };
    if (ts.isConstructorDeclaration(m)) {
      entry = { ...base, name: "constructor", kind: "ctor", sig: clip(callSig(sf, m), max) };
    } else if (ts.isMethodDeclaration(m)) {
      entry = { ...base, name: memberName(sf, m.name), kind: `${isStatic}method`, sig: clip(callSig(sf, m), max) };
    } else if (ts.isGetAccessorDeclaration(m)) {
      entry = { ...base, name: memberName(sf, m.name), kind: `${isStatic}get`, sig: clip(m.type ? `: ${text(sf, m.type)}` : "", max) };
    } else if (ts.isPropertyDeclaration(m)) {
      const ro = hasModifier(m, ts.SyntaxKind.ReadonlyKeyword) ? "readonly " : "";
      entry = { ...base, name: memberName(sf, m.name), kind: `${isStatic}${ro}prop`, sig: clip(m.type ? `: ${text(sf, m.type)}` : "", max) };
    }
    if (entry) out.push(entry);
  }
  return out;
}

function constSig(sf: ts.SourceFile, decl: ts.VariableDeclaration, max: number): { kind: string; sig: string } {
  const init = decl.initializer;
  const fn = init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) ? init : undefined;
  if (fn && !decl.type) return { kind: "fn", sig: clip(callSig(sf, fn), max) };
  if (decl.type) return { kind: "const", sig: clip(`: ${text(sf, decl.type)}`, max) };
  if (!init) return { kind: "const", sig: "" };
  // Show short literal initializers; summarize large ones.
  let shown = text(sf, init);
  if (ts.isObjectLiteralExpression(init) && shown.length > 60) {
    const keys = init.properties.map((p) => (p.name ? text(sf, p.name) : "…"));
    shown = `{ ${keys.join(", ")} }`;
  } else if (ts.isArrayLiteralExpression(init) && shown.length > 60) {
    shown = `[…${init.elements.length} items]`;
  } else if (ts.isAsExpression(init) || ts.isSatisfiesExpression(init)) {
    shown = `… ${ts.isAsExpression(init) ? "as" : "satisfies"} ${text(sf, init.type)}`;
  } else if (ts.isCallExpression(init) || ts.isNewExpression(init)) {
    shown = `${ts.isNewExpression(init) ? "new " : ""}${text(sf, init.expression)}(…)`;
  }
  return { kind: "const", sig: clip(`= ${shown}`, max) };
}

function resolveLocal(fromFile: string, spec: string, known: Set<string>): string {
  const base = resolve(dirname(fromFile), spec);
  const stem = base.replace(/\.(m|c)?(j|t)sx?$/, "");
  const candidates = [base, ...SOURCE_EXT.map((e) => stem + e), ...SOURCE_EXT.map((e) => join(base, `index${e}`))];
  for (const c of candidates) if (known.has(c)) return rel(c);
  for (const c of candidates) if (existsSync(c) && statSync(c).isFile()) return rel(c);
  return rel(base);
}

function packageName(spec: string): string {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? spec);
}

function fileDoc(sf: ts.SourceFile): string {
  fileDocPos = -1;
  const first = sf.statements[0];
  if (!first) return "";
  const ranges = ts.getLeadingCommentRanges(sf.text, first.pos) ?? [];
  const top = ranges.find((r) => sf.text.startsWith("/**", r.pos));
  if (!top) return "";
  const raw = sf.text.slice(top.pos, top.end);
  // A doc directly above a declaration belongs to that declaration, not the file.
  const gap = sf.text.slice(top.end, first.getStart(sf));
  const attached = !/\n\s*\n/.test(gap) && !ts.isImportDeclaration(first) && !ts.isExportDeclaration(first);
  if (attached || top !== ranges[0]) return "";
  fileDocPos = top.pos;
  const body = raw.replace(/^\/\*\*|\*\/$/g, "").replace(/^\s*\* ?/gm, "").split(/\n\s*@/)[0] ?? "";
  return firstSentence(body);
}

function analyze(file: string, known: Set<string>, opts: Options): FileInfo {
  const source = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const info: FileInfo = {
    path: rel(file),
    lines: source.split("\n").length - (source.endsWith("\n") ? 1 : 0),
    doc: fileDoc(sf),
    localImports: [],
    packages: [],
    reexports: [],
    entries: [],
  };
  const local = new Set<string>();
  const pkgs = new Set<string>();
  const addSpec = (spec: string): void => {
    if (spec.startsWith(".")) local.add(resolveLocal(file, spec, known));
    else pkgs.add(packageName(spec));
  };
  const max = opts.maxSig;
  const push = (node: ts.Node, name: string, kind: string, sig: string, exported: boolean, members: Entry[] = []): void => {
    if (!exported && !opts.all) return;
    info.entries.push({ name, kind, line: lineOf(sf, node), sig, doc: docOf(node), exported, members });
  };

  for (const st of sf.statements) {
    const exported = hasModifier(st, ts.SyntaxKind.ExportKeyword);
    const isDefault = hasModifier(st, ts.SyntaxKind.DefaultKeyword);
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      addSpec(st.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(st)) {
      if (st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
        const spec = st.moduleSpecifier.text;
        addSpec(spec);
        const target = spec.startsWith(".") ? resolveLocal(file, spec, known) : spec;
        const what = st.exportClause ? clip(text(sf, st.exportClause), max) : "*";
        info.reexports.push(`${what} from ${target}`);
      } else if (st.exportClause && ts.isNamedExports(st.exportClause)) {
        for (const el of st.exportClause.elements) {
          push(el, el.name.text, "export", el.propertyName ? `= ${el.propertyName.text}` : "", true);
        }
      }
    } else if (ts.isExportAssignment(st)) {
      push(st, "default", "export", clip(`= ${text(sf, st.expression)}`, max), true);
    } else if (ts.isFunctionDeclaration(st)) {
      if (st.name && info.entries.some((e) => e.name === st.name!.text && e.kind.endsWith("fn"))) continue; // overloads: keep the first
      const name = st.name ? st.name.text : "default";
      const async = hasModifier(st, ts.SyntaxKind.AsyncKeyword) ? "async " : "";
      push(st, name, `${isDefault ? "default " : ""}${async}fn`, clip(callSig(sf, st), max), exported);
    } else if (ts.isClassDeclaration(st)) {
      const name = st.name ? st.name.text : "default";
      const abs = hasModifier(st, ts.SyntaxKind.AbstractKeyword) ? "abstract " : "";
      const sig = clip(`${typeParams(sf, st.typeParameters)}${heritage(sf, st.heritageClauses)}`, max);
      push(st, name, `${abs}class`, sig, exported, exported || opts.all ? classMembers(sf, st, max) : []);
    } else if (ts.isInterfaceDeclaration(st)) {
      const body = `{ ${st.members.map((m) => text(sf, m).replace(/;$/, "")).join("; ")} }`;
      push(st, st.name.text, "interface", clip(`${typeParams(sf, st.typeParameters)}${heritage(sf, st.heritageClauses)} ${body}`, max), exported);
    } else if (ts.isTypeAliasDeclaration(st)) {
      push(st, st.name.text, "type", clip(`${typeParams(sf, st.typeParameters)} = ${text(sf, st.type)}`, max), exported);
    } else if (ts.isEnumDeclaration(st)) {
      push(st, st.name.text, "enum", clip(`{ ${st.members.map((m) => text(sf, m.name)).join(", ")} }`, max), exported);
    } else if (ts.isModuleDeclaration(st)) {
      push(st, text(sf, st.name), "namespace", "", exported);
    } else if (ts.isVariableStatement(st)) {
      const flags = st.declarationList.flags;
      const keyword = flags & ts.NodeFlags.Const ? "const" : "let";
      for (const decl of st.declarationList.declarations) {
        const names = ts.isIdentifier(decl.name) ? [decl.name.text] : [clip(text(sf, decl.name), 60)];
        const { kind, sig } = constSig(sf, decl, max);
        for (const name of names) {
          const node = decl === st.declarationList.declarations[0] ? st : decl;
          push(node, name, kind === "fn" ? "fn" : keyword, sig, exported);
        }
      }
    }
  }
  info.localImports = [...local].sort();
  info.packages = [...pkgs].sort();
  return info;
}

function tree(files: FileInfo[]): string[] {
  const out: string[] = [];
  let lastDir = "";
  for (const f of files) {
    const dir = posix.dirname(f.path);
    if (dir !== lastDir) {
      const dirFiles = files.filter((x) => posix.dirname(x.path) === dir);
      const total = dirFiles.reduce((n, x) => n + x.lines, 0);
      out.push(`${dir}/ (${dirFiles.length} files, ${total} lines)`);
      lastDir = dir;
    }
    const exports = f.entries.filter((e) => e.exported).length;
    const doc = f.doc ? ` — ${f.doc}` : "";
    out.push(`  ${posix.basename(f.path)} ${f.lines}L${exports ? ` ${exports}x` : ""}${doc}`);
  }
  return out;
}

function entryLine(e: Entry, indent: string): string {
  const mark = e.exported ? "" : " (local)";
  const sig = e.sig ? ` \`${e.sig}\`` : "";
  const doc = e.doc ? ` — ${e.doc}` : "";
  return `${indent}- \`${e.name}\` ${e.kind}${mark} :${e.line}${sig}${doc}`;
}

function render(files: FileInfo[], opts: Options, argv: string[]): string {
  const cmd = ["node scripts/codemap.ts", ...argv.filter((a) => a !== "--check")].join(" ");
  const importedBy = new Map<string, string[]>();
  for (const f of files) for (const dep of f.localImports) importedBy.set(dep, [...(importedBy.get(dep) ?? []), f.path]);

  const lines: string[] = [
    "# Codemap",
    "",
    `Generated by \`${cmd}\` — do not edit; regenerate after adding, moving or renaming functions or types (\`npm run codemap\`).`,
    `Scope: ${opts.projects.length ? `tsconfig ${opts.projects.join(", ")}` : opts.roots.map((r) => `${toPosix(r)}/`).join(", ")}; ${opts.all ? "exported + local" : "exported"} top-level symbols; parsed only, not type-checked.`,
    "Format: `name` kind :line `signature` — first JSDoc sentence. Paths are repo-relative. Find a symbol: grep the Symbol index for `` `name` ``.",
    "Per file: `imports` = local modules it imports, `pkgs` = packages, `used by` = local files importing it.",
    "",
    "## Files",
    "",
    "```text",
    ...tree(files),
    "```",
    "",
    "## Modules",
  ];
  for (const f of files) {
    lines.push("", `### ${f.path} (${f.lines})`);
    if (f.doc) lines.push(f.doc);
    if (f.localImports.length) lines.push(`imports: ${f.localImports.join(", ")}`);
    if (f.packages.length) lines.push(`pkgs: ${f.packages.join(", ")}`);
    const users = importedBy.get(f.path);
    if (users) lines.push(`used by: ${[...users].sort().join(", ")}`);
    for (const r of f.reexports) lines.push(`- re-export ${r}`);
    for (const e of f.entries) {
      lines.push(entryLine(e, ""));
      for (const m of e.members) lines.push(entryLine(m, "  "));
    }
  }

  const index: string[] = [];
  for (const f of files) {
    for (const e of f.entries) {
      index.push(`\`${e.name}\` ${f.path}:${e.line} ${e.kind}`);
      for (const m of e.members) if (m.kind !== "ctor") index.push(`\`${e.name}.${m.name}\` ${f.path}:${m.line} ${m.kind}`);
    }
  }
  const key = (s: string): string => s.toLowerCase();
  index.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : a < b ? -1 : a > b ? 1 : 0));
  lines.push("", "## Symbol index", "", "```text", ...index, "```", "");
  return lines.join("\n");
}

function main(argv: string[]): number {
  const opts = parseArgs(argv);
  const found: string[] = [];
  for (const p of opts.projects) found.push(...projectFiles(p));
  for (const r of opts.roots) walk(resolve(r), found);
  const outAbs = resolve(opts.out);
  const sortKey = (f: string): string => `${posix.dirname(rel(f))}\0${posix.basename(rel(f))}`;
  const files = [...new Set(found)].filter((f) => f !== outAbs).sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1));
  const known = new Set(files);
  const infos = files.map((f) => analyze(f, known, opts));
  const md = render(infos, opts, argv);

  if (opts.check) {
    const current = existsSync(outAbs) ? readFileSync(outAbs, "utf8") : "";
    if (current === md) {
      console.log(`codemap: ${opts.out} is up to date`);
      return 0;
    }
    console.error(`codemap: ${opts.out} is stale — run \`npm run codemap\``);
    return 1;
  }
  mkdirSync(dirname(outAbs), { recursive: true });
  writeFileSync(outAbs, md);
  const symbols = infos.reduce((n, f) => n + f.entries.length, 0);
  console.log(`codemap: wrote ${opts.out} (${infos.length} files, ${symbols} symbols, ${md.split("\n").length} lines, ${(md.length / 1024).toFixed(1)} KB)`);
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  console.error(`codemap: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 2;
}
