import { applyHostNoclip } from "../shared/movements.js";
import type { GameFiles } from "./game-files.js";
import { nodeGameFiles, nodeHostEnv, projectRoot as findProjectRoot } from "./game-files-node.js";
import { compileGame, GameManifestError, placementRefsOf, type CompiledGame, type CompileSources, type PlacementFileSource } from "./game-manifest.js";

const MANIFEST_REF = "./web/game/arena.game.json";
const PROFILES_REF = "./web/game/building-profiles.json";

export function projectRoot(): string {
  return findProjectRoot();
}

let cached: CompiledGame | undefined;

/**
 * Compile the installed game.
 * @why Omit `files` to read the repo from disk and cache that result. A provided
 *      `files` skips the cache.
 * @pre `env` supplies `ARENA_NOCLIP`; the disk path defaults to the process
 *      environment.
 */
export function loadInstalledGame(files?: GameFiles, env?: Record<string, string | undefined>): CompiledGame {
  if (files) return compileInstalled(files, env ?? {});
  if (cached) return cached;
  cached = compileInstalled(nodeGameFiles(), env ?? nodeHostEnv());
  return cached;
}

function compileInstalled(files: GameFiles, env: Record<string, string | undefined>): CompiledGame {
  const text = readManifestText(files);
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    throw new GameManifestError([{ path: "$", message: `invalid json: ${err instanceof Error ? err.message : String(err)}` }]);
  }
  const sources = readSources(files, doc);
  const game = compileGame(doc, (uri) => files.bytes(uri), sources);
  applyHostNoclip(game.view, env);
  return game;
}

function readManifestText(files: GameFiles): string {
  let text: string | undefined;
  try {
    text = files.text(MANIFEST_REF);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith("file not found")) {
      throw new GameManifestError([{ path: "$", message: "missing web/game/arena.game.json" }]);
    }
    throw new GameManifestError([{ path: "$", message }]);
  }
  if (text === undefined) throw new GameManifestError([{ path: "$", message: "missing web/game/arena.game.json" }]);
  return text;
}

/**
 * Read placements, and bounds, spawnPoints, playerSpawnPoints, lights, elevators, sceneGraph, or regions when those fields are paths.
 * Inline bounds, spawn points, and lights are left for `compileGame`.
 * `web/game/building-profiles.json` is included when that file exists.
 * A string root reads from disk. `GameFiles` reads from that provider.
 * @post Absent placements is `undefined`. An empty placements list is `{ placementFiles: [] }`.
 */
export function readManifestSources(root: string, doc: unknown): CompileSources | undefined;
export function readManifestSources(files: GameFiles, doc: unknown): CompileSources | undefined;
export function readManifestSources(rootOrFiles: string | GameFiles, doc: unknown): CompileSources | undefined {
  const files = typeof rootOrFiles === "string" ? nodeGameFiles(rootOrFiles) : rootOrFiles;
  return readSources(files, doc);
}

function readSources(files: GameFiles, doc: unknown): CompileSources | undefined {
  if (!doc || typeof doc !== "object") return undefined;
  const scene = (doc as { scene?: unknown }).scene;
  if (!scene || typeof scene !== "object") return undefined;
  const record = scene as Record<string, unknown>;
  const sources: CompileSources = {};
  if (Object.prototype.hasOwnProperty.call(record, "placements")) {
    sources.placementFiles = placementFilesFrom(files, doc);
  }
  if (typeof record.bounds === "string") {
    sources.boundsFile = readSceneText(files, record.bounds, "scene.bounds");
  }
  if (typeof record.spawnPoints === "string") {
    sources.spawnPointsFile = readSceneText(files, record.spawnPoints, "scene.spawnPoints");
  }
  if (typeof record.playerSpawnPoints === "string") {
    sources.playerSpawnPointsFile = readSceneText(files, record.playerSpawnPoints, "scene.playerSpawnPoints");
  }
  if (typeof record.lights === "string") {
    sources.lightsFile = readSceneText(files, record.lights, "scene.lights");
  }
  if (typeof record.elevators === "string") {
    sources.elevatorsFile = readSceneText(files, record.elevators, "scene.elevators");
  }
  if (typeof record.sceneGraph === "string") {
    sources.sceneGraphFile = readSceneText(files, record.sceneGraph, "scene.sceneGraph");
  }
  if (typeof record.regions === "string") {
    sources.regionsFile = readSceneText(files, record.regions, "scene.regions");
  }
  const profiles = readOptional(files, PROFILES_REF);
  if (profiles !== undefined) sources.buildingProfiles = profiles;
  if (!sources.placementFiles && !sources.boundsFile && !sources.spawnPointsFile && !sources.playerSpawnPointsFile && !sources.lightsFile && !sources.elevatorsFile && !sources.sceneGraphFile && !sources.regionsFile) return undefined;
  return sources;
}

/**
 * Read every `scene.placements` path.
 * @post Absent is `undefined`; a present empty list is `[]`.
 */
export function readPlacementFiles(root: string, doc: unknown): PlacementFileSource[] | undefined {
  return placementFilesFrom(nodeGameFiles(root), doc);
}

function placementFilesFrom(files: GameFiles, doc: unknown): PlacementFileSource[] | undefined {
  if (!doc || typeof doc !== "object") return undefined;
  const scene = (doc as { scene?: unknown }).scene;
  if (!scene || typeof scene !== "object" || !Object.prototype.hasOwnProperty.call(scene, "placements")) return undefined;
  const { refs, issues } = placementRefsOf(scene);
  if (issues.length) throw new GameManifestError(issues);
  return refs.map((ref) => readSceneText(files, ref.file, ref.path));
}

function readOptional(files: GameFiles, ref: string): string | undefined {
  try {
    return files.text(ref);
  } catch {
    return undefined;
  }
}

function readSceneText(files: GameFiles, ref: string, issuePath: string): PlacementFileSource {
  let text: string | undefined;
  try {
    text = files.text(ref);
  } catch (err) {
    throw new GameManifestError([{ path: issuePath, message: err instanceof Error ? err.message : String(err) }]);
  }
  if (text === undefined) throw new GameManifestError([{ path: issuePath, message: `cannot read ${ref}` }]);
  return { path: ref, text };
}
