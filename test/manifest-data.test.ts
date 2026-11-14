import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { nodeGameFiles } from "../src/server/game-files-node.ts";
import { loadInstalledGame } from "../src/server/load-game.ts";
import { loadArena } from "../src/server/world-loader.ts";

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
  assert.deepEqual(warnings, []);
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
  const graph = JSON.parse(readFileSync("web/game/scene-graph.json", "utf8")) as {
    portals?: Array<{ id?: string; door?: string; locked?: boolean; key?: string }>;
  };
  const doors = new Map(loadArena().view.doors.map((door) => [door.id, door]));
  const problems: string[] = [];
  for (const portal of graph.portals ?? []) {
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
