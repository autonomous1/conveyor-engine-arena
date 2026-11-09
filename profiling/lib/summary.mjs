import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { renderMarkdown } from "./bottom-up.mjs";

/** Writes <out>/<kind>-<scenario>.summary.json/.md and optionally the raw .cpuprofile. */
export async function writeRun(outDir, summary, profile, { keepProfile = true, top = 30 } = {}) {
  await mkdir(outDir, { recursive: true });
  const base = join(outDir, `${summary.kind}-${summary.scenario}`);
  if (profile && keepProfile) await writeFile(`${base}.cpuprofile`, JSON.stringify(profile));
  await writeFile(`${base}.summary.json`, JSON.stringify(summary, null, 1));
  await writeFile(`${base}.md`, renderMarkdown(summary, top));
  return base;
}
