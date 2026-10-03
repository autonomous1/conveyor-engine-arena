import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { compileGame, GameManifestError, placementRefsOf, type CompiledGame, type CompileSources, type PlacementFileSource } from "./game-manifest.js";
import { resolvePlacementsPath } from "./placements-file.js";

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
  const sources = readManifestSources(root, doc);
  cached = compileGame(doc, (uri) => readUnderWeb(root, uri), sources);
  return cached;
}

/**
 * Read placements, and bounds or spawnPoints when those fields are paths.
 * Inline bounds and spawn points are left for `compileGame`. Absent placements
 * is `undefined`. An empty placements list is `{ placementFiles: [] }`.
 */
export function readManifestSources(root: string, doc: unknown): CompileSources | undefined {
  if (!doc || typeof doc !== "object") return undefined;
  const scene = (doc as { scene?: unknown }).scene;
  if (!scene || typeof scene !== "object") return undefined;
  const record = scene as Record<string, unknown>;
  const sources: CompileSources = {};
  if (Object.prototype.hasOwnProperty.call(record, "placements")) {
    sources.placementFiles = readPlacementFiles(root, doc);
  }
  if (typeof record.bounds === "string") {
    sources.boundsFile = readSceneText(root, record.bounds, "scene.bounds");
  }
  if (typeof record.spawnPoints === "string") {
    sources.spawnPointsFile = readSceneText(root, record.spawnPoints, "scene.spawnPoints");
  }
  if (!sources.placementFiles && !sources.boundsFile && !sources.spawnPointsFile) return undefined;
  return sources;
}

/** Read every `scene.placements` path. Absent is `undefined`. An empty list is `[]`. */
export function readPlacementFiles(root: string, doc: unknown): PlacementFileSource[] | undefined {
  if (!doc || typeof doc !== "object") return undefined;
  const scene = (doc as { scene?: unknown }).scene;
  if (!scene || typeof scene !== "object" || !Object.prototype.hasOwnProperty.call(scene, "placements")) return undefined;
  const { refs, issues } = placementRefsOf(scene);
  if (issues.length) throw new GameManifestError(issues);
  return refs.map((ref) => readSceneText(root, ref.file, ref.path));
}

function readSceneText(root: string, ref: string, issuePath: string): PlacementFileSource {
  let file: string;
  try {
    file = resolvePlacementsPath(root, ref);
  } catch (err) {
    throw new GameManifestError([{ path: issuePath, message: err instanceof Error ? err.message : String(err) }]);
  }
  try {
    return { path: ref, text: readFileSync(file, "utf8") };
  } catch {
    throw new GameManifestError([{ path: issuePath, message: `cannot read ${ref}` }]);
  }
}
