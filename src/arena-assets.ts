// ARCHITECTURE: The arena asset manifest: bundle ids, collision, GLB/fixture URLs, and static world helpers.
// Wiring: Bake and client tooling read it; it is not live server state.
import { FixtureRegistry } from "conveyor-engine-assets";
import type { EngineManifest, StaticWorldDefinition } from "conveyor-engine-assets";
import { loadInstalledGame } from "./server/load-game.js";

const installed = loadInstalledGame();

/**
 * ARENA BUNDLE ID.
 */
export const ARENA_BUNDLE_ID = installed.view.bundleId;
/**
 * ARENA BUNDLE VERSION.
 */
export const ARENA_BUNDLE_VERSION = installed.bundleVersion;
/**
 * ARENA PAWN HEIGHT.
 */
export const ARENA_PAWN_HEIGHT = installed.view.pawnHeight;
/**
 * ARENA COLLISION.
 */
export const ARENA_COLLISION = installed.collision;

/**
 * arena Visual Glb.
 */
export function arenaVisualGlb(): Uint8Array {
  return installed.visualBytes;
}

/**
 * arena Manifest.
 */
export function arenaManifest(): EngineManifest {
  return installed.engineManifest;
}

/**
 * arena Fixtures.
 */
export function arenaFixtures(): FixtureRegistry {
  return new FixtureRegistry()
    .success("memory:collision", JSON.stringify(installed.collision))
    .success("memory:visual", installed.visualBytes)
    .success("memory:box", new TextEncoder().encode("box"));
}

/**
 * arena Static World.
 */
export function arenaStaticWorld(): { definition: StaticWorldDefinition; hash: string; manifest: EngineManifest } {
  return {
    definition: installed.definition,
    hash: installed.authoritativeHash,
    manifest: installed.engineManifest,
  };
}
