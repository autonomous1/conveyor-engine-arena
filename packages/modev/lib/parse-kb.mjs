// ARCHITECTURE: parse the KB markdown halves into sections (numbered, bounded)
// and their markdown tables. Sections are queried by `layer §N`; tables feed the
// entity query and the drift checks. The markdown stays the model.
// Wiring: lib/index.mjs; the CLI's `query section|entity` and `drift`.
// Order: a section ends at the next heading of any kind at the same or higher
// level, so `### 13.6` stops at `### Ownership…`, not at the next numbered
// heading. Unnumbered headings are boundaries, never sections.
// Invariants: one section per numbered heading; ids are unique per layer (the
// lint enforces the same rule); index files (`*-kb.md`) declare no sections.
import { readdirSync, readFileSync } from "node:fs";

const KB_FILE = /^(host|client|shared)-(?:kb|flow|model)\.md$/;
const HEADING = /^(#{2,6})\s+(.+?)\s*$/;
const NUMBERED = /^(\d+(?:\.\d+)?)\.?\s+(.+)$/;

export function layerOf(file) {
  return KB_FILE.exec(file)?.[1] ?? null;
}

export function kbFiles(agentsDir) {
  return readdirSync(agentsDir)
    .filter((f) => KB_FILE.test(f))
    .sort();
}

export function parseSections(text, file) {
  const lines = text.split("\n");
  const headings = [];
  lines.forEach((line, index) => {
    const match = HEADING.exec(line);
    if (!match) return;
    const numbered = NUMBERED.exec(match[2]);
    headings.push({
      level: match[1].length,
      id: numbered?.[1] ?? null,
      title: numbered?.[2] ?? match[2],
      line: index + 1,
    });
  });

  const sections = [];
  for (let i = 0; i < headings.length; i++) {
    const heading = headings[i];
    if (!heading.id) continue;
    let end = lines.length;
    for (let j = i + 1; j < headings.length; j++) {
      if (headings[j].level <= heading.level) {
        end = headings[j].line - 1;
        break;
      }
    }
    sections.push({
      file,
      id: heading.id,
      level: heading.level,
      title: heading.title,
      line: heading.line,
      endLine: end,
      text: lines.slice(heading.line - 1, end).join("\n").trimEnd(),
    });
  }
  return sections;
}

export function parseTables(sectionText) {
  const lines = sectionText.split("\n");
  const tables = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("|")) continue;
    const block = [];
    while (i < lines.length && lines[i].startsWith("|")) block.push(lines[i++]);
    if (block.length < 3) continue;
    const cells = (row) =>
      row
        .split("|")
        .slice(1, -1)
        .map((c) => c.trim());
    if (!block[1].includes("---")) continue;
    tables.push({ header: cells(block[0]), rows: block.slice(2).map(cells) });
  }
  return tables;
}

export function readKb(root) {
  const agentsDir = `${root}/agents`;
  const files = kbFiles(agentsDir).map((file) => {
    const text = readFileSync(`${agentsDir}/${file}`, "utf8");
    return { file, layer: layerOf(file), sections: parseSections(text, file) };
  });
  const byLayer = new Map();
  for (const entry of files) {
    if (!byLayer.has(entry.layer)) byLayer.set(entry.layer, []);
    byLayer.get(entry.layer).push(entry);
  }
  return { files, byLayer };
}

export function findSection(kb, layer, id) {
  const hits = [];
  for (const entry of kb.byLayer.get(layer) ?? []) {
    for (const section of entry.sections) {
      if (section.id === id) hits.push(section);
    }
  }
  return hits;
}

export function entitiesOf(kb) {
  const section = findSection(kb, "shared", "13.6")[0];
  if (!section) return [];
  const table = parseTables(section.text).find((t) => t.header[0] === "entity");
  if (!table) return [];
  return table.rows.map((row) => ({
    entity: row[0].replace(/\*\*/g, ""),
    factory: row[1] ?? "",
    host: row[2] ?? "",
    client: row[3] ?? "",
    test: row[4] ?? "",
  }));
}
