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
import { interpretPlacements } from "./placements-file.js";
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
  /** `"static"` placements share one InstancedMesh per source mesh. Omitted means clone. */
  instance?: "static";
};

/** A wall face from the manifest. Position and yaw are optional; the client falls back to the face anchor. */
type FaceRec = {
  model: string;
  modelPath: string;
  position?: [number, number, number];
  /** Degrees about +Y, wrapped onto 0, 90, 180, or 270. */
  yaw?: number;
  scale?: number;
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

/** Only `"static"` is instanced. Anything else is a manifest error, not a silent clone. */
function parseInstance(value: unknown, path: string, issues: GameIssue[]): "static" | undefined {
  if (value === undefined) return undefined;
  if (value === "static") return "static";
  issues.push({ path, message: "must be static" });
  return undefined;
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

/** A face is an asset id, or `{ model, position?, yaw?, scale? }`. The server does not read the GLB. */
function parseFace(value: unknown, path: string, issues: GameIssue[]): FaceRec | undefined {
  if (typeof value === "string") {
    const model = str(value, path, issues);
    return model ? { model, modelPath: path } : undefined;
  }
  if (!isObject(value)) {
    issues.push({ path, message: "model id or { model, position, yaw, scale }" });
    return undefined;
  }
  const modelPath = `${path}.model`;
  const model = str(value.model, modelPath, issues);
  const position = value.position === undefined ? undefined : vec3(value.position, `${path}.position`, issues);
  const yaw = value.yaw === undefined ? undefined : cardinalYaw(value.yaw, `${path}.yaw`, issues);
  const scale = value.scale === undefined ? undefined : modelScale(value.scale, `${path}.scale`, issues);
  if (!model) return undefined;
  return { model, modelPath, position, yaw, scale };
}

function vec3(value: unknown, path: string, issues: GameIssue[]): [number, number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 3) {
    issues.push({ path, message: "must be [x,y,z]" });
    return undefined;
  }
  const coords = value.map((item, index) => num(item, `${path}[${index}]`, issues));
  if (coords.some((item) => item === undefined)) return undefined;
  return coords as [number, number, number];
}

/** −90° is the same turn as 270°. Anything else is not a baked quarter turn. */
function cardinalYaw(value: unknown, path: string, issues: GameIssue[]): number | undefined {
  const degrees = num(value, path, issues);
  if (degrees === undefined) return undefined;
  const wrapped = ((degrees % 360) + 360) % 360;
  for (const card of [0, 90, 180, 270]) {
    if (Math.abs(wrapped - card) < 1e-6) return card;
  }
  issues.push({ path, message: "must be 0, 90, 180, or 270 degrees" });
  return undefined;
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

export type PlacementRef = { file: string; path: string };

export type PlacementFileSource = {
  /** Path as written in `scene.placements`. */
  path: string;
  text: string;
};

export type CompileSources = {
  /** One entry per placements path, in manifest order. */
  placementFiles?: PlacementFileSource[];
  /** Set when `scene.bounds` is a path. The text is the bounds object. */
  boundsFile?: PlacementFileSource;
  /** Set when `scene.spawnPoints` is a path. The text is the spawn array. */
  spawnPointsFile?: PlacementFileSource;
};

type CollisionBox = {
  id: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
};

/**
 * `scene.placements` is a list of paths. A single string is a one-element list.
 * An absent field is an empty list, not an error.
 */
export function placementRefsOf(scene: unknown): { refs: PlacementRef[]; issues: GameIssue[] } {
  const issues: GameIssue[] = [];
  if (!isObject(scene) || !Object.prototype.hasOwnProperty.call(scene, "placements")) {
    return { refs: [], issues };
  }
  const value = scene.placements;
  if (typeof value === "string") {
    if (!value.trim()) {
      issues.push({ path: "scene.placements", message: "must be a path to a placements file" });
      return { refs: [], issues };
    }
    return { refs: [{ file: value, path: "scene.placements" }], issues };
  }
  if (!Array.isArray(value)) {
    issues.push({ path: "scene.placements", message: "must be a path or a list of paths" });
    return { refs: [], issues };
  }
  const refs: PlacementRef[] = [];
  value.forEach((item, index) => {
    const path = `scene.placements[${index}]`;
    if (typeof item !== "string" || !item.trim()) {
      issues.push({ path, message: "must be a path to a placements file" });
      return;
    }
    refs.push({ file: item, path });
  });
  return { refs, issues };
}

/**
 * `scene.bounds` is the bounds object, or a path to a JSON file of that object.
 * A missing field is an error. The file is not allowed to wrap the object in `scene`.
 */
function boundsObject(
  scene: Record<string, unknown> | undefined,
  sources: CompileSources | undefined,
  issues: GameIssue[],
): Record<string, unknown> | undefined {
  if (!scene || !Object.prototype.hasOwnProperty.call(scene, "bounds")) {
    issues.push({ path: "scene.bounds", message: "must be an object or a path" });
    return undefined;
  }
  return jsonObject(scene.bounds, "scene.bounds", sources?.boundsFile, issues);
}

function jsonObject(
  value: unknown,
  issuePath: string,
  file: PlacementFileSource | undefined,
  issues: GameIssue[],
): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    if (!value.trim()) {
      issues.push({ path: issuePath, message: "must be an object or a path" });
      return undefined;
    }
    if (!file || file.path !== value) {
      issues.push({ path: issuePath, message: "file was not loaded" });
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(file.text);
    } catch (err) {
      issues.push({ path: issuePath, message: `invalid json: ${err instanceof Error ? err.message : String(err)}` });
      return undefined;
    }
    if (!isObject(parsed)) {
      issues.push({ path: issuePath, message: "must be an object" });
      return undefined;
    }
    return parsed;
  }
  if (isObject(value)) return value;
  issues.push({ path: issuePath, message: "must be an object or a path" });
  return undefined;
}

/** Inline array, or a path to a JSON file that is that array. Absent is an empty list. */
function spawnList(
  scene: Record<string, unknown> | undefined,
  sources: CompileSources | undefined,
  issues: GameIssue[],
): unknown[] {
  if (!scene || !Object.prototype.hasOwnProperty.call(scene, "spawnPoints")) return [];
  const value = scene.spawnPoints;
  if (typeof value === "string") {
    if (!value.trim()) {
      issues.push({ path: "scene.spawnPoints", message: "must be an array or a path" });
      return [];
    }
    const file = sources?.spawnPointsFile;
    if (!file || file.path !== value) {
      issues.push({ path: "scene.spawnPoints", message: "file was not loaded" });
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(file.text);
    } catch (err) {
      issues.push({ path: "scene.spawnPoints", message: `invalid json: ${err instanceof Error ? err.message : String(err)}` });
      return [];
    }
    if (!Array.isArray(parsed)) {
      issues.push({ path: "scene.spawnPoints", message: "must be an array" });
      return [];
    }
    return parsed;
  }
  if (Array.isArray(value)) return value;
  issues.push({ path: "scene.spawnPoints", message: "must be an array or a path" });
  return [];
}

function sceneArray(scene: Record<string, unknown> | undefined, key: string, path: string, issues: GameIssue[]): unknown[] {
  if (!scene || !Object.prototype.hasOwnProperty.call(scene, key)) return [];
  const value = scene[key];
  if (!Array.isArray(value)) {
    issues.push({ path, message: "must be an array" });
    return [];
  }
  return value;
}

function optionalFieldArray(source: Record<string, unknown>, key: string, path: string, issues: GameIssue[]): unknown[] | undefined {
  if (!Object.prototype.hasOwnProperty.call(source, key)) return undefined;
  const value = source[key];
  if (!Array.isArray(value)) {
    issues.push({ path, message: "must be an array" });
    return undefined;
  }
  return value;
}

/** Spawn points, props, and collision append. Floor, sky, cityscape, shadows, and bounds do not. */
function partialScene(value: unknown, file: string, issues: GameIssue[]): { spawns?: unknown[]; props?: unknown[]; collision?: unknown[] } {
  if (!isObject(value) || !Object.prototype.hasOwnProperty.call(value, "scene")) return {};
  const partial = value.scene;
  if (!isObject(partial)) {
    issues.push({ path: `${file} scene`, message: "must be an object" });
    return {};
  }
  return {
    spawns: optionalFieldArray(partial, "spawnPoints", `${file} scene.spawnPoints`, issues),
    props: optionalFieldArray(partial, "props", `${file} scene.props`, issues),
    collision: optionalFieldArray(partial, "collision", `${file} scene.collision`, issues),
  };
}

function pushCollision(items: unknown[], pathFor: (index: number) => string, issues: GameIssue[], seen: Set<number>, boxes: CollisionBox[]): void {
  items.forEach((item, index) => {
    const path = pathFor(index);
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
    if (seen.has(id) || WALL_IDS.includes(id as (typeof WALL_IDS)[number])) {
      issues.push({ path: `${path}.id`, message: `duplicate or reserved id ${id}` });
    }
    seen.add(id);
    const [x0, y0, z0, x1, y1, z1] = coords as number[];
    if (x1 < x0 || y1 < y0 || z1 < z0) issues.push({ path, message: "max must exceed min" });
    boxes.push({ id, minX: x0, maxX: x1, minY: y0, maxY: y1, minZ: z0, maxZ: z1 });
  });
}

export function compileGame(doc: unknown, read: (uri: string) => Uint8Array | undefined, sources?: CompileSources): CompiledGame {
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
  else str(scene.id, "scene.id", issues);
  const boundsRaw = boundsObject(scene, sources, issues);
  const minX = boundsRaw ? num(boundsRaw.minX, "scene.bounds.minX", issues) : undefined;
  const maxX = boundsRaw ? num(boundsRaw.maxX, "scene.bounds.maxX", issues) : undefined;
  const minY = boundsRaw ? num(boundsRaw.minY, "scene.bounds.minY", issues) : undefined;
  const maxY = boundsRaw ? num(boundsRaw.maxY, "scene.bounds.maxY", issues) : undefined;
  const minZ = boundsRaw ? num(boundsRaw.minZ, "scene.bounds.minZ", issues) : undefined;
  const maxZ = boundsRaw ? num(boundsRaw.maxZ, "scene.bounds.maxZ", issues) : undefined;
  if (minX !== undefined && maxX !== undefined && maxX <= minX) issues.push({ path: "scene.bounds", message: "maxX must exceed minX" });
  if (minZ !== undefined && maxZ !== undefined && maxZ <= minZ) issues.push({ path: "scene.bounds", message: "maxZ must exceed minZ" });

  const floorValue = scene && Object.prototype.hasOwnProperty.call(scene, "floor") ? scene.floor : undefined;
  const floor = isObject(floorValue) ? floorValue : undefined;
  if (floorValue !== undefined && !floor) issues.push({ path: "scene.floor", message: "must be an object" });
  const floorY = floor ? num(floor.y, "scene.floor.y", issues) : undefined;
  const floorMaterial = floor ? str(floor.material, "scene.floor.material", issues) : undefined;

  const wallsValue = scene && Object.prototype.hasOwnProperty.call(scene, "walls") ? scene.walls : undefined;
  const walls = isObject(wallsValue) ? wallsValue : undefined;
  if (wallsValue !== undefined && !walls) issues.push({ path: "scene.walls", message: "must be an object" });
  const wallHeight = walls ? num(walls.height, "scene.walls.height", issues) : undefined;
  const wallThickness = walls ? num(walls.thickness, "scene.walls.thickness", issues) : undefined;
  if (walls && walls.collision !== true) issues.push({ path: "scene.walls.collision", message: "must be true for the one-room arena" });
  const faceOrder = ["south", "east", "north", "west"] as const;
  const facePlacements: Partial<Record<(typeof faceOrder)[number], FaceRec>> = {};
  const faces = walls && isObject(walls.faces) ? walls.faces : undefined;
  if (walls && !faces) issues.push({ path: "scene.walls.faces", message: "required object with south, east, north, and west" });
  else if (faces) {
    for (const face of faceOrder) {
      const placed = parseFace(faces[face], `scene.walls.faces.${face}`, issues);
      if (placed) facePlacements[face] = placed;
    }
  }
  if (wallHeight !== undefined && wallHeight <= 0) issues.push({ path: "scene.walls.height", message: "must be > 0" });
  if (wallThickness !== undefined && wallThickness <= 0) issues.push({ path: "scene.walls.thickness", message: "must be > 0" });

  const skyValue = scene && Object.prototype.hasOwnProperty.call(scene, "sky") ? scene.sky : undefined;
  const sky = isObject(skyValue) ? skyValue : undefined;
  if (skyValue !== undefined && !sky) issues.push({ path: "scene.sky", message: "must be an object" });
  if (sky && sky.kind !== "sky-dome") issues.push({ path: "scene.sky.kind", message: "must be sky-dome" });
  const skyMaterial = sky ? str(sky.material, "scene.sky.material", issues) : undefined;

  const cityscapeValue = scene && Object.prototype.hasOwnProperty.call(scene, "cityscape") ? scene.cityscape : undefined;
  const cityscape = isObject(cityscapeValue) ? cityscapeValue : undefined;
  if (cityscapeValue !== undefined && !cityscape) issues.push({ path: "scene.cityscape", message: "must be an object" });
  const cityscapeMaterial = cityscape ? str(cityscape.material, "scene.cityscape.material", issues) : undefined;

  const shadowsValue = scene && Object.prototype.hasOwnProperty.call(scene, "shadows") ? scene.shadows : undefined;
  const shadows = isObject(shadowsValue) ? shadowsValue : undefined;
  if (shadowsValue !== undefined && !shadows) issues.push({ path: "scene.shadows", message: "must be an object" });
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
      const instance = parseInstance(item.instance, `${path}.instance`, issues);
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
        assets.set(id, { id, kind, uri, mediaType, licenseId, origin, notes, scale, shape, radius, height, animations, instance });
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
  for (const face of faceOrder) {
    const placed = facePlacements[face];
    refAsset(placed?.model, placed?.modelPath ?? `scene.walls.faces.${face}`, "model");
  }

  const collisionBoxes: CollisionBox[] = [];
  const seenCollision = new Set<number>();
  /** Prop obstacles are named `<id>-box` and bound one mesh. Wall runs are not. */
  const meshObstacleIds = new Set<number>();
  pushCollision(sceneArray(scene, "collision", "scene.collision", issues), (index) => `scene.collision[${index}]`, issues, seenCollision, collisionBoxes);

  const propEntries: Array<{ item: unknown; path: string }> = [];
  sceneArray(scene, "props", "scene.props", issues).forEach((item, index) => {
    propEntries.push({ item, path: `scene.props[${index}]` });
  });
  const spawnEntries: Array<{ item: unknown; path: string }> = [];
  spawnList(scene, sources, issues).forEach((item, index) => {
    spawnEntries.push({ item, path: `scene.spawnPoints[${index}]` });
  });

  const bakedBuildings: ArenaView["buildings"] = [];
  const bakedDoors: ArenaView["doors"] = [];
  const { refs: placementRefs, issues: placementIssues } = placementRefsOf(scene);
  for (const issue of placementIssues) issues.push(issue);
  const providedFiles = sources?.placementFiles ?? [];
  const knownModels = new Set([...assets.values()].filter((asset) => asset.kind === "model").map((asset) => asset.id));
  const seenObstacleIds = new Set<string>();
  const seenBuildingIds = new Set<string>();
  placementRefs.forEach((ref, index) => {
    const source = providedFiles[index];
    if (!source || source.path !== ref.file) {
      issues.push({ path: ref.path, message: "file was not loaded" });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(source.text);
    } catch (err) {
      issues.push({ path: ref.path, message: `invalid json: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }
    const partial = partialScene(parsed, ref.file, issues);
    if (partial.collision) pushCollision(partial.collision, (entry) => `${ref.file} scene.collision[${entry}]`, issues, seenCollision, collisionBoxes);
    partial.spawns?.forEach((item, entry) => spawnEntries.push({ item, path: `${ref.file} scene.spawnPoints[${entry}]` }));
    partial.props?.forEach((item, entry) => propEntries.push({ item, path: `${ref.file} scene.props[${entry}]` }));

    const used = new Set<number>([...collisionBoxes.map((box) => box.id), ...WALL_IDS]);
    const baked = interpretPlacements(parsed, knownModels, used);
    let fileOk = baked.issues.length === 0;
    for (const issue of baked.issues) issues.push({ path: `${ref.file} ${issue.path}`, message: issue.message });
    const localObstacles = new Set<string>();
    for (const box of baked.boxes) {
      if (localObstacles.has(box.sourceId)) continue;
      localObstacles.add(box.sourceId);
      if (seenObstacleIds.has(box.sourceId)) {
        issues.push({ path: ref.path, message: `duplicate obstacle id ${box.sourceId} in ${ref.file}` });
        fileOk = false;
      }
      seenObstacleIds.add(box.sourceId);
    }
    const localBuildings = new Set<string>();
    for (const building of baked.buildings) {
      if (localBuildings.has(building.id)) continue;
      localBuildings.add(building.id);
      if (seenBuildingIds.has(building.id)) {
        issues.push({ path: ref.path, message: `duplicate placement id ${building.id} in ${ref.file}` });
        fileOk = false;
      }
      seenBuildingIds.add(building.id);
    }
    for (const door of baked.doors) {
      if (localBuildings.has(door.id)) continue;
      localBuildings.add(door.id);
      if (seenBuildingIds.has(door.id)) {
        issues.push({ path: ref.path, message: `duplicate placement id ${door.id} in ${ref.file}` });
        fileOk = false;
      }
      seenBuildingIds.add(door.id);
    }
    if (!fileOk) return;
    for (const building of baked.buildings) {
      const asset = assets.get(building.model);
      if (!asset) continue;
      bakedBuildings.push({
        id: building.id,
        model: asset.uri,
        position: building.position,
        yaw: building.yaw,
        scale: building.scale,
      });
    }
    for (const door of baked.doors) {
      const asset = assets.get(door.model);
      if (!asset || asset.kind !== "model") continue;
      bakedDoors.push({
        id: door.id,
        model: asset.uri,
        position: door.position,
        yaw: door.yaw,
        hinge: door.hinge,
        size: door.size,
        open: door.open,
      });
    }
    for (const box of baked.boxes) {
      seenCollision.add(box.id);
      collisionBoxes.push({
        id: box.id,
        minX: box.minX, maxX: box.maxX,
        minY: box.minY, maxY: box.maxY,
        minZ: box.minZ, maxZ: box.maxZ,
      });
      if (box.sourceId.endsWith("-box")) meshObstacleIds.add(box.id);
    }
  });

  const props: ArenaView["props"] = [];
  const seenProps = new Set<string>();
  for (const entry of propEntries) {
    const { item, path } = entry;
    if (!isObject(item)) {
      issues.push({ path, message: "must be an object" });
      continue;
    }
    const id = str(item.id, `${path}.id`, issues);
    const model = str(item.model, `${path}.model`, issues);
    const collisionId = num(item.collision, `${path}.collision`, issues);
    if (id && seenProps.has(id)) issues.push({ path: `${path}.id`, message: `duplicate id ${id}` });
    if (id) seenProps.add(id);
    refAsset(model, `${path}.model`, "model");
    const box = collisionBoxes.find((candidate) => candidate.id === collisionId);
    if (collisionId !== undefined && !box) issues.push({ path: `${path}.collision`, message: `unknown collision ${collisionId}` });
    if (id && model && box) {
      const asset = assets.get(model);
      props.push({
        id,
        model: asset?.uri ?? "",
        minX: box.minX, maxX: box.maxX, minY: box.minY, maxY: box.maxY, minZ: box.minZ, maxZ: box.maxZ,
      });
    }
  }

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
  for (const entry of spawnEntries) {
    const { item, path } = entry;
    if (!isObject(item)) {
      issues.push({ path, message: "must be an object" });
      continue;
    }
    const id = str(item.id, `${path}.id`, issues);
    const x = num(item.x, `${path}.x`, issues);
    const y = num(item.y, `${path}.y`, issues);
    const z = num(item.z, `${path}.z`, issues);
    const yaw = num(item.yaw, `${path}.yaw`, issues);
    if (id && seenSpawns.has(id)) issues.push({ path: `${path}.id`, message: `duplicate id ${id}` });
    if (id) seenSpawns.add(id);
    if (id && x !== undefined && y !== undefined && z !== undefined && yaw !== undefined) spawns.push({ id, x, y, z, yaw });
  }

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

  const facesReady = !walls || faceOrder.every((face) => {
    const placed = facePlacements[face];
    return !!placed && assets.get(placed.model)?.kind === "model";
  });
  if (issues.length || !facesReady || !bundleId || !bundleVersion || !worldVersion || minX === undefined || maxX === undefined || minY === undefined || maxY === undefined || minZ === undefined || maxZ === undefined || pawnRadius === undefined || pawnHeight === undefined) {
    throw new GameManifestError(issues.length ? issues : [{ path: "$", message: "manifest is incomplete" }]);
  }

  const bounds = { minX, maxX, minY, maxY, minZ, maxZ };
  const wallBoxes = walls && wallHeight !== undefined && wallThickness !== undefined && facesReady
    ? [
      { id: 10, face: "west" as const, minX, maxX: minX + wallThickness, minZ, maxZ, minY: 0, maxY: wallHeight },
      { id: 11, face: "east" as const, minX: maxX - wallThickness, maxX, minZ, maxZ, minY: 0, maxY: wallHeight },
      { id: 12, face: "south" as const, minX, maxX, minZ, maxZ: minZ + wallThickness, minY: 0, maxY: wallHeight },
      { id: 13, face: "north" as const, minX, maxX, minZ: maxZ - wallThickness, maxZ, minY: 0, maxY: wallHeight },
    ]
    : [];
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
    resolved = resolveStaticWorld({ manifest: engineManifest, collision, profile: "minimal" });
  } catch (err) {
    const messages = (err as { issues?: string[] }).issues ?? [err instanceof Error ? err.message : "static world rejected"];
    throw new GameManifestError(messages.map((message) => ({ path: "scene", message })));
  }

  const floorTexture = floorMaterial ? assets.get(floorMaterial)?.uri : undefined;
  const skyAsset = skyMaterial ? assets.get(skyMaterial) : undefined;
  const cityAsset = cityscapeMaterial ? assets.get(cityscapeMaterial) : undefined;
  const view: ArenaView = {
    bundleId,
    bundleVersion,
    authoritativeHash: resolved.hash,
    presentationHash,
    collisionContentHash: collisionHash,
    world: worldVersion,
    bounds,
    ...(floorY !== undefined && floorTexture ? { floor: { y: floorY, texture: floorTexture } } : {}),
    walls: wallBoxes.map((wall) => {
      const placed = facePlacements[wall.face]!;
      const asset = assets.get(placed.model)!;
      return {
        face: wall.face,
        minX: wall.minX,
        maxX: wall.maxX,
        minZ: wall.minZ,
        maxZ: wall.maxZ,
        height: wall.maxY,
        model: asset.uri,
        ...(placed.position ? { position: placed.position } : {}),
        ...(placed.yaw === undefined ? {} : { yaw: placed.yaw }),
        scale: placed.scale ?? asset.scale ?? 1,
      };
    }),
    buildings: bakedBuildings,
    doors: bakedDoors,
    ...(skyAsset?.uri && skyAsset.shape && skyAsset.radius && skyAsset.height
      ? { sky: { kind: "sky-dome" as const, texture: skyAsset.uri, shape: skyAsset.shape, radius: skyAsset.radius, height: skyAsset.height } }
      : {}),
    ...(cityAsset?.uri && cityAsset.shape && cityAsset.radius && cityAsset.height
      ? { cityscape: { texture: cityAsset.uri, shape: cityAsset.shape, radius: cityAsset.radius, height: cityAsset.height } }
      : {}),
    ...(shadowQuality ? { shadows: { quality: shadowQuality } } : {}),
    props,
    characters,
    staticModels: [...assets.values()]
      .filter((asset) => asset.kind === "model" && asset.instance === "static")
      .map((asset) => asset.uri)
      .sort((a, b) => a.localeCompare(b)),
    aabbs: resolved.definition.aabbs.map((box) => ({
      id: box.id,
      minX: box.minX,
      maxX: box.maxX,
      minZ: box.minZ,
      maxZ: box.maxZ,
      ...(typeof box.minY === "number" && typeof box.maxY === "number" ? { minY: box.minY, maxY: box.maxY } : {}),
      ...(meshObstacleIds.has(box.id) ? { mesh: true as const } : {}),
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
