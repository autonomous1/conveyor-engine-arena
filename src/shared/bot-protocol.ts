/**
 * Arena frame parsers for a browser client, a Worker bot, or a Node bot.
 * No Node builtin imports, no filesystem, and no WebSocket package.
 */
import { parseAudit, type AuditFrame } from "./audit.js";
import { parseDoor, parseDoorSet, type DoorFrame } from "./doors.js";
import { parseElevatorSet, parseElevatorState, type ElevatorState } from "./elevators.js";
import { parseGrenadePose, type GrenadePose } from "./grenade.js";
import { parseHealth, type HealthFrame } from "./health.js";
import { parseLaser, type LaserFrame } from "./hitscan.js";
import { parseLoadout, parsePickup, parsePickupSet, type LoadoutFrame, type PickupFrame } from "./pickups.js";
import type { SceneGraphFile } from "./scene-graph.js";

export type InventoryFrame = {
  t: "inventory";
  keys: string[];
};

/** `graph` is the file shape (places and portals), not the runtime maps. */
export type SceneGraphFrame = {
  t: "sceneGraph";
  v: 1;
  hash: string;
  graph: SceneGraphFile;
};

/** Reply to a client `teleport` frame. Only the sender's connection gets it. */
export type TeleportResultFrame = {
  t: "teleportResult";
  ok: boolean;
  reason?: string;
};

export type SnapshotVec3 = { x: number; y: number; z: number };

/** Aimed shutter. `fovDeg` defaults to 55 on the QA page when omitted. */
export type SnapshotLookFrom = {
  eye: SnapshotVec3;
  target: SnapshotVec3;
  fovDeg?: number;
};

/** Chase a pawn. `back` / `up` default to 3 / 1.6 on the QA page when omitted. */
export type SnapshotFollow = {
  entityId: number;
  back?: number;
  up?: number;
};

export type SnapshotResultReason = "invalid" | "busy" | "noRenderer";

/** Reply to the client that sent `qaSnapshot`. `png` is a PNG data URL. */
export type SnapshotResultFrame = {
  t: "snapshotResult";
  ok: boolean;
  id: string;
  png?: string;
  reason?: SnapshotResultReason;
};

/**
 * Host → other browsers. The requester is skipped.
 * No `lookFrom` or `follow`: any play tab may answer with its current view.
 * Either field: only a `?qa=1` tab should answer.
 */
export type QaCaptureFrame = {
  t: "qaCapture";
  id: string;
  lookFrom?: SnapshotLookFrom;
  follow?: SnapshotFollow;
  waitFrames?: number;
};

/** Host → client arena frames. Elevator is cab state. Grenade is the replicated pose. */
export type ArenaFrame =
  | LoadoutFrame
  | PickupFrame
  | DoorFrame
  | ElevatorState
  | HealthFrame
  | LaserFrame
  | GrenadePose
  | AuditFrame
  | InventoryFrame
  | SceneGraphFrame
  | TeleportResultFrame
  | SnapshotResultFrame
  | QaCaptureFrame;

export type WelcomeExtras = {
  pickups: string[];
  doors: DoorFrame[];
  elevators?: ElevatorState[];
  weapon?: string;
  ammo: number;
  keys: string[];
  role?: string;
  scope?: string[];
};

/** One arena `t` frame. Unknown `t`, kernel messages, and bad JSON are `undefined`. */
export function parseArenaFrame(text: string): ArenaFrame | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const t = (value as { t?: unknown }).t;
  if (t === "loadout") return parseLoadout(value);
  if (t === "pickup") return parsePickup(value);
  if (t === "door") return parseDoor(value);
  if (t === "elevator") return parseElevatorState(value);
  if (t === "health") return parseHealth(value);
  if (t === "laser") return parseLaser(value);
  if (t === "grenade") return parseGrenadePose(value);
  if (t === "audit") return parseAudit(value);
  if (t === "inventory") return parseInventory(value);
  if (t === "sceneGraph") return parseSceneGraphFrame(value);
  if (t === "teleportResult") return parseTeleportResult(value);
  if (t === "snapshotResult") return parseSnapshotResult(value);
  if (t === "qaCapture") return parseQaCapture(value);
  return undefined;
}

const SNAPSHOT_REASONS = new Set<string>(["invalid", "busy", "noRenderer"]);

export function parseSnapshotResult(frame: unknown): SnapshotResultFrame | undefined {
  if (!frame || typeof frame !== "object" || Array.isArray(frame)) return undefined;
  const rec = frame as Record<string, unknown>;
  if (rec.t !== "snapshotResult" || typeof rec.ok !== "boolean") return undefined;
  if (typeof rec.id !== "string" || rec.id.length === 0 || rec.id.length > 64) return undefined;
  if (rec.ok === true) {
    if (typeof rec.png !== "string" || !rec.png.startsWith("data:image/png;base64,")) return undefined;
    if (rec.reason !== undefined) return undefined;
    return { t: "snapshotResult", ok: true, id: rec.id, png: rec.png };
  }
  if (typeof rec.reason !== "string" || !SNAPSHOT_REASONS.has(rec.reason)) return undefined;
  if (rec.png !== undefined) return undefined;
  return { t: "snapshotResult", ok: false, id: rec.id, reason: rec.reason as SnapshotResultReason };
}

export function parseQaCapture(frame: unknown): QaCaptureFrame | undefined {
  if (!frame || typeof frame !== "object" || Array.isArray(frame)) return undefined;
  const rec = frame as Record<string, unknown>;
  if (rec.t !== "qaCapture") return undefined;
  if (typeof rec.id !== "string" || rec.id.length === 0 || rec.id.length > 64) return undefined;
  const out: QaCaptureFrame = { t: "qaCapture", id: rec.id };
  if (rec.lookFrom !== undefined) {
    const lookFrom = parseSnapshotLook(rec.lookFrom);
    if (!lookFrom) return undefined;
    out.lookFrom = lookFrom;
  }
  if (rec.follow !== undefined) {
    const follow = parseSnapshotFollow(rec.follow);
    if (!follow) return undefined;
    out.follow = follow;
  }
  if (rec.waitFrames !== undefined) {
    if (typeof rec.waitFrames !== "number" || !Number.isInteger(rec.waitFrames)) return undefined;
    if (rec.waitFrames < 0 || rec.waitFrames > 30) return undefined;
    out.waitFrames = rec.waitFrames;
  }
  return out;
}

function parseSnapshotLook(value: unknown): SnapshotLookFrom | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const rec = value as Record<string, unknown>;
  const eye = parseSnapshotVec(rec.eye);
  const target = parseSnapshotVec(rec.target);
  if (!eye || !target) return undefined;
  if (rec.fovDeg === undefined) return { eye, target };
  if (typeof rec.fovDeg !== "number" || !Number.isFinite(rec.fovDeg)) return undefined;
  return { eye, target, fovDeg: rec.fovDeg };
}

function parseSnapshotFollow(value: unknown): SnapshotFollow | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const rec = value as Record<string, unknown>;
  if (typeof rec.entityId !== "number" || !Number.isInteger(rec.entityId)) return undefined;
  const out: SnapshotFollow = { entityId: rec.entityId };
  if (rec.back !== undefined) {
    if (typeof rec.back !== "number" || !Number.isFinite(rec.back)) return undefined;
    out.back = rec.back;
  }
  if (rec.up !== undefined) {
    if (typeof rec.up !== "number" || !Number.isFinite(rec.up)) return undefined;
    out.up = rec.up;
  }
  return out;
}

function parseSnapshotVec(value: unknown): SnapshotVec3 | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const rec = value as Record<string, unknown>;
  if (typeof rec.x !== "number" || typeof rec.y !== "number" || typeof rec.z !== "number") return undefined;
  if (!Number.isFinite(rec.x) || !Number.isFinite(rec.y) || !Number.isFinite(rec.z)) return undefined;
  return { x: rec.x, y: rec.y, z: rec.z };
}

export function parseTeleportResult(frame: unknown): TeleportResultFrame | undefined {
  if (!frame || typeof frame !== "object" || Array.isArray(frame)) return undefined;
  const rec = frame as Record<string, unknown>;
  if (rec.t !== "teleportResult" || typeof rec.ok !== "boolean") return undefined;
  if (rec.reason === undefined) return { t: "teleportResult", ok: rec.ok };
  if (typeof rec.reason !== "string" || rec.reason.length === 0) return undefined;
  return { t: "teleportResult", ok: rec.ok, reason: rec.reason };
}

export function parseInventory(frame: unknown): InventoryFrame | undefined {
  if (!frame || typeof frame !== "object" || Array.isArray(frame)) return undefined;
  const rec = frame as Record<string, unknown>;
  if (rec.t !== "inventory" || !Array.isArray(rec.keys)) return undefined;
  const keys: string[] = [];
  for (const item of rec.keys) {
    if (typeof item !== "string" || item.length === 0) return undefined;
    keys.push(item);
  }
  return { t: "inventory", keys };
}

export function parseSceneGraphFrame(frame: unknown): SceneGraphFrame | undefined {
  if (!frame || typeof frame !== "object" || Array.isArray(frame)) return undefined;
  const rec = frame as Record<string, unknown>;
  if (rec.t !== "sceneGraph" || rec.v !== 1) return undefined;
  if (typeof rec.hash !== "string" || !/^[0-9a-f]{64}$/.test(rec.hash)) return undefined;
  const graph = rec.graph;
  if (!graph || typeof graph !== "object" || Array.isArray(graph)) return undefined;
  const file = graph as Record<string, unknown>;
  if (file.formatVersion !== 1 || file.units !== "meters") return undefined;
  if (!Array.isArray(file.places) || !Array.isArray(file.portals)) return undefined;
  return { t: "sceneGraph", v: 1, hash: rec.hash, graph: graph as SceneGraphFile };
}

/**
 * Welcome fields the kernel does not know about. `role` and `scope` are
 * optional. Solo omits them. The claim field is `scope`, not `scopes`.
 */
export function parseWelcomeExtras(welcome: unknown): WelcomeExtras | undefined {
  if (!welcome || typeof welcome !== "object" || Array.isArray(welcome)) return undefined;
  const rec = welcome as Record<string, unknown>;
  if (rec.type !== "welcome") return undefined;
  const weapon = typeof rec.weapon === "string" && rec.weapon.length > 0 ? rec.weapon : undefined;
  const ammo = typeof rec.ammo === "number" && Number.isFinite(rec.ammo) ? rec.ammo : 0;
  const role = typeof rec.role === "string" && rec.role.length > 0 ? rec.role : undefined;
  const scope = stringList(rec.scope);
  const elevators = Array.isArray(rec.elevators) ? parseElevatorSet(rec.elevators) : undefined;
  return {
    pickups: parsePickupSet(rec.pickups) ?? [],
    doors: parseDoorSet(rec.doors) ?? [],
    ...(elevators ? { elevators } : {}),
    ...(weapon ? { weapon } : {}),
    ammo,
    keys: parsePickupSet(rec.keys) ?? [],
    ...(role ? { role } : {}),
    ...(scope ? { scope } : {}),
  };
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0) return undefined;
    out.push(item);
  }
  return out;
}
