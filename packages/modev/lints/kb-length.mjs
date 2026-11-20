// ARCHITECTURE: KB halves must fit the read window; a KB past ~78% of the window
// has a tail the reading agent never sees (agents/model-developer-role.md).
// Wiring: check.mjs; one finding per oversized file.
// Invariants: the budget is derived from READ_WINDOW_LINES, never from the file.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export const id = "kb-length";
export const description = "a KB half above 78% of the read window has an invisible tail";

// The operator's stated read window. If it changes, move this constant — the 78%
// rule and the lint stay put.
const READ_WINDOW_LINES = 400;
const MAX_LINES = Math.floor(READ_WINDOW_LINES * 0.78);

export function run(root) {
  const dir = path.join(root, "agents");
  const findings = [];
  for (const file of readdirSync(dir).sort()) {
    if (!/-(?:kb|flow|model)\.md$/.test(file)) continue;
    const lines = readFileSync(path.join(dir, file), "utf8").split("\n").length - 1;
    if (lines > MAX_LINES) {
      findings.push({
        file: `agents/${file}`,
        line: MAX_LINES + 1,
        message: `${lines} lines > ${MAX_LINES} (78% of a ${READ_WINDOW_LINES}-line window)`,
      });
    }
  }
  return findings;
}
