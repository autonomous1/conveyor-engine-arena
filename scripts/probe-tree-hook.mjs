// Probe tree switch: the probe lane's imports stay `../src/…`, and this hook
// decides which tree they load from (`BOT_CLIENT_TREE=src|proto`). It mirrors
// `ts-ext-hook.mjs` and extends it to proto's own `./x.js` siblings.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const TREE = process.env.BOT_CLIENT_TREE === "proto" ? "proto" : "src";
const BOT = new URL("../packages/bot-client/", import.meta.url);

export async function resolve(specifier, context, nextResolve) {
  const parent = context.parentURL ?? "";
  // The branch's own siblings are `.js` on disk as `.ts` (same rule as the tests).
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && specifier.endsWith(".js")) {
    const ts = specifier.slice(0, -3) + ".ts";
    if ((parent.includes("/src/") || parent.includes("/proto/")) && existsSync(fileURLToPath(new URL(ts, parent)))) {
      return nextResolve(ts, context);
    }
  }
  const result = await nextResolve(specifier, context);
  const src = new URL("src/", BOT).href;
  if (TREE === "proto" && result.url.startsWith(src)) {
    const url = new URL("proto/", BOT).href + result.url.slice(src.length);
    if (existsSync(fileURLToPath(url))) return { ...result, url, shortCircuit: true };
  }
  return result;
}
