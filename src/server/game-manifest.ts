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
import type { ArenaCharacterBeam, ArenaElevator, ArenaExplosionSheet, ArenaSoundEffect, ArenaSoundName, ArenaSounds, ArenaView, CharacterAnimation } from "../shared/arena-view.js";
import { parseSceneGraph, type ElevatorPlace, type SceneGraph } from "../shared/scene-graph.js";
import { parseBakedRegions, type BakedRegionsFile } from "../shared/nav/regions.js";
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
  /**
   * Places and portals from `scene.sceneGraph`. Absent when that field is absent.
   * Privileged: not copied onto `view` and not part of either content hash.
   */
  sceneGraph?: SceneGraph;
  /**
   * Walkable regions from `scene.regions`. Absent when that field is absent.
   * Privileged: not copied onto `view` and not part of either content hash.
   */
  regions?: BakedRegionsFile;
};

type AssetRec = {
  id: string;
  kind: "texture" | "model" | "audio";
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
  /** Audio only. A missing file is a console warning and silence, not a manifest issue. */
  optional?: boolean;
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

const EXPLOSION_ASSET = "grenade-explosion";
const LASER_IMPACT_ASSET = "laser-impact";

/**
 * `projectile` block on the `grenade` model. Absent is not an issue: the host
 * defaults to explode-on-impact and half of max health. A present block with a
 * bad `impact` or `damage` is a manifest issue.
 */
function grenadeProjectile(docAssets: unknown, issues: GameIssue[]): { impact?: "explode" | "bounce"; damage?: number } | undefined {
  const index = Array.isArray(docAssets) ? docAssets.findIndex((item) => isObject(item) && item.id === "grenade") : -1;
  if (index < 0) return undefined;
  const path = `assets[${index}].projectile`;
  const item = (docAssets as unknown[])[index];
  if (!isObject(item) || item.projectile === undefined) return undefined;
  if (!isObject(item.projectile)) {
    issues.push({ path, message: "must be an object" });
    return undefined;
  }
  const out: { impact?: "explode" | "bounce"; damage?: number } = {};
  if (item.projectile.impact !== undefined) {
    if (item.projectile.impact !== "explode" && item.projectile.impact !== "bounce") {
      issues.push({ path: `${path}.impact`, message: "must be explode or bounce" });
    } else {
      out.impact = item.projectile.impact;
    }
  }
  if (item.projectile.damage !== undefined) {
    const damage = item.projectile.damage;
    if (typeof damage !== "number" || !Number.isFinite(damage) || damage <= 0) {
      issues.push({ path: `${path}.damage`, message: "must be a number > 0" });
    } else {
      out.damage = damage;
    }
  }
  return out;
}

/**
 * `sprite` block of the `grenade-explosion` texture asset. Bad fields are manifest issues.
 * A PNG whose size is not columns × frameWidth by rows × frameHeight is a warning only.
 */
function explosionSheet(
  docAssets: unknown,
  asset: AssetRec | undefined,
  fileBytes: ReadonlyMap<string, Uint8Array>,
  issues: GameIssue[],
): ArenaExplosionSheet | undefined {
  if (!asset) return undefined;
  const index = Array.isArray(docAssets) ? docAssets.findIndex((item) => isObject(item) && item.id === EXPLOSION_ASSET) : -1;
  const path = `assets[${index}].sprite`;
  if (asset.kind !== "texture") {
    issues.push({ path: `assets[${index}].kind`, message: `${EXPLOSION_ASSET} must be a texture` });
    return undefined;
  }
  const item = index >= 0 ? (docAssets as unknown[])[index] : undefined;
  const sprite = isObject(item) && isObject(item.sprite) ? item.sprite : undefined;
  if (!sprite) {
    issues.push({ path, message: "required sprite object" });
    return undefined;
  }
  const whole = (key: string): number | undefined => {
    const value = sprite[key];
    if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
    issues.push({ path: `${path}.${key}`, message: "must be a positive integer" });
    return undefined;
  };
  const positive = (key: string): number | undefined => {
    const value = sprite[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
    issues.push({ path: `${path}.${key}`, message: "must be > 0" });
    return undefined;
  };
  const columns = whole("columns");
  const rows = whole("rows");
  const frameCount = whole("frameCount");
  const frameWidth = whole("frameWidth");
  const frameHeight = whole("frameHeight");
  const fps = positive("fps");
  const size = positive("size");
  const blending = sprite.blending ?? "normal";
  if (blending !== "normal" && blending !== "additive") issues.push({ path: `${path}.blending`, message: "must be normal or additive" });
  if (!columns || !rows || !frameCount || !frameWidth || !frameHeight || !fps || !size) return undefined;
  if (blending !== "normal" && blending !== "additive") return undefined;
  if (frameCount > columns * rows) {
    issues.push({ path: `${path}.frameCount`, message: `more than ${columns} × ${rows} frames` });
    return undefined;
  }
  const impact = sprite.laserImpactSize;
  if (impact !== undefined && !(typeof impact === "number" && Number.isFinite(impact) && impact > 0)) {
    issues.push({ path: `${path}.laserImpactSize`, message: "must be > 0" });
    return undefined;
  }
  const png = fileBytes.get(asset.uri);
  if (png && png.length >= 24) {
    const width = ((png[16]! << 24) | (png[17]! << 16) | (png[18]! << 8) | png[19]!) >>> 0;
    const height = ((png[20]! << 24) | (png[21]! << 16) | (png[22]! << 8) | png[23]!) >>> 0;
    if (width !== columns * frameWidth || height !== rows * frameHeight) {
      console.warn(`${EXPLOSION_ASSET}: ${asset.uri} is ${width}x${height}, sprite expects ${columns * frameWidth}x${rows * frameHeight}`);
    }
  }
  return {
    texture: asset.uri, columns, rows, frameCount, frameWidth, frameHeight, fps, size, blending,
    ...(typeof impact === "number" ? { laserImpactSize: impact } : {}),
  };
}

/**
 * `sprite` block of the optional `laser-impact` texture asset. Every field is optional:
 * defaults match `grenade-explosion` (6 x 5, 30 frames, 256 x 256 px, 30 fps, `size` 0.8,
 * `blending` normal). The arena sheet is 1536x1280 (256x256 frames). The client always
 * derives frame size from the loaded image (width/columns by height/rows).
 * Optional `rotation` is degrees applied as SpriteMaterial.rotation, as on beam sheets.
 * Optional `laserImpactSize` is the world size of a laser hit in metres (absent: `size`).
 * A bad field is a manifest issue. An absent optional file leaves the sheet out; the
 * client then uses the grenade-explosion sheet.
 */
function laserImpactSheet(
  docAssets: unknown,
  asset: AssetRec | undefined,
  absent: ReadonlySet<string>,
  fileBytes: ReadonlyMap<string, Uint8Array>,
  issues: GameIssue[],
): ArenaExplosionSheet | undefined {
  if (!asset || absent.has(asset.id)) return undefined;
  const index = Array.isArray(docAssets) ? docAssets.findIndex((item) => isObject(item) && item.id === asset.id) : -1;
  const path = `assets[${index}].sprite`;
  if (asset.kind !== "texture") {
    issues.push({ path: `assets[${index}].kind`, message: `${asset.id} must be a texture` });
    return undefined;
  }
  const item = index >= 0 ? (docAssets as unknown[])[index] : undefined;
  const raw = isObject(item) ? item.sprite : undefined;
  if (raw !== undefined && !isObject(raw)) {
    issues.push({ path, message: "must be an object" });
    return undefined;
  }
  const sprite: Record<string, unknown> = raw ?? {};
  let ok = true;
  const whole = (key: string, fallback: number): number => {
    const value = sprite[key];
    if (value === undefined) return fallback;
    if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
    issues.push({ path: `${path}.${key}`, message: "must be a positive integer" });
    ok = false;
    return fallback;
  };
  const positive = (key: string, fallback: number): number => {
    const value = sprite[key];
    if (value === undefined) return fallback;
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
    issues.push({ path: `${path}.${key}`, message: "must be > 0" });
    ok = false;
    return fallback;
  };
  const columns = whole("columns", 6);
  const rows = whole("rows", 5);
  const frameCount = whole("frameCount", 30);
  const frameWidth = whole("frameWidth", 256);
  const frameHeight = whole("frameHeight", 256);
  const fps = positive("fps", 30);
  const size = positive("size", 0.8);
  const blending = sprite.blending ?? "normal";
  if (blending !== "normal" && blending !== "additive") {
    issues.push({ path: `${path}.blending`, message: "must be normal or additive" });
    ok = false;
  }
  let rotation: number | undefined;
  if (sprite.rotation !== undefined) {
    if (typeof sprite.rotation === "number" && Number.isFinite(sprite.rotation)) rotation = sprite.rotation;
    else {
      issues.push({ path: `${path}.rotation`, message: "must be a finite number of degrees" });
      ok = false;
    }
  }
  let impact: number | undefined;
  if (sprite.laserImpactSize !== undefined) {
    if (typeof sprite.laserImpactSize === "number" && Number.isFinite(sprite.laserImpactSize) && sprite.laserImpactSize > 0) {
      impact = sprite.laserImpactSize;
    } else {
      issues.push({ path: `${path}.laserImpactSize`, message: "must be > 0" });
      ok = false;
    }
  }
  if (frameCount > columns * rows) {
    issues.push({ path: `${path}.frameCount`, message: `more than ${columns} × ${rows} frames` });
    ok = false;
  }
  if (!ok || (blending !== "normal" && blending !== "additive")) return undefined;
  const png = fileBytes.get(asset.uri);
  if (png && png.length >= 24 && sprite.frameWidth !== undefined && sprite.frameHeight !== undefined) {
    const width = ((png[16]! << 24) | (png[17]! << 16) | (png[18]! << 8) | png[19]!) >>> 0;
    const height = ((png[20]! << 24) | (png[21]! << 16) | (png[22]! << 8) | png[23]!) >>> 0;
    if (width !== columns * frameWidth || height !== rows * frameHeight) {
      console.warn(`${asset.id}: ${asset.uri} is ${width}x${height}, sprite expects ${columns * frameWidth}x${rows * frameHeight}`);
    }
  }
  return {
    texture: asset.uri, columns, rows, frameCount, frameWidth, frameHeight, fps, size, blending,
    ...(typeof impact === "number" ? { laserImpactSize: impact } : {}),
    ...(rotation !== undefined ? { rotation } : {}),
  };
}

const BEAM_FADE_DEFAULT_MS = 1700;
const BEAM_DESPAWN_DELAY_DEFAULT_MS = 1200;
const BEAM_MAX_MS = 10000;
const BEAM_SHEETS = [["spawn", "beam-spawn"], ["despawn", "beam-despawn"]] as const;

/**
 * One beam overlay sheet (`beam-spawn`, `beam-despawn`). Every `sprite` field is optional:
 * defaults are 8 x 6 frames, 48 of them, 256 x 256 px (the client reads the real size from
 * the loaded image), `fps` 24 (2 s), and `size` the pawn height. Optional `rotation` is
 * degrees applied as SpriteMaterial.rotation on the client (beam-despawn uses 90).
 * A bad field is a manifest issue. An absent optional file leaves the sheet out.
 */
function beamSheet(
  docAssets: unknown,
  asset: AssetRec | undefined,
  absent: ReadonlySet<string>,
  fileBytes: ReadonlyMap<string, Uint8Array>,
  pawnHeight: number | undefined,
  issues: GameIssue[],
): ArenaExplosionSheet | undefined {
  if (!asset || absent.has(asset.id)) return undefined;
  const index = Array.isArray(docAssets) ? docAssets.findIndex((item) => isObject(item) && item.id === asset.id) : -1;
  const path = `assets[${index}].sprite`;
  if (asset.kind !== "texture") {
    issues.push({ path: `assets[${index}].kind`, message: `${asset.id} must be a texture` });
    return undefined;
  }
  const item = index >= 0 ? (docAssets as unknown[])[index] : undefined;
  const raw = isObject(item) ? item.sprite : undefined;
  if (raw !== undefined && !isObject(raw)) {
    issues.push({ path, message: "must be an object" });
    return undefined;
  }
  const sprite: Record<string, unknown> = raw ?? {};
  let ok = true;
  const whole = (key: string, fallback: number): number => {
    const value = sprite[key];
    if (value === undefined) return fallback;
    if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
    issues.push({ path: `${path}.${key}`, message: "must be a positive integer" });
    ok = false;
    return fallback;
  };
  const positive = (key: string, fallback: number): number => {
    const value = sprite[key];
    if (value === undefined) return fallback;
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
    issues.push({ path: `${path}.${key}`, message: "must be > 0" });
    ok = false;
    return fallback;
  };
  const columns = whole("columns", 8);
  const rows = whole("rows", 6);
  const frameCount = whole("frameCount", 48);
  const frameWidth = whole("frameWidth", 256);
  const frameHeight = whole("frameHeight", 256);
  const fps = positive("fps", 24);
  const size = positive("size", pawnHeight ?? 2);
  const blending = sprite.blending ?? "additive";
  if (blending !== "normal" && blending !== "additive") {
    issues.push({ path: `${path}.blending`, message: "must be normal or additive" });
    ok = false;
  }
  let rotation: number | undefined;
  if (sprite.rotation !== undefined) {
    if (typeof sprite.rotation === "number" && Number.isFinite(sprite.rotation)) rotation = sprite.rotation;
    else {
      issues.push({ path: `${path}.rotation`, message: "must be a finite number of degrees" });
      ok = false;
    }
  }
  if (frameCount > columns * rows) {
    issues.push({ path: `${path}.frameCount`, message: `more than ${columns} × ${rows} frames` });
    ok = false;
  }
  if (!ok || (blending !== "normal" && blending !== "additive")) return undefined;
  const png = fileBytes.get(asset.uri);
  if (png && png.length >= 24 && sprite.frameWidth !== undefined && sprite.frameHeight !== undefined) {
    const width = ((png[16]! << 24) | (png[17]! << 16) | (png[18]! << 8) | png[19]!) >>> 0;
    const height = ((png[20]! << 24) | (png[21]! << 16) | (png[22]! << 8) | png[23]!) >>> 0;
    if (width !== columns * frameWidth || height !== rows * frameHeight) {
      console.warn(`${asset.id}: ${asset.uri} is ${width}x${height}, sprite expects ${columns * frameWidth}x${rows * frameHeight}`);
    }
  }
  return {
    texture: asset.uri, columns, rows, frameCount, frameWidth, frameHeight, fps, size, blending,
    ...(rotation !== undefined ? { rotation } : {}),
  };
}

const DOOR_SWING_DEFAULT_MS = 400;
const DOOR_SWING_MIN_MS = 50;
const DOOR_SWING_MAX_MS = 10000;

const AUDIO_MEDIA_TYPES = new Set(["audio/mpeg", "audio/wav", "audio/ogg", "audio/opus"]);

/**
 * MP3: an ID3 tag or an MPEG frame sync. WAV: RIFF....WAVE.
 * Opus (`.opus`, media type audio/ogg or audio/opus): an Ogg page, 'OggS', whose first packet is
 * an 'OpusHead' (RFC 7845), version 0 or 1. Chrome and Firefox decode it in decodeAudioData;
 * Safari only from 18.4, so an older Safari drops that one sound.
 */
function audioBytesMatch(mediaType: string, bytes: Uint8Array): boolean {
  const ascii = (at: number, text: string) => [...text].every((ch, i) => bytes[at + i] === ch.charCodeAt(0));
  if (mediaType === "audio/wav") return bytes.length >= 12 && ascii(0, "RIFF") && ascii(8, "WAVE");
  if (mediaType === "audio/ogg" || mediaType === "audio/opus") {
    if (bytes.length < 28 || !ascii(0, "OggS")) return false;
    const head = 27 + bytes[26]!;
    return bytes.length >= head + 19 && ascii(head, "OpusHead") && (bytes[head + 8]! >> 4) === 0;
  }
  if (bytes.length < 3) return false;
  return ascii(0, "ID3") || (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0);
}

function audioKindName(mediaType: string): string {
  if (mediaType === "audio/wav") return "a wav";
  return mediaType === "audio/mpeg" ? "an mp3" : "an ogg opus file";
}

/** Fixed asset id per effect, like `grenade-explosion` for the blast sprite. */
const SOUND_ASSETS: ReadonlyArray<readonly [ArenaSoundName, string]> = [
  ["laser", "laser-blast"],
  ["grenadeLaunch", "grenade-launch"],
  ["grenadeBlast", "grenade-blast"],
  ["cratePickup", "crate-pickup"],
  ["keyPickup", "key-pickup"],
  ["medkitPickup", "medkit-pickup"],
  ["doorOpen", "door-open"],
  ["doorClose", "door-close"],
  ["elevatorStart", "elevator-start"],
  ["beamSpawn", "beam-spawn-sfx"],
  ["beamDespawn", "beam-despawn-sfx"],
];
const MAX_SOUND_VOICES = 16;
/** Linear effect gain. 1 is unity; 2 is +6 dB, used by the grenade blast. */
const MAX_SOUND_VOLUME = 2;

/**
 * `sound` block of each effect's `audio` asset. Bad fields are manifest issues.
 * `positional` defaults to false and `refDistance` to 1.
 */
function soundEffects(docAssets: unknown, assets: ReadonlyMap<string, AssetRec>, absent: ReadonlySet<string>, issues: GameIssue[]): ArenaSounds | undefined {
  const out: ArenaSounds = {};
  let any = false;
  for (const [name, id] of SOUND_ASSETS) {
    const asset = assets.get(id);
    if (!asset || absent.has(id)) continue;
    const index = Array.isArray(docAssets) ? docAssets.findIndex((item) => isObject(item) && item.id === id) : -1;
    if (asset.kind !== "audio") {
      issues.push({ path: `assets[${index}].kind`, message: `${id} must be audio` });
      continue;
    }
    const path = `assets[${index}].sound`;
    const item = index >= 0 ? (docAssets as unknown[])[index] : undefined;
    const sound = isObject(item) && isObject(item.sound) ? item.sound : undefined;
    if (!sound) {
      issues.push({ path, message: "required sound object" });
      continue;
    }
    const volume = sound.volume;
    const volumeOk = typeof volume === "number" && Number.isFinite(volume) && volume >= 0 && volume <= MAX_SOUND_VOLUME;
    if (!volumeOk) issues.push({ path: `${path}.volume`, message: `must be a number from 0 to ${MAX_SOUND_VOLUME}` });
    const voices = sound.maxVoices;
    const voicesOk = typeof voices === "number" && Number.isInteger(voices) && voices >= 1 && voices <= MAX_SOUND_VOICES;
    if (!voicesOk) issues.push({ path: `${path}.maxVoices`, message: `must be an integer from 1 to ${MAX_SOUND_VOICES}` });
    const positional = sound.positional ?? false;
    if (typeof positional !== "boolean") issues.push({ path: `${path}.positional`, message: "must be a boolean" });
    const refDistance = sound.refDistance ?? 1;
    const refOk = typeof refDistance === "number" && Number.isFinite(refDistance) && refDistance > 0;
    if (!refOk) issues.push({ path: `${path}.refDistance`, message: "must be > 0" });
    const kinds = sound.pickupKinds;
    const kindsOk = kinds === undefined || (Array.isArray(kinds) && kinds.every((kind) => parsePickupKind(kind) !== undefined));
    if (!kindsOk) issues.push({ path: `${path}.pickupKinds`, message: "must be an array of ammo, health, weapon, or key" });
    if (!volumeOk || !voicesOk || typeof positional !== "boolean" || !refOk || !kindsOk) continue;
    const effect: ArenaSoundEffect = {
      uri: asset.uri,
      volume: volume as number,
      maxVoices: voices as number,
      positional,
      refDistance: refDistance as number,
      ...(Array.isArray(kinds) ? { pickupKinds: [...new Set(kinds as string[])] } : {}),
    };
    out[name] = effect;
    any = true;
  }
  return any ? out : undefined;
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

function isPublicAssetPath(uri: string): boolean {
  return uri.charCodeAt(0) === 47 && uri.startsWith("assets/", 1);
}

function publicAssetUri(value: unknown, path: string, issues: GameIssue[]): string | undefined {
  const uri = str(value, path, issues);
  if (!uri) return undefined;
  if (!isPublicAssetPath(uri) || uri.includes("..") || uri.includes("\\") || uri.includes("\0")) {
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
   * Set when `scene.sceneGraph` is a path. The text is a scene-graph file.
   * Not part of either content hash. Absent means no graph.
   */
  sceneGraphFile?: PlacementFileSource;
  /**
   * Set when `scene.regions` is a path. The text is a baked regions file.
   * Not part of either content hash. Absent means no baked region graph.
   */
  regionsFile?: PlacementFileSource;
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

/**
 * `scene.sceneGraph` is a path to a scene-graph file. Absent is no graph.
 * Door lock mismatches are warnings: the compiled door wins and the graph still loads.
 */
function sceneGraph(
  scene: Record<string, unknown> | undefined,
  sources: CompileSources | undefined,
  doors: ArenaView["doors"],
  issues: GameIssue[],
): SceneGraph | undefined {
  if (!scene || !Object.prototype.hasOwnProperty.call(scene, "sceneGraph")) return undefined;
  const value = scene.sceneGraph;
  if (typeof value !== "string" || !value.trim()) {
    issues.push({ path: "scene.sceneGraph", message: "must be a path" });
    return undefined;
  }
  const file = sources?.sceneGraphFile;
  if (!file || file.path !== value) {
    issues.push({ path: "scene.sceneGraph", message: "file was not loaded" });
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(file.text);
  } catch (err) {
    issues.push({ path: "scene.sceneGraph", message: `invalid json: ${err instanceof Error ? err.message : String(err)}` });
    return undefined;
  }
  const result = parseSceneGraph(parsed, doors);
  if (!result.graph) {
    issues.push(...result.issues);
    return undefined;
  }
  if (result.issues.length) {
    const listed = result.issues.slice(0, 3).map((issue) => issue.path).join(", ");
    const more = result.issues.length > 3 ? ` and ${result.issues.length - 3} more` : "";
    console.warn(`scene.sceneGraph: ${result.issues.length} door locks disagree with the door placement (${listed}${more}); the doors file wins`);
  }
  return result.graph;
}

/**
 * `scene.regions` is a path to a baked region file. Absent is no graph.
 * The partition is not rebuilt here.
 */
function bakedRegions(
  scene: Record<string, unknown> | undefined,
  sources: CompileSources | undefined,
  pawnRadius: number | undefined,
  pawnHeight: number | undefined,
  issues: GameIssue[],
): BakedRegionsFile | undefined {
  if (!scene || !Object.prototype.hasOwnProperty.call(scene, "regions")) return undefined;
  const value = scene.regions;
  if (typeof value !== "string" || !value.trim()) {
    issues.push({ path: "scene.regions", message: "must be a path" });
    return undefined;
  }
  const file = sources?.regionsFile;
  if (!file || file.path !== value) {
    issues.push({ path: "scene.regions", message: "file was not loaded" });
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(file.text);
  } catch (err) {
    issues.push({ path: "scene.regions", message: `invalid json: ${err instanceof Error ? err.message : String(err)}` });
    return undefined;
  }
  const result = parseBakedRegions(parsed);
  if (!result.file) {
    issues.push(...result.issues);
    return undefined;
  }
  if (pawnRadius !== undefined && pawnHeight !== undefined && (result.file.radius !== pawnRadius || result.file.height !== pawnHeight)) {
    console.warn(`scene.regions: bake radius ${result.file.radius} height ${result.file.height} differs from player ${pawnRadius} ${pawnHeight}`);
  }
  return result.file;
}

/** Same shaft id should carry the same stops and landings. A difference is a warning. */
function warnShaftDrift(graph: SceneGraph, elevators: readonly ArenaElevator[]): void {
  const byId = new Map(elevators.map((row) => [row.id, row]));
  const seen = new Set<string>();
  for (const shaft of graph.shafts) {
    seen.add(shaft.id);
    const row = byId.get(shaft.id);
    if (!row) {
      console.warn(`scene.sceneGraph.places.${shaft.id}: no matching elevator`);
      continue;
    }
    if (!sameNumbers(shaft.stops, row.stops) || !sameLandings(shaft.landings, row.landings)) {
      console.warn(`scene.sceneGraph.places.${shaft.id}: stops or landings differ from scene.elevators`);
    }
  }
  for (const row of elevators) {
    if (seen.has(row.id)) continue;
    console.warn(`scene.elevators.${row.id}: no matching scene-graph shaft`);
  }
}

function sameNumbers(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

function sameLandings(a: ElevatorPlace["landings"], b: ArenaElevator["landings"]): boolean {
  return a.length === b.length && a.every((point, index) => {
    const other = b[index];
    return !!other && point[0] === other[0] && point[1] === other[1] && point[2] === other[2];
  });
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
  const room = optionalName(value.room, `${path}.room`, issues);
  const building = optionalName(value.building, `${path}.building`, issues);
  if (!ok || !id || !stops || !polygon || !landings || speed === undefined || waitS === undefined) return undefined;
  return {
    id,
    stops,
    speed,
    waitS,
    polygon,
    landings,
    ...(room ? { room } : {}),
    ...(building ? { building } : {}),
  };
}

/** Absent is fine. Anything else must be a non-empty string. */
function optionalName(value: unknown, path: string, issues: GameIssue[]): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    issues.push({ path, message: "must be a non-empty string" });
    return undefined;
  }
  return value;
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
  let wsUrl: string | undefined;
  if (Object.prototype.hasOwnProperty.call(doc, "wsUrl")) {
    const value = doc.wsUrl;
    if (typeof value !== "string" || !(value.startsWith("wss:") || value.startsWith("ws:"))) {
      issues.push({ path: "wsUrl", message: "must be a ws: or wss: url" });
    } else {
      wsUrl = value;
    }
  }

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

  // Swing time of a door leaf, in ms. Each of openMs and closeMs defaults to 400.
  const swingValue = scene && Object.prototype.hasOwnProperty.call(scene, "doorSwing") ? scene.doorSwing : undefined;
  let doorSwing: { openMs: number; closeMs: number } | undefined;
  if (swingValue !== undefined) {
    if (!isObject(swingValue)) issues.push({ path: "scene.doorSwing", message: "must be an object" });
    else {
      const ms = (key: "openMs" | "closeMs"): number => {
        const value = swingValue[key];
        if (value === undefined) return DOOR_SWING_DEFAULT_MS;
        if (typeof value === "number" && Number.isFinite(value) && value >= DOOR_SWING_MIN_MS && value <= DOOR_SWING_MAX_MS) return value;
        issues.push({ path: `scene.doorSwing.${key}`, message: `must be ${DOOR_SWING_MIN_MS} to ${DOOR_SWING_MAX_MS}` });
        return DOOR_SWING_DEFAULT_MS;
      };
      doorSwing = { openMs: ms("openMs"), closeMs: ms("closeMs") };
    }
  }

  // Spawn and despawn of a character, in ms. `fadeMs` is the model fade only (beam length is
  // frameCount/fps on the sheet), `despawnDelayMs` holds the character still before its beam and
  // fade-out start, `despawnSoundDelayMs` shifts the despawn sound from the event, and
  // `deathHoldMs` makes a death wait before its despawn begins. Absent block: no fade, no beam.
  const beamValue = scene && Object.prototype.hasOwnProperty.call(scene, "characterBeam") ? scene.characterBeam : undefined;
  let beamTiming: { fadeMs: number; despawnDelayMs: number; despawnSoundDelayMs: number; deathHoldMs: number } | undefined;
  if (beamValue !== undefined) {
    if (!isObject(beamValue)) issues.push({ path: "scene.characterBeam", message: "must be an object" });
    else {
      const ms = (key: string, fallback: number, min: number): number => {
        const value = beamValue[key];
        if (value === undefined) return fallback;
        if (typeof value === "number" && Number.isFinite(value) && value >= min && value <= BEAM_MAX_MS) return value;
        issues.push({ path: `scene.characterBeam.${key}`, message: `must be ${min} to ${BEAM_MAX_MS}` });
        return fallback;
      };
      beamTiming = {
        fadeMs: ms("fadeMs", BEAM_FADE_DEFAULT_MS, 50),
        despawnDelayMs: ms("despawnDelayMs", BEAM_DESPAWN_DELAY_DEFAULT_MS, 0),
        despawnSoundDelayMs: ms("despawnSoundDelayMs", 0, 0),
        deathHoldMs: ms("deathHoldMs", 0, 0),
      };
    }
  }

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
      const kind = item.kind === "texture" || item.kind === "model" || item.kind === "audio" ? item.kind : undefined;
      if (!kind) issues.push({ path: `${path}.kind`, message: "must be texture, model, or audio" });
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
      const optionalKind = kind === "audio" || kind === "texture";
      if (item.optional !== undefined && (typeof item.optional !== "boolean" || !optionalKind)) {
        issues.push({ path: `${path}.optional`, message: "must be a boolean, on an audio or texture asset" });
      }
      const optional = optionalKind && item.optional === true ? true : undefined;
      if (id && kind && uri && mediaType && licenseId && origin) {
        assets.set(id, { id, kind, uri, mediaType, licenseId, origin, notes, scale, shape, radius, height, animation, animations, instance, assetType, optional });
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
  const absentOptional = new Set<string>();
  for (const asset of assets.values()) {
    const index = [...(Array.isArray(doc.assets) ? doc.assets : [])].findIndex((item) => isObject(item) && item.id === asset.id);
    const path = `assets[${index}].uri`;
    if (asset.kind === "audio") {
      if (!AUDIO_MEDIA_TYPES.has(asset.mediaType)) issues.push({ path: `assets[${index}].mediaType`, message: "must be audio/mpeg, audio/wav, audio/ogg or audio/opus" });
    } else {
      const expected = asset.kind === "texture" ? "image/png" : "model/gltf-binary";
      if (asset.mediaType !== expected) issues.push({ path: `assets[${index}].mediaType`, message: `must be ${expected}` });
    }
    const bytes = read(asset.uri);
    if (!bytes) {
      if (asset.optional) {
        console.warn(`${asset.id}: optional ${asset.kind} ${asset.uri} is missing; ${asset.kind === "audio" ? "that sound stays silent" : "that effect is skipped"}`);
        absentOptional.add(asset.id);
        continue;
      }
      issues.push({ path, message: `file not found for ${asset.uri}` });
      continue;
    }
    if (asset.kind === "audio") {
      if (!audioBytesMatch(asset.mediaType, bytes)) issues.push({ path, message: `not ${audioKindName(asset.mediaType)}` });
    } else if (asset.kind === "texture") {
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
  const graph = sceneGraph(scene, sources, bakedDoors, issues);
  const regions = bakedRegions(scene, sources, pawnRadius, pawnHeight, issues);
  if (graph && scene && Object.prototype.hasOwnProperty.call(scene, "elevators")) warnShaftDrift(graph, elevators);
  const buildingIds = new Set(bakedBuildings.map((building) => building.id));
  for (const cab of elevators) {
    if (!cab.room) continue;
    if (buildingIds.has(cab.room)) continue;
    // A bad id does not fail the manifest. The cab still rides with no room, as in 16a.
    const issue: GameIssue = {
      path: `scene.elevators.${cab.id}.room`,
      message: `unknown room placement "${cab.room}"`,
    };
    console.warn(`${issue.path}: ${issue.message}`);
    delete cab.room;
  }

  const facesReady = !walls || faceOrder.every((face) => {
    const placed = facePlacements[face];
    return !!placed && assets.get(placed.model)?.kind === "model";
  });
  const explosion = explosionSheet(doc.assets, assets.get(EXPLOSION_ASSET), fileBytes, issues);
  const laserImpact = laserImpactSheet(doc.assets, assets.get(LASER_IMPACT_ASSET), absentOptional, fileBytes, issues);
  const grenadeProj = grenadeProjectile(doc.assets, issues);
  const sounds = soundEffects(doc.assets, assets, absentOptional, issues);
  const characterBeam: ArenaCharacterBeam | undefined = beamTiming
    ? {
      ...beamTiming,
      ...Object.fromEntries(BEAM_SHEETS.flatMap(([key, id]) => {
        const sheet = beamSheet(doc.assets, assets.get(id), absentOptional, fileBytes, pawnHeight, issues);
        return sheet ? [[key, sheet]] : [];
      })),
    }
    : undefined;
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
      ...[...assets.values()].filter((asset) => !absentOptional.has(asset.id)).map((asset) => ({
        id: asset.id,
        kind: asset.kind === "texture" ? "texture" as const : asset.kind === "audio" ? "audio" as const : "renderable-model" as const,
        authority: "presentation" as const,
        version: "1.0.0",
        contentHash: hashBytes(fileBytes.get(asset.uri) ?? new Uint8Array()),
        runtimeUri: asset.uri.replace(/^\//, ""),
        runtimeRole: asset.kind === "texture" ? "texture" as const : asset.kind === "audio" ? "audio" as const : "model" as const,
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
    ...(doorSwing ? { doorSwing } : {}),
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
    ...(grenadeProj?.impact ? { grenadeImpact: grenadeProj.impact } : {}),
    ...(grenadeProj?.damage !== undefined ? { grenadeDamage: grenadeProj.damage } : {}),
    ...(explosion ? { explosion } : {}),
    ...(laserImpact ? { laserImpact } : {}),
    ...(sounds ? { sounds } : {}),
    ...(characterBeam ? { characterBeam } : {}),
    ...(wsUrl ? { wsUrl } : {}),
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
    ...(graph ? { sceneGraph: graph } : {}),
    ...(regions ? { regions } : {}),
  };
}
