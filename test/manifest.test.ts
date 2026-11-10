import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import * as THREE from "three";
import { placeStaticInstances, propInstancePose } from "../src/client/arena-scene.ts";
import { arenaStaticWorld } from "../dist/arena-assets.js";
import { compileGame, GameManifestError, type CompileSources } from "../dist/server/game-manifest.js";
import { loadInstalledGame, projectRoot, readManifestSources, readPlacementFiles } from "../dist/server/load-game.js";

function filesFromDisk(): Map<string, Uint8Array> {
  const root = projectRoot();
  const doc = document() as { assets?: Array<{ uri?: unknown }> };
  const out = new Map<string, Uint8Array>();
  for (const asset of doc.assets ?? []) {
    if (typeof asset.uri !== "string") continue;
    // An optional audio file the user has not supplied yet is absent; compile reports any required one.
    if (!existsSync(`${root}/web${asset.uri}`)) continue;
    out.set(asset.uri, new Uint8Array(readFileSync(`${root}/web${asset.uri}`)));
  }
  return out;
}

/** The first Ogg page of an Opus stream: 'OggS', one segment holding a 19-byte 'OpusHead'. */
function opusHeader(version = 1): Uint8Array {
  const page = new Uint8Array(27 + 1 + 19);
  page.set(Buffer.from("OggS"), 0);
  page[5] = 0x02;
  page[26] = 1;
  page[27] = 19;
  page.set(Buffer.from("OpusHead"), 28);
  page[36] = version;
  page[37] = 2;
  return page;
}

function document(): Record<string, unknown> {
  return JSON.parse(readFileSync(`${projectRoot()}/web/game/arena.game.json`, "utf8")) as Record<string, unknown>;
}

type PlacementDoc = {
  placements?: Array<{ id?: string; model?: string; hinge?: unknown; position?: number[]; yaw?: number; scale?: number }>;
  obstacles?: unknown[];
  scene?: { props?: unknown[] };
};

function assetRow(id: string): { id?: string; scale?: number; animation?: unknown } | undefined {
  const assets = document().assets as Array<{ id?: string; scale?: number; animation?: unknown }> | undefined;
  return assets?.find((item) => item.id === id);
}

function assetScale(id: string): number {
  const scale = assetRow(id)?.scale;
  return typeof scale === "number" ? scale : 1;
}

/** Scale other than 1, or a clip, is a prop. A crate with no clip stays a building. */
function drawsAsProp(model: string): boolean {
  if (assetScale(model) !== 1) return true;
  const animation = assetRow(model)?.animation;
  return typeof animation === "string" && animation.length > 0;
}

function sceneRecord(): Record<string, unknown> {
  const scene = document().scene;
  return scene && typeof scene === "object" ? scene as Record<string, unknown> : {};
}

function placementRefs(): string[] {
  const listed = sceneRecord().placements;
  if (typeof listed === "string") return [listed];
  return Array.isArray(listed) ? listed.filter((item): item is string => typeof item === "string") : [];
}

function placementDocs(): PlacementDoc[] {
  return placementRefs().map((ref) => JSON.parse(readFileSync(`${projectRoot()}/${ref}`, "utf8")) as PlacementDoc);
}

/** Building ids in the baked files. A hinged placement is a door. A prop scale or a clip is not a building. */
function bakedBuildingIds(): string[] {
  return placementDocs().flatMap((file) =>
    (file.placements ?? []).flatMap((item) => {
      if (item.hinge != null || typeof item.id !== "string") return [];
      if (typeof item.model === "string" && drawsAsProp(item.model)) return [];
      return [item.id];
    }),
  );
}

/** Placement props after coincident stamps of the same model collapse. */
function placementPropCount(): number {
  const stamps = new Set<string>();
  for (const file of placementDocs()) {
    for (const item of file.placements ?? []) {
      if (item.hinge != null || typeof item.model !== "string" || !drawsAsProp(item.model)) continue;
      const position = Array.isArray(item.position) ? item.position.join(",") : "";
      stamps.add(`${item.model}|${position}|${item.yaw}|${item.scale}`);
    }
  }
  return stamps.size;
}

function compile(doc: unknown, read: (uri: string) => Uint8Array | undefined, sources?: CompileSources) {
  const scene = doc && typeof doc === "object"
    ? (doc as { scene?: { lights?: unknown; playerSpawnPoints?: unknown; elevators?: unknown; sceneGraph?: unknown; regions?: unknown; placements?: unknown } }).scene
    : undefined;
  const installedPlacements = (document() as { scene?: { placements?: unknown } }).scene?.placements;
  // A placements subset does not include every baked door. Leave the graph off that compile.
  const placementsChanged = !!scene && JSON.stringify(scene.placements) !== JSON.stringify(installedPlacements);
  if (placementsChanged) delete scene.sceneGraph;
  const resolved = sources ?? readManifestSources(projectRoot(), doc);
  // Partial sources still need the installed lights, player pads, and elevators when the scene keeps those paths.
  if (resolved) {
    if (placementsChanged) delete resolved.sceneGraphFile;
    if (!resolved.lightsFile && typeof scene?.lights === "string") {
      const installed = readManifestSources(projectRoot(), document());
      if (installed?.lightsFile?.path === scene.lights) resolved.lightsFile = installed.lightsFile;
    }
    if (!resolved.playerSpawnPointsFile && typeof scene?.playerSpawnPoints === "string") {
      const installed = readManifestSources(projectRoot(), document());
      if (installed?.playerSpawnPointsFile?.path === scene.playerSpawnPoints) {
        resolved.playerSpawnPointsFile = installed.playerSpawnPointsFile;
      }
    }
    if (!resolved.elevatorsFile && typeof scene?.elevators === "string") {
      const installed = readManifestSources(projectRoot(), document());
      if (installed?.elevatorsFile?.path === scene.elevators) resolved.elevatorsFile = installed.elevatorsFile;
    }
    if (!placementsChanged && !resolved.sceneGraphFile && typeof scene?.sceneGraph === "string") {
      const installed = readManifestSources(projectRoot(), document());
      if (installed?.sceneGraphFile?.path === scene.sceneGraph) resolved.sceneGraphFile = installed.sceneGraphFile;
    }
    if (!resolved.regionsFile && typeof scene?.regions === "string") {
      const installed = readManifestSources(projectRoot(), document());
      if (installed?.regionsFile?.path === scene.regions) resolved.regionsFile = installed.regionsFile;
    }
  }
  return compileGame(doc, read, resolved);
}

test("installed manifest matches the authoritative world and keeps spawns clear", () => {
  const game = loadInstalledGame();
  const arena = arenaStaticWorld();
  const scene = sceneRecord();
  assert.equal(game.authoritativeHash, arena.hash);
  assert.equal(game.view.bundleId, document().bundleId);
  assert.equal(game.view.walls.length, scene.walls ? 4 : 0);
  assert.deepEqual(game.view.buildings.map((building) => building.id).sort(), bakedBuildingIds().sort());
  const inlineProps = Array.isArray(scene.props) ? scene.props.length : 0;
  const fileProps = placementDocs().reduce((count, file) => count + (Array.isArray(file.scene?.props) ? file.scene.props.length : 0), 0);
  assert.equal(game.view.props.length, inlineProps + fileProps + placementPropCount());
  assert.equal(game.view.shadows?.quality, scene.shadows && typeof scene.shadows === "object" ? (scene.shadows as { quality?: string }).quality : undefined);
  assert.equal(game.view.cityscape === undefined, scene.cityscape === undefined);
  assert.equal(game.view.sky === undefined, scene.sky === undefined);
  assert.ok(game.view.characters.length >= 2);
  assert.ok(game.view.modelChoices.includes("grok-bot"));
  assert.ok(game.view.modelChoices.includes("player-1"));
  assert.ok(game.view.modelChoices.length >= 2);
  assert.deepEqual(game.view.npcModelChoices, ["steampunk-dog", "ratty", "cyborg-endoskeleton", "player-a", "player-b", "player-d"]);
  assert.equal(game.view.characters.find((character) => character.id === "player-1")?.model, "/assets/models/player-2.glb");
  assert.ok(game.view.characters.some((character) => character.id === "cyborg-endoskeleton"));
  for (const character of game.view.characters) assert.ok(character.scale > 0, character.id);
  assert.ok((game.view.playerSpawns?.length ?? 0) >= 3);
  const playerIds = new Set((game.view.playerSpawns ?? []).map((spawn) => spawn.id));
  assert.equal(game.definition.spawnPoints.some((spawn) => playerIds.has(spawn.id)), false);
  assert.ok(game.view.staticModels.includes("/assets/models/brutalist-building-1-cbake.cut.glb"));
  assert.ok(game.view.staticModels.includes("/assets/models/med-kit.glb"));
  assert.ok(game.view.staticModels.includes("/assets/models/ammo-box.glb"));
  assert.ok(game.view.staticModels.includes("/assets/models/step.glb"));
  assert.ok(game.view.staticModels.includes("/assets/models/door1.glb"));
  assert.ok(game.view.staticModels.includes("/assets/models/door2.glb"));
  for (const character of game.view.characters) {
    assert.equal(game.view.staticModels.includes(character.model), false, character.id);
  }
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

  const instanced = structuredClone(doc) as { assets: Array<Record<string, unknown>> };
  const crate = instanced.assets.find((asset) => asset.id === "step");
  assert.ok(crate);
  crate.instance = "clone";
  assert.throws(() => compile(instanced, read), (err: unknown) => {
    assert.ok(err instanceof GameManifestError);
    assert.ok(err.issues.some((issue) => issue.path.endsWith(".instance") && issue.message === "must be static"));
    return true;
  });
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
  const buildingsFile = JSON.parse(readFileSync(`${projectRoot()}/web/game/buildings.placements.json`, "utf8")) as PlacementDoc;
  const buildingsInFile = (buildingsFile.placements ?? []).filter((item) => item.hinge == null).length;
  assert.equal(compile(asString, read).view.buildings.length, buildingsInFile);

  const withWalls = structuredClone(doc) as { scene: { walls?: unknown; spawnPoints?: unknown } };
  withWalls.scene.spawnPoints = [];
  withWalls.scene.walls = {
    height: 8,
    thickness: 2,
    collision: true,
    faces: {
      south: "brutalist-building-1-cbake",
      west: "brutalist-building-2-cbake",
      north: "brutalist-building-3-bake",
      east: "brutalist-building-1-cbake",
    },
  };
  const faced = compile(withWalls, read);
  const faceModel = Object.fromEntries(faced.view.walls.map((wall) => [wall.face, wall.model]));
  assert.deepEqual(faceModel, {
    south: "/assets/models/brutalist-building-1-cbake.cut.glb",
    west: "/assets/models/brutalist-building-2-cbake.cut.glb",
    north: "/assets/models/brutalist-building-3-bake.cut.glb",
    east: "/assets/models/brutalist-building-1-cbake.cut.glb",
  });

  delete base.scene.walls;
  delete base.scene.sky;
  const keptFloor = (base.scene as { floor?: { y?: number } }).floor?.y;
  const keptShadows = (base.scene as { shadows?: { quality?: string } }).shadows?.quality;
  const stripped = compile(base, read);
  assert.equal(stripped.view.walls.length, 0);
  assert.equal(stripped.view.sky, undefined);
  assert.equal(stripped.view.buildings.length, bakedBuildingIds().length);
  assert.equal(stripped.definition.aabbs.some((box) => box.id === 10), false);
  assert.equal(stripped.view.floor?.y, keptFloor);
  assert.equal(stripped.view.shadows?.quality, keptShadows);

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
  const obstacleCount = placementDocs().reduce((count, file) => count + (file.obstacles?.length ?? 0), 0);
  assert.equal(spawned.definition.aabbs.some((box) => box.id >= 100), obstacleCount > 0);

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
    placements: [{ id: "prop-b", model: "brutalist-building-1-cbake", position: [12, 0, 18], yaw: 0, scale: 1 }],
    obstacles: [{ id: "box-b", kind: "aabb", min: [20, 0, 16], max: [21, 1, 17] }],
    scene: {
      props: [{ id: "from-b", model: "step", collision: 50 }],
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
  assert.equal(merged.view.floor?.y, keptFloor);
  assert.notEqual(merged.view.floor?.y, 9);
  assert.equal(merged.view.bounds.minX, -24);
  assert.equal(merged.view.shadows?.quality, keptShadows);
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
  assert.equal(loaded.view.buildings.length, bakedBuildingIds().length);

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

test("a prop AABB is not inflated, so a spawn 0.6 m from the face is accepted", () => {
  const doc = document() as { scene: Record<string, unknown>; player: { radius: number } };
  assert.equal(doc.player.radius, 0.5);
  const scene = structuredClone(doc) as { scene: Record<string, unknown> };
  scene.scene.placements = ["./crate.json"];
  scene.scene.bounds = { minX: -24, maxX: 24, minY: -2, maxY: 12, minZ: -24, maxZ: 24 };
  scene.scene.spawnPoints = [{ id: "near", x: 1.2, y: 0, z: 0, yaw: 0 }];
  const file = {
    formatVersion: 1,
    units: "meters",
    placements: [],
    obstacles: [{ id: "crate-box", kind: "aabb", min: [-0.6, 0, -0.4], max: [0.6, 0.8, 0.4] }],
  };
  const files = filesFromDisk();
  const read = (uri: string) => files.get(uri);
  const sources = { placementFiles: [{ path: "./crate.json", text: JSON.stringify(file) }] };
  const game = compile(scene, read, sources);
  const box = game.view.aabbs.find((item) => item.minX === -0.6 && item.maxX === 0.6);
  assert.ok(box);
  assert.equal(box.mesh, true);
  assert.equal(box.minY, 0);
  assert.equal(box.maxY, 0.8);
  assert.equal(box.minZ, -0.4);
  assert.equal(box.maxZ, 0.4);
  const authored = game.definition.aabbs.find((item) => item.id === box.id);
  assert.ok(authored);
  assert.equal(authored.maxX, 0.6);
  assert.equal(authored.minX, -0.6);
  assert.ok(game.definition.spawnPoints.some((spawn) => spawn.id === "near" && spawn.x === 1.2));

  scene.scene.spawnPoints = [{ id: "tight", x: 1.0, y: 0, z: 0, yaw: 0 }];
  assert.throws(() => compile(scene, read, sources), (err: unknown) => {
    assert.ok(err instanceof GameManifestError);
    assert.match(err.message, /tight/);
    return true;
  });
});

test("props.placements.json yields alien-weapon-1 at asset scale times placement scale", () => {
  const files = filesFromDisk();
  const read = (uri: string) => files.get(uri);
  const scene = structuredClone(document()) as { scene: Record<string, unknown> };
  scene.scene.placements = ["./web/game/props.placements.json"];
  scene.scene.bounds = { minX: -80, maxX: 80, minY: -2, maxY: 12, minZ: -80, maxZ: 80 };
  scene.scene.spawnPoints = [];
  const game = compile(scene, read);
  const weaponAsset = (document().assets as Array<{ id?: string; uri?: string }> | undefined)?.find((item) => item.id === "alien-weapon-enh");
  assert.equal(typeof weaponAsset?.uri, "string");
  const weapon = game.view.props.find((prop) => prop.id === "alien-weapon-1");
  assert.ok(weapon);
  assert.equal(weapon.model, weaponAsset?.uri);
  assert.equal(weapon.animation, "idle");
  assert.equal(weapon.animations?.idle.clip, "rotate");
  assert.equal(game.view.buildings.some((building) => building.id === "alien-weapon-1"), false);
  const propsFile = JSON.parse(readFileSync(`${projectRoot()}/web/game/props.placements.json`, "utf8")) as {
    placements: Array<{ id?: string; yaw?: number; scale?: number }>;
  };
  const stamp = propsFile.placements.find((item) => item.id === "alien-weapon-1");
  assert.equal(typeof stamp?.yaw, "number");
  const stampYaw = stamp?.yaw;
  const expectedScale = assetScale("alien-weapon-enh") * (typeof stamp?.scale === "number" ? stamp.scale : 1);
  assert.equal(weapon.scale, expectedScale);
  assert.equal(weapon.yaw, stampYaw);
  const pose = propInstancePose(weapon);
  assert.equal(pose.scale, expectedScale);
  assert.equal(pose.yaw, stampYaw);
  const template = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
  const instanced = placeStaticInstances(template, [pose]);
  assert.equal(instanced.length, 1);
  const matrix = new THREE.Matrix4();
  instanced[0]!.getMatrixAt(0, matrix);
  const scale = new THREE.Vector3();
  matrix.decompose(new THREE.Vector3(), new THREE.Quaternion(), scale);
  assert.ok(Math.abs(scale.x - expectedScale) < 1e-6 && Math.abs(scale.y - expectedScale) < 1e-6 && Math.abs(scale.z - expectedScale) < 1e-6);

  const doubled = {
    formatVersion: 1,
    units: "meters",
    placements: [{ id: "alien-weapon-1", model: "alien-weapon-enh", position: [0, 1, 0], yaw: 0, scale: 2 }],
    obstacles: [{ id: "alien-weapon-1-box", kind: "aabb", min: [-1, 0, -1], max: [1, 2, 1] }],
    spawnPoints: [{ id: "pad", x: 6, y: 0, z: 6, yaw: 0 }],
  };
  const wrapped = {
    formatVersion: 1,
    units: "meters",
    placements: [],
    obstacles: [],
    scene: { spawnPoints: [{ id: "from-scene", x: -6, y: 0, z: -6, yaw: 90 }] },
  };
  const both = structuredClone(scene);
  both.scene.placements = ["./doubled.json", "./wrapped.json"];
  const merged = compile(both, read, {
    placementFiles: [
      { path: "./doubled.json", text: JSON.stringify(doubled) },
      { path: "./wrapped.json", text: JSON.stringify(wrapped) },
    ],
  });
  const grown = merged.view.props.find((prop) => prop.id === "alien-weapon-1");
  assert.ok(grown);
  assert.equal(grown.scale, assetScale("alien-weapon-enh") * 2);
  assert.equal(grown.animation, "idle");
  assert.equal(grown.animations?.idle.clip, "rotate");
  assert.ok(merged.definition.spawnPoints.some((spawn) => spawn.id === "pad" && spawn.x === 6));
  assert.ok(merged.definition.spawnPoints.some((spawn) => spawn.id === "from-scene" && spawn.x === -6 && spawn.yaw === 90));

  assert.throws(() => readPlacementFiles(projectRoot(), {
    scene: { placements: ["./web/game/missing.placements.json"] },
  }), (err: unknown) => {
    assert.ok(err instanceof GameManifestError);
    assert.match(err.message, /missing\.placements\.json/);
    return true;
  });
  const missing = structuredClone(scene);
  missing.scene.placements = ["./web/game/missing.placements.json"];
  assert.throws(() => compile(missing, read, { placementFiles: [] }), (err: unknown) => {
    assert.ok(err instanceof GameManifestError);
    assert.match(err.message, /file was not loaded/);
    return true;
  });
});

test("scene.elevators path compiles and an absent field omits the key", () => {
  const files = filesFromDisk();
  const read = (uri: string) => files.get(uri);
  const bareDoc = structuredClone(document()) as { scene: Record<string, unknown> };
  delete bareDoc.scene.elevators;
  const bare = compile(bareDoc, read);
  assert.equal("elevators" in bare.view, false);

  const withPath = structuredClone(document()) as { scene: Record<string, unknown> };
  withPath.scene.elevators = "./web/game/elevators.json";
  const loaded = readManifestSources(projectRoot(), withPath);
  assert.ok(loaded?.elevatorsFile, "elevators file was not loaded");
  const compiled = compile(withPath, read, loaded);
  assert.ok(compiled.view.elevators && compiled.view.elevators.length > 0);
  assert.equal(compiled.authoritativeHash, bare.authoritativeHash);
  assert.equal(compiled.presentationHash, bare.presentationHash);
  for (const row of compiled.view.elevators) {
    assert.ok(row.stops.length >= 2, row.id);
    assert.equal(row.landings.length, row.stops.length, row.id);
    assert.ok(row.polygon.length >= 3, row.id);
    assert.ok(row.speed > 0, row.id);
    assert.ok(row.waitS >= 0, row.id);
    assert.equal(row.room, `${row.building}.elevator-1-1`);
  }

  const strippedSources = readManifestSources(projectRoot(), withPath)!;
  const strippedDoc = JSON.parse(loaded.elevatorsFile.text) as { elevators: Array<{ room?: string }> };
  for (const row of strippedDoc.elevators) delete row.room;
  strippedSources.elevatorsFile = {
    path: "./web/game/elevators.json",
    text: JSON.stringify(strippedDoc),
  };
  const stripped = compile(withPath, read, strippedSources);
  assert.equal(stripped.authoritativeHash, compiled.authoritativeHash);
  assert.equal(stripped.presentationHash, compiled.presentationHash);
  for (const row of stripped.view.elevators ?? []) assert.equal(row.room, undefined);

  const emptySources = readManifestSources(projectRoot(), withPath)!;
  emptySources.elevatorsFile = {
    path: "./web/game/elevators.json",
    text: JSON.stringify({ formatVersion: 1, units: "meters", elevators: [] }),
  };
  const empty = compile(withPath, read, emptySources);
  assert.equal("elevators" in empty.view, false);
  assert.equal(empty.authoritativeHash, bare.authoritativeHash);
  assert.equal(empty.presentationHash, bare.presentationHash);

  const badSources = readManifestSources(projectRoot(), withPath)!;
  badSources.elevatorsFile = {
    path: "./web/game/elevators.json",
    text: JSON.stringify({
      formatVersion: 1,
      units: "meters",
      elevators: [{
        id: "bad-cab",
        stops: [2, 1],
        speed: 1,
        waitS: 0,
        polygon: [[0, 0], [1, 0], [1, 1]],
        landings: [[0, 2, 0], [0, 1, 0]],
      }],
    }),
  };
  assert.throws(() => compile(withPath, read, badSources), (err: unknown) => {
    assert.ok(err instanceof GameManifestError);
    assert.ok(err.issues.some((issue) => issue.path.includes("bad-cab")));
    return true;
  });
});

test("a non-string elevator room is a GameIssue and an unknown room is dropped", () => {
  const files = filesFromDisk();
  const read = (uri: string) => files.get(uri);
  const withPath = structuredClone(document()) as { scene: Record<string, unknown> };
  withPath.scene.elevators = "./web/game/elevators.json";
  const base = readManifestSources(projectRoot(), withPath)!;
  const doc = JSON.parse(base.elevatorsFile!.text) as { elevators: Array<Record<string, unknown>> };
  const file = (rows: { elevators: Array<Record<string, unknown>> }) => {
    const sources = readManifestSources(projectRoot(), withPath)!;
    sources.elevatorsFile = { path: "./web/game/elevators.json", text: JSON.stringify(rows) };
    return sources;
  };

  const badType = structuredClone(doc);
  badType.elevators[0]!.room = 4;
  assert.throws(() => compile(withPath, read, file(badType)), (err: unknown) => {
    assert.ok(err instanceof GameManifestError);
    assert.ok(err.issues.some((issue) => issue.path.endsWith(".room") && issue.message === "must be a non-empty string"));
    return true;
  });

  const badBuilding = structuredClone(doc);
  badBuilding.elevators[0]!.building = "";
  assert.throws(() => compile(withPath, read, file(badBuilding)), (err: unknown) => {
    assert.ok(err instanceof GameManifestError);
    assert.ok(err.issues.some((issue) => issue.path.endsWith(".building") && issue.message === "must be a non-empty string"));
    return true;
  });

  const unknown = structuredClone(doc);
  const cabId = String(unknown.elevators[0]!.id);
  unknown.elevators[0]!.room = "no-such-room";
  const warnings: string[] = [];
  const orig = console.warn;
  console.warn = (line?: unknown) => { warnings.push(String(line)); };
  try {
    const game = compile(withPath, read, file(unknown));
    const row = game.view.elevators?.find((item) => item.id === cabId);
    assert.ok(row, "the cab still rides");
    assert.equal(row.room, undefined);
    assert.ok(warnings.some((line) => line === `scene.elevators.${cabId}.room: unknown room placement "no-such-room"`));
    assert.equal(game.authoritativeHash, compile(withPath, read, file(doc)).authoritativeHash);
  } finally {
    console.warn = orig;
  }
});

test("scene.sceneGraph is optional, a missing file is an issue, and invalid json is an issue", () => {
  const files = filesFromDisk();
  const read = (uri: string) => files.get(uri);
  const withPath = structuredClone(document()) as { scene: Record<string, unknown> };
  const loaded = compile(withPath, read);
  assert.equal(loaded.sceneGraph?.places.length, 174);
  assert.equal(loaded.sceneGraph?.portals.length, 321);
  assert.equal("sceneGraph" in loaded.view, false);
  assert.equal("places" in loaded.view, false);
  assert.equal("portals" in loaded.view, false);
  assert.ok(loaded.regions);
  assert.equal(loaded.regions.version, 1);
  assert.equal(loaded.regions.radius, 0.5);
  assert.equal(loaded.regions.height, 1.8);
  assert.ok(loaded.regions.places.length > 0);
  assert.equal("regions" in loaded.view, false);

  const bareDoc = structuredClone(withPath);
  delete bareDoc.scene.sceneGraph;
  const bare = compile(bareDoc, read);
  assert.equal(bare.sceneGraph, undefined);
  assert.equal(bare.regions?.places.length, loaded.regions?.places.length);
  assert.equal(bare.authoritativeHash, loaded.authoritativeHash);
  assert.equal(bare.presentationHash, loaded.presentationHash);

  const noRegions = structuredClone(withPath);
  delete noRegions.scene.regions;
  const without = compile(noRegions, read);
  assert.equal(without.regions, undefined);
  assert.equal(without.authoritativeHash, loaded.authoritativeHash);
  assert.equal(without.presentationHash, loaded.presentationHash);

  assert.throws(() => readManifestSources(projectRoot(), {
    scene: { sceneGraph: "./web/game/missing-scene-graph.json" },
  }), (err: unknown) => {
    assert.ok(err instanceof GameManifestError);
    assert.ok(err.issues.some((issue) => issue.path === "scene.sceneGraph"));
    assert.match(err.message, /missing-scene-graph\.json/);
    return true;
  });

  const badSources = readManifestSources(projectRoot(), withPath)!;
  badSources.sceneGraphFile = { path: "./web/game/scene-graph.json", text: "{not json" };
  assert.throws(() => compile(withPath, read, badSources), (err: unknown) => {
    assert.ok(err instanceof GameManifestError);
    assert.ok(err.issues.some((issue) => issue.path === "scene.sceneGraph" && issue.message.startsWith("invalid json:")));
    return true;
  });

  const unloaded = readManifestSources(projectRoot(), withPath)!;
  unloaded.sceneGraphFile = { path: "./other.json", text: "{}" };
  assert.throws(() => compile(withPath, read, unloaded), (err: unknown) => {
    assert.ok(err instanceof GameManifestError);
    assert.ok(err.issues.some((issue) => issue.path === "scene.sceneGraph" && issue.message === "file was not loaded"));
    return true;
  });

  const drifted = readManifestSources(projectRoot(), withPath)!;
  const rows = JSON.parse(drifted.sceneGraphFile!.text) as { places: Array<{ id?: string; stops?: number[] }> };
  const shaft = rows.places.find((place) => place.id === "brutalist-building-1-cbake-0.e1");
  assert.ok(shaft?.stops);
  shaft.stops[0] = 0.25;
  drifted.sceneGraphFile = { path: "./web/game/scene-graph.json", text: JSON.stringify(rows) };
  const warnings: string[] = [];
  const orig = console.warn;
  console.warn = (line?: unknown) => { warnings.push(String(line)); };
  try {
    const game = compile(withPath, read, drifted);
    assert.equal(game.sceneGraph?.places.length, 174);
    assert.ok(warnings.some((line) => line === "scene.sceneGraph.places.brutalist-building-1-cbake-0.e1: stops or landings differ from scene.elevators"));
  } finally {
    console.warn = orig;
  }
});

test("grenade projectile.impact compiles to view.grenadeImpact; a bad value is an issue", () => {
  const doc = document();
  const files = filesFromDisk();
  const read = (uri: string) => files.get(uri);
  const compiled = compile(doc, read);
  assert.equal(compiled.view.grenadeImpact, "explode");
  assert.equal(compiled.view.grenadeDamage, 50);

  const missing = structuredClone(doc) as { assets: Array<Record<string, unknown>> };
  const row = missing.assets.find((asset) => asset.id === "grenade");
  assert.ok(row);
  delete row.projectile;
  const bare = compile(missing, read);
  assert.equal(bare.view.grenadeImpact, undefined);
  assert.equal(bare.view.grenadeDamage, undefined);

  const bad = structuredClone(doc) as { assets: Array<Record<string, unknown>> };
  const grenade = bad.assets.find((asset) => asset.id === "grenade");
  assert.ok(grenade);
  grenade.projectile = { impact: "ricochet", damage: 0 };
  assert.throws(() => compile(bad, read), (err: unknown) => {
    assert.ok(err instanceof GameManifestError);
    assert.ok(err.issues.some((issue) => issue.path.endsWith(".projectile.impact")));
    assert.ok(err.issues.some((issue) => issue.path.endsWith(".projectile.damage")));
    return true;
  });
});

test("grenade-explosion asset compiles to view.explosion; a bad sprite block is an issue", () => {
  const doc = document();
  const files = filesFromDisk();
  const read = (uri: string) => files.get(uri);
  const compiled = compile(doc, read);
  assert.deepEqual(compiled.view.explosion, {
    texture: "/assets/textures/grenade-explosion-sheet.png",
    columns: 6,
    rows: 5,
    frameCount: 30,
    frameWidth: 226,
    frameHeight: 256,
    fps: 30,
    size: 8,
    blending: "normal",
    laserImpactSize: 0.8,
  });

  const bad = structuredClone(doc) as { assets: Array<Record<string, unknown>> };
  const sheet = bad.assets.find((asset) => asset.id === "grenade-explosion");
  assert.ok(sheet);
  sheet.sprite = { ...(sheet.sprite as Record<string, unknown>), frameCount: 31, blending: "screen" };
  assert.throws(() => compile(bad, read), (err: unknown) => {
    assert.ok(err instanceof GameManifestError);
    assert.ok(err.issues.some((issue) => issue.path.endsWith(".sprite.blending")));
    return true;
  });
  sheet.sprite = { ...(sheet.sprite as Record<string, unknown>), blending: "additive" };
  assert.throws(() => compile(bad, read), (err: unknown) => {
    assert.ok(err instanceof GameManifestError);
    assert.ok(err.issues.some((issue) => issue.path.endsWith(".sprite.frameCount")));
    return true;
  });

  const none = structuredClone(doc) as { assets: Array<Record<string, unknown>> };
  none.assets = none.assets.filter((asset) => asset.id !== "grenade-explosion");
  assert.equal(compile(none, read).view.explosion, undefined);
});

test("laser-impact asset compiles to view.laserImpact; an absent optional file is dropped with a warning", () => {
  const doc = document();
  const files = filesFromDisk();
  const uri = "/assets/textures/laser-impact-sheet.png";
  const row = (doc.assets as Array<Record<string, unknown>>).find((asset) => asset.id === "laser-impact")!;
  assert.equal(row.kind, "texture");
  assert.equal(row.optional, true);
  assert.equal("type" in row, false, "no placement type");
  assert.equal(row.uri, uri);
  const reader = (extra: Record<string, Uint8Array | undefined> = {}) => (path: string) => (path in extra ? extra[path] : files.get(path));

  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
  let bare;
  try {
    bare = compile(doc, reader({ [uri]: undefined }));
  } finally {
    console.warn = warn;
  }
  assert.equal(bare.view.laserImpact, undefined);
  assert.ok(bare.view.explosion, "grenade sheet is still there for the client fallback");
  assert.equal(warnings.filter((line) => line.includes("laser-impact") && line.includes("effect is skipped")).length >= 1, true);

  // Real sheet is 1536x1280 (6x5 frames of 256x256). The client still uses width/cols by height/rows.
  const view = compile(doc, reader({ [uri]: pngHeader(1536, 1280) })).view;
  assert.deepEqual(view.laserImpact, {
    texture: uri,
    columns: 6,
    rows: 5,
    frameCount: 30,
    frameWidth: 256,
    frameHeight: 256,
    fps: 30,
    size: 0.8,
    blending: "normal",
    laserImpactSize: 0.8,
  });

  const emptySprite = structuredClone(doc) as { assets: Array<Record<string, unknown>> };
  emptySprite.assets.find((asset) => asset.id === "laser-impact")!.sprite = {};
  const defaults = compile(emptySprite, reader({ [uri]: pngHeader(1536, 1280) })).view.laserImpact;
  assert.deepEqual(defaults, {
    texture: uri, columns: 6, rows: 5, frameCount: 30, frameWidth: 256, frameHeight: 256, fps: 30, size: 0.8, blending: "normal",
  }, "defaults; no laserImpactSize or rotation when omitted");

  const custom = structuredClone(doc) as { assets: Array<Record<string, unknown>> };
  custom.assets.find((asset) => asset.id === "laser-impact")!.sprite = {
    columns: 4, rows: 4, frameCount: 16, frameWidth: 128, frameHeight: 128, fps: 12, size: 1.2, laserImpactSize: 0.5, blending: "additive", rotation: 90,
  };
  assert.deepEqual(compile(custom, reader({ [uri]: pngHeader(512, 512) })).view.laserImpact, {
    texture: uri, columns: 4, rows: 4, frameCount: 16, frameWidth: 128, frameHeight: 128, fps: 12, size: 1.2, blending: "additive", laserImpactSize: 0.5, rotation: 90,
  });

  const none = structuredClone(doc) as { assets: Array<Record<string, unknown>> };
  none.assets = none.assets.filter((asset) => asset.id !== "laser-impact");
  assert.equal(compile(none, (path) => files.get(path)).view.laserImpact, undefined);
});

test("laser-impact sprite rejects bad values with the field path", () => {
  const doc = document();
  const files = filesFromDisk();
  const uri = "/assets/textures/laser-impact-sheet.png";
  const read = (path: string) => (path === uri ? pngHeader(1536, 1280) : files.get(path));
  const paths = (edit: (copy: { assets: Array<Record<string, unknown>> }) => void): string[] => {
    const copy = structuredClone(doc) as { assets: Array<Record<string, unknown>> };
    edit(copy);
    try {
      compile(copy, read);
    } catch (err) {
      assert.ok(err instanceof GameManifestError);
      return err.issues.map((issue) => issue.path);
    }
    return [];
  };
  const columnPaths = paths((c) => void (c.assets.find((asset) => asset.id === "laser-impact")!.sprite = { columns: 0 }));
  assert.ok(columnPaths.some((path) => path.endsWith(".sprite.columns")), String(columnPaths));
  const blendPaths = paths((c) => void (c.assets.find((asset) => asset.id === "laser-impact")!.sprite = { blending: "screen" }));
  assert.ok(blendPaths.some((path) => path.endsWith(".sprite.blending")), String(blendPaths));
  const rotPaths = paths((c) => void (c.assets.find((asset) => asset.id === "laser-impact")!.sprite = { rotation: "cw" }));
  assert.ok(rotPaths.some((path) => path.endsWith(".sprite.rotation")), String(rotPaths));
  const countPaths = paths((c) => void (c.assets.find((asset) => asset.id === "laser-impact")!.sprite = { columns: 6, rows: 5, frameCount: 31 }));
  assert.ok(countPaths.some((path) => path.endsWith(".sprite.frameCount")), String(countPaths));
  const sizePaths = paths((c) => void (c.assets.find((asset) => asset.id === "laser-impact")!.sprite = { laserImpactSize: 0 }));
  assert.ok(sizePaths.some((path) => path.endsWith(".sprite.laserImpactSize")), String(sizePaths));
  const kindPaths = paths((c) => void (c.assets.find((asset) => asset.id === "laser-impact")!.kind = "model"));
  assert.ok(kindPaths.some((path) => path.endsWith(".kind")), String(kindPaths));
  const objPaths = paths((c) => void (c.assets.find((asset) => asset.id === "laser-impact")!.sprite = "sheet"));
  assert.ok(objPaths.some((path) => path.endsWith(".sprite")), String(objPaths));
});

test("grenade-surface-explosion asset compiles to view.surfaceExplosion; an absent optional file is dropped with a warning", () => {
  const doc = document();
  const files = filesFromDisk();
  const uri = "/assets/textures/grenade-ground-blast-sheet.png";
  const row = (doc.assets as Array<Record<string, unknown>>).find((asset) => asset.id === "grenade-surface-explosion")!;
  assert.equal(row.kind, "texture");
  assert.equal(row.optional, true);
  assert.equal("type" in row, false, "no placement type");
  assert.equal(row.uri, uri);
  const reader = (extra: Record<string, Uint8Array | undefined> = {}) => (path: string) => (path in extra ? extra[path] : files.get(path));

  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
  let bare;
  try {
    bare = compile(doc, reader({ [uri]: undefined }));
  } finally {
    console.warn = warn;
  }
  assert.equal(bare.view.surfaceExplosion, undefined);
  assert.ok(bare.view.explosion, "grenade sheet is still there for the client fallback");
  assert.equal(warnings.filter((line) => line.includes("grenade-surface-explosion") && line.includes("effect is skipped")).length >= 1, true);

  const view = compile(doc, reader({ [uri]: pngHeader(1536, 1280) })).view;
  assert.deepEqual(view.surfaceExplosion, {
    texture: uri,
    columns: 6,
    rows: 5,
    frameCount: 30,
    frameWidth: 256,
    frameHeight: 256,
    fps: 30,
    size: 8,
    blending: "normal",
    anchorY: 0.48,
  });

  const emptySprite = structuredClone(doc) as { assets: Array<Record<string, unknown>> };
  emptySprite.assets.find((asset) => asset.id === "grenade-surface-explosion")!.sprite = {};
  const defaults = compile(emptySprite, reader({ [uri]: pngHeader(1536, 1280) })).view.surfaceExplosion;
  assert.deepEqual(defaults, {
    texture: uri, columns: 6, rows: 5, frameCount: 30, frameWidth: 256, frameHeight: 256, fps: 30, size: 8, blending: "normal",
  }, "size defaults to the grenade-explosion size");

  const noExplosion = structuredClone(emptySprite) as { assets: Array<Record<string, unknown>> };
  noExplosion.assets = noExplosion.assets.filter((asset) => asset.id !== "grenade-explosion");
  const fallbackSize = compile(noExplosion, reader({ [uri]: pngHeader(1536, 1280) })).view.surfaceExplosion;
  assert.equal(fallbackSize?.size, 4, "size falls back to 4 when the grenade sheet is also absent");

  const custom = structuredClone(doc) as { assets: Array<Record<string, unknown>> };
  custom.assets.find((asset) => asset.id === "grenade-surface-explosion")!.sprite = {
    columns: 4, rows: 4, frameCount: 16, frameWidth: 128, frameHeight: 128, fps: 12, size: 6, blending: "additive", rotation: 90,
  };
  assert.deepEqual(compile(custom, reader({ [uri]: pngHeader(512, 512) })).view.surfaceExplosion, {
    texture: uri, columns: 4, rows: 4, frameCount: 16, frameWidth: 128, frameHeight: 128, fps: 12, size: 6, blending: "additive", rotation: 90,
  });

  const none = structuredClone(doc) as { assets: Array<Record<string, unknown>> };
  none.assets = none.assets.filter((asset) => asset.id !== "grenade-surface-explosion");
  assert.equal(compile(none, (path) => files.get(path)).view.surfaceExplosion, undefined);
});

test("grenade-surface-explosion sprite rejects bad values with the field path", () => {
  const doc = document();
  const files = filesFromDisk();
  const uri = "/assets/textures/grenade-ground-blast-sheet.png";
  const read = (path: string) => (path === uri ? pngHeader(1536, 1280) : files.get(path));
  const paths = (edit: (copy: { assets: Array<Record<string, unknown>> }) => void): string[] => {
    const copy = structuredClone(doc) as { assets: Array<Record<string, unknown>> };
    edit(copy);
    try {
      compile(copy, read);
    } catch (err) {
      assert.ok(err instanceof GameManifestError);
      return err.issues.map((issue) => issue.path);
    }
    return [];
  };
  const columnPaths = paths((c) => void (c.assets.find((asset) => asset.id === "grenade-surface-explosion")!.sprite = { columns: 0 }));
  assert.ok(columnPaths.some((path) => path.endsWith(".sprite.columns")), String(columnPaths));
  const blendPaths = paths((c) => void (c.assets.find((asset) => asset.id === "grenade-surface-explosion")!.sprite = { blending: "screen" }));
  assert.ok(blendPaths.some((path) => path.endsWith(".sprite.blending")), String(blendPaths));
  const rotPaths = paths((c) => void (c.assets.find((asset) => asset.id === "grenade-surface-explosion")!.sprite = { rotation: "cw" }));
  assert.ok(rotPaths.some((path) => path.endsWith(".sprite.rotation")), String(rotPaths));
  const countPaths = paths((c) => void (c.assets.find((asset) => asset.id === "grenade-surface-explosion")!.sprite = { columns: 6, rows: 5, frameCount: 31 }));
  assert.ok(countPaths.some((path) => path.endsWith(".sprite.frameCount")), String(countPaths));
  const anchorPaths = paths((c) => void (c.assets.find((asset) => asset.id === "grenade-surface-explosion")!.sprite = { anchorY: 1 }));
  assert.ok(anchorPaths.some((path) => path.endsWith(".sprite.anchorY")), String(anchorPaths));
  const sizePaths = paths((c) => void (c.assets.find((asset) => asset.id === "grenade-surface-explosion")!.sprite = { size: 0 }));
  assert.ok(sizePaths.some((path) => path.endsWith(".sprite.size")), String(sizePaths));
  const kindPaths = paths((c) => void (c.assets.find((asset) => asset.id === "grenade-surface-explosion")!.kind = "model"));
  assert.ok(kindPaths.some((path) => path.endsWith(".kind")), String(kindPaths));
  const objPaths = paths((c) => void (c.assets.find((asset) => asset.id === "grenade-surface-explosion")!.sprite = "sheet"));
  assert.ok(objPaths.some((path) => path.endsWith(".sprite")), String(objPaths));
});

test("audio assets compile to view.sounds; a bad sound block or file is an issue", () => {
  const doc = document();
  const files = filesFromDisk();
  // The med-kit file is optional and may not be on disk; this test wants it present.
  for (const uri of ["medkit-pickup", "metal-door-creak-open", "metal-door-close"]) {
    if (!files.has(`/assets/audio/${uri}.wav`)) files.set(`/assets/audio/${uri}.wav`, new Uint8Array([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WAVE")]));
  }
  if (!files.has("/assets/audio/elevator-start.opus")) files.set("/assets/audio/elevator-start.opus", opusHeader());
  for (const name of ["spawn", "despawn"]) {
    const uri = `/assets/audio/beam-transport-sfx-${name}.mp3`;
    if (!files.has(uri)) files.set(uri, new Uint8Array([...Buffer.from("ID3"), 4, 0, 0]));
  }
  const read = (uri: string) => files.get(uri);
  assert.deepEqual(compile(doc, read).view.sounds, {
    laser: { uri: "/assets/audio/laser-blast-sfx.mp3", volume: 0.6, maxVoices: 4, positional: true, refDistance: 4 },
    grenadeLaunch: { uri: "/assets/audio/grenade-launch.wav", volume: 0.8, maxVoices: 2, positional: true, refDistance: 3 },
    grenadeBlast: { uri: "/assets/audio/grenade-launch-grenade-blast.wav", volume: 2, maxVoices: 4, positional: true, refDistance: 8 },
    cratePickup: { uri: "/assets/audio/crate-pickup.wav", volume: 0.8, maxVoices: 2, positional: true, refDistance: 3, pickupKinds: ["ammo"] },
    keyPickup: { uri: "/assets/audio/key-pickup.wav", volume: 0.8, maxVoices: 2, positional: true, refDistance: 3, pickupKinds: ["key"] },
    medkitPickup: { uri: "/assets/audio/medkit-pickup.wav", volume: 0.8, maxVoices: 2, positional: true, refDistance: 3, pickupKinds: ["health"] },
    doorOpen: { uri: "/assets/audio/metal-door-creak-open.wav", volume: 0.8, maxVoices: 4, positional: true, refDistance: 4 },
    doorClose: { uri: "/assets/audio/metal-door-close.wav", volume: 0.8, maxVoices: 4, positional: true, refDistance: 4 },
    elevatorStart: { uri: "/assets/audio/elevator-start.opus", volume: 0.8, maxVoices: 2, positional: true, refDistance: 5 },
    beamSpawn: { uri: "/assets/audio/beam-transport-sfx-spawn.mp3", volume: 0.8, maxVoices: 4, positional: true, refDistance: 4 },
    beamDespawn: { uri: "/assets/audio/beam-transport-sfx-despawn.mp3", volume: 0.8, maxVoices: 4, positional: true, refDistance: 4 },
  });

  const issuesOf = (edit: (assets: Array<Record<string, unknown>>) => void, readFile = read) => {
    const bad = structuredClone(doc) as { assets: Array<Record<string, unknown>> };
    edit(bad.assets);
    try {
      compile(bad, readFile);
    } catch (err) {
      assert.ok(err instanceof GameManifestError);
      return err.issues.map((issue) => `${issue.path} ${issue.message}`);
    }
    return [];
  };
  const laser = (assets: Array<Record<string, unknown>>) => assets.find((asset) => asset.id === "laser-blast")!;
  const bad = issuesOf((assets) => {
    laser(assets).sound = { volume: 3, maxVoices: 0, positional: "yes", refDistance: -1 };
  });
  for (const key of ["volume", "maxVoices", "positional", "refDistance"]) {
    assert.ok(bad.some((issue) => issue.includes(`.sound.${key}`)), `${key}: ${bad.join("; ")}`);
  }
  assert.ok(issuesOf((assets) => {
    delete laser(assets).sound;
  }).some((issue) => issue.endsWith(".sound required sound object")));
  assert.ok(issuesOf((assets) => {
    laser(assets).mediaType = "audio/flac";
  }).some((issue) => issue.includes(".mediaType must be audio/mpeg, audio/wav, audio/ogg or audio/opus")));
  assert.ok(issuesOf(() => undefined, (uri) => (uri.endsWith(".wav") ? new Uint8Array([1, 2, 3, 4]) : read(uri)))
    .some((issue) => issue.endsWith("not a wav")));
  assert.ok(issuesOf(() => undefined, (uri) => (uri.endsWith("laser-blast-sfx.mp3") ? undefined : read(uri)))
    .some((issue) => issue.includes("file not found for /assets/audio/laser-blast-sfx.mp3")));

  const none = structuredClone(doc) as { assets: Array<Record<string, unknown>> };
  none.assets = none.assets.filter((asset) => asset.kind !== "audio");
  assert.equal(compile(none, read).view.sounds, undefined);
  const defaults = structuredClone(doc) as { assets: Array<Record<string, unknown>> };
  laser(defaults.assets).sound = { volume: 0.5, maxVoices: 3 };
  assert.deepEqual(compile(defaults, read).view.sounds?.laser, {
    uri: "/assets/audio/laser-blast-sfx.mp3", volume: 0.5, maxVoices: 3, positional: false, refDistance: 1,
  });
});

test("pickup sound assets are audio entries with their own sound blocks", () => {
  const doc = document();
  const files = filesFromDisk();
  const read = (uri: string) => files.get(uri);
  for (const [id, uri] of [["crate-pickup", "/assets/audio/crate-pickup.wav"], ["key-pickup", "/assets/audio/key-pickup.wav"]] as const) {
    const row = (doc.assets as Array<Record<string, unknown>>).find((asset) => asset.id === id);
    assert.ok(row, id);
    assert.equal(row.kind, "audio");
    assert.equal(row.uri, uri);
    assert.equal(row.mediaType, "audio/wav");
  }
  const bad = structuredClone(doc) as { assets: Array<Record<string, unknown>> };
  const key = bad.assets.find((asset) => asset.id === "key-pickup")!;
  key.sound = { volume: 3, maxVoices: 2 };
  assert.throws(() => compile(bad, read), (err: unknown) => {
    assert.ok(err instanceof GameManifestError);
    assert.ok(err.issues.some((issue) => issue.path.endsWith(".sound.volume")));
    return true;
  });
  const missing = (uri: string) => (uri.endsWith("key-pickup.wav") ? undefined : read(uri));
  assert.throws(() => compile(doc, missing), (err: unknown) => {
    assert.ok(err instanceof GameManifestError);
    assert.ok(err.issues.some((issue) => issue.message.includes("file not found for /assets/audio/key-pickup.wav")));
    return true;
  });
});

test("medkit-pickup is optional audio: present it is validated, absent it is dropped with a warning", () => {
  const doc = document();
  const files = filesFromDisk();
  const wav = new Uint8Array([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WAVE")]);
  const withFile = (uri: string) => (uri === "/assets/audio/medkit-pickup.wav" ? wav : files.get(uri));
  const without = (uri: string) => (uri === "/assets/audio/medkit-pickup.wav" ? undefined : files.get(uri));
  const row = (doc.assets as Array<Record<string, unknown>>).find((asset) => asset.id === "medkit-pickup")!;
  assert.equal(row.optional, true);
  assert.deepEqual((row.sound as { pickupKinds: string[] }).pickupKinds, ["health"]);

  assert.deepEqual(compile(doc, withFile).view.sounds?.medkitPickup, {
    uri: "/assets/audio/medkit-pickup.wav", volume: 0.8, maxVoices: 2, positional: true, refDistance: 3, pickupKinds: ["health"],
  });
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
  try {
    const compiled = compile(doc, without);
    assert.equal(compiled.view.sounds?.medkitPickup, undefined);
    assert.ok(compiled.view.sounds?.cratePickup, "the other sounds are unaffected");
  } finally {
    console.warn = warn;
  }
  assert.equal(warnings.filter((line) => line.includes("medkit-pickup")).length, 1);

  // Present but not a wav: still an issue. Required audio missing: still an issue.
  assert.throws(() => compile(doc, (uri) => (uri.endsWith("medkit-pickup.wav") ? new Uint8Array([1, 2, 3, 4]) : files.get(uri))), (err: unknown) => {
    assert.ok(err instanceof GameManifestError);
    assert.ok(err.issues.some((issue) => issue.message === "not a wav"));
    return true;
  });
  const required = structuredClone(doc) as { assets: Array<Record<string, unknown>> };
  delete required.assets.find((asset) => asset.id === "medkit-pickup")!.optional;
  assert.throws(() => compile(required, without), (err: unknown) => {
    assert.ok(err instanceof GameManifestError);
    assert.ok(err.issues.some((issue) => issue.message.includes("file not found for /assets/audio/medkit-pickup.wav")));
    return true;
  });
  // The flag and the kinds are validated.
  const bad = structuredClone(doc) as { assets: Array<Record<string, unknown>> };
  bad.assets.find((asset) => asset.id === "key-pickup")!.optional = "yes";
  (bad.assets.find((asset) => asset.id === "crate-pickup")!.sound as Record<string, unknown>).pickupKinds = ["ammo", "crate"];
  assert.throws(() => compile(bad, withFile), (err: unknown) => {
    assert.ok(err instanceof GameManifestError);
    assert.ok(err.issues.some((issue) => issue.path.endsWith(".optional")));
    assert.ok(err.issues.some((issue) => issue.path.endsWith(".sound.pickupKinds")));
    return true;
  });
});

test("door-open and door-close are optional audio entries without a type: absent they are dropped with a warning", () => {
  const doc = document();
  const files = filesFromDisk();
  const wav = new Uint8Array([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WAVE")]);
  const rows = (doc.assets as Array<Record<string, unknown>>).filter((asset) => asset.id === "door-open" || asset.id === "door-close");
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.kind, "audio");
    assert.equal(row.optional, true);
    assert.equal("type" in row, false, "no placement type, so bake:scene accepts it");
  }
  const door = (uri: string) => (uri.includes("metal-door") ? wav : files.get(uri));
  const sounds = compile(doc, door).view.sounds;
  assert.equal(sounds?.doorOpen?.uri, "/assets/audio/metal-door-creak-open.wav");
  assert.equal(sounds?.doorClose?.uri, "/assets/audio/metal-door-close.wav");
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
  try {
    const none = compile(doc, (uri) => (uri.includes("metal-door") ? undefined : files.get(uri))).view.sounds;
    assert.equal(none?.doorOpen, undefined);
    assert.equal(none?.doorClose, undefined);
  } finally {
    console.warn = warn;
  }
  assert.equal(warnings.filter((line) => line.startsWith("door-open") || line.startsWith("door-close")).length, 2);
  assert.throws(() => compile(doc, (uri) => (uri.endsWith("metal-door-close.wav") ? new Uint8Array([1, 2, 3, 4]) : door(uri))), (err: unknown) => {
    assert.ok(err instanceof GameManifestError);
    assert.ok(err.issues.some((issue) => issue.message === "not a wav"));
    return true;
  });
});

test("scene.doorSwing sets the swing time in view; absent omits it; bad values name the field", () => {
  const doc = document();
  const files = filesFromDisk();
  const read = (uri: string) => files.get(uri);
  assert.deepEqual(compile(doc, read).view.doorSwing, { openMs: 2800, closeMs: 2800 });

  const scene = (edit: (scene: Record<string, unknown>) => void) => {
    const copy = structuredClone(doc) as { scene: Record<string, unknown> };
    edit(copy.scene);
    return copy;
  };
  assert.equal(compile(scene((s) => void delete s.doorSwing), read).view.doorSwing, undefined);
  assert.deepEqual(compile(scene((s) => void (s.doorSwing = { openMs: 1500 })), read).view.doorSwing, { openMs: 1500, closeMs: 400 });

  const issues = (edit: (scene: Record<string, unknown>) => void) => {
    try {
      compile(scene(edit), read);
    } catch (err) {
      assert.ok(err instanceof GameManifestError);
      return err.issues.map((issue) => issue.path);
    }
    return [];
  };
  assert.ok(issues((s) => void (s.doorSwing = { openMs: 10, closeMs: 99999 })).includes("scene.doorSwing.openMs"));
  assert.ok(issues((s) => void (s.doorSwing = { openMs: 10, closeMs: 99999 })).includes("scene.doorSwing.closeMs"));
  assert.ok(issues((s) => void (s.doorSwing = { closeMs: "slow" })).includes("scene.doorSwing.closeMs"));
  assert.ok(issues((s) => void (s.doorSwing = 5)).includes("scene.doorSwing"));
});

test("elevator-start is an optional ogg opus entry: header-checked, dropped with one warning when absent", () => {
  const doc = document();
  const files = filesFromDisk();
  const uri = "/assets/audio/elevator-start.opus";
  const row = (doc.assets as Array<Record<string, unknown>>).find((asset) => asset.id === "elevator-start")!;
  assert.equal(row.kind, "audio");
  assert.equal(row.optional, true);
  assert.equal("type" in row, false, "no placement type");
  assert.equal(row.mediaType, "audio/ogg");
  assert.equal(row.uri, uri);
  const withFile = (bytes: Uint8Array | undefined) => (path: string) => (path === uri ? bytes : files.get(path));

  assert.deepEqual(compile(doc, withFile(opusHeader())).view.sounds?.elevatorStart, {
    uri, volume: 0.8, maxVoices: 2, positional: true, refDistance: 5,
  });
  // audio/opus is accepted too.
  const asOpus = structuredClone(doc) as { assets: Array<Record<string, unknown>> };
  asOpus.assets.find((asset) => asset.id === "elevator-start")!.mediaType = "audio/opus";
  assert.ok(compile(asOpus, withFile(opusHeader())).view.sounds?.elevatorStart);

  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
  try {
    const compiled = compile(doc, withFile(undefined));
    assert.equal(compiled.view.sounds?.elevatorStart, undefined);
    assert.ok(compiled.view.sounds?.cratePickup, "the other sounds are unaffected");
  } finally {
    console.warn = warn;
  }
  assert.equal(warnings.filter((line) => line.includes("elevator-start")).length, 1);

  const messages = (bytes: Uint8Array, source = doc): string[] => {
    try {
      compile(source, withFile(bytes));
    } catch (err) {
      assert.ok(err instanceof GameManifestError);
      return err.issues.map((issue) => issue.message);
    }
    return [];
  };
  const broken = opusHeader();
  broken.set(Buffer.from("OpusTags"), 28);
  assert.deepEqual(messages(broken), ["not an ogg opus file"], "an Ogg page that does not open with OpusHead");
  assert.deepEqual(messages(new Uint8Array([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WAVE")])), ["not an ogg opus file"]);
  assert.deepEqual(messages(opusHeader().subarray(0, 30)), ["not an ogg opus file"], "truncated");
  assert.deepEqual(messages(opusHeader(0x10)), ["not an ogg opus file"], "an unknown OpusHead version");
  const vorbis = opusHeader();
  vorbis.set(Buffer.from("\x01vorbis"), 28);
  assert.deepEqual(messages(vorbis), ["not an ogg opus file"], "Ogg Vorbis is not accepted");

  const wrongType = structuredClone(doc) as { assets: Array<Record<string, unknown>> };
  wrongType.assets.find((asset) => asset.id === "elevator-start")!.mediaType = "audio/flac";
  assert.ok(messages(opusHeader(), wrongType).some((message) => message.includes("audio/ogg or audio/opus")));
  // An Ogg Opus file under a wav type is still rejected.
  const asWav = structuredClone(doc) as { assets: Array<Record<string, unknown>> };
  asWav.assets.find((asset) => asset.id === "elevator-start")!.mediaType = "audio/wav";
  assert.deepEqual(messages(opusHeader(), asWav), ["not a wav"]);
});

/** A PNG header (signature, IHDR length and tag, width, height) is all the manifest reads. */
function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82], 0);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

test("scene.characterBeam: timings, optional beam sheets with defaults, absent files skipped", () => {
  const doc = document();
  const files = filesFromDisk();
  const spawnUri = "/assets/textures/beam-spawn-sheet.png";
  const despawnUri = "/assets/textures/beam-despawn-sheet.png";
  for (const id of ["beam-spawn", "beam-despawn"]) {
    const row = (doc.assets as Array<Record<string, unknown>>).find((asset) => asset.id === id)!;
    assert.equal(row.kind, "texture");
    assert.equal(row.optional, true);
    assert.equal("type" in row, false, "no placement type");
  }
  for (const id of ["beam-spawn-sfx", "beam-despawn-sfx"]) {
    const row = (doc.assets as Array<Record<string, unknown>>).find((asset) => asset.id === id)!;
    assert.equal(row.kind, "audio");
    assert.equal(row.optional, true);
    assert.equal("type" in row, false);
  }
  const reader = (extra: Record<string, Uint8Array | undefined> = {}) => (uri: string) => (uri in extra ? extra[uri] : files.get(uri));
  const timings = { fadeMs: 1700, despawnDelayMs: 1200, despawnSoundDelayMs: 0, deathHoldMs: 0 };

  // No sheet files: the timings still apply, there is just no beam.
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
  let bare;
  try {
    bare = compile(doc, reader({ [spawnUri]: undefined, [despawnUri]: undefined }));
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(bare.view.characterBeam, timings);
  assert.equal(warnings.filter((line) => line.includes("beam-spawn") && line.includes("effect is skipped")).length >= 1, true);

  // Sheet files with the real 8 x 6 x 48 layout: fps 24, square frames, despawn rotated 90°.
  const view = compile(doc, reader({ [spawnUri]: pngHeader(2048, 1536), [despawnUri]: pngHeader(2048, 1536) })).view;
  const sheet = {
    columns: 8, rows: 6, frameCount: 48, frameWidth: 256, frameHeight: 256, fps: 24, size: view.pawnHeight, blending: "additive" as const,
  };
  assert.deepEqual(view.characterBeam?.spawn, { texture: spawnUri, ...sheet });
  assert.deepEqual(view.characterBeam?.despawn, { texture: despawnUri, ...sheet, rotation: 90 });
  assert.equal(view.characterBeam!.spawn!.fps, 24);
  assert.equal(view.characterBeam!.spawn!.frameCount / view.characterBeam!.spawn!.fps, 2, "48 frames at 24 fps = 2 s");

  // Empty sprite object: code defaults (8x6, 48, 256 square, fps 24, size = pawn height, additive, no rotation).
  const bareSheets = structuredClone(doc) as { scene: Record<string, unknown>; assets: Array<Record<string, unknown>> };
  bareSheets.assets.find((asset) => asset.id === "beam-spawn")!.sprite = {};
  bareSheets.assets.find((asset) => asset.id === "beam-despawn")!.sprite = {};
  const bareView = compile(bareSheets, reader({ [spawnUri]: pngHeader(2048, 1536), [despawnUri]: pngHeader(2048, 1536) })).view;
  assert.deepEqual(bareView.characterBeam?.spawn, { texture: spawnUri, ...sheet });
  assert.deepEqual(bareView.characterBeam?.despawn, { texture: despawnUri, ...sheet }, "no rotation when omitted");

  // Overrides: layout, an explicit fps, a size, rotation, and a different fade (fade no longer drives fps).
  const custom = structuredClone(doc) as { scene: Record<string, unknown>; assets: Array<Record<string, unknown>> };
  custom.scene.characterBeam = { fadeMs: 2000, despawnDelayMs: 900, despawnSoundDelayMs: 150, deathHoldMs: 400 };
  custom.assets.find((asset) => asset.id === "beam-spawn")!.sprite = { columns: 4, rows: 4, frameCount: 16, frameWidth: 100, frameHeight: 300, fps: 8, size: 3, blending: "normal" };
  custom.assets.find((asset) => asset.id === "beam-despawn")!.sprite = { rotation: -90 };
  const customView = compile(custom, reader({ [spawnUri]: pngHeader(400, 1200), [despawnUri]: pngHeader(2048, 1536) })).view;
  assert.deepEqual(customView.characterBeam?.spawn, {
    texture: spawnUri, columns: 4, rows: 4, frameCount: 16, frameWidth: 100, frameHeight: 300, fps: 8, size: 3, blending: "normal",
  });
  assert.deepEqual(customView.characterBeam?.despawn, {
    texture: despawnUri, columns: 8, rows: 6, frameCount: 48, frameWidth: 256, frameHeight: 256, fps: 24, size: customView.pawnHeight, blending: "additive", rotation: -90,
  });
  assert.deepEqual(
    { ...customView.characterBeam, spawn: undefined, despawn: undefined },
    { fadeMs: 2000, despawnDelayMs: 900, despawnSoundDelayMs: 150, deathHoldMs: 400, spawn: undefined, despawn: undefined },
  );

  // No scene block: no beam, even with the files present.
  const off = structuredClone(doc) as { scene: Record<string, unknown> };
  delete off.scene.characterBeam;
  assert.equal(compile(off, reader({ [spawnUri]: pngHeader(2048, 1536), [despawnUri]: pngHeader(2048, 1536) })).view.characterBeam, undefined);
});

test("scene.characterBeam and the beam sprites reject bad values with the field path", () => {
  const doc = document();
  const files = filesFromDisk();
  const spawnUri = "/assets/textures/beam-spawn-sheet.png";
  const read = (uri: string) => (uri === spawnUri ? pngHeader(2048, 1536) : files.get(uri));
  const paths = (edit: (copy: { scene: Record<string, unknown>; assets: Array<Record<string, unknown>> }) => void): string[] => {
    const copy = structuredClone(doc) as { scene: Record<string, unknown>; assets: Array<Record<string, unknown>> };
    edit(copy);
    try {
      compile(copy, read);
    } catch (err) {
      assert.ok(err instanceof GameManifestError);
      return err.issues.map((issue) => issue.path);
    }
    return [];
  };
  assert.ok(paths((c) => void (c.scene.characterBeam = { fadeMs: 10 })).includes("scene.characterBeam.fadeMs"));
  assert.ok(paths((c) => void (c.scene.characterBeam = { despawnDelayMs: -1 })).includes("scene.characterBeam.despawnDelayMs"));
  assert.ok(paths((c) => void (c.scene.characterBeam = { despawnSoundDelayMs: "now" })).includes("scene.characterBeam.despawnSoundDelayMs"));
  assert.ok(paths((c) => void (c.scene.characterBeam = { deathHoldMs: 99999 })).includes("scene.characterBeam.deathHoldMs"));
  assert.ok(paths((c) => void (c.scene.characterBeam = 7)).includes("scene.characterBeam"));
  const sheet = (sprite: unknown) => (c: { assets: Array<Record<string, unknown>> }) => void (c.assets.find((asset) => asset.id === "beam-spawn")!.sprite = sprite);
  assert.ok(paths(sheet({ columns: 0 })).some((path) => path.endsWith(".sprite.columns")));
  assert.ok(paths(sheet({ frameCount: 49 })).some((path) => path.endsWith(".sprite.frameCount")), "49 > 8x6");
  assert.ok(paths(sheet({ fps: -2 })).some((path) => path.endsWith(".sprite.fps")));
  assert.ok(paths(sheet({ blending: "multiply" })).some((path) => path.endsWith(".sprite.blending")));
  assert.ok(paths(sheet({ rotation: "cw" })).some((path) => path.endsWith(".sprite.rotation")));
  assert.ok(paths(sheet({ rotation: Number.NaN })).some((path) => path.endsWith(".sprite.rotation")));
  assert.ok(paths(sheet("fast")).some((path) => path.endsWith(".sprite")));
  // `optional` is for audio and texture assets only.
  assert.ok(paths((c) => void (c.assets.find((asset) => asset.kind === "model")!.optional = true)).some((path) => path.endsWith(".optional")));
});
