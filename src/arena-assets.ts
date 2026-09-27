import { FixtureRegistry } from "conveyor-engine-assets";
import type { EngineManifest, StaticWorldDefinition } from "conveyor-engine-assets";
import { loadInstalledGame } from "./server/load-game.js";

const installed = loadInstalledGame();

export const ARENA_BUNDLE_ID = installed.view.bundleId;
export const ARENA_BUNDLE_VERSION = installed.bundleVersion;
export const ARENA_COLLISION = installed.collision;

export function arenaVisualGlb(): Uint8Array {
  return installed.visualBytes;
}

export function arenaManifest(): EngineManifest {
  return installed.engineManifest;
}

export function arenaFixtures(): FixtureRegistry {
  return new FixtureRegistry()
    .success("memory:collision", JSON.stringify(installed.collision))
    .success("memory:visual", installed.visualBytes)
    .success("memory:box", new TextEncoder().encode("box"));
}

export function arenaStaticWorld(): { definition: StaticWorldDefinition; hash: string; manifest: EngineManifest } {
  return {
    definition: installed.definition,
    hash: installed.authoritativeHash,
    manifest: installed.engineManifest,
  };
}
