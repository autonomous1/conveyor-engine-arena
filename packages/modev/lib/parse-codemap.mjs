// ARCHITECTURE: parse the generated agents/codemap.md into a queryable index —
// files (imports, used-by, module doc) and symbols (kind, line, signature, doc,
// tags, local calls). The markdown stays the artifact; this is a view of it.
// Wiring: lib/index.mjs; the CLI queries the result; nothing here writes.
// Order: the module sections (## Modules) are the source; the symbol index at the
// end is redundant and not parsed.
// Invariants: one symbol record per `- \`name\`` line; tags/calls attach to the
// symbol above them; a heading without `(N)` ends the file record.
import { readFileSync } from "node:fs";

const FILE_HEADING = /^### (.+) \((\d+)\)$/;
const SYMBOL_LINE =
  /^- `([^`]+)` ((?:async )?(?:fn|type|const|let|interface|class|namespace|export))( \(local\))? :(\d+)(?: `([^`]*)`)?(?: — (.*))?$/;

function splitList(raw) {
  return raw
    .replace(/`/g, "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function parseCodemap(text) {
  const files = new Map();
  const symbols = [];
  let file = null;
  let symbol = null;

  for (const line of text.split("\n")) {
    const heading = FILE_HEADING.exec(line);
    if (heading) {
      file = { path: heading[1], lines: Number(heading[2]), doc: null, imports: [], pkgs: [], usedBy: [], symbols: [] };
      files.set(file.path, file);
      symbol = null;
      continue;
    }
    if (line.startsWith("### ") || line.startsWith("## ")) {
      file = null;
      symbol = null;
      continue;
    }
    if (!file) continue;

    if (line.startsWith("imports: ")) {
      file.imports = splitList(line.slice("imports: ".length));
      symbol = null;
      continue;
    }
    if (line.startsWith("pkgs: ")) {
      file.pkgs = splitList(line.slice("pkgs: ".length));
      symbol = null;
      continue;
    }
    if (line.startsWith("used by: ")) {
      file.usedBy = splitList(line.slice("used by: ".length));
      symbol = null;
      continue;
    }
    if (line.startsWith("  calls: ")) {
      if (symbol) symbol.calls = splitList(line.slice("  calls: ".length));
      continue;
    }
    const tag = /^ {2}`(@[a-z]+)`(?:\s+(.*))?$/.exec(line);
    if (tag) {
      if (symbol) symbol.tags.push({ tag: tag[1], text: (tag[2] ?? "").trim() });
      continue;
    }
    const record = SYMBOL_LINE.exec(line);
    if (record) {
      symbol = {
        name: record[1],
        kind: record[2],
        local: Boolean(record[3]),
        line: Number(record[4]),
        signature: record[5] ?? null,
        doc: record[6] ?? null,
        file: file.path,
        tags: [],
        calls: [],
      };
      file.symbols.push(symbol);
      symbols.push(symbol);
      continue;
    }
    if (!symbol && line.trim() && !line.startsWith("- ")) {
      file.doc = line.trim();
    }
  }

  return { files, symbols };
}

export function readCodemap(root) {
  return parseCodemap(readFileSync(`${root}/agents/codemap.md`, "utf8"));
}
