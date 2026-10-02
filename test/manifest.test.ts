import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { arenaStaticWorld } from "../dist/arena-assets.js";
import { compileGame, GameManifestError } from "../dist/server/game-manifest.js";
import { loadInstalledGame, projectRoot } from "../dist/server/load-game.js";

function filesFromDisk(): Map<string, Uint8Array> {
  const game = loadInstalledGame();
  const root = projectRoot();
  const uris = [
    ...game.view.characters.map((character) => character.model),
    ...game.view.props.map((prop) => prop.model),
    game.view.floor.texture,
    game.view.sky.texture,
    game.view.cityscape.texture,
    ...game.view.walls.map((wall) => wall.model),
  ];
  const out = new Map<string, Uint8Array>();
  for (const uri of uris) out.set(uri, new Uint8Array(readFileSync(`${root}/web${uri}`)));
  return out;
}

function document(): Record<string, unknown> {
  return JSON.parse(readFileSync(`${projectRoot()}/web/game/arena.game.json`, "utf8")) as Record<string, unknown>;
}

test("installed manifest matches the authoritative world and keeps spawns clear", () => {
  const game = loadInstalledGame();
  const arena = arenaStaticWorld();
  assert.equal(game.authoritativeHash, arena.hash);
  assert.equal(game.view.bundleId, "arena.one-room.v1");
  assert.equal(game.view.walls.length, 4);
  assert.equal(game.view.shadows.quality, "realistic");
  assert.deepEqual(game.view.cityscape, {
    texture: "/assets/textures/cityscape-pano-3-lt.png",
    shape: "cylinder",
    radius: 80,
    height: 80.534,
  });
  assert.deepEqual(
    { texture: game.view.sky.texture, shape: game.view.sky.shape, radius: game.view.sky.radius, height: game.view.sky.height },
    { texture: "/assets/textures/dark-sky-pano-4.png", shape: "dome", radius: 160, height: 320 },
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
  const faceModel = Object.fromEntries(game.view.walls.map((wall) => [wall.face, wall.model]));
  assert.deepEqual(faceModel, {
    south: "/assets/models/brutalist-urban-1.glb",
    west: "/assets/models/brutalist-urban-2.glb",
    north: "/assets/models/brutalist-urban-3.glb",
    east: "/assets/models/brutalist-urban-4.glb",
  });
  assert.ok(game.view.props.length >= 2);
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
  assert.throws(() => compileGame({ ...doc, formatVersion: 2 }, read), (err: unknown) => {
    assert.ok(err instanceof GameManifestError);
    assert.ok(err.issues.some((issue) => issue.path === "formatVersion"));
    return true;
  });
  const scene = { ...(doc.scene as Record<string, unknown>) };
  const props = [...(scene.props as unknown[])];
  props[0] = { ...(props[0] as Record<string, unknown>), model: "missing-model" };
  assert.throws(() => compileGame({ ...doc, scene: { ...scene, props } }, read), (err: unknown) => {
    assert.ok(err instanceof GameManifestError);
    assert.ok(err.issues.some((issue) => issue.path.includes("model")));
    return true;
  });
  const scaled = structuredClone(doc) as { assets: Array<{ id: string; scale?: number }> };
  const player = scaled.assets.find((asset) => asset.id === "player-a");
  assert.ok(player);
  player.scale = 0;
  assert.throws(() => compileGame(scaled, read), (err: unknown) => {
    assert.ok(err instanceof GameManifestError);
    assert.ok(err.issues.some((issue) => issue.path.endsWith(".scale")));
    return true;
  });
  player.scale = 4;
  const compiled = compileGame(scaled, read);
  assert.equal(compiled.view.characters.find((character) => character.id === "player-a")!.scale, 4);
});

test("replacing texture bytes changes presentation identity only", () => {
  const doc = document();
  const files = filesFromDisk();
  const read = (uri: string) => files.get(uri);
  const before = compileGame(doc, read);
  const texture = before.view.floor.texture;
  const next = new Map(files);
  const bytes = new Uint8Array(files.get(texture)!);
  next.set(texture, new Uint8Array([...bytes, 1]));
  const after = compileGame(doc, (uri) => next.get(uri));
  assert.equal(after.authoritativeHash, before.authoritativeHash);
  assert.notEqual(after.presentationHash, before.presentationHash);
  const moved = structuredClone(doc) as { assets: Array<{ id: string; uri: string }> };
  const player = moved.assets.find((asset) => asset.id === "player-a");
  assert.ok(player);
  player.uri = before.view.characters.find((character) => character.id === "player-b")!.model;
  next.set(player.uri, files.get(player.uri)!);
  const retargeted = compileGame(moved, (uri) => next.get(uri));
  assert.equal(retargeted.view.characters.find((character) => character.id === "player-a")!.model, player.uri);
  assert.equal(retargeted.authoritativeHash, before.authoritativeHash);
});
