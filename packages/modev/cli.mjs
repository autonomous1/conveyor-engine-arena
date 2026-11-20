#!/usr/bin/env node
// ARCHITECTURE: the `modev` command line — exact symbol lookup, KB section
// slices, entity rows, substring discovery, and the drift report, all over the
// generated codemap and the KB markdown. Read-only: it never writes agents/.
// Wiring: `node packages/modev/cli.mjs <cmd>`; tests import this file's main().
// Invariants: `query symbol` is exact (no fuzzy guess); a miss exits 1 without
// output; every query is logged to .cache/queries.jsonl, never to the repo.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { drift, findFiles, findSymbols, findText, loadIndex, queryEntity, querySection } from "./lib/index.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(HERE, "../..");

const USAGE = `modev — query the codemap and the KBs without reading them

  node packages/modev/cli.mjs query symbol <name> [--file <substr>] [--kind <k>]
  node packages/modev/cli.mjs query file <path>
  node packages/modev/cli.mjs query section <host|shared|client> <§N>
  node packages/modev/cli.mjs query entity <Pawn|Door|Cab|Pickup|Claim>
  node packages/modev/cli.mjs find <text> [--limit <n>]
  node packages/modev/cli.mjs drift
  node packages/modev/cli.mjs stats

Options: --root <dir> (default: this repo), --json (machine output).
Exit: 0 found/clean, 1 no result or drift findings, 2 usage.`;

function parseArgs(argv) {
  const opts = { root: DEFAULT_ROOT, json: false, file: undefined, kind: undefined, limit: 10 };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--root": opts.root = path.resolve(argv[++i] ?? "."); break;
      case "--json": opts.json = true; break;
      case "--file": opts.file = argv[++i]; break;
      case "--kind": opts.kind = argv[++i]; break;
      case "--limit": opts.limit = Number(argv[++i] ?? 10); break;
      case "--help": case "-h": opts.help = true; break;
      default: positional.push(arg);
    }
  }
  return { opts, positional };
}

function log(opts, command, arg, hits) {
  try {
    const dir = path.join(HERE, ".cache");
    mkdirSync(dir, { recursive: true });
    appendFileSync(
      path.join(dir, "queries.jsonl"),
      JSON.stringify({ ts: new Date().toISOString(), command, arg, hits }) + "\n",
    );
  } catch {
    // A log write must never fail a query.
  }
}

function clip(list, max) {
  return list.length > max ? `${list.slice(0, max).join(", ")} … (+${list.length - max} more)` : list.join(", ");
}

function printSymbol(symbol, index) {
  const file = index.codemap.files.get(symbol.file);
  console.log(`${symbol.name}  ${symbol.kind}${symbol.local ? " (local)" : ""}  ${symbol.file}:${symbol.line}`);
  if (symbol.signature) console.log(`  ${symbol.signature}`);
  if (symbol.doc) console.log(`  ${symbol.doc}`);
  for (const tag of symbol.tags) console.log(`  ${tag.tag} ${tag.text}`.trimEnd());
  if (symbol.calls.length) console.log(`  calls: ${clip(symbol.calls, 8)}`);
  if (file?.usedBy.length) console.log(`  used by: ${clip(file.usedBy, 6)}`);
}

function printSection(section) {
  console.log(`${section.layer} §${section.id} — ${section.title}`);
  console.log(`${section.file}:${section.line}-${section.endLine} (${section.text.split("\n").length} lines)`);
  console.log("");
  console.log(section.text);
}

const plain = (text) => text.replace(/`/g, "");

function printEntity(row) {
  console.log(`${row.entity}  (shared-model §13.6)`);
  console.log(`  shared: ${plain(row.factory)}`);
  console.log(`  host:   ${plain(row.host)}`);
  console.log(`  client: ${plain(row.client)}`);
  console.log(`  test:   ${plain(row.test)}`);
}

export function main(argv) {
  const { opts, positional } = parseArgs(argv);
  if (opts.help || positional.length === 0) {
    console.log(USAGE);
    return 0;
  }
  if (!existsSync(path.join(opts.root, "agents/codemap.md"))) {
    console.error(`modev: no ${path.join(opts.root, "agents/codemap.md")}; run npm run codemap`);
    return 2;
  }

  const [command, sub, ...rest] = positional;
  const index = loadIndex(opts.root);

  if (command === "query" && sub === "symbol") {
    const name = rest[0];
    if (!name) { console.error("modev: query symbol <name>"); return 2; }
    const hits = findSymbols(index, name, { file: opts.file, kind: opts.kind });
    log(opts, "symbol", name, hits.length);
    if (hits.length === 0) { console.error(`modev: no symbol ${name}`); return 1; }
    if (opts.json) console.log(JSON.stringify(hits, null, 2));
    else hits.forEach((hit, i) => { if (i) console.log(""); printSymbol(hit, index); });
    return 0;
  }

  if (command === "query" && sub === "file") {
    const target = rest[0];
    if (!target) { console.error("modev: query file <path>"); return 2; }
    const files = findFiles(index, target);
    if (files.length === 0) { console.error(`modev: no file ${target}`); return 1; }
    if (files.length > 1) {
      console.error(`modev: ${target} matches ${files.length} files:`);
      for (const file of files) console.error(`  ${file.path}`);
      return 1;
    }
    const file = files[0];
    log(opts, "file", file.path, file.symbols.length);
    if (opts.json) console.log(JSON.stringify(file, null, 2));
    else {
      console.log(`${file.path} (${file.lines} lines)`);
      if (file.doc) console.log(`  ${file.doc}`);
      if (file.imports.length) console.log(`  imports: ${clip(file.imports, 8)}`);
      if (file.pkgs.length) console.log(`  pkgs: ${clip(file.pkgs, 6)}`);
      if (file.usedBy.length) console.log(`  used by: ${clip(file.usedBy, 6)}`);
      for (const symbol of file.symbols) {
        const doc = symbol.doc ? `  ${symbol.doc}` : "";
        console.log(`  ${symbol.name}  ${symbol.kind}${symbol.local ? " (local)" : ""}  :${symbol.line}${doc}`);
      }
    }
    return 0;
  }

  if (command === "query" && sub === "section") {
    const target = rest[0];
    const id = rest[1];
    if (!target || !id) { console.error("modev: query section <host|shared|client|layer-file> <§N>"); return 2; }
    // Accept the layer (`shared`) or the file (`shared-model`, `shared-model.md`);
    // the file form narrows resolution to that half.
    const fileMatch = /^(host|client|shared)-(kb|flow|model)(?:\.md)?$/.exec(target);
    const layer = fileMatch ? fileMatch[1] : target;
    // `*-kb` is the index: it declares no sections, so resolve by layer instead.
    const file =
      fileMatch && fileMatch[2] !== "kb" ? `${target.replace(/\.md$/, "")}.md` : undefined;
    const hits = querySection(index, layer, id).filter((hit) => !file || hit.file.endsWith(file));
    log(opts, "section", `${layer} ${id}`, hits.length);
    if (hits.length === 0) { console.error(`modev: no ${layer} §${id}`); return 1; }
    if (opts.json) console.log(JSON.stringify(hits, null, 2));
    else hits.forEach((hit, i) => { if (i) console.log(""); printSection(hit); });
    return 0;
  }

  if (command === "query" && sub === "entity") {
    const name = rest[0];
    if (!name) { console.error("modev: query entity <name>"); return 2; }
    const hits = queryEntity(index, name);
    log(opts, "entity", name, hits.length);
    if (hits.length === 0) { console.error(`modev: no entity ${name}`); return 1; }
    if (opts.json) console.log(JSON.stringify(hits, null, 2));
    else hits.forEach(printEntity);
    return 0;
  }

  if (command === "find") {
    const text = sub;
    if (!text) { console.error("modev: find <text>"); return 2; }
    const hits = findText(index, text, opts.limit);
    log(opts, "find", text, hits.length);
    if (hits.length === 0) { console.error(`modev: nothing matches ${text}`); return 1; }
    if (opts.json) console.log(JSON.stringify(hits, null, 2));
    else {
      for (const hit of hits) {
        console.log(
          hit.kind === "symbol"
            ? `${hit.name}  ${hit.symbolKind}  ${hit.file}:${hit.line}`
            : `${hit.layer} §${hit.id}  ${hit.title}  ${hit.file}:${hit.line}`,
        );
      }
    }
    return 0;
  }

  if (command === "drift") {
    const findings = drift(index);
    if (opts.json) console.log(JSON.stringify(findings, null, 2));
    else if (findings.length === 0) console.log("modev: no drift");
    else for (const finding of findings) console.log(`${finding.file}:${finding.line}  ${finding.message}`);
    return findings.length === 0 ? 0 : 1;
  }

  if (command === "stats") {
    const file = path.join(HERE, ".cache/queries.jsonl");
    if (!existsSync(file)) { console.log("modev: no queries logged yet"); return 0; }
    const rows = readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const byCommand = new Map();
    const byArg = new Map();
    for (const row of rows) {
      byCommand.set(row.command, (byCommand.get(row.command) ?? 0) + 1);
      const key = `${row.command} ${row.arg}`;
      byArg.set(key, (byArg.get(key) ?? 0) + 1);
    }
    console.log(`queries: ${rows.length}`);
    for (const [name, count] of [...byCommand].sort((a, b) => b[1] - a[1])) console.log(`  ${name}: ${count}`);
    console.log("top:");
    for (const [key, count] of [...byArg].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`  ${count}× ${key}`);
    return 0;
  }

  console.error(`modev: unknown command "${[command, sub].filter(Boolean).join(" ")}"`);
  console.error(USAGE);
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
