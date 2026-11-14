/**
 * Search and door overlay for a baked region adjacency graph.
 * The partition is written by blueprint-scene (`regions.json`). Nothing here
 * rebuilds it. A shut door drops any portal whose usable segment meets the leaf.
 * Task 26 turns a path into movement waypoints. Nothing here walks.
 */
// ARCHITECTURE: Baked region adjacency: search, shut-door overlay, and the
//   region-file parser.
// Wiring: server/world-loader.ts loads the bake; server/game.ts and
//   server/bot-brain.ts query; shared/nav/funnel.ts and shared/nav/legs.ts
//   consume overlays.
import { doorLeafBox, type DoorRuntime } from "../doors.js";
import { STEP_HEIGHT } from "../movements.js";
import type { Vec3 } from "../scene-graph.js";

/** A point this far from a region still counts as standing in it. */
const SNAP = 0.5;
/** Vertical slack when a point is matched to a region's floor. */
const Y_BAND = STEP_HEIGHT;

export type Region = {
  id: string;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  y: number;
};

export type RegionPortal = {
  from: string;
  to: string;
  /** Usable shared-boundary endpoints (already inset by radius). */
  left: Vec3;
  right: Vec3;
  width: number;
};

export type RegionGraph = {
  placeId: string;
  regions: Region[];
  portals: RegionPortal[];
};

export type RegionPath = {
  start: Vec3;
  goal: Vec3;
  /** Ordered region ids, start region through goal region. */
  regions: string[];
  /** Ordered apertures: portals[i] connects regions[i] to regions[i + 1]. */
  portals: RegionPortal[];
};

export type DoorStand = {
  doorId: string;
  side: "a" | "b";
  regionId: string;
  at: Vec3;
};

export type BakedPlaceRegions = {
  placeId: string;
  regions: Region[];
  portals: RegionPortal[];
  doorStands?: DoorStand[];
};

export type BakedRegionsFile = {
  version: 1;
  radius: number;
  height: number;
  places: BakedPlaceRegions[];
};

export type RegionIssue = { path: string; message: string };

export type RegionDoor = Pick<DoorRuntime, "id" | "position" | "yaw" | "hinge" | "size">;

/** Reused region graphs, keyed like the occupancy grids. */
export type RegionCache = {
  /** Live graph, or undefined. Does not create a row. */
  get(key: string): RegionGraph | undefined;
  /** Stores `graph` by reference. `misses` increments only the first time this key is stored. */
  set(key: string, graph: RegionGraph): void;
  /** First-time `set` count. A later `set` of the same key does not increment. */
  misses: number;
};

type Box = { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number };

export function createRegionCache(): RegionCache {
  const graphs = new Map<string, RegionGraph>();
  const cache: RegionCache = {
    misses: 0,
    get(key) {
      return graphs.get(key);
    },
    set(key, graph) {
      if (!graphs.has(key)) cache.misses += 1;
      graphs.set(key, graph);
    },
  };
  return cache;
}

export function regionsOf(file: BakedRegionsFile, placeId: string): RegionGraph | undefined {
  const place = file.places.find((item) => item.placeId === placeId);
  if (!place) return undefined;
  return { placeId: place.placeId, regions: place.regions, portals: place.portals };
}

export function indexRegions(file: BakedRegionsFile): Map<string, RegionGraph> {
  const map = new Map<string, RegionGraph>();
  for (const place of file.places) {
    map.set(place.placeId, { placeId: place.placeId, regions: place.regions, portals: place.portals });
  }
  return map;
}

/**
 * Drop portals a shut leaf covers.
 * @post An open door leaves the bake unchanged; the returned graph shares
 *       `regions` with `graph`. Cab motion is not applied here.
 */
export function overlayShutDoors(
  graph: RegionGraph,
  doors: readonly RegionDoor[],
  shut: ReadonlySet<string>,
): RegionGraph {
  if (shut.size === 0 || graph.portals.length === 0) return graph;
  const leaves: Box[] = [];
  for (const door of doors) {
    if (!shut.has(door.id)) continue;
    leaves.push(doorLeafBox(door));
  }
  if (leaves.length === 0) return graph;
  const portals = graph.portals.filter((portal) => !leaves.some((leaf) => segmentHitsBox(portal.left, portal.right, leaf)));
  if (portals.length === graph.portals.length) return graph;
  return { placeId: graph.placeId, regions: graph.regions, portals };
}

/**
 * `scene.regions` file.
 * @post Absent and invalid are the caller's problem; this only parses.
 */
export function parseBakedRegions(value: unknown): { file?: BakedRegionsFile; issues: RegionIssue[] } {
  const issues: RegionIssue[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    issues.push({ path: "scene.regions", message: "must be an object" });
    return { issues };
  }
  const rec = value as Record<string, unknown>;
  if (rec.version !== 1) issues.push({ path: "scene.regions.version", message: "must be 1" });
  if (typeof rec.radius !== "number" || !Number.isFinite(rec.radius) || rec.radius <= 0) {
    issues.push({ path: "scene.regions.radius", message: "must be a positive number" });
  }
  if (typeof rec.height !== "number" || !Number.isFinite(rec.height) || rec.height <= 0) {
    issues.push({ path: "scene.regions.height", message: "must be a positive number" });
  }
  if (!Array.isArray(rec.places)) {
    issues.push({ path: "scene.regions.places", message: "required array" });
    return { issues };
  }
  const places: BakedPlaceRegions[] = [];
  const seen = new Set<string>();
  rec.places.forEach((item, index) => {
    const parsed = parsePlace(item, index, issues);
    if (!parsed) return;
    if (seen.has(parsed.placeId)) {
      issues.push({ path: `scene.regions.places.${parsed.placeId}`, message: "duplicate id" });
      return;
    }
    seen.add(parsed.placeId);
    places.push(parsed);
  });
  if (issues.length) return { issues };
  return {
    file: {
      version: 1,
      radius: rec.radius as number,
      height: rec.height as number,
      places,
    },
    issues,
  };
}

function parsePlace(value: unknown, index: number, issues: RegionIssue[]): BakedPlaceRegions | undefined {
  const path = `scene.regions.places[${index}]`;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    issues.push({ path, message: "must be an object" });
    return undefined;
  }
  const rec = value as Record<string, unknown>;
  if (typeof rec.placeId !== "string" || rec.placeId.length === 0) {
    issues.push({ path: `${path}.placeId`, message: "required string" });
    return undefined;
  }
  if (!Array.isArray(rec.regions) || !Array.isArray(rec.portals)) {
    issues.push({ path, message: "regions and portals are required" });
    return undefined;
  }
  const regions: Region[] = [];
  const ids = new Set<string>();
  let ok = true;
  rec.regions.forEach((item, regionIndex) => {
    const region = parseRegion(item, `${path}.regions[${regionIndex}]`, issues);
    if (!region) {
      ok = false;
      return;
    }
    if (ids.has(region.id)) {
      issues.push({ path: `${path}.regions.${region.id}`, message: "duplicate id" });
      ok = false;
      return;
    }
    ids.add(region.id);
    regions.push(region);
  });
  const portals: RegionPortal[] = [];
  rec.portals.forEach((item, portalIndex) => {
    const portal = parsePortal(item, `${path}.portals[${portalIndex}]`, ids, issues);
    if (!portal) ok = false;
    else portals.push(portal);
  });
  let doorStands: DoorStand[] | undefined;
  if (rec.doorStands !== undefined) {
    if (!Array.isArray(rec.doorStands)) {
      issues.push({ path: `${path}.doorStands`, message: "must be an array" });
      ok = false;
    } else {
      doorStands = [];
      rec.doorStands.forEach((item, standIndex) => {
        const stand = parseStand(item, `${path}.doorStands[${standIndex}]`, ids, issues);
        if (!stand) ok = false;
        else doorStands!.push(stand);
      });
    }
  }
  if (!ok) return undefined;
  return {
    placeId: rec.placeId,
    regions,
    portals,
    ...(doorStands && doorStands.length > 0 ? { doorStands } : {}),
  };
}

function parseRegion(value: unknown, path: string, issues: RegionIssue[]): Region | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    issues.push({ path, message: "must be an object" });
    return undefined;
  }
  const rec = value as Record<string, unknown>;
  const id = rec.id;
  const minX = num(rec.minX);
  const maxX = num(rec.maxX);
  const minZ = num(rec.minZ);
  const maxZ = num(rec.maxZ);
  const y = num(rec.y);
  if (typeof id !== "string" || id.length === 0 || minX === undefined || maxX === undefined || minZ === undefined || maxZ === undefined || y === undefined) {
    issues.push({ path, message: "id and bounds are required" });
    return undefined;
  }
  if (!(maxX > minX) || !(maxZ > minZ)) {
    issues.push({ path, message: "bounds are empty" });
    return undefined;
  }
  return { id, minX, maxX, minZ, maxZ, y };
}

function parsePortal(value: unknown, path: string, ids: ReadonlySet<string>, issues: RegionIssue[]): RegionPortal | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    issues.push({ path, message: "must be an object" });
    return undefined;
  }
  const rec = value as Record<string, unknown>;
  const from = rec.from;
  const to = rec.to;
  const left = vec(rec.left);
  const right = vec(rec.right);
  const width = num(rec.width);
  if (typeof from !== "string" || typeof to !== "string" || !left || !right || width === undefined || !(width > 0)) {
    issues.push({ path, message: "from, to, left, right, and width are required" });
    return undefined;
  }
  if (!ids.has(from) || !ids.has(to)) {
    issues.push({ path, message: "portal names an unknown region" });
    return undefined;
  }
  return { from, to, left, right, width };
}

function parseStand(value: unknown, path: string, ids: ReadonlySet<string>, issues: RegionIssue[]): DoorStand | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    issues.push({ path, message: "must be an object" });
    return undefined;
  }
  const rec = value as Record<string, unknown>;
  const at = vec(rec.at);
  if (typeof rec.doorId !== "string" || (rec.side !== "a" && rec.side !== "b") || typeof rec.regionId !== "string" || !at) {
    issues.push({ path, message: "doorId, side, regionId, and at are required" });
    return undefined;
  }
  if (!ids.has(rec.regionId)) {
    issues.push({ path, message: "stand names an unknown region" });
    return undefined;
  }
  return { doorId: rec.doorId, side: rec.side, regionId: rec.regionId, at };
}

function num(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value;
}

function vec(value: unknown): Vec3 | undefined {
  if (!Array.isArray(value) || value.length < 3) return undefined;
  const x = num(value[0]);
  const y = num(value[1]);
  const z = num(value[2]);
  if (x === undefined || y === undefined || z === undefined) return undefined;
  return [x, y, z];
}

function segmentHitsBox(a: Vec3, b: Vec3, box: Box): boolean {
  let t0 = 0;
  let t1 = 1;
  const axes: Array<[number, number, number, number]> = [
    [a[0], b[0] - a[0], box.minX, box.maxX],
    [a[1], b[1] - a[1], box.minY, box.maxY],
    [a[2], b[2] - a[2], box.minZ, box.maxZ],
  ];
  for (const [origin, delta, min, max] of axes) {
    if (Math.abs(delta) <= 1e-12) {
      if (origin < min - 1e-6 || origin > max + 1e-6) return false;
      continue;
    }
    let near = (min - origin) / delta;
    let far = (max - origin) / delta;
    if (near > far) {
      const swap = near;
      near = far;
      far = swap;
    }
    if (near > t0) t0 = near;
    if (far < t1) t1 = far;
    if (t0 > t1 + 1e-6) return false;
  }
  return true;
}


export function findRegionPath(graph: RegionGraph, start: Vec3, goal: Vec3): RegionPath | undefined {
  const from = locate(graph, start);
  const to = locate(graph, goal);
  if (!from || !to) return undefined;
  if (from.index === to.index) {
    return { start: from.point, goal: to.point, regions: [graph.regions[from.index]!.id], portals: [] };
  }
  const chain = search(graph, from.index, to.index);
  if (!chain) return undefined;
  const regions = chain.regions.map((index) => graph.regions[index]!.id);
  const portals: RegionPortal[] = [];
  for (let i = 0; i < chain.portals.length; i += 1) {
    const portal = graph.portals[chain.portals[i]!]!;
    portals.push(orient(portal, regions[i]!, regions[i + 1]!));
  }
  return { start: from.point, goal: to.point, regions, portals };
}

function orient(portal: RegionPortal, from: string, to: string): RegionPortal {
  if (portal.from === from && portal.to === to) {
    return { from, to, left: portal.left, right: portal.right, width: portal.width };
  }
  return { from, to, left: portal.right, right: portal.left, width: portal.width };
}

type Hit = { index: number; point: Vec3 };

function locate(graph: RegionGraph, point: Vec3): Hit | undefined {
  let inside: number | undefined;
  for (let i = 0; i < graph.regions.length; i += 1) {
    const region = graph.regions[i]!;
    if (!yNear(region.y, point[1])) continue;
    if (point[0] < region.minX || point[0] > region.maxX || point[2] < region.minZ || point[2] > region.maxZ) continue;
    if (inside === undefined || region.id < graph.regions[inside]!.id) inside = i;
  }
  if (inside !== undefined) return { index: inside, point: [point[0], point[1], point[2]] };

  let best = -1;
  let bestDist = SNAP;
  let bestId = "";
  let snapX = 0;
  let snapZ = 0;
  for (let i = 0; i < graph.regions.length; i += 1) {
    const region = graph.regions[i]!;
    if (!yNear(region.y, point[1])) continue;
    const x = clamp(point[0], region.minX, region.maxX);
    const z = clamp(point[2], region.minZ, region.maxZ);
    const dist = Math.hypot(x - point[0], z - point[2]);
    if (dist > SNAP) continue;
    if (best >= 0 && (dist > bestDist || (dist === bestDist && region.id >= bestId))) continue;
    best = i;
    bestDist = dist;
    bestId = region.id;
    snapX = x;
    snapZ = z;
  }
  if (best < 0) return undefined;
  return { index: best, point: [snapX, graph.regions[best]!.y, snapZ] };
}

function yNear(floorY: number, pointY: number): boolean {
  return Math.abs(pointY - floorY) <= Y_BAND + 1e-4;
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

type Chain = { regions: number[]; portals: number[] };

function search(graph: RegionGraph, start: number, goal: number): Chain | undefined {
  const count = graph.regions.length;
  const index = new Map<string, number>();
  for (let i = 0; i < count; i += 1) index.set(graph.regions[i]!.id, i);
  const adj: Array<Array<{ to: number; portal: number; id: string }>> = graph.regions.map(() => []);
  for (let portalIndex = 0; portalIndex < graph.portals.length; portalIndex += 1) {
    const portal = graph.portals[portalIndex]!;
    const a = index.get(portal.from);
    const b = index.get(portal.to);
    if (a === undefined || b === undefined || a === b) continue;
    const id = `${portal.from}|${portal.to}|${portal.left[0]}|${portal.left[2]}`;
    adj[a]!.push({ to: b, portal: portalIndex, id });
    adj[b]!.push({ to: a, portal: portalIndex, id });
  }
  for (const list of adj) {
    list.sort((p, q) => (p.to === q.to ? (p.id < q.id ? -1 : p.id > q.id ? 1 : 0) : regionBefore(graph, p.to, q.to) ? -1 : 1));
  }

  const g = new Float64Array(count);
  g.fill(Infinity);
  g[start] = 0;
  const parent = new Int32Array(count);
  parent.fill(-1);
  const via = new Int32Array(count);
  via.fill(-1);
  const closed = new Uint8Array(count);
  const goalC = centre(graph.regions[goal]!);
  const heapI: number[] = [start];
  const heapF: number[] = [Math.hypot(centre(graph.regions[start]!).x - goalC.x, centre(graph.regions[start]!).z - goalC.z)];

  while (heapI.length > 0) {
    const current = pop(heapI, heapF, graph);
    if (closed[current]) continue;
    closed[current] = 1;
    if (current === goal) break;
    const base = g[current]!;
    const here = centre(graph.regions[current]!);
    for (const link of adj[current]!) {
      if (closed[link.to]) continue;
      const there = centre(graph.regions[link.to]!);
      const cost = base + Math.hypot(there.x - here.x, there.z - here.z);
      if (!(cost < g[link.to]!)) continue;
      g[link.to] = cost;
      parent[link.to] = current;
      via[link.to] = link.portal;
      push(heapI, heapF, graph, link.to, cost + Math.hypot(there.x - goalC.x, there.z - goalC.z));
    }
  }
  if (!(g[goal]! < Infinity)) return undefined;

  const regions: number[] = [];
  const portals: number[] = [];
  for (let cursor = goal; cursor !== start; cursor = parent[cursor]!) {
    if (cursor < 0) return undefined;
    regions.push(cursor);
    portals.push(via[cursor]!);
  }
  regions.push(start);
  regions.reverse();
  portals.reverse();
  return { regions, portals };
}

function centre(region: Region): { x: number; z: number } {
  return { x: (region.minX + region.maxX) * 0.5, z: (region.minZ + region.maxZ) * 0.5 };
}

function regionBefore(graph: RegionGraph, a: number, b: number): boolean {
  const idA = graph.regions[a]!.id;
  const idB = graph.regions[b]!.id;
  return idA < idB;
}

function before(graph: RegionGraph, fA: number, iA: number, fB: number, iB: number): boolean {
  if (fA !== fB) return fA < fB;
  return regionBefore(graph, iA, iB);
}

function push(heapI: number[], heapF: number[], graph: RegionGraph, item: number, f: number): void {
  heapI.push(item);
  heapF.push(f);
  let index = heapI.length - 1;
  while (index > 0) {
    const up = (index - 1) >> 1;
    if (!before(graph, heapF[index]!, heapI[index]!, heapF[up]!, heapI[up]!)) break;
    swapHeap(heapI, heapF, index, up);
    index = up;
  }
}

function pop(heapI: number[], heapF: number[], graph: RegionGraph): number {
  const top = heapI[0]!;
  const lastI = heapI.pop()!;
  const lastF = heapF.pop()!;
  if (heapI.length === 0) return top;
  heapI[0] = lastI;
  heapF[0] = lastF;
  let index = 0;
  for (;;) {
    const left = index * 2 + 1;
    const right = left + 1;
    let best = index;
    if (left < heapI.length && before(graph, heapF[left]!, heapI[left]!, heapF[best]!, heapI[best]!)) best = left;
    if (right < heapI.length && before(graph, heapF[right]!, heapI[right]!, heapF[best]!, heapI[best]!)) best = right;
    if (best === index) break;
    swapHeap(heapI, heapF, index, best);
    index = best;
  }
  return top;
}

function swapHeap(heapI: number[], heapF: number[], a: number, b: number): void {
  const item = heapI[a]!;
  heapI[a] = heapI[b]!;
  heapI[b] = item;
  const score = heapF[a]!;
  heapF[a] = heapF[b]!;
  heapF[b] = score;
}
