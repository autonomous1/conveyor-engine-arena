// ARCHITECTURE: a prose "<N> `always` gates" claim must equal test/scopes.json's
// always list; the count drifted once (README said five, the manifest has six).
// Wiring: check.mjs; one finding per disagreeing claim.
// Invariants: the manifest is the authority; a claim with no manifest is a finding too.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export const id = "kb-count-claims";
export const description = 'a prose "N `always` gates" claim must equal test/scopes.json';

const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const CLAIM = /\b(one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+`always`\s+gates?/gi;

export function run(root) {
  const manifest = JSON.parse(readFileSync(path.join(root, "test/scopes.json"), "utf8"));
  const actual = manifest.always.length;
  const findings = [];
  const dir = path.join(root, "agents");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".md")).sort()) {
    const lines = readFileSync(path.join(dir, file), "utf8").split("\n");
    lines.forEach((line, index) => {
      for (const match of line.matchAll(CLAIM)) {
        const word = match[1].toLowerCase();
        const claimed = WORDS[word] ?? Number(word);
        if (claimed !== actual) {
          findings.push({
            file: `agents/${file}`,
            line: index + 1,
            message: `says ${match[1]} \`always\` gates; test/scopes.json has ${actual}`,
          });
        }
      }
    });
  }
  return findings;
}
