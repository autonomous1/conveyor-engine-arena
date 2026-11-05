/**
 * Crosshair inspect. The slab test and the readout are pure: no DOM, no WebGL,
 * no socket. A hit closer than `range` wins. Combat's ray keeps its own
 * minimum distance; this one reports an origin inside a box as distance 0.
 */
import type { ArenaView } from "./arena-view.js";
import type { SceneGraphFrame } from "./bot-protocol.js";
import { parseSceneGraph, placeAt, type CabState, type SceneGraph } from "./scene-graph.js";

export const INFO_RANGE_M = 96;
export const INFO_SHOW_MS = 4000;

const AXIS_EPS = 1e-12;
const TIE_M = 1e-4;
/** A slab this far past the hit on both sides is not a floor. */
const UNBOUNDED_M = 8;
const EYE_M = 1.6;

export type Vec3 = { x: number; y: number; z: number };

export type InfoKind = "door" | "pickup" | "pawn" | "prop" | "collision";

export type InfoMetadata = {
  name?: string;
  model?: string;
  pickupKind?: string;
};

/** One pick volume. `min` / `max` are world-axis corners. */
export type InfoCandidate = {
  kind: InfoKind;
  id: string;
  min: Vec3;
  max: Vec3;
  metadata: InfoMetadata;
};

export type InfoHit = InfoCandidate & {
  distance: number;
  point: Vec3;
};

export type Aabb = {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
};

const RANK: Record<InfoKind, number> = {
  door: 0,
  pickup: 0,
  pawn: 1,
  prop: 2,
  collision: 3,
};

export type DoorLive = { open: boolean; locked: boolean; key?: string };

export function formatDoorLine(id: string, live: DoorLive): string {
  const parts = [`door ${id}`, live.open ? "open" : "closed", live.locked ? "locked" : "unlocked"];
  const key = live.key;
  if (live.locked) {
    if (key) parts.push(`needs ${key}`);
  } else if (key) {
    parts.push(`key ${key}`);
  }
  return parts.join(" · ");
}

export function formatPickupLine(id: string, kind: string | undefined, available: boolean): string {
  const state = available ? "available" : "gone";
  return kind ? `pickup ${id} · ${kind} · ${state}` : `pickup ${id} · ${state}`;
}

export function formatPawnLine(id: string, name?: string, model?: string): string {
  const parts = [`pawn ${id}`];
  if (name) parts.push(name);
  if (model) parts.push(model);
  return parts.join(" · ");
}

export function formatMeters(distance: number): string {
  if (!Number.isFinite(distance)) return "";
  const rounded = Math.round(distance * 10) / 10;
  const text = Object.is(rounded, -0) ? "0" : Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return `${text} m`;
}

/**
 * Feet height for `placeAt`. A pawn uses its feet. A tall wall or door uses
 * the volume base, so a hit at camera height still lands in the room band.
 * A slab that runs far above and below the hit is not a floor: sample 1.6 m
 * under the impact instead.
 */
export function placeSampleY(hit: Pick<InfoHit, "kind" | "min" | "max" | "point">): number {
  if (hit.kind === "pawn") return hit.min.y;
  const below = hit.point.y - hit.min.y;
  const above = hit.max.y - hit.point.y;
  if (below > UNBOUNDED_M && above > UNBOUNDED_M) return hit.point.y - EYE_M;
  const height = hit.max.y - hit.min.y;
  if (hit.kind === "collision" || hit.kind === "door" || height > 2) return hit.min.y;
  return hit.point.y;
}

/**
 * Nearest nonnegative hit. `direction` need not be a unit. Equal distances
 * keep the semantic door or pickup ahead of a duplicate collision box, then
 * the smaller id. A miss, a backward hit, and a hit past `range` are absent.
 */
export function pickInfoTarget(
  origin: Vec3,
  direction: Vec3,
  candidates: readonly InfoCandidate[],
  range = INFO_RANGE_M,
): InfoHit | undefined {
  if (!finiteVec(origin) || !Number.isFinite(range) || range < 0) return undefined;
  const len = Math.hypot(direction.x, direction.y, direction.z);
  if (!(len > AXIS_EPS)) return undefined;
  const dir = { x: direction.x / len, y: direction.y / len, z: direction.z / len };
  let best: InfoHit | undefined;
  for (const candidate of candidates) {
    const box = candidateBox(candidate);
    if (!box) continue;
    const distance = rayEnter(origin, dir, box, range);
    if (distance === undefined) continue;
    const hit: InfoHit = {
      kind: candidate.kind,
      id: candidate.id,
      min: { x: box.minX, y: box.minY, z: box.minZ },
      max: { x: box.maxX, y: box.maxY, z: box.maxZ },
      metadata: candidate.metadata,
      distance,
      point: {
        x: origin.x + dir.x * distance,
        y: origin.y + dir.y * distance,
        z: origin.z + dir.z * distance,
      },
    };
    if (!best || preferred(hit, best)) best = hit;
  }
  return best;
}

export type DoorPick = {
  id: string;
  /** Live open flag. A shut door with no leaf may use `closed`. */
  open: boolean;
  /** Current leaf bounds, including swing and a moving cab. */
  leaf?: Aabb;
  /** Closed leaf. Ignored when `leaf` is set or the door is open. */
  closed?: Aabb;
};

export type PickupPick = {
  id: string;
  kind?: string;
  available: boolean;
  min: Vec3;
  max: Vec3;
};

export type PawnPick = {
  id: string;
  min: Vec3;
  max: Vec3;
  name?: string;
  model?: string;
};

export type VolumePick = {
  id?: number;
  source?: string;
  mesh?: boolean;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  minY?: number;
  maxY?: number;
};

/**
 * Candidates from data the browser already has. An open door with no leaf is
 * skipped, so a stale closed box is not inspected through the doorway. A
 * pickup volume is not also emitted as collision. Gone pickups are absent.
 */
export function collectInfoCandidates(args: {
  doors: readonly DoorPick[];
  pickups: readonly PickupPick[];
  pawns: readonly PawnPick[];
  volumes: readonly VolumePick[];
  propIds: readonly string[];
  /** Every known pickup id, including ones that are gone. */
  pickupIds: readonly string[];
}): InfoCandidate[] {
  const props = new Set(args.propIds);
  const pickups = new Set(args.pickupIds);
  const out: InfoCandidate[] = [];
  for (const door of args.doors) {
    const box = door.leaf ?? (door.open ? undefined : door.closed);
    if (!box) continue;
    const candidate = fromAabb("door", door.id, box, {});
    if (candidate) out.push(candidate);
  }
  for (const pickup of args.pickups) {
    if (!pickup.available) continue;
    const candidate = fromCorners("pickup", pickup.id, pickup.min, pickup.max, {
      ...(pickup.kind ? { pickupKind: pickup.kind } : {}),
    });
    if (candidate) out.push(candidate);
  }
  for (const pawn of args.pawns) {
    const candidate = fromCorners("pawn", pawn.id, pawn.min, pawn.max, {
      ...(pawn.name ? { name: pawn.name } : {}),
      ...(pawn.model ? { model: pawn.model } : {}),
    });
    if (candidate) out.push(candidate);
  }
  for (const volume of args.volumes) {
    const source = volume.source;
    if (source && (pickups.has(source) || pickups.has(stripBox(source)))) continue;
    const propId = propPlacement(source, props);
    const id = propId ?? (source && source.length > 0 ? source : volume.id !== undefined ? String(volume.id) : "");
    if (!id) continue;
    const kind: InfoKind = propId || volume.mesh === true ? "prop" : "collision";
    const minY = typeof volume.minY === "number" && Number.isFinite(volume.minY) ? volume.minY : -1e6;
    const maxY = typeof volume.maxY === "number" && Number.isFinite(volume.maxY) ? volume.maxY : 1e6;
    const candidate = fromAabb(kind, id, {
      minX: volume.minX,
      maxX: volume.maxX,
      minY,
      maxY,
      minZ: volume.minZ,
      maxZ: volume.maxZ,
    }, {});
    if (candidate) out.push(candidate);
  }
  return out;
}

export type InfoOwn = { x: number; y: number; z: number };

export type InfoSession = {
  onDoors(rows: readonly { id: string; open: boolean; locked: boolean }[]): void;
  onDoor(row: { id: string; open: boolean; locked: boolean }): void;
  onPickupSet(ids: readonly string[]): void;
  onPickupGone(id: string): void;
  onSceneGraph(frame: SceneGraphFrame | undefined): void;
  doorLive(id: string): { open: boolean; locked: boolean } | undefined;
  pickupAvailable(id: string): boolean;
  readonly graph: SceneGraph | undefined;
  inspect(args: {
    now: number;
    origin: Vec3;
    direction: Vec3;
    candidates: readonly InfoCandidate[];
    own?: InfoOwn;
    cabs?: readonly CabState[];
    range?: number;
  }): string;
  /** Status and own place from current state. No raycast. Empty after expiry. */
  refresh(now: number, own?: InfoOwn, cabs?: readonly CabState[]): string;
};

export function createInfoSession(opts: {
  doors: ArenaView["doors"];
  pickups: readonly { id: string; kind?: string }[];
}): InfoSession {
  const keys = new Map<string, string>();
  const live = new Map<string, { open: boolean; locked: boolean }>();
  const kinds = new Map<string, string>();
  for (const door of opts.doors) {
    live.set(door.id, { open: door.open === true, locked: door.locked === true });
    if (typeof door.key === "string" && door.key.length > 0) keys.set(door.id, door.key);
  }
  for (const pickup of opts.pickups) {
    if (pickup.kind) kinds.set(pickup.id, pickup.kind);
  }
  let remaining = new Set(opts.pickups.map((pickup) => pickup.id));
  let graph: SceneGraph | undefined;
  let shown: { until: number; hit?: InfoHit } | undefined;

  const text = (own?: InfoOwn, cabs?: readonly CabState[]): string => {
    if (!shown) return "";
    const lines: string[] = [];
    const hit = shown.hit;
    if (hit) {
      lines.push(subjectLine(hit));
      const meters = formatMeters(hit.distance);
      if (meters) lines.push(meters);
    }
    if (graph) {
      if (hit) {
        const y = placeSampleY(hit);
        lines.push(`place ${placeAt(graph, hit.point.x, y, hit.point.z, cabs).id}`);
      } else if (own && finiteOwn(own)) {
        lines.push(`place ${placeAt(graph, own.x, own.y, own.z, cabs).id}`);
      }
      if (own && finiteOwn(own)) lines.push(`you: ${placeAt(graph, own.x, own.y, own.z, cabs).id}`);
    }
    return lines.join("\n");
  };

  const subjectLine = (hit: InfoHit): string => {
    if (hit.kind === "door") {
      const row = live.get(hit.id) ?? { open: false, locked: false };
      const key = keys.get(hit.id);
      return formatDoorLine(hit.id, { open: row.open, locked: row.locked, ...(key ? { key } : {}) });
    }
    if (hit.kind === "pickup") {
      return formatPickupLine(hit.id, kinds.get(hit.id) ?? hit.metadata.pickupKind, remaining.has(hit.id));
    }
    if (hit.kind === "pawn") return formatPawnLine(hit.id, hit.metadata.name, hit.metadata.model);
    if (hit.kind === "prop") return `prop ${hit.id}`;
    return `collision ${hit.id}`;
  };

  return {
    onDoors(rows) {
      for (const row of rows) live.set(row.id, { open: row.open === true, locked: row.locked === true });
    },
    onDoor(row) {
      live.set(row.id, { open: row.open === true, locked: row.locked === true });
    },
    onPickupSet(ids) {
      remaining = new Set(ids);
    },
    onPickupGone(id) {
      remaining.delete(id);
    },
    onSceneGraph(frame) {
      if (!frame) {
        graph = undefined;
        return;
      }
      graph = parseSceneGraph(frame.graph, opts.doors).graph;
    },
    doorLive(id) {
      const row = live.get(id);
      return row ? { open: row.open, locked: row.locked } : undefined;
    },
    pickupAvailable(id) {
      return remaining.has(id);
    },
    get graph() {
      return graph;
    },
    inspect(args) {
      const hit = pickInfoTarget(args.origin, args.direction, args.candidates, args.range ?? INFO_RANGE_M);
      shown = { until: args.now + INFO_SHOW_MS, ...(hit ? { hit } : {}) };
      return text(args.own, args.cabs);
    },
    refresh(now, own, cabs) {
      if (!shown) return "";
      if (!(now < shown.until)) {
        shown = undefined;
        return "";
      }
      return text(own, cabs);
    },
  };
}

function preferred(next: InfoHit, prev: InfoHit): boolean {
  if (next.distance < prev.distance - TIE_M) return true;
  if (next.distance > prev.distance + TIE_M) return false;
  const rank = RANK[next.kind] - RANK[prev.kind];
  if (rank !== 0) return rank < 0;
  return next.id < prev.id;
}

function finiteVec(v: Vec3): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

function finiteOwn(v: InfoOwn): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

function candidateBox(candidate: InfoCandidate): Aabb | undefined {
  if (!finiteVec(candidate.min) || !finiteVec(candidate.max)) return undefined;
  if (!candidate.id) return undefined;
  return {
    minX: Math.min(candidate.min.x, candidate.max.x),
    maxX: Math.max(candidate.min.x, candidate.max.x),
    minY: Math.min(candidate.min.y, candidate.max.y),
    maxY: Math.max(candidate.min.y, candidate.max.y),
    minZ: Math.min(candidate.min.z, candidate.max.z),
    maxZ: Math.max(candidate.min.z, candidate.max.z),
  };
}

/** Entry distance along a unit ray. Inside the box is 0. Behind the ray is a miss. */
function rayEnter(origin: Vec3, dir: Vec3, box: Aabb, maxT: number): number | undefined {
  let tmin = 0;
  let tmax = maxT;
  const axes: Array<[number, number, number, number]> = [
    [origin.x, box.minX, box.maxX, dir.x],
    [origin.y, box.minY, box.maxY, dir.y],
    [origin.z, box.minZ, box.maxZ, dir.z],
  ];
  for (const [o, min, max, d] of axes) {
    if (Math.abs(d) < AXIS_EPS) {
      if (o < min || o > max) return undefined;
      continue;
    }
    let t1 = (min - o) / d;
    let t2 = (max - o) / d;
    if (t1 > t2) {
      const swap = t1;
      t1 = t2;
      t2 = swap;
    }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return undefined;
  }
  if (tmax < 0) return undefined;
  if (tmin < 0) return 0;
  if (tmin > maxT) return undefined;
  return tmin;
}

function fromAabb(kind: InfoKind, id: string, box: Aabb, metadata: InfoMetadata): InfoCandidate | undefined {
  return fromCorners(kind, id, { x: box.minX, y: box.minY, z: box.minZ }, { x: box.maxX, y: box.maxY, z: box.maxZ }, metadata);
}

function fromCorners(kind: InfoKind, id: string, min: Vec3, max: Vec3, metadata: InfoMetadata): InfoCandidate | undefined {
  if (!id || !finiteVec(min) || !finiteVec(max)) return undefined;
  return { kind, id, min, max, metadata };
}

function stripBox(source: string): string {
  return source.endsWith("-box") ? source.slice(0, -4) : source;
}

function propPlacement(source: string | undefined, props: ReadonlySet<string>): string | undefined {
  if (!source) return undefined;
  if (props.has(source)) return source;
  const bare = stripBox(source);
  if (bare !== source && props.has(bare)) return bare;
  return undefined;
}
