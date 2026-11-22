// ARCHITECTURE: the `layer-kb §N` reference scanner — one implementation shared
// by the lint and the drift report. A reference resolves by layer, not by file,
// so the split halves stay transparent to an older `host-kb §13` pointer.
// Wiring: lints/kb-section-refs.mjs (the gate) and lib/index.mjs (drift).
// Invariants: a cleaned tree yields an empty list; each finding names one ref.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const LAYERS = ["host", "client", "shared", "bot"];
const KB_FILE = /^(host|client|shared|bot)-(?:kb|flow|model)\.md$/;
const REF = /§(\d+(?:\.\d+)?)(?:\s*[–-]\s*§?(\d+(?:\.\d+)?))?/g;
const OWNER = /(host|client|shared|bot)(?:-kb)?\b/g;

function sections(text) {
  const out = new Set();
  for (const m of text.matchAll(/^#{2,6}\s+(\d+(?:\.\d+)?)\.?\s+/gm)) out.add(m[1]);
  return out;
}

export function sectionRefFindings(root) {
  const dir = path.join(root, "agents");
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".md") && f !== "codemap.md")
    .sort();

  const declared = new Map(LAYERS.map((layer) => [layer, new Map()]));
  for (const file of files) {
    const layer = file.match(KB_FILE)?.[1];
    if (!layer) continue;
    for (const section of sections(readFileSync(path.join(dir, file), "utf8"))) {
      const map = declared.get(layer);
      if (!map.has(section)) map.set(section, []);
      map.get(section).push(file);
    }
  }

  const findings = [];
  for (const file of files) {
    const ownLayer = file.match(KB_FILE)?.[1];
    const lines = readFileSync(path.join(dir, file), "utf8").split("\n");
    lines.forEach((line, index) => {
      for (const match of line.matchAll(REF)) {
        const before = line.slice(0, match.index);
        const owners = [...before.matchAll(OWNER)];
        const layer = owners.length > 0 ? owners[owners.length - 1][1] : ownLayer;
        if (!layer) continue;
        const map = declared.get(layer);
        for (const section of new Set([match[1], match[2] ?? match[1]])) {
          const homes = map.get(section);
          if (!homes) {
            findings.push({ file: `agents/${file}`, line: index + 1, message: `§${section} is not in the ${layer} KB` });
          } else if (homes.length > 1) {
            findings.push({
              file: `agents/${file}`,
              line: index + 1,
              message: `§${section} is declared twice in the ${layer} KB (${homes.join(", ")})`,
            });
          }
        }
      }
    });
  }
  return findings;
}
