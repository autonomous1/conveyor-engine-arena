import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { nodeGameFiles } from "../src/server/game-files-node.ts";
import { loadInstalledGame } from "../src/server/load-game.ts";
import { loadArena } from "../src/server/world-loader.ts";

let game: ReturnType<typeof loadInstalledGame> | undefined;
const gameOnce = (): ReturnType<typeof loadInstalledGame> => (game ??= loadInstalledGame());
let arena: ReturnType<typeof loadArena> | undefined;
const arenaOnce = (): ReturnType<typeof loadArena> => (arena ??= loadArena());

function pngSize(path: string): { width: number; height: number } {
  const bytes = readFileSync(path);
  assert.equal(bytes.toString("ascii", 1, 4), "PNG", `${path} is not a PNG`);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

test("manifest_loads_without_warnings", () => {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    // Passing files skips the module cache, so the warnings are always emitted.
    loadInstalledGame(nodeGameFiles());
  } finally {
    console.warn = original;
  }
  // The bake's scene-graph portals lag the doors file on the 67 room locks; the
  // compiler rewrites them from the doors and logs that one line (216). It goes
  // away when the sibling bake carries the portal lock. Any other warning fails.
  const unexpected = warnings.filter((line) => !/^scene\.sceneGraph: \d+ door locks disagree with the door placement /.test(line));
  assert.deepEqual(unexpected, []);
});

test("baked_regions_match_the_manifest_player_capsule", () => {
  const game = gameOnce();
  const regions = JSON.parse(readFileSync("web/game/regions.json", "utf8")) as {
    radius?: number;
    height?: number;
    places?: unknown[];
  };
  assert.equal(regions.radius, game.view.pawnRadius);
  assert.equal(regions.height, game.view.pawnHeight);
});

test("sprite_frame_geometry_matches_png", () => {
  const doc = JSON.parse(readFileSync("web/game/arena.game.json", "utf8")) as {
    assets?: Array<{
      id: string;
      uri?: string;
      optional?: boolean;
      sprite?: { columns: number; rows: number; frameCount: number; frameWidth: number; frameHeight: number };
    }>;
  };
  const problems: string[] = [];
  for (const asset of doc.assets ?? []) {
    if (!asset.sprite || !asset.uri) continue;
    const path = `web${asset.uri}`;
    if (!existsSync(path)) {
      if (asset.optional !== true) problems.push(`${asset.id}: missing ${path}`);
      continue;
    }
    const { width, height } = pngSize(path);
    const { columns, rows, frameCount, frameWidth, frameHeight } = asset.sprite;
    if (columns * frameWidth !== width || rows * frameHeight !== height) {
      problems.push(`${asset.id}: declared ${columns * frameWidth}x${rows * frameHeight}, PNG ${width}x${height}`);
    }
    if (frameCount !== columns * rows) {
      problems.push(`${asset.id}: frameCount ${frameCount} != ${columns}x${rows}`);
    }
  }
  assert.deepEqual(problems, []);
});

test("scene_graph_locks_match_doors", () => {
  // The served graph, not the raw bake file: parseSceneGraph rewrites each
  // portal's lock from the door placement (the doors file wins), which is how
  // the 216 room locks reach the graph. The raw file's disagreement is the
  // sibling bake follow-up and is logged, not asserted here.
  const graph = arenaOnce().sceneGraph;
  const doors = new Map(arenaOnce().view.doors.map((door) => [door.id, door]));
  const problems: string[] = [];
  for (const portal of graph?.portals ?? []) {
    const door = doors.get(portal.door ?? portal.id ?? "");
    if (!door) continue;
    const graphKey = typeof portal.key === "string" && portal.key.length > 0 ? portal.key : undefined;
    const doorKey = typeof door.key === "string" && door.key.length > 0 ? door.key : undefined;
    if ((portal.locked === true) !== (door.locked === true) || graphKey !== doorKey) {
      problems.push(`${door.id}: graph ${portal.locked}/${graphKey} vs door ${door.locked}/${doorKey}`);
    }
  }
  assert.deepEqual(problems, []);
});

test("spatial_dag_is_loaded_and_hashed", () => {
  const loaded = arenaOnce();
  assert.ok(loaded.spatialDag, "server did not load the DAG");
  assert.ok(loaded.view.spatialDagHash, "view has no spatialDagHash");
  assert.equal(loaded.spatialDag.hash, loaded.view.spatialDagHash);
  assert.ok(loaded.view.spatialDag, "arena.json view has no DAG");
});
