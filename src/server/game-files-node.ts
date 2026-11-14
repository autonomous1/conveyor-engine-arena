// ARCHITECTURE: Disk-backed `GameFiles`: manifest discovery, path resolution,
//   and placement resolution against this repo or the sibling checkout.
// Wiring: load-game.ts reads the installed game through it; main.ts uses its
//   root for boot.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import type { GameFiles } from "./game-files.js";
import { GameManifestError } from "./game-manifest.js";

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

export function nodeHostEnv(): Record<string, string | undefined> {
  return process.env;
}

/**
 * Resolve `scene.placements` against the arena root.
 * The file may live in this repo or in the sibling `blueprint-scene` checkout.
 * @post Absolute paths and anything outside those two trees are rejected.
 */
export function resolvePlacementsPath(root: string, ref: string): string {
  const trimmed = ref.trim();
  if (!trimmed || trimmed.includes("\0") || isAbsolute(trimmed)) {
    throw new Error("must be a relative path");
  }
  const file = resolve(root, trimmed);
  const bases = [resolve(root)];
  const sibling = resolve(root, "..", "blueprint-scene");
  if (existsSync(sibling)) bases.push(sibling);
  if (!bases.some((base) => inside(base, file))) {
    throw new Error(`path is outside the arena and blueprint-scene trees: ${trimmed}`);
  }
  if (!existsSync(file)) throw new Error(`file not found: ${trimmed}`);
  const realFile = realpathSync(file);
  const realBases = bases.map((base) => realpathSync(base));
  if (!realBases.some((base) => inside(base, realFile))) {
    throw new Error(`path is outside the arena and blueprint-scene trees: ${trimmed}`);
  }
  return realFile;
}

function inside(base: string, file: string): boolean {
  const rel = relative(base, file);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
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

function isProfiles(ref: string): boolean {
  const trimmed = ref.trim().replace(/^\.\//, "");
  return trimmed === "web/game/building-profiles.json";
}

/** Disk `GameFiles` for one arena root. Omitted root walks up from this module to the manifest. */
export function nodeGameFiles(root = projectRoot()): GameFiles {
  return {
    text(ref: string): string | undefined {
      if (isProfiles(ref)) {
        try {
          return readFileSync(resolvePlacementsPath(root, ref), "utf8");
        } catch {
          return undefined;
        }
      }
      const file = resolvePlacementsPath(root, ref);
      try {
        return readFileSync(file, "utf8");
      } catch {
        return undefined;
      }
    },
    bytes(uri: string): Uint8Array | undefined {
      return readUnderWeb(root, uri);
    },
  };
}
