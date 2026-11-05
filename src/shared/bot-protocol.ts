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
  | SceneGraphFrame;

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
  return undefined;
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
