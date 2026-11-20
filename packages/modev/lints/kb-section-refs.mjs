// ARCHITECTURE: a `host`/`client`/`shared` KB section reference must resolve to a
// section a file of that layer actually declares.
// Wiring: check.mjs; one finding per unresolved or ambiguous reference.
// Invariants: a section number is declared once per layer — the stub indexes prose,
// it does not declare §N, so a resolved reference has exactly one home.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export const id = "kb-section-refs";
export const description = "a `layer-kb §N` reference must resolve to a section in that layer";

const LAYERS = ["host", "client", "shared"];
const KB_FILE = /^(host|client|shared)-(?:kb|flow|model)\.md$/;
const REF = /§(\d+(?:\.\d+)?)(?:\s*[–-]\s*§?(\d+(?:\.\d+)?))?/g;
const OWNER = /(host|client|shared)(?:-kb)?\b/g;

function sections(text) {
  const out = new Set();
  for (const m of text.matchAll(/^#{2,6}\s+(\d+(?:\.\d+)?)\.?\s+/gm)) out.add(m[1]);
  return out;
}

export function run(root) {
  const dir = path.join(root, "agents");
  const files = readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "codemap.md").sort();

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
            findings.push({
              file: `agents/${file}`,
              line: index + 1,
              message: `§${section} is not in the ${layer} KB`,
            });
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
