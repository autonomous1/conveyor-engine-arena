import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { compileGame, GameManifestError, type CompiledGame } from "./game-manifest.js";

const MANIFEST = join("web", "game", "arena.game.json");

export function projectRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, MANIFEST))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new GameManifestError([{ path: "$", message: `missing ${MANIFEST}` }]);
}

function readUnderWeb(root: string, uri: string): Uint8Array | undefined {
  const rel = uri.replace(/^\//, "");
  const web = resolve(root, "web");
  const file = resolve(web, rel);
  const fromWeb = relative(web, file);
  if (fromWeb.startsWith("..") || fromWeb.includes(`..${sep}`)) return undefined;
  if (!existsSync(file)) return undefined;
  return new Uint8Array(readFileSync(file));
}

let cached: CompiledGame | undefined;

export function loadInstalledGame(): CompiledGame {
  if (cached) return cached;
  const root = projectRoot();
  const text = readFileSync(join(root, MANIFEST), "utf8");
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    throw new GameManifestError([{ path: "$", message: `invalid json: ${err instanceof Error ? err.message : String(err)}` }]);
  }
  cached = compileGame(doc, (uri) => readUnderWeb(root, uri));
  return cached;
}
