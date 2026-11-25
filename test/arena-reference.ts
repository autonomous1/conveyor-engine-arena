// Task 193: the tests ground on the checked-in arena-1 reference, not the live
// arena-2 bake under web/game. The loader's `GameFiles` seam is the injection
// point: every `./web/game/<file>` read is mapped to `test/fixtures/arena-1/`.
import { readFileSync } from "node:fs";
import type { GameFiles } from "../src/server/game-files.ts";
import { nodeGameFiles } from "../src/server/game-files-node.ts";
import { loadArena, type LoadedArena } from "../src/server/world-loader.ts";
import { parseSceneGraph, type SceneGraph } from "../src/shared/scene-graph.ts";

const FIXTURE = new URL("./fixtures/arena-1/", import.meta.url);
const PREFIX = "./web/game/";

const fileOf = (ref: string): URL | undefined => (ref.startsWith(PREFIX) ? new URL(ref.slice(PREFIX.length), FIXTURE) : undefined);

/** The reference file set: the arena-1 bake's `web/game` tree. */
export function referenceFiles(): GameFiles {
  return {
    text(ref) {
      const file = fileOf(ref);
      return file ? readFileSync(file, "utf8") : undefined;
    },
    bytes(uri) {
      // Models are presentation, not layout: keep the installed bytes.
      return nodeGameFiles().bytes(uri);
    },
  };
}

/** One fixture file as text (a manifest path or a bare fixture name). */
export function referenceText(file: string): string {
  return readFileSync(new URL(file.replace(PREFIX, ""), FIXTURE), "utf8");
}

/** The arena-1 reference arena, loaded through the same seam as production. */
export function loadReferenceArena(): LoadedArena {
  return loadArena(referenceFiles());
}

/** The reference scene graph, parsed with the reference arena's doors. */
export function referenceSceneGraph(): SceneGraph {
  const arena = loadReferenceArena();
  return parseSceneGraph(JSON.parse(referenceText("scene-graph.json")), arena.view.doors).graph;
}
