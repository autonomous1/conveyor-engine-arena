import {
  encodeGlb,
  hashBytes,
  hashCanonicalJson,
  hashUtf8,
  parseManifest,
  resolveStaticWorld,
  sniffGlb,
  type CollisionArtifact,
  type EngineManifest,
  type OriginCategory,
  type StaticWorldDefinition,
} from "conveyor-engine-assets";
import type { ArenaView, CharacterAnimation } from "../shared/arena-view.js";
import { DEFAULT_MOVEMENT_SPEED, MOVEMENTS, type Movement } from "../shared/movements.js";
import { SHADOW_QUALITIES, type ShadowQuality } from "../shared/shadows.js";

export type GameIssue = { path: string; message: string };

export class GameManifestError extends Error {
  readonly issues: GameIssue[];
  constructor(issues: GameIssue[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n"));
    this.name = "GameManifestError";
    this.issues = issues;
  }
}

export type CompiledGame = {
  view: ArenaView;
  definition: StaticWorldDefinition;
  engineManifest: EngineManifest;
  collision: CollisionArtifact;
  authoritativeHash: string;
  presentationHash: string;
  visualBytes: Uint8Array;
  bundleVersion: string;
};

type AssetRec = {
  id: string;
  kind: "texture" | "model";
  uri: string;
  mediaType: string;
  licenseId: string;
  origin: string;
  notes?: string;
  /** Uniform visual scale for a model. Omitted assets use 1. */
  scale?: number;
  shape?: "cylinder" | "dome";
  radius?: number;
  height?: number;
  animations?: Record<Movement, CharacterAnimation>;
};

const KNOWN_ORIGINS = new Set([
  "manual", "procedural", "imported-open-content", "imported-third-party",
  "ai-assisted", "scanned", "generated-test-fixture", "derived", "unknown",
]);

const WALL_IDS = [10, 11, 12, 13] as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseCharacterAnimations(raw: unknown, path: string, issues: GameIssue[]): Record<Movement, CharacterAnimation> | undefined {
  if (!isObject(raw)) {
    issues.push({ path, message: "required object" });
    return undefined;
  }
  let ok = true;
  const out = {} as Record<Movement, CharacterAnimation>;
  for (const movement of MOVEMENTS) {
    const value = raw[movement];
    const field = `${path}.${movement}`;
    if (typeof value === "string") {
      if (!value) {
        issues.push({ path: field, message: "clip name is required" });
        ok = false;
        continue;
      }
      out[movement] = { clip: value, speed: DEFAULT_MOVEMENT_SPEED[movement] };
      continue;
    }
    if (!isObject(value)) {
      issues.push({ path: field, message: "clip name or { clip, speed }" });
      ok = false;
      continue;
    }
    const clip = typeof value.clip === "string" ? value.clip : undefined;
    if (!clip) {
      issues.push({ path: `${field}.clip`, message: "required string" });
      ok = false;
      continue;
    }
    let speed = DEFAULT_MOVEMENT_SPEED[movement];
    if (value.speed !== undefined) {
      if (typeof value.speed !== "number" || !Number.isFinite(value.speed)) {
        issues.push({ path: `${field}.speed`, message: "required finite number" });
        ok = false;
        continue;
      }
      if (value.speed < 0) {
        issues.push({ path: `${field}.speed`, message: "must be >= 0" });
        ok = false;
        continue;
      }
      speed = value.speed;
    }
    out[movement] = { clip, speed };
  }
  return ok ? out : undefined;
}

function modelScale(value: unknown, path: string, issues: GameIssue[]): number {
  if (value === undefined) return 1;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    issues.push({ path, message: "required finite number" });
    return 1;
  }
  if (value <= 0) {
    issues.push({ path, message: "must be > 0" });
    return 1;
  }
  return value;
}

function num(value: unknown, path: string, issues: GameIssue[]): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    issues.push({ path, message: "required finite number" });
    return undefined;
  }
  return value;
}

function str(value: unknown, path: string, issues: GameIssue[]): string | undefined {
  if (typeof value !== "string" || !value) {
    issues.push({ path, message: "required string" });
    return undefined;
  }
  return value;
}

function publicAssetUri(value: unknown, path: string, issues: GameIssue[]): string | undefined {
  const uri = str(value, path, issues);
  if (!uri) return undefined;
  if (!uri.startsWith("/assets/") || uri.includes("..") || uri.includes("\\") || uri.includes("\0")) {
    issues.push({ path, message: "must be a /assets/ path inside the web root" });
    return undefined;
  }
  return uri;
}

function visualLayoutBytes(): Uint8Array {
  return encodeGlb({
    asset: { version: "2.0", generator: "conveyor-engine-arena" },
    scene: 0,
    scenes: [{ name: "arena-layout", nodes: [] }],
    nodes: [],
  });
}

export function compileGame(doc: unknown, read: (uri: string) => Uint8Array | undefined): CompiledGame {
  const issues: GameIssue[] = [];
  if (!isObject(doc)) throw new GameManifestError([{ path: "$", message: "manifest must be an object" }]);
  if (doc.formatVersion !== 1) issues.push({ path: "formatVersion", message: "must be 1" });
  str(doc.gameId, "gameId", issues);
  str(doc.gameVersion, "gameVersion", issues);
  const worldVersion = str(doc.worldVersion, "worldVersion", issues);
  const bundleId = str(doc.bundleId, "bundleId", issues);
  const bundleVersion = str(doc.bundleVersion, "bundleVersion", issues);
  if (doc.units !== "meters") issues.push({ path: "units", message: "must be meters" });
  if (doc.coordinateSystem !== "y-up") issues.push({ path: "coordinateSystem", message: "must be y-up" });

  const scene = isObject(doc.scene) ? doc.scene : undefined;
  if (!scene) issues.push({ path: "scene", message: "required object" });
  const boundsRaw = scene && isObject(scene.bounds) ? scene.bounds : undefined;
  if (!boundsRaw) issues.push({ path: "scene.bounds", message: "required object" });
  const minX = boundsRaw ? num(boundsRaw.minX, "scene.bounds.minX", issues) : undefined;
  const maxX = boundsRaw ? num(boundsRaw.maxX, "scene.bounds.maxX", issues) : undefined;
  const minY = boundsRaw ? num(boundsRaw.minY, "scene.bounds.minY", issues) : undefined;
  const maxY = boundsRaw ? num(boundsRaw.maxY, "scene.bounds.maxY", issues) : undefined;
  const minZ = boundsRaw ? num(boundsRaw.minZ, "scene.bounds.minZ", issues) : undefined;
  const maxZ = boundsRaw ? num(boundsRaw.maxZ, "scene.bounds.maxZ", issues) : undefined;
  if (minX !== undefined && maxX !== undefined && maxX <= minX) issues.push({ path: "scene.bounds", message: "maxX must exceed minX" });
  if (minZ !== undefined && maxZ !== undefined && maxZ <= minZ) issues.push({ path: "scene.bounds", message: "maxZ must exceed minZ" });

  const floor = scene && isObject(scene.floor) ? scene.floor : undefined;
  if (!floor) issues.push({ path: "scene.floor", message: "required object" });
  const floorY = floor ? num(floor.y, "scene.floor.y", issues) : undefined;
  const floorMaterial = floor ? str(floor.material, "scene.floor.material", issues) : undefined;

  const walls = scene && isObject(scene.walls) ? scene.walls : undefined;
  if (!walls) issues.push({ path: "scene.walls", message: "required object" });
  const wallHeight = walls ? num(walls.height, "scene.walls.height", issues) : undefined;
  const wallThickness = walls ? num(walls.thickness, "scene.walls.thickness", issues) : undefined;
  if (walls && walls.collision !== true) issues.push({ path: "scene.walls.collision", message: "must be true for the one-room arena" });
  const faceOrder = ["south", "east", "north", "west"] as const;
  const faceMaterials: Partial<Record<(typeof faceOrder)[number], string>> = {};
  const faces = walls && isObject(walls.faces) ? walls.faces : undefined;
  if (!faces) issues.push({ path: "scene.walls.faces", message: "required object with south, east, north, and west" });
  else {
    for (const face of faceOrder) {
      const material = str(faces[face], `scene.walls.faces.${face}`, issues);
      if (material) faceMaterials[face] = material;
    }
  }
  if (wallHeight !== undefined && wallHeight <= 0) issues.push({ path: "scene.walls.height", message: "must be > 0" });
  if (wallThickness !== undefined && wallThickness <= 0) issues.push({ path: "scene.walls.thickness", message: "must be > 0" });

  const sky = scene && isObject(scene.sky) ? scene.sky : undefined;
  if (!sky) issues.push({ path: "scene.sky", message: "required object" });
  if (sky && sky.kind !== "sky-dome") issues.push({ path: "scene.sky.kind", message: "must be sky-dome" });
  const skyMaterial = sky ? str(sky.material, "scene.sky.material", issues) : undefined;

  const cityscape = scene && isObject(scene.cityscape) ? scene.cityscape : undefined;
  if (!cityscape) issues.push({ path: "scene.cityscape", message: "required object" });
  const cityscapeMaterial = cityscape ? str(cityscape.material, "scene.cityscape.material", issues) : undefined;

  const shadows = scene && isObject(scene.shadows) ? scene.shadows : undefined;
  if (!shadows) issues.push({ path: "scene.shadows", message: "required object" });
  const shadowQuality = shadows && SHADOW_QUALITIES.includes(shadows.quality as ShadowQuality)
    ? shadows.quality as ShadowQuality
    : undefined;
  if (shadows && !shadowQuality) issues.push({ path: "scene.shadows.quality", message: "must be off, basic, soft, or realistic" });

  const assets = new Map<string, AssetRec>();
  if (!Array.isArray(doc.assets)) issues.push({ path: "assets", message: "required array" });
  else {
    doc.assets.forEach((item, index) => {
      const path = `assets[${index}]`;
      if (!isObject(item)) {
        issues.push({ path, message: "must be an object" });
        return;
      }
      const id = str(item.id, `${path}.id`, issues);
      const kind = item.kind === "texture" || item.kind === "model" ? item.kind : undefined;
      if (!kind) issues.push({ path: `${path}.kind`, message: "must be texture or model" });
      const uri = publicAssetUri(item.uri, `${path}.uri`, issues);
      const mediaType = str(item.mediaType, `${path}.mediaType`, issues);
      const licenseId = isObject(item.license) && typeof item.license.id === "string" ? item.license.id : undefined;
      if (!licenseId) issues.push({ path: `${path}.license.id`, message: "required license id" });
      const origin = isObject(item.provenance) && typeof item.provenance.origin === "string" ? item.provenance.origin : undefined;
      if (!origin) issues.push({ path: `${path}.provenance.origin`, message: "required origin" });
      const notes = isObject(item.provenance) && typeof item.provenance.notes === "string" ? item.provenance.notes : undefined;
      if (id && assets.has(id)) issues.push({ path: `${path}.id`, message: `duplicate id ${id}` });
      const scale = kind === "model" ? modelScale(item.scale, `${path}.scale`, issues) : undefined;
      const animations = kind === "model" && item.animations !== undefined
        ? parseCharacterAnimations(item.animations, `${path}.animations`, issues)
        : undefined;
      const backdrop = id === skyMaterial || id === cityscapeMaterial;
      let shape: AssetRec["shape"];
      let radius: number | undefined;
      let height: number | undefined;
      if (backdrop) {
        if (item.shape !== "cylinder" && item.shape !== "dome") {
          issues.push({ path: `${path}.shape`, message: "must be cylinder or dome" });
        } else shape = item.shape;
        radius = num(item.radius, `${path}.radius`, issues);
        height = num(item.height, `${path}.height`, issues);
        if (radius !== undefined && radius <= 0) issues.push({ path: `${path}.radius`, message: "must be > 0" });
        if (height !== undefined && height <= 0) issues.push({ path: `${path}.height`, message: "must be > 0" });
      }
      if (id && kind && uri && mediaType && licenseId && origin) {
        assets.set(id, { id, kind, uri, mediaType, licenseId, origin, notes, scale, shape, radius, height, animations });
      }
    });
  }

  const refAsset = (id: string | undefined, path: string, kind: "texture" | "model") => {
    if (!id) return;
    const asset = assets.get(id);
    if (!asset) issues.push({ path, message: `unknown asset ${id}` });
    else if (asset.kind !== kind) issues.push({ path, message: `${id} is not a ${kind}` });
  };
  refAsset(floorMaterial, "scene.floor.material", "texture");
  refAsset(skyMaterial, "scene.sky.material", "texture");
  refAsset(cityscapeMaterial, "scene.cityscape.material", "texture");
  for (const face of faceOrder) refAsset(faceMaterials[face], `scene.walls.faces.${face}`, "model");

  const collisionBoxes: Array<{ id: number; minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number }> = [];
  const seenCollision = new Set<number>();
  if (!scene || !Array.isArray(scene.collision)) issues.push({ path: "scene.collision", message: "required array" });
  else scene.collision.forEach((item, index) => {
    const path = `scene.collision[${index}]`;
    if (!isObject(item)) {
      issues.push({ path, message: "must be an object" });
      return;
    }
    if (item.kind !== "aabb") issues.push({ path: `${path}.kind`, message: "must be aabb" });
    const id = num(item.id, `${path}.id`, issues);
    const min = Array.isArray(item.min) ? item.min : undefined;
    const max = Array.isArray(item.max) ? item.max : undefined;
    if (!min || min.length !== 3) issues.push({ path: `${path}.min`, message: "must be [x,y,z]" });
    if (!max || max.length !== 3) issues.push({ path: `${path}.max`, message: "must be [x,y,z]" });
    const coords = [...(min ?? []), ...(max ?? [])].map((value, i) => num(value, `${path}.${i < 3 ? "min" : "max"}[${i % 3}]`, issues));
    if (id === undefined || coords.some((value) => value === undefined)) return;
    if (seenCollision.has(id) || WALL_IDS.includes(id as (typeof WALL_IDS)[number])) {
      issues.push({ path: `${path}.id`, message: `duplicate or reserved id ${id}` });
    }
    seenCollision.add(id);
    const [x0, y0, z0, x1, y1, z1] = coords as number[];
    if (x1 < x0 || y1 < y0 || z1 < z0) issues.push({ path, message: "max must exceed min" });
    collisionBoxes.push({ id, minX: x0, maxX: x1, minY: y0, maxY: y1, minZ: z0, maxZ: z1 });
  });

  const props: ArenaView["props"] = [];
  const seenProps = new Set<string>();
  if (!scene || !Array.isArray(scene.props) || scene.props.length < 2) {
    issues.push({ path: "scene.props", message: "at least two props are required" });
  } else scene.props.forEach((item, index) => {
    const path = `scene.props[${index}]`;
    if (!isObject(item)) {
      issues.push({ path, message: "must be an object" });
      return;
    }
    const id = str(item.id, `${path}.id`, issues);
    const model = str(item.model, `${path}.model`, issues);
    const collisionId = num(item.collision, `${path}.collision`, issues);
    if (id && seenProps.has(id)) issues.push({ path: `${path}.id`, message: `duplicate id ${id}` });
    if (id) seenProps.add(id);
    refAsset(model, `${path}.model`, "model");
    const box = collisionBoxes.find((entry) => entry.id === collisionId);
    if (collisionId !== undefined && !box) issues.push({ path: `${path}.collision`, message: `unknown collision ${collisionId}` });
    if (id && model && box) {
      const asset = assets.get(model);
      props.push({
        id,
        model: asset?.uri ?? "",
        minX: box.minX, maxX: box.maxX, minY: box.minY, maxY: box.maxY, minZ: box.minZ, maxZ: box.maxZ,
      });
    }
  });

  const player = isObject(doc.player) ? doc.player : undefined;
  if (!player) issues.push({ path: "player", message: "required object" });
  const pawnRadius = player ? num(player.radius, "player.radius", issues) : undefined;
  const pawnHeight = player ? num(player.height, "player.height", issues) : undefined;
  if (pawnRadius !== undefined && pawnRadius <= 0) issues.push({ path: "player.radius", message: "must be > 0" });
  const choices = player && Array.isArray(player.modelChoices) ? player.modelChoices : undefined;
  if (!choices || choices.length < 2) issues.push({ path: "player.modelChoices", message: "at least two model ids are required" });
  const characters: ArenaView["characters"] = [];
  choices?.forEach((choice, index) => {
    const id = str(choice, `player.modelChoices[${index}]`, issues);
    refAsset(id, `player.modelChoices[${index}]`, "model");
    const asset = id ? assets.get(id) : undefined;
    if (id && asset?.kind === "model") {
      if (!asset.animations) issues.push({ path: `player.modelChoices[${index}]`, message: "animations for idle, walk, run, fall, and angry are required" });
      else characters.push({ id, model: asset.uri, scale: asset.scale ?? 1, animations: asset.animations });
    }
  });

  const spawns: Array<{ id: string; x: number; y: number; z: number; yaw: number }> = [];
  const seenSpawns = new Set<string>();
  if (!scene || !Array.isArray(scene.spawnPoints) || scene.spawnPoints.length < 2) {
    issues.push({ path: "scene.spawnPoints", message: "at least two spawn points are required" });
  } else scene.spawnPoints.forEach((item, index) => {
    const path = `scene.spawnPoints[${index}]`;
    if (!isObject(item)) {
      issues.push({ path, message: "must be an object" });
      return;
    }
    const id = str(item.id, `${path}.id`, issues);
    const x = num(item.x, `${path}.x`, issues);
    const y = num(item.y, `${path}.y`, issues);
    const z = num(item.z, `${path}.z`, issues);
    const yaw = num(item.yaw, `${path}.yaw`, issues);
    if (id && seenSpawns.has(id)) issues.push({ path: `${path}.id`, message: `duplicate id ${id}` });
    if (id) seenSpawns.add(id);
    if (id && x !== undefined && y !== undefined && z !== undefined && yaw !== undefined) spawns.push({ id, x, y, z, yaw });
  });

  const fileBytes = new Map<string, Uint8Array>();
  for (const asset of assets.values()) {
    const index = [...(Array.isArray(doc.assets) ? doc.assets : [])].findIndex((item) => isObject(item) && item.id === asset.id);
    const path = `assets[${index}].uri`;
    const expected = asset.kind === "texture" ? "image/png" : "model/gltf-binary";
    if (asset.mediaType !== expected) issues.push({ path: `assets[${index}].mediaType`, message: `must be ${expected}` });
    const bytes = read(asset.uri);
    if (!bytes) {
      issues.push({ path, message: `file not found for ${asset.uri}` });
      continue;
    }
    if (asset.kind === "texture") {
      const png = bytes.length >= 8 && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71;
      if (!png) issues.push({ path, message: "not a png" });
    } else {
      try {
        const report = sniffGlb(bytes);
        if (report.errors.length) issues.push({ path, message: report.errors.join("; ") });
      } catch (err) {
        issues.push({ path, message: err instanceof Error ? err.message : "glb decode failed" });
      }
    }
    fileBytes.set(asset.uri, bytes);
  }

  const facesReady = faceOrder.every((face) => faceMaterials[face] && assets.get(faceMaterials[face]!)?.kind === "model");
  if (issues.length || !bundleId || !bundleVersion || !worldVersion || minX === undefined || maxX === undefined || minY === undefined || maxY === undefined || minZ === undefined || maxZ === undefined || floorY === undefined || wallHeight === undefined || wallThickness === undefined || pawnRadius === undefined || pawnHeight === undefined || !floorMaterial || !skyMaterial || !cityscapeMaterial || !shadowQuality || !facesReady) {
    throw new GameManifestError(issues.length ? issues : [{ path: "$", message: "manifest is incomplete" }]);
  }

  const bounds = { minX, maxX, minY, maxY, minZ, maxZ };
  const wallBoxes = [
    { id: 10, face: "west" as const, minX, maxX: minX + wallThickness, minZ, maxZ, minY: 0, maxY: wallHeight },
    { id: 11, face: "east" as const, minX: maxX - wallThickness, maxX, minZ, maxZ, minY: 0, maxY: wallHeight },
    { id: 12, face: "south" as const, minX, maxX, minZ, maxZ: minZ + wallThickness, minY: 0, maxY: wallHeight },
    { id: 13, face: "north" as const, minX, maxX, minZ: maxZ - wallThickness, maxZ, minY: 0, maxY: wallHeight },
  ];
  const aabbs = [...collisionBoxes, ...wallBoxes];
  const collision: CollisionArtifact = {
    formatVersion: 1,
    representation: "aabb",
    coordinateSystem: "y-up",
    unitScale: 1,
    origin: { x: 0, y: 0, z: 0 },
    bounds,
    visualAssetId: "environment.arena.visual",
    spawnPoints: spawns.map((spawn) => ({ ...spawn, clearance: pawnRadius })),
    aabbs,
  };

  const visualBytes = visualLayoutBytes();
  const collisionJson = JSON.stringify(collision);
  const collisionHash = hashBytes(new TextEncoder().encode(collisionJson));
  const visualHash = hashBytes(visualBytes);
  const fileHashes = [...assets.values()]
    .map((asset) => ({ id: asset.id, hash: hashBytes(fileBytes.get(asset.uri) ?? new Uint8Array()) }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const presentationHash = hashCanonicalJson(fileHashes);

  const license = { id: "CC0-1.0", status: "spdx" as const };
  const provenance = {
    origin: "procedural" as const,
    notes: "Original procedural placeholder made for this arena. No third-party art.",
  };
  const engineInput = {
    formatVersion: 1 as const,
    bundleId,
    bundleVersion,
    schemaVersion: "static-world-v1",
    assets: [
      {
        id: "environment.arena.collision",
        kind: "static-collision-scene",
        authority: "authoritative-static",
        version: "1.0.0",
        contentHash: collisionHash,
        runtimeUri: "memory:collision",
        runtimeRole: "collision",
        license,
        provenance,
      },
      {
        id: "environment.arena.visual",
        kind: "static-visual-scene",
        authority: "presentation",
        version: "1.0.0",
        contentHash: visualHash,
        runtimeUri: "memory:visual",
        runtimeRole: "visual-scene",
        runtimePolicy: { fallbackAssetId: "primitive/box" },
        license,
        provenance,
      },
      {
        id: "primitive/box",
        kind: "primitive",
        authority: "diagnostic",
        version: "1.0.0",
        contentHash: hashUtf8("box"),
        runtimeUri: "memory:box",
      },
      ...[...assets.values()].map((asset) => ({
        id: asset.id,
        kind: asset.kind === "texture" ? "texture" as const : "renderable-model" as const,
        authority: "presentation" as const,
        version: "1.0.0",
        contentHash: hashBytes(fileBytes.get(asset.uri) ?? new Uint8Array()),
        runtimeUri: asset.uri.replace(/^\//, ""),
        runtimeRole: asset.kind === "texture" ? "texture" as const : "model" as const,
        license: { id: asset.licenseId, status: asset.licenseId === "CC0-1.0" ? "spdx" as const : "unknown" as const },
        provenance: {
          origin: (KNOWN_ORIGINS.has(asset.origin) ? asset.origin : "manual") as OriginCategory,
          notes: asset.notes,
        },
      })),
    ],
  };

  let engineManifest: EngineManifest;
  try {
    engineManifest = parseManifest(engineInput);
  } catch (err) {
    const schemaIssues = (err as { issues?: { path: string; message: string }[] }).issues;
    throw new GameManifestError(schemaIssues ?? [{ path: "assets", message: err instanceof Error ? err.message : "engine manifest rejected" }]);
  }

  let resolved: ReturnType<typeof resolveStaticWorld>;
  try {
    resolved = resolveStaticWorld({ manifest: engineManifest, collision, profile: "example-arena" });
  } catch (err) {
    const messages = (err as { issues?: string[] }).issues ?? [err instanceof Error ? err.message : "static world rejected"];
    throw new GameManifestError(messages.map((message) => ({ path: "scene", message })));
  }

  const floorTexture = assets.get(floorMaterial)!.uri;
  const skyAsset = assets.get(skyMaterial)!;
  const cityAsset = assets.get(cityscapeMaterial)!;
  const view: ArenaView = {
    bundleId,
    bundleVersion,
    authoritativeHash: resolved.hash,
    presentationHash,
    collisionContentHash: collisionHash,
    world: worldVersion,
    bounds,
    floor: { y: floorY, texture: floorTexture },
    walls: wallBoxes.map((wall) => ({
      face: wall.face,
      minX: wall.minX,
      maxX: wall.maxX,
      minZ: wall.minZ,
      maxZ: wall.maxZ,
      height: wallHeight,
      model: assets.get(faceMaterials[wall.face]!)!.uri,
    })),
    sky: { kind: "sky-dome", texture: skyAsset.uri, shape: skyAsset.shape!, radius: skyAsset.radius!, height: skyAsset.height! },
    cityscape: { texture: cityAsset.uri, shape: cityAsset.shape!, radius: cityAsset.radius!, height: cityAsset.height! },
    shadows: { quality: shadowQuality },
    props,
    characters,
    aabbs: resolved.definition.aabbs.map((box) => ({
      id: box.id, minX: box.minX, maxX: box.maxX, minZ: box.minZ, maxZ: box.maxZ,
    })),
    pawnRadius,
    pawnHeight,
  };

  return {
    view,
    definition: resolved.definition,
    engineManifest,
    collision,
    authoritativeHash: resolved.hash,
    presentationHash,
    visualBytes,
    bundleVersion,
  };
}
