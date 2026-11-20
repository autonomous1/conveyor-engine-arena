// ARCHITECTURE: the query layer over the parsed codemap and KBs — symbol lookup,
// section slice, entity row, substring discovery, and the drift report.
// Wiring: cli.mjs; lints stay separate (check.mjs).
// Order: loadIndex() once per process; every query is a pure read.
// Invariants: no query writes the repo; symbol lookup is exact (find is the only
// substring entry); a drift finding names one place and one defect.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { readCodemap } from "./parse-codemap.mjs";
import { readKb, findSection, entitiesOf, kbFiles } from "./parse-kb.mjs";
import { sectionRefFindings } from "./refs.mjs";

export function loadIndex(root) {
  return { root, codemap: readCodemap(root), kb: readKb(root) };
}

export function findSymbols(index, name, { file, kind } = {}) {
  return index.codemap.symbols.filter(
    (s) =>
      s.name === name &&
      (!file || s.file.endsWith(file)) &&
      (!kind || s.kind.includes(kind)),
  );
}

export function findFiles(index, target) {
  const exact = index.codemap.files.get(target);
  if (exact) return [exact];
  return [...index.codemap.files.values()].filter((file) => file.path.endsWith(target));
}

export function querySection(index, layer, rawId) {
  const id = rawId.replace(/^§/, "");
  return findSection(index.kb, layer, id).map((section) => ({
    layer,
    id: section.id,
    title: section.title,
    file: `agents/${section.file}`,
    line: section.line,
    endLine: section.endLine,
    text: section.text,
  }));
}

export function queryEntity(index, name) {
  const wanted = name.toLowerCase();
  return entitiesOf(index.kb).filter((row) => row.entity.toLowerCase() === wanted);
}

export function findText(index, text, limit = 10) {
  const needle = text.toLowerCase();
  const symbols = index.codemap.symbols
    .filter((s) => s.name.toLowerCase().includes(needle))
    .slice(0, limit)
    .map((s) => ({ kind: "symbol", name: s.name, symbolKind: s.kind, file: s.file, line: s.line }));
  const sections = [];
  for (const entry of index.kb.files) {
    if (sections.length >= limit) break;
    for (const section of entry.sections) {
      if (sections.length >= limit) break;
      if (section.title.toLowerCase().includes(needle)) {
        sections.push({
          kind: "section",
          layer: entry.layer,
          id: section.id,
          title: section.title,
          file: `agents/${entry.file}`,
          line: section.line,
        });
      }
    }
  }
  return [...symbols, ...sections].slice(0, limit);
}

function readLines(dir, file) {
  return readFileSync(path.join(dir, file), "utf8").split("\n");
}

// Mechanical, advisory: a § ref that does not resolve, a KB file path that is gone
// (or missing from the codemap), a §13.6 test pin that names no test file.
export function drift(index) {
  const findings = sectionRefFindings(index.root);
  const agentsDir = path.join(index.root, "agents");

  for (const file of kbFiles(agentsDir)) {
    readLines(agentsDir, file).forEach((line, i) => {
      for (const m of line.matchAll(/`((?:src|test|packages|agents|scripts|web)\/[\w./-]+\.(?:ts|json|md))`/g)) {
        const rel = m[1];
        if (!existsSync(path.join(index.root, rel))) {
          findings.push({ file: `agents/${file}`, line: i + 1, message: `${rel} does not exist` });
        } else if (rel.startsWith("src/") && !index.codemap.files.has(rel)) {
          findings.push({
            file: `agents/${file}`,
            line: i + 1,
            message: `${rel} is not in the codemap (run npm run codemap)`,
          });
        }
      }
    });
  }

  const section = findSection(index.kb, "shared", "13.6")[0];
  if (section) {
    for (const row of entitiesOf(index.kb)) {
      for (const m of row.test.matchAll(/([\w.-]+\.test\.ts)/g)) {
        if (!existsSync(path.join(index.root, "test", m[1]))) {
          findings.push({
            file: `agents/${section.file}`,
            line: section.line,
            message: `§13.6 ${row.entity} names test/${m[1]}, which does not exist`,
          });
        }
      }
    }
  }

  return findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}
