// ARCHITECTURE: the model check runner — imports every lint in lints/, prints
// one line per lint, and exits 1 if any lint reports a finding.
// Wiring: `npm --prefix packages/modev run check`; each lint exports { id, run }.
// Order: lints are independent and sorted by filename; none reads another's state.
// Invariants: a lint returns findings and never writes; the runner owns the exit code.
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const lintDir = path.join(here, "lints");

let failed = 0;
for (const file of readdirSync(lintDir).filter((f) => f.endsWith(".mjs")).sort()) {
  const { id, run } = await import(path.join(lintDir, file));
  const findings = run(root);
  console.log(`modev: ${id} — ${findings.length === 0 ? "ok" : `FAIL (${findings.length})`}`);
  for (const finding of findings) {
    console.log(`  ${finding.file}:${finding.line}  ${finding.message}`);
  }
  if (findings.length > 0) failed += 1;
}

if (failed > 0) {
  console.log(`\nmodev:check failed — ${failed} lint(s)`);
  process.exit(1);
}
console.log("\nmodev:check passed");
