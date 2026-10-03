import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { arenaStaticWorld } from "../dist/arena-assets.js";
import { compileGame, GameManifestError, type CompileSources } from "../dist/server/game-manifest.js";
import { loadInstalledGame, projectRoot, readManifestSources, readPlacementFiles } from "../dist/server/load-game.js";

function filesFromDisk(): Map<string, Uint8Array> {
  const root = projectRoot();
  const doc = document() as { assets?: Array<{ uri?: unknown }> };
  const out = new Map<string, Uint8Array>();
  for (const asset of doc.assets ?? []) {
    if (typeof asset.uri !== "string") continue;
    out.set(asset.uri, new Uint8Array(readFileSync(`${root}/web${asset.uri}`)));
  }
  return out;
}

function document(): Record<string, unknown> {
  return JSON.parse(readFileSync(`${projectRoot()}/web/game/arena.game.json`, "utf8")) as Record<string, unknown>;
}

function compile(doc: unknown, read: (uri: string) => Uint8Array | undefined, sources?: CompileSources) {
  const resolved = sources ?? readManifestSources(projectRoot(), doc);
  return compileGame(doc, read, resolved);
}

test("installed manifest matches the authoritative world and keeps spawns clear", () => {
  const game = loadInstalledGame();
  const arena = arenaStaticWorld();
  assert.equal(game.authoritativeHash, arena.hash);
  assert.equal(game.view.bundleId, "arena.one-room.v1");
  assert.equal(game.view.walls.length, 0);
  assert.equal(game.view.buildings.length, 11);
  assert.equal(game.view.props.length, 0);
  assert.deepEqual(
    game.view.buildings.filter((building) => building.model.endsWith("/ammo-crate.glb")).map((building) => building.id).sort(),
    ["cover-crate-1", "cover-crate-2", "cover-crate-3"],
  );
  assert.equal(game.view.shadows?.quality, "off");
  assert.deepEqual(game.view.cityscape, {
    texture: "/assets/textures/cityscape-pano-3-lt2.png",
    shape: "cylinder",
    radius: 80,
    height: 80.534,
  });
  assert.deepEqual(
    { texture: game.view.sky?.texture, shape: game.view.sky?.shape, radius: game.view.sky?.radius, height: game.view.sky?.height },
    { texture: "/assets/textures/dark-sky-pano-4-sm.png", shape: "dome", radius: 160, height: 320 },
  );
  const characterScale = Object.fromEntries(game.view.characters.map((character) => [character.id, character.scale]));
  assert.deepEqual(characterScale, { 'player-a': 4, 'player-b': 4, 'player-1': 3 });
  const rider = game.view.characters.find((character) => character.id === "player-a");
  const skeleton = game.view.characters.find((character) => character.id === "player-b");
  assert.ok(rider && skeleton);
  assert.deepEqual(
    Object.fromEntries(Object.entries(rider.animations).map(([movement, entry]) => [movement, entry.speed])),
    { idle: 0, walk: 1, run: 2, fall: 0, angry: 3 },
  );
  assert.equal(rider.animations.walk.clip, "please generate a ilitary marching walk and call it \"walk\".001");
  assert.equal(skeleton.animations.run.clip, "I would like to make a \"zombie run\"");
  assert.equal(skeleton.animations.fall.clip, "fall");
  assert.equal(skeleton.animations.angry.clip, "angry_01");
  assert.ok(game.view.characters.length >= 2);
  const r = game.view.pawnRadius;
  for (const spawn of game.definition.spawnPoints) {
    for (const box of game.definition.aabbs) {
      const inside = spawn.x > box.minX - r && spawn.x < box.maxX + r && spawn.z > box.minZ - r && spawn.z < box.maxZ + r;
      assert.equal(inside, false, `${spawn.id} overlaps ${box.id}`);
    }
  }
});

test("invalid manifest names the field", () => {
  const doc = document();
  const files = filesFromDisk();
  const read = (uri: string) => files.get(uri);
  assert.throws(() => compile({ ...doc, formatVersion: 2 }, read), (err: unknown) => {
    assert.ok(err instanceof GameManifestError);
    assert.ok(err.issues.some((issue) => issue.path === "formatVersion"));
    return true;
  });
  const scene = { ...(doc.scene as Record<string, unknown>) };
  scene.props = [{ id: "cover-center", model: "missing-model", collision: 1 }];
  assert.throws(() => compile({ ...doc, scene }, read), (err: unknown) => {
    assert.ok(err instanceof GameManifestError);
    assert.ok(err.issues.some((issue) => issue.path.includes("model")));
    return true;
  });
  const scaled = structuredClone(doc) as { assets: Array<{ id: string; scale?: number }> };
  const player = scaled.assets.find((asset) => asset.id === "player-a");
  assert.ok(player);
  player.scale = 0;
  assert.throws(() => compile(scaled, read), (err: unknown) => {
    assert.ok(err instanceof GameManifestError);
    assert.ok(err.issues.some((issue) => issue.path.endsWith(".scale")));
    return true;
  });
  player.scale = 4;
  const compiled = compile(scaled, read);
  assert.equal(compiled.view.characters.find((character) => character.id === "player-a")!.scale, 4);
});

test("replacing texture bytes changes presentation identity only", () => {
  const doc = document();
  const files = filesFromDisk();
  const read = (uri: string) => files.get(uri);
  const before = compile(doc, read);
  const texture = before.view.floor.texture;
  const next = new Map(files);
  const bytes = new Uint8Array(files.get(texture)!);
  next.set(texture, new Uint8Array([...bytes, 1]));
  const after = compile(doc, (uri) => next.get(uri));
  assert.equal(after.authoritativeHash, before.authoritativeHash);
  assert.notEqual(after.presentationHash, before.presentationHash);
  const moved = structuredClone(doc) as { assets: Array<{ id: string; uri: string }> };
  const player = moved.assets.find((asset) => asset.id === "player-a");
  assert.ok(player);
  player.uri = before.view.characters.find((character) => character.id === "player-b")!.model;
  next.set(player.uri, files.get(player.uri)!);
  const retargeted = compile(moved, (uri) => next.get(uri));
  assert.equal(retargeted.view.characters.find((character) => character.id === "player-a")!.model, player.uri);
  assert.equal(retargeted.authoritativeHash, before.authoritativeHash);
});

test("optional scene blocks and a placements list", () => {
  const doc = document();
  const files = filesFromDisk();
  const read = (uri: string) => files.get(uri);
  const base = structuredClone(doc) as { scene: Record<string, unknown> };

  const asString = structuredClone(base) as { scene: { placements: unknown } };
  asString.scene.placements = "./web/game/buildings.placements.json";
  assert.equal(compile(asString, read).view.buildings.length, 8);

  const withWalls = structuredClone(doc) as { scene: { walls?: unknown } };
  withWalls.scene.walls = {
    height: 8,
    thickness: 2,
    collision: true,
    faces: {
      south: "brutalist-urban-1",
      west: "brutalist-urban-2",
      north: "brutalist-urban-3",
      east: "brutalist-urban-4",
    },
  };
  const faced = compile(withWalls, read);
  const faceModel = Object.fromEntries(faced.view.walls.map((wall) => [wall.face, wall.model]));
  assert.deepEqual(faceModel, {
    south: "/assets/models/brutalist-urban-1.glb",
    west: "/assets/models/brutalist-urban-2.glb",
    north: "/assets/models/brutalist-urban-3.glb",
    east: "/assets/models/brutalist-urban-4.glb",
  });

  delete base.scene.walls;
  delete base.scene.sky;
  const stripped = compile(base, read);
  assert.equal(stripped.view.walls.length, 0);
  assert.equal(stripped.view.sky, undefined);
  assert.equal(stripped.view.buildings.length, 11);
  assert.equal(stripped.definition.aabbs.some((box) => box.id === 10), false);
  assert.equal(stripped.view.floor?.y, 0);
  assert.equal(stripped.view.shadows?.quality, "off");

  const open = structuredClone(base) as { scene: Record<string, unknown> };
  delete open.scene.spawnPoints;
  delete open.scene.collision;
  delete open.scene.props;
  delete open.scene.floor;
  delete open.scene.cityscape;
  delete open.scene.shadows;
  const spawned = compile(open, read);
  assert.equal(spawned.definition.spawnPoints.length, 0);
  assert.equal(spawned.view.floor, undefined);
  assert.equal(spawned.view.cityscape, undefined);
  assert.equal(spawned.view.shadows, undefined);
  assert.equal(spawned.definition.aabbs.some((box) => box.id === 1), false);
  assert.ok(spawned.definition.aabbs.some((box) => box.id >= 100));

  const empty = structuredClone(base) as { scene: { placements: unknown; collision?: unknown } };
  empty.scene.placements = [];
  empty.scene.collision = [{ id: 1, kind: "aabb", min: [20, 0, 20], max: [21, 1, 21] }];
  assert.equal(compile(empty, read).view.buildings.length, 0);

  const a = {
    formatVersion: 1,
    units: "meters",
    placements: [],
    obstacles: [{ id: "box-a", kind: "aabb", min: [20, 0, 20], max: [21, 1, 21] }],
    scene: {
      bounds: { minX: -1, maxX: 1, minY: 0, maxY: 1, minZ: -1, maxZ: 1 },
      floor: { y: 9, material: "floor-stone" },
      sky: { kind: "sky-dome", material: "cloudy-sky" },
      cityscape: { material: "cityscape-pano" },
      shadows: { quality: "realistic" },
      spawnPoints: [{ id: "from-a", x: 0, y: 0, z: 18, yaw: 0 }],
      collision: [{ id: 50, kind: "aabb", min: [18, 0, 18], max: [19, 1, 19] }],
    },
  };
  const b = {
    formatVersion: 1,
    units: "meters",
    placements: [{ id: "prop-b", model: "brutalist-urban-1", position: [12, 0, 18], yaw: 0, scale: 1 }],
    obstacles: [{ id: "box-b", kind: "aabb", min: [20, 0, 16], max: [21, 1, 17] }],
    scene: {
      props: [{ id: "from-b", model: "cover-crate", collision: 50 }],
    },
  };
  const overlay = structuredClone(base) as { scene: Record<string, unknown> };
  overlay.scene.placements = ["./a.json", "./b.json"];
  overlay.scene.bounds = { minX: -24, maxX: 24, minY: -2, maxY: 12, minZ: -24, maxZ: 24 };
  overlay.scene.spawnPoints = [];
  const sources = [
    { path: "./a.json", text: JSON.stringify(a) },
    { path: "./b.json", text: JSON.stringify(b) },
  ];
  const merged = compile(overlay, read, { placementFiles: sources });
  assert.equal(merged.view.walls.length, 0);
  assert.equal(merged.view.sky, undefined);
  assert.equal(merged.view.floor?.y, 0);
  assert.equal(merged.view.bounds.minX, -24);
  assert.equal(merged.view.shadows?.quality, "off");
  assert.ok(merged.definition.aabbs.some((box) => box.minX === 20 && box.minZ === 20));
  assert.ok(merged.definition.aabbs.some((box) => box.minX === 20 && box.minZ === 16));
  assert.ok(merged.definition.aabbs.some((box) => box.id === 50));
  assert.ok(merged.definition.spawnPoints.some((spawn) => spawn.id === "from-a"));
  assert.ok(merged.view.props.some((prop) => prop.id === "from-b"));
  assert.ok(merged.view.buildings.some((building) => building.id === "prop-b"));

  const duplicate = {
    ...b,
    obstacles: [{ id: "box-a", kind: "aabb", min: [20, 0, 16], max: [21, 1, 17] }],
  };
  assert.throws(() => compile(overlay, read, {
    placementFiles: [sources[0]!, { path: "./b.json", text: JSON.stringify(duplicate) }],
  }), (err: unknown) => {
    assert.ok(err instanceof GameManifestError);
    assert.match(err.message, /duplicate obstacle id box-a/);
    assert.match(err.message, /b\.json/);
    return true;
  });

  assert.throws(() => readPlacementFiles(projectRoot(), {
    scene: { placements: ["./web/game/missing.placements.json"] },
  }), (err: unknown) => {
    assert.ok(err instanceof GameManifestError);
    assert.match(err.message, /missing\.placements\.json/);
    return true;
  });

  const rooted = document() as { scene: Record<string, unknown> };
  const listed = readPlacementFiles(projectRoot(), rooted);
  assert.ok(listed);
  const fromFiles = structuredClone(rooted) as { scene: Record<string, unknown> };
  fromFiles.scene.bounds = "./web/game/bounds.json";
  fromFiles.scene.spawnPoints = "./web/game/spawn-points.json";
  const loaded = compile(fromFiles, read, {
    placementFiles: listed,
    boundsFile: {
      path: "./web/game/bounds.json",
      text: JSON.stringify({ minX: -24, maxX: 24, minY: -2, maxY: 12, minZ: -24, maxZ: 24 }),
    },
    spawnPointsFile: {
      path: "./web/game/spawn-points.json",
      text: JSON.stringify([{ id: "from-file", x: -18, y: 0, z: 0, yaw: 90 }]),
    },
  });
  assert.equal(loaded.view.bounds.minX, -24);
  assert.equal(loaded.view.bounds.maxZ, 24);
  assert.equal(loaded.view.bounds.minY, -2);
  assert.ok(loaded.definition.spawnPoints.some((spawn) => spawn.id === "from-file" && spawn.x === -18 && spawn.z === 0 && spawn.yaw === 90));
  assert.equal(loaded.definition.spawnPoints.some((spawn) => spawn.id === "spawn-a"), false);
  assert.equal(loaded.view.buildings.length, 11);

  assert.throws(() => readManifestSources(projectRoot(), {
    scene: { bounds: "./web/game/missing-bounds.json" },
  }), (err: unknown) => {
    assert.ok(err instanceof GameManifestError);
    assert.match(err.message, /missing-bounds\.json/);
    return true;
  });
  assert.throws(() => readManifestSources(projectRoot(), {
    scene: { spawnPoints: "./web/game/missing-spawns.json" },
  }), (err: unknown) => {
    assert.ok(err instanceof GameManifestError);
    assert.match(err.message, /missing-spawns\.json/);
    return true;
  });
  assert.throws(() => compile({ ...doc, scene: { ...(doc.scene as object), bounds: "./web/game/bounds.json" } }, read, {
    placementFiles: listed,
  }), (err: unknown) => {
    assert.ok(err instanceof GameManifestError);
    assert.match(err.message, /file was not loaded/);
    return true;
  });

  const noId = structuredClone(doc) as { scene: Record<string, unknown> };
  delete noId.scene.id;
  assert.throws(() => compile(noId, read), (err: unknown) => {
    assert.ok(err instanceof GameManifestError);
    assert.ok(err.issues.some((issue) => issue.path === "scene.id"));
    return true;
  });
});
