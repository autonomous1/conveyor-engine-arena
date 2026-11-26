/**
 * Arena frame parsers for a browser client, a Worker bot, or a Node bot.
 * No Node builtin imports, no filesystem, and no WebSocket package.
 */
// ARCHITECTURE: Arena frame parsers and the small wire types for client and bot
//   frames (health, doors, elevators, lasers, grenades, QA, messages).
// Wiring: client/net.ts parses snapshots; client/boot.ts and
//   client/info-probe.ts parse arena frames; shared/info-probe.ts reads the
//   scene-graph frame.
import { parseAudit, type AuditFrame } from "./audit.js";
import { parseDoor, parseDoorSet, type DoorFrame } from "./doors.js";
import { parseElevatorSet, parseElevatorState, type ElevatorState } from "./elevators.js";
import { parseGrenadePose, type GrenadePose } from "./grenade.js";
import { parseBotLabel, type BotLabelFrame } from "./bot-label.js";
import { parseHealth, type HealthFrame } from "./health.js";
import { parseLaser, type LaserFrame } from "./hitscan.js";
import { parseLoadout, parsePickup, parsePickupSet, type LoadoutFrame, type PickupFrame } from "./pickups.js";
import type { SceneGraphFile } from "./scene-graph.js";
import { parseBakedRegions, type BakedRegionsFile } from "./nav/regions.js";

/**
 * Inventory Frame type.
 */
export type InventoryFrame = {
  t: "inventory";
  keys: string[];
};

/**
 * `graph` is the file shape (places and portals), not the runtime maps.
 */
export type SceneGraphFrame = {
  t: "sceneGraph";
  v: 1;
  hash: string;
  graph: SceneGraphFile;
};

/**
 * `regions` is the baked file (places and portals), not a runtime overlay.
 */
export type RegionsFrame = {
  t: "regions";
  v: 1;
  hash: string;
  regions: BakedRegionsFile;
};

/**
 * Reply to a client `teleport` frame.
 * @post Only the sender's connection gets it.
 */
export type TeleportResultFrame = {
  t: "teleportResult";
  ok: boolean;
  reason?: string;
};

/**
 * Snapshot Vec3 type.
 */
export type SnapshotVec3 = { x: number; y: number; z: number };

/**
 * Aimed shutter. `fovDeg` defaults to 55 on the QA page when omitted.
 */
export type SnapshotLookFrom = {
  eye: SnapshotVec3;
  target: SnapshotVec3;
  fovDeg?: number;
};

/**
 * Chase a pawn. `back` / `up` default to 3 / 1.6 on the QA page when omitted.
 */
export type SnapshotFollow = {
  entityId: number;
  back?: number;
  up?: number;
};

/**
 * Snapshot Result Reason type.
 */
export type SnapshotResultReason = "invalid" | "busy" | "noRenderer";

/**
 * Reply to the client that sent `qaSnapshot`. `png` is a PNG data URL.
 */
export type SnapshotResultFrame = {
  t: "snapshotResult";
  ok: boolean;
  id: string;
  png?: string;
  reason?: SnapshotResultReason;
};

/**
 * Host → other browsers. No `lookFrom` or `follow`: any play tab may answer
 * with its current view. Either field: only a `?qa=1` tab should answer.
 * @post The requester is skipped.
 */
export type QaCaptureFrame = {
  t: "qaCapture";
  id: string;
  lookFrom?: SnapshotLookFrom;
  follow?: SnapshotFollow;
  waitFrames?: number;
};

/**
 * One connected player pawn's team, sent with the roster frame.
 * @when A row is present only for a roster pawn that spawned on a teamed pad.
 */
export type PlayerTeamRow = { id: number; team: string };
/**
 * Players Frame type.
 * @when Sent with the welcome and whenever the roster changes. `teams` is
 * absent when no connected player has a team.
 */
export type PlayersFrame = { t: "players"; ids: number[]; teams?: PlayerTeamRow[] };
/**
 * Claim Row type.
 */
export type ClaimRow = { key: string; owner: number; expires: number };
/**
 * Claims Frame type.
 */
export type ClaimsFrame = { t: "claims"; rows: ClaimRow[] };

/**
 * One host-stamped bot signal. `to: 0` is broadcast.
 */
export type MsgRow = { from: number; to: number; seq: number; text: string; at: number };
/**
 * Host → client batch of bot signals; one frame per host tick.
 */
export type MsgFrame = { t: "msg"; rows: MsgRow[] };

/**
 * Host → client arena frames. Elevator is cab state. Grenade is the replicated pose.
 */
export type ArenaFrame =
  | LoadoutFrame
  | PickupFrame
  | DoorFrame
  | ElevatorState
  | HealthFrame
  | BotLabelFrame
  | LaserFrame
  | GrenadePose
  | AuditFrame
  | InventoryFrame
  | PlayersFrame
  | ClaimsFrame
  | MsgFrame
  | SceneGraphFrame
  | RegionsFrame
  | TeleportResultFrame
  | SnapshotResultFrame
  | QaCaptureFrame;

/**
 * Welcome Extras type.
 * @why The health frame is change-driven (unseen `hp|dead` only), so a pawn that
 *      never takes damage is never sent one; the welcome seeds the owner's vital.
 */
export type WelcomeExtras = {
  pickups: string[];
  doors: DoorFrame[];
  elevators?: ElevatorState[];
  weapon?: string;
  ammo: number;
  keys: string[];
  role?: string;
  scope?: string[];
  players?: number[];
  claims?: ClaimRow[];
  messages?: boolean;
  /** The owned pawn's vital at join. Absent means unknown — never 0, never dead. */
  hp?: number;
  dead?: boolean;
};

/**
 * One arena `t` frame.
 * @post Unknown `t`, kernel messages, and bad JSON are `undefined`.
 */
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
  if (t === "botLabel") return parseBotLabel(value);
  if (t === "laser") return parseLaser(value);
  if (t === "grenade") return parseGrenadePose(value);
  if (t === "audit") return parseAudit(value);
  if (t === "inventory") return parseInventory(value);
  if (t === "players") return parsePlayers(value);
  if (t === "claims") return parseClaims(value);
  if (t === "msg") return parseMsg(value);
  if (t === "sceneGraph") return parseSceneGraphFrame(value);
  if (t === "regions") return parseRegionsFrame(value);
  if (t === "teleportResult") return parseTeleportResult(value);
  if (t === "snapshotResult") return parseSnapshotResult(value);
  if (t === "qaCapture") return parseQaCapture(value);
  return undefined;
}

/**
 * Parses Claims.
 */
export function parseClaims(frame: unknown): ClaimsFrame | undefined {
  if (!frame || typeof frame !== "object" || Array.isArray(frame)) return undefined;
  const rec = frame as Record<string, unknown>;
  if (rec.t !== "claims" || !Array.isArray(rec.rows)) return undefined;
  const rows: ClaimRow[] = [];
  for (const value of rec.rows) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const row = value as Record<string, unknown>;
    if (typeof row.key !== "string" || row.key.length === 0 || row.key.length > 128 || /[\u0000-\u001f\u007f]/.test(row.key)) return undefined;
    if (typeof row.owner !== "number" || !Number.isInteger(row.owner)) return undefined;
    if (typeof row.expires !== "number" || !Number.isFinite(row.expires)) return undefined;
    rows.push({ key: row.key, owner: row.owner, expires: row.expires });
  }
  rows.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { t: "claims", rows };
}

const MAX_MSG_ROWS = 64;

/**
 * Parses one `msg` frame: malformed rows are dropped, not fatal.
 * @post A non-`msg` frame is `undefined`; rows past `MAX_MSG_ROWS` are dropped.
 */
export function parseMsg(frame: unknown): MsgFrame | undefined {
  if (!frame || typeof frame !== "object" || Array.isArray(frame)) return undefined;
  const rec = frame as Record<string, unknown>;
  if (rec.t !== "msg" || !Array.isArray(rec.rows)) return undefined;
  const rows: MsgRow[] = [];
  for (const value of rec.rows) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    const { from, to, seq, at } = row;
    if (typeof from !== "number" || !Number.isInteger(from) || from <= 0) continue;
    if (typeof to !== "number" || !Number.isInteger(to) || to < 0) continue;
    if (typeof seq !== "number" || !Number.isInteger(seq) || seq <= 0) continue;
    if (typeof at !== "number" || !Number.isFinite(at)) continue;
    if (typeof row.text !== "string") continue;
    rows.push({ from, to, seq, text: row.text, at });
    if (rows.length >= MAX_MSG_ROWS) break;
  }
  return { t: "msg", rows };
}

/**
 * Parses Players.
 * @post Ids are deduped and sorted; `teams` is emitted in `ids` order, only for
 * ids in `ids`, and omitted when empty or absent.
 */
export function parsePlayers(frame: unknown): PlayersFrame | undefined {
  if (!frame || typeof frame !== "object" || Array.isArray(frame)) return undefined;
  const rec = frame as Record<string, unknown>;
  if (rec.t !== "players" || !Array.isArray(rec.ids)) return undefined;
  const ids: number[] = [];
  for (const value of rec.ids) {
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return undefined;
    ids.push(value);
  }
  const sorted = [...new Set(ids)].sort((a, b) => a - b);
  if (rec.teams === undefined) return { t: "players", ids: sorted };
  if (!Array.isArray(rec.teams)) return undefined;
  const byId = new Map<number, string>();
  for (const row of rec.teams) {
    if (!row || typeof row !== "object" || Array.isArray(row)) return undefined;
    const entry = row as Record<string, unknown>;
    if (typeof entry.id !== "number" || !Number.isInteger(entry.id) || entry.id <= 0) return undefined;
    if (typeof entry.team !== "string" || entry.team.length === 0) return undefined;
    byId.set(entry.id, entry.team);
  }
  const teams = sorted.filter((id) => byId.has(id)).map((id) => ({ id, team: byId.get(id)! }));
  return { t: "players", ids: sorted, ...(teams.length > 0 ? { teams } : {}) };
}

const SNAPSHOT_REASONS = new Set<string>(["invalid", "busy", "noRenderer"]);

/**
 * Parses Snapshot Result.
 */
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

/**
 * Parses Qa Capture.
 */
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

/**
 * Parses Teleport Result.
 */
export function parseTeleportResult(frame: unknown): TeleportResultFrame | undefined {
  if (!frame || typeof frame !== "object" || Array.isArray(frame)) return undefined;
  const rec = frame as Record<string, unknown>;
  if (rec.t !== "teleportResult" || typeof rec.ok !== "boolean") return undefined;
  if (rec.reason === undefined) return { t: "teleportResult", ok: rec.ok };
  if (typeof rec.reason !== "string" || rec.reason.length === 0) return undefined;
  return { t: "teleportResult", ok: rec.ok, reason: rec.reason };
}

/**
 * Parses Inventory.
 */
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

/**
 * Parses Scene Graph Frame.
 */
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
 * Parses Regions Frame.
 */
export function parseRegionsFrame(frame: unknown): RegionsFrame | undefined {
  if (!frame || typeof frame !== "object" || Array.isArray(frame)) return undefined;
  const rec = frame as Record<string, unknown>;
  if (rec.t !== "regions" || rec.v !== 1) return undefined;
  if (typeof rec.hash !== "string" || !/^[0-9a-f]{64}$/.test(rec.hash)) return undefined;
  const parsed = parseBakedRegions(rec.regions);
  if (!parsed.file) return undefined;
  return { t: "regions", v: 1, hash: rec.hash, regions: parsed.file };
}

/**
 * Welcome fields the kernel does not know about. `role` and `scope` are
 * optional. Solo omits them.
 * @why The claim field is `scope`, not `scopes`.
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
  const players = Array.isArray(rec.players) ? parsePlayers({ t: "players", ids: rec.players })?.ids : undefined;
  const claims = Array.isArray(rec.claims) ? parseClaims({ t: "claims", rows: rec.claims })?.rows : undefined;
  const hp = typeof rec.hp === "number" && Number.isFinite(rec.hp) ? rec.hp : undefined;
  const dead = typeof rec.dead === "boolean" ? rec.dead : undefined;
  return {
    pickups: parsePickupSet(rec.pickups) ?? [],
    doors: parseDoorSet(rec.doors) ?? [],
    ...(elevators ? { elevators } : {}),
    ...(weapon ? { weapon } : {}),
    ammo,
    keys: parsePickupSet(rec.keys) ?? [],
    ...(players !== undefined ? { players } : {}),
    ...(claims !== undefined ? { claims } : {}),
    ...(rec.messages === true ? { messages: true } : {}),
    ...(hp !== undefined && dead !== undefined ? { hp, dead } : {}),
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
