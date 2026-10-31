import {
  DEFAULT_CAPABILITIES,
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
import { attachBuildingProfiles } from "../shared/building-profile.js";
import type { ArenaElevator, ArenaView, CharacterAnimation } from "../shared/arena-view.js";
import { DEFAULT_MOVEMENT_SPEED, MOVEMENTS, type Movement } from "../shared/movements.js";
import { AMMO_PICKUP, HEALTH_PICKUP, parsePickupKind, type PickupPlacement } from "../shared/pickups.js";
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
  animation?: string | undefined;
  animations?: Record<Movement, CharacterAnimation>;
  /** `"static"` placements share one InstancedMesh per source mesh. Omitted means clone. */
  instance?: "static";
  /** Asset `type`, such as `"character"`. Omitted when the asset has none. */
  assetType?: string;
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

/** Same clearance rule as the kernel spawn check. A span above the head, or below the feet, is free. */
function spawnHitsBox(
  spawn: { x: number; y: number; z: number },
  radius: number,
  height: number,
  box: { minX: number; maxX: number; minZ: number; maxZ: number; minY?: number; maxY?: number },
): boolean {
  if (box.minY !== undefined && box.maxY !== undefined) {
    const head = spawn.y + height;
    if (spawn.y >= box.maxY || head <= box.minY) return false;
  }
  return spawn.x + radius > box.minX && spawn.x - radius < box.maxX
    && spawn.z + radius > box.minZ && spawn.z - radius < box.maxZ;
}

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
    const rate = parseClipRate(value, field, issues);
    if (!rate) {
      ok = false;
      continue;
    }
    out[movement] = { clip, speed, ...rate };
  }
  return ok ? out : undefined;
}

/** Optional client playback fields. Absent fields stay absent. `undefined` on an issue. */
function parseClipRate(
  value: Record<string, unknown>,
  field: string,
  issues: GameIssue[],
): { referenceSpeed?: number; minTimeScale?: number; maxTimeScale?: number } | undefined {
  const out: { referenceSpeed?: number; minTimeScale?: number; maxTimeScale?: number } = {};
  for (const key of ["referenceSpeed", "minTimeScale", "maxTimeScale"] as const) {
    const raw = value[key];
    if (raw === undefined) continue;
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
      issues.push({ path: `${field}.${key}`, message: "must be a finite number > 0" });
      return undefined;
    }
    out[key] = raw;
  }
  if (out.minTimeScale !== undefined && out.maxTimeScale !== undefined && out.minTimeScale > out.maxTimeScale) {
    issues.push({ path: `${field}.minTimeScale`, message: "must be <= maxTimeScale" });
    return undefined;
  }
  return out;
}

/** Only `"static"` is instanced. Anything else is a manifest error, not a silent clone. */
function parseInstance(value: unknown, path: string, issues: GameIssue[]): "static" | undefined {
  if (value === undefined) return undefined;
  if (value === "static") return "static";
  issues.push({ path, message: "must be static" });
  return undefined;
}

/** Asset field `animation` names a key in `animations`, such as `"idle"`. The clip is that entry's `clip`. */
function optionalAnimation(
  value: unknown,
  path: string,
  animations: Record<Movement, CharacterAnimation> | undefined,
  issues: GameIssue[],
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value) {
    issues.push({ path, message: "required string" });
    return undefined;
  }
  if (!(MOVEMENTS as readonly string[]).includes(value) || !animations?.[value as Movement]?.clip) {
    issues.push({ path, message: `unknown animation ${value}` });
    return undefined;
  }
  return value;
}

function takePickupAmount(value: unknown, path: string, issues: GameIssue[], fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    issues.push({ path, message: "must be > 0" });
    return fallback;
  }
  return value;
}

/**
 * Scale other than 1 is a prop. A clip is a prop at scale 1 too, so the client
 * can play it. Type is not consulted. A crate with no clip stays a building.
 */
function drawsAsProp(asset: AssetRec): boolean {
  if (asset.kind !== "model") return false;
  if ((asset.scale ?? 1) !== 1) return true;
  return typeof asset.animation === "string" && asset.animation.length > 0;
}

function logBuiltProp(id: string, model: string, item: Record<string, unknown>): void {
  const type = typeof item.type === "string" ? item.type : "";
  console.log(`prop ${id} model=${model} type=${type}`);
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
  /** Set when `scene.playerSpawnPoints` is a path. The text is the human pad array. */
  playerSpawnPointsFile?: PlacementFileSource;
  /**
   * Set when `scene.lights` is a path. The text is a lights object or a lights array.
   * Presentation hash only. Absent lights compile to `[]`.
   */
  lightsFile?: PlacementFileSource;
  /**
   * Set when `scene.elevators` is a path. The text is an elevators object.
   * Not part of either content hash. An empty list is omitted from the view.
   */
  elevatorsFile?: PlacementFileSource;
  /**
   * `web/game/building-profiles.json`. Outlines for the scene map.
   * Absent when that file was not loaded. Not part of either content hash.
   */
  buildingProfiles?: string;
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
  field: "spawnPoints" | "playerSpawnPoints",
  file: PlacementFileSource | undefined,
  issues: GameIssue[],
): unknown[] {
  const issuePath = `scene.${field}`;
  if (!scene || !Object.prototype.hasOwnProperty.call(scene, field)) return [];
  const value = scene[field];
  if (typeof value === "string") {
    if (!value.trim()) {
      issues.push({ path: issuePath, message: "must be an array or a path" });
      return [];
    }
    if (!file || file.path !== value) {
      issues.push({ path: issuePath, message: "file was not loaded" });
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(file.text);
    } catch (err) {
      issues.push({ path: issuePath, message: `invalid json: ${err instanceof Error ? err.message : String(err)}` });
      return [];
    }
    if (!Array.isArray(parsed)) {
      issues.push({ path: issuePath, message: "must be an array" });
      return [];
    }
    return parsed;
  }
  if (Array.isArray(value)) return value;
  issues.push({ path: issuePath, message: "must be an array or a path" });
  return [];
}

const MAX_LIGHTS = 32;
const LIGHT_COLOR = /^#[0-9a-fA-F]{6}$/;

/**
 * `scene.lights` is an array, or a path to a rooms.lights.json object (or a bare array).
 * Absent is `[]`. Each failure names the light id.
 */
function sceneLights(
  scene: Record<string, unknown> | undefined,
  sources: CompileSources | undefined,
  issues: GameIssue[],
): ArenaView["lights"] {
  if (!scene || !Object.prototype.hasOwnProperty.call(scene, "lights")) return [];
  const value = scene.lights;
  let items: unknown[] | undefined;
  if (typeof value === "string") {
    if (!value.trim()) {
      issues.push({ path: "scene.lights", message: "must be an array or a path" });
      return [];
    }
    const file = sources?.lightsFile;
    if (!file || file.path !== value) {
      issues.push({ path: "scene.lights", message: "file was not loaded" });
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(file.text);
    } catch (err) {
      issues.push({ path: "scene.lights", message: `invalid json: ${err instanceof Error ? err.message : String(err)}` });
      return [];
    }
    items = lightItems(parsed, "scene.lights", issues);
  } else if (Array.isArray(value)) {
    items = value;
  } else {
    issues.push({ path: "scene.lights", message: "must be an array or a path" });
    return [];
  }
  if (!items) return [];
  if (items.length > MAX_LIGHTS) {
    const extra = items[MAX_LIGHTS];
    const id = isObject(extra) && typeof extra.id === "string" && extra.id ? extra.id : String(MAX_LIGHTS);
    issues.push({ path: `scene.lights.${id}`, message: "at most 32 lights" });
  }
  const lights: ArenaView["lights"] = [];
  items.forEach((item, index) => {
    const light = parseLight(item, index, issues);
    if (light) lights.push(light);
  });
  return lights;
}

/**
 * `scene.elevators` is an array, or a path to an elevators.json object.
 * Absent is `[]`, and the view omits the key when the list stays empty.
 * Each failure names the elevator id.
 */
function sceneElevators(
  scene: Record<string, unknown> | undefined,
  sources: CompileSources | undefined,
  issues: GameIssue[],
): ArenaElevator[] {
  if (!scene || !Object.prototype.hasOwnProperty.call(scene, "elevators")) return [];
  const value = scene.elevators;
  let items: unknown[] | undefined;
  if (typeof value === "string") {
    if (!value.trim()) {
      issues.push({ path: "scene.elevators", message: "must be an array or a path" });
      return [];
    }
    const file = sources?.elevatorsFile;
    if (!file || file.path !== value) {
      issues.push({ path: "scene.elevators", message: "file was not loaded" });
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(file.text);
    } catch (err) {
      issues.push({ path: "scene.elevators", message: `invalid json: ${err instanceof Error ? err.message : String(err)}` });
      return [];
    }
    items = elevatorItems(parsed, "scene.elevators", issues);
  } else if (Array.isArray(value)) {
    items = value;
  } else {
    issues.push({ path: "scene.elevators", message: "must be an array or a path" });
    return [];
  }
  if (!items) return [];
  const elevators: ArenaElevator[] = [];
  items.forEach((item, index) => {
    const row = parseElevator(item, index, issues);
    if (row) elevators.push(row);
  });
  return elevators;
}

function elevatorItems(parsed: unknown, issuePath: string, issues: GameIssue[]): unknown[] | undefined {
  if (Array.isArray(parsed)) return parsed;
  if (!isObject(parsed)) {
    issues.push({ path: issuePath, message: "must be an object" });
    return undefined;
  }
  if (parsed.formatVersion !== undefined && parsed.formatVersion !== 1) {
    issues.push({ path: `${issuePath}.formatVersion`, message: "must be 1" });
  }
  if (parsed.units !== undefined && parsed.units !== "meters") {
    issues.push({ path: `${issuePath}.units`, message: "must be meters" });
  }
  if (!Array.isArray(parsed.elevators)) {
    issues.push({ path: `${issuePath}.elevators`, message: "required array" });
    return undefined;
  }
  return parsed.elevators;
}

function parseElevator(value: unknown, index: number, issues: GameIssue[]): ArenaElevator | undefined {
  const id = isObject(value) && typeof value.id === "string" && value.id ? value.id : undefined;
  const path = id ? `scene.elevators.${id}` : `scene.elevators[${index}]`;
  if (!isObject(value)) {
    issues.push({ path, message: "must be an object" });
    return undefined;
  }
  if (!id) issues.push({ path: `${path}.id`, message: "required string" });
  const stops = numList(value.stops, `${path}.stops`, issues);
  const speed = num(value.speed, `${path}.speed`, issues);
  const waitS = num(value.waitS, `${path}.waitS`, issues);
  const polygon = pairList(value.polygon, `${path}.polygon`, issues);
  const landings = tripleList(value.landings, `${path}.landings`, issues);
  let ok = id !== undefined && stops !== undefined && polygon !== undefined && landings !== undefined && speed !== undefined && waitS !== undefined;
  if (stops && stops.length < 2) {
    issues.push({ path: `${path}.stops`, message: "needs at least two stops" });
    ok = false;
  } else if (stops) {
    for (let i = 1; i < stops.length; i += 1) {
      if (!(stops[i]! > stops[i - 1]!)) {
        issues.push({ path: `${path}.stops`, message: "stops must increase" });
        ok = false;
        break;
      }
    }
  }
  if (speed !== undefined && !(speed > 0)) {
    issues.push({ path: `${path}.speed`, message: "must be > 0" });
    ok = false;
  }
  if (waitS !== undefined && waitS < 0) {
    issues.push({ path: `${path}.waitS`, message: "must be >= 0" });
    ok = false;
  }
  if (polygon && polygon.length < 3) {
    issues.push({ path: `${path}.polygon`, message: "needs at least three points" });
    ok = false;
  }
  if (stops && landings && landings.length !== stops.length) {
    issues.push({ path: `${path}.landings`, message: "must match stops" });
    ok = false;
  }
  if (!ok || !id || !stops || !polygon || !landings || speed === undefined || waitS === undefined) return undefined;
  return { id, stops, speed, waitS, polygon, landings };
}

function numList(value: unknown, path: string, issues: GameIssue[]): number[] | undefined {
  if (!Array.isArray(value)) {
    issues.push({ path, message: "required array" });
    return undefined;
  }
  const out: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = num(value[index], `${path}[${index}]`, issues);
    if (item === undefined) return undefined;
    out.push(item);
  }
  return out;
}

function pairList(value: unknown, path: string, issues: GameIssue[]): Array<[number, number]> | undefined {
  if (!Array.isArray(value)) {
    issues.push({ path, message: "required array" });
    return undefined;
  }
  const out: Array<[number, number]> = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    const at = `${path}[${index}]`;
    if (!Array.isArray(item) || item.length !== 2) {
      issues.push({ path: at, message: "must be [x,z]" });
      return undefined;
    }
    const x = num(item[0], `${at}[0]`, issues);
    const z = num(item[1], `${at}[1]`, issues);
    if (x === undefined || z === undefined) return undefined;
    out.push([x, z]);
  }
  return out;
}

function tripleList(value: unknown, path: string, issues: GameIssue[]): Array<[number, number, number]> | undefined {
  if (!Array.isArray(value)) {
    issues.push({ path, message: "required array" });
    return undefined;
  }
  const out: Array<[number, number, number]> = [];
  for (let index = 0; index < value.length; index += 1) {
    const point = vec3(value[index], `${path}[${index}]`, issues);
    if (!point) return undefined;
    out.push(point);
  }
  return out;
}

function lightItems(parsed: unknown, issuePath: string, issues: GameIssue[]): unknown[] | undefined {
  if (Array.isArray(parsed)) return parsed;
  if (!isObject(parsed)) {
    issues.push({ path: issuePath, message: "must be an object" });
    return undefined;
  }
  if (parsed.formatVersion !== undefined && parsed.formatVersion !== 1) {
    issues.push({ path: `${issuePath}.formatVersion`, message: "must be 1" });
  }
  if (parsed.units !== undefined && parsed.units !== "meters") {
    issues.push({ path: `${issuePath}.units`, message: "must be meters" });
  }
  if (!Array.isArray(parsed.lights)) {
    issues.push({ path: `${issuePath}.lights`, message: "required array" });
    return undefined;
  }
  return parsed.lights;
}

function parseLight(value: unknown, index: number, issues: GameIssue[]): ArenaView["lights"][number] | undefined {
  const id = isObject(value) && typeof value.id === "string" && value.id ? value.id : undefined;
  const path = id ? `scene.lights.${id}` : `scene.lights[${index}]`;
  if (!isObject(value)) {
    issues.push({ path, message: "must be an object" });
    return undefined;
  }
  if (!id) issues.push({ path: `${path}.id`, message: "required string" });
  const position = vec3(value.position, `${path}.position`, issues);
  const color = str(value.color, `${path}.color`, issues);
  if (color && !LIGHT_COLOR.test(color)) issues.push({ path: `${path}.color`, message: "must be #rrggbb" });
  const intensity = num(value.intensity, `${path}.intensity`, issues);
  if (intensity !== undefined && intensity <= 0) issues.push({ path: `${path}.intensity`, message: "must be > 0" });
  const type = value.type === "point" || value.type === "rect" ? value.type : undefined;
  if (!type) issues.push({ path: `${path}.type`, message: "must be point or rect" });
  const yawGiven = value.yaw !== undefined || type === "rect";
  const yaw = yawGiven ? cardinalYaw(value.yaw, `${path}.yaw`, issues) : undefined;
  let width: number | undefined;
  let height: number | undefined;
  if (type === "rect") {
    width = num(value.width, `${path}.width`, issues);
    height = num(value.height, `${path}.height`, issues);
    if (width !== undefined && width <= 0) issues.push({ path: `${path}.width`, message: "must be > 0" });
    if (height !== undefined && height <= 0) issues.push({ path: `${path}.height`, message: "must be > 0" });
  }
  let range: number | undefined;
  if (value.range !== undefined) {
    range = num(value.range, `${path}.range`, issues);
    if (range !== undefined && range < 0) issues.push({ path: `${path}.range`, message: "must be >= 0" });
  }
  const colorOk = !!color && LIGHT_COLOR.test(color);
  const intensityOk = intensity !== undefined && intensity > 0;
  const yawOk = !yawGiven || yaw !== undefined;
  const sizeOk = type !== "rect" || (width !== undefined && width > 0 && height !== undefined && height > 0);
  const rangeOk = value.range === undefined || (range !== undefined && range >= 0);
  if (!id || !position || !type || !colorOk || !intensityOk || !yawOk || !sizeOk || !rangeOk) return undefined;
  return {
    id,
    type,
    position,
    color,
    intensity,
    ...(type === "rect" ? { yaw: yaw!, width: width!, height: height! } : {}),
    ...(range !== undefined && range >= 0 ? { range } : {}),
  };
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
      const animation = kind === "model" ? optionalAnimation(item.animation, `${path}.animation`, animations, issues) : undefined;
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
      const assetType = typeof item.type === "string" ? item.type : undefined;
      if (id && kind && uri && mediaType && licenseId && origin) {
        assets.set(id, { id, kind, uri, mediaType, licenseId, origin, notes, scale, shape, radius, height, animation, animations, instance, assetType });
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
  const boxBySource = new Map<string, CollisionBox>();
  const seenCollision = new Set<number>();
  /** Prop obstacles are named `<id>-box` and bound one mesh. Wall runs are not. */
  const meshObstacleIds = new Set<number>();
  pushCollision(sceneArray(scene, "collision", "scene.collision", issues), (index) => `scene.collision[${index}]`, issues, seenCollision, collisionBoxes);

  const propEntries: Array<{ item: unknown; path: string }> = [];
  sceneArray(scene, "props", "scene.props", issues).forEach((item, index) => {
    propEntries.push({ item, path: `scene.props[${index}]` });
  });
  const spawnEntries: Array<{ item: unknown; path: string }> = [];
  spawnList(scene, "spawnPoints", sources?.spawnPointsFile, issues).forEach((item, index) => {
    spawnEntries.push({ item, path: `scene.spawnPoints[${index}]` });
  });
  const playerSpawnEntries: Array<{ item: unknown; path: string }> = [];
  spawnList(scene, "playerSpawnPoints", sources?.playerSpawnPointsFile, issues).forEach((item, index) => {
    playerSpawnEntries.push({ item, path: `scene.playerSpawnPoints[${index}]` });
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
    if (isObject(parsed)) {
      if (Array.isArray(parsed.placements)) {
        parsed.placements.forEach((item, entry) => {
          propEntries.push({ item, path: `${ref.file} placements[${entry}]` });
        });
      }
      // Bake obstacles use string ids and are numbered by interpretPlacements.
      // Numeric ids are scene-collision boxes and go through the same checker.
      if (Array.isArray(parsed.obstacles)) {
        pushCollision(
          parsed.obstacles.filter((item) => isObject(item) && typeof item.id === "number"),
          (entry) => `${ref.file} obstacles[${entry}]`,
          issues,
          seenCollision,
          collisionBoxes,
        );
      }
      if (Array.isArray(parsed.spawnPoints)) {
        parsed.spawnPoints.forEach((item, entry) => {
          spawnEntries.push({ item, path: `${ref.file} spawnPoints[${entry}]` });
        });
      }
      if (isObject(parsed.scene)) {
        const partial = partialScene(parsed, ref.file, issues);
        if (partial.collision) pushCollision(partial.collision, (entry) => `${ref.file} scene.collision[${entry}]`, issues, seenCollision, collisionBoxes);
        partial.spawns?.forEach((item, entry) => spawnEntries.push({ item, path: `${ref.file} scene.spawnPoints[${entry}]` }));
        partial.props?.forEach((item, entry) => propEntries.push({ item, path: `${ref.file} scene.props[${entry}]` }));
      }
    }

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
      if (!asset || drawsAsProp(asset)) continue;
      bakedBuildings.push({
        id: building.id,
        model: asset.uri,
        position: building.position,
        yaw: building.yaw,
        scale: building.scale,
      });
    }
    // A rooms file leaf has no exterior twin. A lock copied from the door
    // asset would ignore KeyE. Keyed locks stay on doors.placements.json.
    const roomLeaf = ref.file.endsWith("rooms.placements.json");
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
        ...(!roomLeaf && door.locked ? { locked: true } : {}),
        ...(!roomLeaf && door.key ? { key: door.key } : {}),
      });
    }
    for (const box of baked.boxes) {
      seenCollision.add(box.id);
      const stored: CollisionBox = {
        id: box.id,
        minX: box.minX, maxX: box.maxX,
        minY: box.minY, maxY: box.maxY,
        minZ: box.minZ, maxZ: box.maxZ,
      };
      collisionBoxes.push(stored);
      boxBySource.set(box.sourceId, stored);
      if (box.sourceId.endsWith("-box")) meshObstacleIds.add(box.id);
    }
  });

  const props: ArenaView["props"] = [];
  const seenProps = new Set<string>();
  /** Same model, pose, and placement scale: the later stamp replaces the earlier one. */
  const placementPropAt = new Map<string, number>();
  /**
   * Placement files have no collision id. Scale 1 with no clip stays a building.
   * An animation is a prop at any scale, so a key is not dropped for failing a weapon scale.
   * Placement type is not a render filter. crate and key both draw.
   * type "key" is a pickup. The pawn who walks into it holds that placement id.
   */
  const pushPlacementProp = (item: Record<string, unknown>, path: string): void => {
    if (Object.prototype.hasOwnProperty.call(item, "hinge")) return;
    const modelId = typeof item.model === "string" ? item.model : undefined;
    const asset = modelId ? assets.get(modelId) : undefined;
    if (!asset || !drawsAsProp(asset)) return;
    const id = str(item.id, `${path}.id`, issues);
    const model = str(item.model, `${path}.model`, issues);
    const position = vec3(item.position, `${path}.position`, issues);
    const yaw = cardinalYaw(item.yaw, `${path}.yaw`, issues);
    const placementScale = modelScale(item.scale, `${path}.scale`, issues);
    if (!id || !model || !position || yaw === undefined) return;
    refAsset(model, `${path}.model`, "model");
    logBuiltProp(id, model, item);
    const bounds = boxBySource.get(`${id}-box`);
    const [x, y, z] = position;
    const next: ArenaView["props"][number] = {
      id,
      idNum: 0,
      model: asset.uri,
      minX: bounds?.minX ?? x,
      maxX: bounds?.maxX ?? x,
      minY: bounds?.minY ?? y,
      maxY: bounds?.maxY ?? y,
      minZ: bounds?.minZ ?? z,
      maxZ: bounds?.maxZ ?? z,
      animation: asset.animation,
      ...(asset.animation && asset.animations ? { animations: asset.animations } : {}),
      position,
      yaw,
      scale: (asset.scale ?? 1) * placementScale,
    };
    const stamp = `${model}\0${position.join("\0")}\0${yaw}\0${placementScale}`;
    const prior = placementPropAt.get(stamp);
    if (prior !== undefined) {
      const previous = props[prior];
      if (previous) seenProps.delete(previous.id);
      if (seenProps.has(id)) issues.push({ path: `${path}.id`, message: `duplicate id ${id}` });
      seenProps.add(id);
      props[prior] = next;
      return;
    }
    if (seenProps.has(id)) issues.push({ path: `${path}.id`, message: `duplicate id ${id}` });
    seenProps.add(id);
    placementPropAt.set(stamp, props.length);
    props.push(next);
  };
  for (const entry of propEntries) {
    const { item, path } = entry;
    if (!isObject(item)) {
      issues.push({ path, message: "must be an object" });
      continue;
    }
    if (Array.isArray(item.position)) {
      pushPlacementProp(item, path);
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
      logBuiltProp(id, model, item);
      props.push({
        id,
        idNum: 0,
        model: asset?.uri ?? "",
        minX: box.minX, maxX: box.maxX, minY: box.minY, maxY: box.maxY, minZ: box.minZ, maxZ: box.maxZ,
        animation: asset?.animation,
        ...(asset?.animation && asset.animations ? { animations: asset.animations } : {}),
      });
    }
  }

  const pickups: PickupPlacement[] = [];
  const seenPickups = new Set<string>();
  for (const entry of propEntries) {
    const { item, path } = entry;
    if (!isObject(item) || Object.prototype.hasOwnProperty.call(item, "hinge")) continue;
    // Type is copied from the asset. crate, door, building, and character stay.
    // A leftover placement kind is not a pickup.
    const kind = parsePickupKind(item.type);
    if (!kind) continue;
    const id = typeof item.id === "string" ? item.id : undefined;
    const modelId = typeof item.model === "string" ? item.model : undefined;
    if (!id || !modelId) continue;
    if (seenPickups.has(id)) {
      issues.push({ path: `${path}.id`, message: `duplicate pickup ${id}` });
      continue;
    }
    const asset = assets.get(modelId);
    if (!asset || asset.kind !== "model") continue;
    const named = boxBySource.get(`${id}-box`);
    const collisionId = typeof item.collision === "number" ? item.collision : undefined;
    const box = named ?? (collisionId === undefined ? undefined : collisionBoxes.find((candidate) => candidate.id === collisionId));
    if (!box || (box.maxX <= box.minX && box.maxY <= box.minY && box.maxZ <= box.minZ)) {
      issues.push({ path: `${path}.type`, message: "pickup needs an aabb" });
      continue;
    }
    const amount = kind === "weapon" || kind === "key" ? 0 : takePickupAmount(item.amount, `${path}.amount`, issues, kind === "health" ? HEALTH_PICKUP : AMMO_PICKUP);
    const weapon = kind === "weapon" ? modelId : undefined;
    seenPickups.add(id);
    pickups.push({
      id,
      kind,
      model: asset.uri,
      ...(weapon ? { weapon } : {}),
      amount,
      minX: box.minX,
      maxX: box.maxX,
      minY: box.minY,
      maxY: box.maxY,
      minZ: box.minZ,
      maxZ: box.maxZ,
    });
    const drawn = props.find((prop) => prop.id === id);
    if (drawn) {
      drawn.type = kind;
      if (weapon) drawn.weapon = weapon;
    }
  }

  const player = isObject(doc.player) ? doc.player : undefined;
  if (!player) issues.push({ path: "player", message: "required object" });
  const pawnRadius = player ? num(player.radius, "player.radius", issues) : undefined;
  const pawnHeight = player ? num(player.height, "player.height", issues) : undefined;
  if (pawnRadius !== undefined && pawnRadius <= 0) issues.push({ path: "player.radius", message: "must be > 0" });
  const characters: ArenaView["characters"] = [];
  const takeCharacters = (raw: unknown, path: string, min: number | undefined): string[] => {
    if (raw === undefined) {
      if (min !== undefined) issues.push({ path, message: `at least ${min} model ids are required` });
      return [];
    }
    if (!Array.isArray(raw)) {
      issues.push({ path, message: "must be an array of model ids" });
      return [];
    }
    if (min !== undefined && raw.length < min) issues.push({ path, message: `at least ${min} model ids are required` });
    const ids: string[] = [];
    raw.forEach((choice, index) => {
      const id = str(choice, `${path}[${index}]`, issues);
      refAsset(id, `${path}[${index}]`, "model");
      const asset = id ? assets.get(id) : undefined;
      if (!id || !asset || asset.kind !== "model") return;
      if (asset.assetType !== "character") {
        issues.push({ path: `${path}[${index}]`, message: "must be a character" });
        return;
      }
      if (!asset.animations) {
        issues.push({ path: `${path}[${index}]`, message: "animations for idle, walk, run, fall, and angry are required" });
        return;
      }
      ids.push(id);
      if (!characters.some((character) => character.id === id)) {
        characters.push({ id, model: asset.uri, scale: asset.scale ?? 1, animations: asset.animations });
      }
    });
    return ids;
  };
  const modelChoices = takeCharacters(player?.modelChoices, "player.modelChoices", 2);
  const npcModelChoices = player && Object.prototype.hasOwnProperty.call(player, "npcModelChoices")
    ? takeCharacters(player.npcModelChoices, "player.npcModelChoices", undefined)
    : [];

  const readSpawns = (entries: Array<{ item: unknown; path: string }>, seen: Set<string>) => {
    const parsed: Array<{ id: string; x: number; y: number; z: number; yaw: number }> = [];
    for (const entry of entries) {
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
      if (id && seen.has(id)) issues.push({ path: `${path}.id`, message: `duplicate id ${id}` });
      if (id) seen.add(id);
      if (id && x !== undefined && y !== undefined && z !== undefined && yaw !== undefined) parsed.push({ id, x, y, z, yaw });
    }
    return parsed;
  };
  const seenSpawns = new Set<string>();
  const spawns = readSpawns(spawnEntries, seenSpawns);
  const playerSpawns = readSpawns(playerSpawnEntries, seenSpawns);

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
        // The client registers KTX2Loader, so KHR_texture_basisu is playable.
        // Default capabilities reject that required extension.
        const report = sniffGlb(bytes, { ...DEFAULT_CAPABILITIES, supportsKtx2: true });
        if (report.errors.length) issues.push({ path, message: report.errors.join("; ") });
      } catch (err) {
        issues.push({ path, message: err instanceof Error ? err.message : "glb decode failed" });
      }
    }
    fileBytes.set(asset.uri, bytes);
  }

  const lights = sceneLights(scene, sources, issues);
  const elevators = sceneElevators(scene, sources, issues);

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
  try {
    attachBuildingProfiles(bakedBuildings, sources?.buildingProfiles);
  } catch (err) {
    throw new GameManifestError([{ path: "building-profiles", message: err instanceof Error ? err.message : "invalid profiles" }]);
  }
  const collisionJson = JSON.stringify(collision);
  const collisionHash = hashBytes(new TextEncoder().encode(collisionJson));
  const visualHash = hashBytes(visualBytes);
  const fileHashes = [...assets.values()]
    .map((asset) => ({ id: asset.id, hash: hashBytes(fileBytes.get(asset.uri) ?? new Uint8Array()) }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const presentationHash = hashCanonicalJson({ files: fileHashes, lights });

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
  const blockedPads = playerSpawns.filter((spawn) => resolved.definition.aabbs.some((box) => spawnHitsBox(spawn, pawnRadius, pawnHeight, box)));
  if (blockedPads.length) {
    throw new GameManifestError(blockedPads.map((spawn) => ({
      path: "scene.playerSpawnPoints",
      message: `spawn ${spawn.id} intersects an obstacle`,
    })));
  }

  const sourceOf = new Map<number, string>();
  for (const [sourceId, box] of boxBySource) sourceOf.set(box.id, sourceId);
  const floorTexture = floorMaterial ? assets.get(floorMaterial)?.uri : undefined;
  const grenadeAsset = assets.get("grenade");
  const grenadeModel = grenadeAsset?.kind === "model" ? grenadeAsset.uri : undefined;
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
    pickups,
    characters,
    modelChoices,
    ...(npcModelChoices.length > 0 ? { npcModelChoices } : {}),
    staticModels: [...assets.values()]
      .filter((asset) => asset.kind === "model" && asset.instance === "static")
      .map((asset) => asset.uri)
      .sort((a, b) => a.localeCompare(b)),
    aabbs: resolved.definition.aabbs.map((box) => {
      const source = sourceOf.get(box.id);
      return {
        id: box.id,
        minX: box.minX,
        maxX: box.maxX,
        minZ: box.minZ,
        maxZ: box.maxZ,
        ...(typeof box.minY === "number" && typeof box.maxY === "number" ? { minY: box.minY, maxY: box.maxY } : {}),
        ...(meshObstacleIds.has(box.id) ? { mesh: true as const } : {}),
        ...(source ? { source } : {}),
      };
    }),
    pawnRadius,
    pawnHeight,
    spawns: spawns.map((spawn) => ({ id: spawn.id, x: spawn.x, z: spawn.z, yaw: spawn.yaw })),
    ...(playerSpawns.length > 0
      ? { playerSpawns: playerSpawns.map((spawn) => ({ id: spawn.id, x: spawn.x, z: spawn.z, yaw: spawn.yaw })) }
      : {}),
    lights,
    ...(elevators.length ? { elevators } : {}),
    ...(grenadeModel ? { grenade: grenadeModel } : {}),
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
