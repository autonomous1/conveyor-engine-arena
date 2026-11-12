// `npm test` loads this hook. Source files import siblings as `.js`, and
// `node --test` runs TypeScript in place, so those `.js` files are not on disk.
// A deploy check has to run `npm test` (this `--import`), not a bare `node --test`.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export async function resolve(specifier, context, nextResolve) {
  const parent = context.parentURL ?? "";
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && specifier.endsWith(".js") && parent.includes("/src/")) {
    const ts = specifier.slice(0, -3) + ".ts";
    if (existsSync(fileURLToPath(new URL(ts, parent)))) return nextResolve(ts, context);
  }
  return nextResolve(specifier, context);
}
