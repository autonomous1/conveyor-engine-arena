import type { GameFiles } from "../server/game-files.js";

/**
 * Solo bundle stand-in.
 * @why The page always passes fetched `GameFiles` and never calls these.
 */
export function projectRoot(): string {
  throw new Error("node-only");
}

export function nodeHostEnv(): Record<string, string | undefined> {
  throw new Error("node-only");
}

export function nodeGameFiles(): GameFiles {
  throw new Error("node-only");
}

export function resolvePlacementsPath(): string {
  throw new Error("node-only");
}
