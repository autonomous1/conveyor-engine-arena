import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { interpretPlacements, resolvePlacementsPath } from "../src/server/placements-file.ts";

const models = new Set(["brutalist-urban-1", "brutalist-urban-2", "brutalist-urban-3", "brutalist-urban-4"]);

test("a placements file becomes buildings and collision ids from 100", () => {
  const file = {
    formatVersion: 1,
    units: "meters",
    placements: [
      { id: "south", model: "brutalist-urban-1", position: [8, 0, -8], yaw: -90, scale: 2 },
    ],
    obstacles: [
      { id: "south-wall-0", kind: "aabb", min: [0, 0, -1], max: [1, 2, 0] },
      { id: "south-wall-1", kind: "aabb", min: [2, 0, -1], max: [3, 2, 0] },
    ],
  };
  const used = new Set([1, 2, 3, 100]);
  const baked = interpretPlacements(file, models, used);
  assert.deepEqual(baked.issues, []);
  assert.equal(baked.buildings[0]?.yaw, 270);
  assert.equal(baked.buildings[0]?.scale, 2);
  assert.deepEqual(baked.boxes.map((box) => box.id), [101, 102]);
  assert.equal(baked.boxes[0]?.minY, 0);
  assert.equal(baked.boxes[0]?.maxY, 2);
});

test("a bad yaw, an unknown model, and an escaping path fail", () => {
  const baked = interpretPlacements({
    formatVersion: 1,
    units: "meters",
    placements: [
      { id: "south", model: "missing", position: [0, 0, 0], yaw: 45, scale: 1 },
    ],
    obstacles: [],
  }, models, new Set());
  assert.ok(baked.issues.some((issue) => issue.path.endsWith(".model")));
  assert.ok(baked.issues.some((issue) => issue.path.endsWith(".yaw")));
  assert.equal(baked.buildings.length, 0);

  const root = mkdtempSync(path.join(tmpdir(), "arena-placements-"));
  try {
    const scene = path.join(root, "scenes");
    mkdirSync(scene);
    writeFileSync(path.join(scene, "arena-1.placements.json"), "{}");
    const resolved = resolvePlacementsPath(root, "scenes/arena-1.placements.json");
    assert.equal(resolved, path.join(scene, "arena-1.placements.json"));
    assert.throws(() => resolvePlacementsPath(root, "../secret.json"), /outside/);
    assert.throws(() => resolvePlacementsPath(root, "/etc/hostname"), /relative path/);
    const outside = path.join(root, "link.json");
    symlinkSync("/etc/hostname", outside);
    assert.throws(() => resolvePlacementsPath(root, "link.json"), /outside/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the manifest placements file loads every building and box it lists", () => {
  const root = path.join(import.meta.dirname, "..");
  const manifest = JSON.parse(readFileSync(path.join(root, "web/game/arena.game.json"), "utf8")) as {
    assets?: Array<{ id?: string; kind?: string }>;
    scene: { placements: string | string[] };
  };
  const listed = manifest.scene.placements;
  const placementPath = Array.isArray(listed) ? listed[0] : listed;
  if (!placementPath) throw new Error("arena.game.json has no placements path");
  const file = resolvePlacementsPath(root, placementPath);
  const raw = JSON.parse(readFileSync(file, "utf8")) as {
    placements?: Array<{ id?: string; model?: string; scale?: number; hinge?: unknown }>;
    obstacles?: unknown[];
  };
  const known = new Set(
    (manifest.assets ?? []).flatMap((asset) => asset.kind === "model" && asset.id ? [asset.id] : []),
  );
  const baked = interpretPlacements(raw, known, new Set([1, 2, 3]));
  assert.deepEqual(baked.issues, []);
  const placements = raw.placements ?? [];
  const buildings = placements.filter((item) => item.hinge == null);
  const doors = placements.filter((item) => item.hinge != null);
  assert.equal(baked.buildings.length, buildings.length);
  assert.equal(baked.doors.length, doors.length);
  assert.equal(baked.boxes.length, raw.obstacles?.length ?? 0);
  if (baked.boxes.length > 0) assert.equal(baked.boxes[0]?.id, 100);
  for (const placement of buildings) {
    const found = baked.buildings.find((building) => building.id === placement.id);
    assert.ok(found, placement.id);
    assert.equal(found.model, placement.model);
    assert.equal(found.scale, placement.scale);
  }
});
