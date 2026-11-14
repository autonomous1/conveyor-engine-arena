/**
 * Scene graph loaded from `scene.sceneGraph`. Privileged: it stays off `ArenaView`.
 * Walk places are metres, y-up. A shaft and its cab room share the stop footprint,
 * so lookup uses `<shaft>@<i>` instead of either of those.
 */
// ARCHITECTURE: The privileged scene graph: places, portals, cab state,
//   canonical JSON, and the file validator.
// Wiring: server/world-loader.ts loads it; server/game.ts and
//   server/bot-brain.ts query places; shared/nav/* route through it.
import type { ArenaView } from "./arena-view.js";
import { pointInPolygon, RIDE_Y_TOL_M, type ElevatorPhase } from "./elevators.js";

export type Vec3 = [number, number, number];

export type PlaceKind = "room" | "hall" | "platform" | "stairs" | "elevator" | "landing";

/** One walkable region. Stairs and elevators add the fields on {@link StairsPlace} and {@link ElevatorPlace}. */
export type ScenePlace = {
  id: string;
  kind: PlaceKind;
  building?: string;
  floor?: string;
  /** Walkable elevation in world metres (y). */
  y: number;
  /** World XZ polygon, counter-clockwise. */
  polygon: Array<[number, number]>;
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
};

/** A stair run. `top` and the landing `y` values are world metres. */
export type StairsPlace = ScenePlace & {
  kind: "stairs";
  /** World y of the top of the run. */
  top: number;
  width: number;
  run: number;
  landings: { bottom: Vec3; top: Vec3 };
  /** Place ids. Absent when that end is outside ground or matches no place. */
  joins: { from?: string; to?: string };
};

/** An elevator shaft. `stops` and landing `y` values are world metres. */
export type ElevatorPlace = ScenePlace & {
  kind: "elevator";
  /** World y, ascending. */
  stops: number[];
  waitS: number;
  speed: number;
  /** One landing per stop. */
  landings: Vec3[];
  /** One place id per stop. JSON `null` is stored as a hole. */
  joins: Array<string | undefined>;
  /** Room placement that rides with the cab. Absent when no room covers the shaft. */
  room?: string;
};

export type AnyPlace = ScenePlace | StairsPlace | ElevatorPlace;

export type PortalKind = "door" | "landing" | "elevator" | "opening";

export type ScenePortal = {
  id: string;
  kind: PortalKind;
  a: string;
  b: string;
  /** Door placement id. Set when `kind` is `"door"`. */
  door?: string;
  /** Copied from the door. Omitted when the leaf is not locked. */
  locked?: boolean;
  /** Pickup placement id that unlocks a locked door. */
  key?: string;
  at: { a: Vec3; b: Vec3 };
  width: number;
  /** Metres-equivalent. An elevator portal adds `waitS`. */
  cost: number;
};

export type OutsidePlace = {
  id: "outside";
  kind: "outside";
  y: 0;
  polygon: Array<[number, number]>;
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
};

export type SceneGraphFile = {
  formatVersion: 1;
  units: "meters";
  places: Array<AnyPlace | OutsidePlace>;
  /** Sorted by `id`. */
  portals: ScenePortal[];
};

/**
 * Cab fields `placeAt` reads. Matches `ElevatorRuntime` without the queue.
 * @see ElevatorRuntime
 */
export type CabState = {
  id: string;
  at: number;
  target?: number;
  phase: ElevatorPhase;
  y: number;
};

export type SceneGraph = SceneGraphFile & {
  placeById: Map<string, AnyPlace | OutsidePlace>;
  /** Both ends of each portal, sorted by portal id. */
  portalsOf: Map<string, ScenePortal[]>;
  shafts: ElevatorPlace[];
  /** Shaft ids and `shaft.room` ids. The static pass skips these. */
  skip: Set<string>;
};

/**
 * File shape only.
 * @post Drops the runtime maps on `SceneGraph`.
 */
export function sceneGraphPayload(graph: SceneGraph): SceneGraphFile {
  return {
    formatVersion: graph.formatVersion,
    units: graph.units,
    places: graph.places,
    portals: graph.portals,
  };
}

/**
 * @invariant Object keys are sorted, array order is kept, and `undefined` is
 *            omitted, so equal values hash the same.
 *            (test: canonical_json_is_stable)
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  const rec = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(rec).sort()) {
    const item = rec[key];
    if (item === undefined) continue;
    out[key] = canonicalize(item);
  }
  return out;
}

/**
 * Hex SHA-256.
 * @why `crypto.subtle` is global in Node 22 and the browser.
 */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  let hex = "";
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

type Issue = { path: string; message: string };

const PLACE_KINDS = new Set<string>(["room", "hall", "platform", "stairs", "elevator", "landing", "outside"]);
const PORTAL_KINDS = new Set<string>(["door", "landing", "elevator", "opening"]);
const NO_PORTALS: ScenePortal[] = [];

export function isElevatorShaft(p: AnyPlace | OutsidePlace): p is ElevatorPlace {
  return p.kind === "elevator" && "stops" in p;
}

function isStairs(p: AnyPlace | OutsidePlace): p is StairsPlace {
  return p.kind === "stairs" && "top" in p;
}

/**
 * `<shaft>@<index>` from the last `@`.
 * @post Anything else is not a stop id.
 */
export function stopOf(id: string): { shaft: string; index: number } | undefined {
  const at = id.lastIndexOf("@");
  if (at <= 0) return undefined;
  const rest = id.slice(at + 1);
  if (!/^\d+$/.test(rest)) return undefined;
  return { shaft: id.slice(0, at), index: Number(rest) };
}

export function portalsOf(graph: SceneGraph, placeId: string): ScenePortal[] {
  return graph.portalsOf.get(placeId) ?? NO_PORTALS;
}

/**
 * Place under the feet, or `outside`.
 * Static places match the polygon and `y − 0.5 … y + 1.5`. Stairs run up to `top + 0.5`.
 * The smallest polygon wins, then the lower id. With `cabs`, a pawn on a cab is
 * that stop, or the shaft id while the cab is moving.
 * @why Shafts and cab rooms are skipped so a stop place is not shadowed.
 */
export function placeAt(
  graph: SceneGraph,
  x: number,
  feetY: number,
  z: number,
  cabs?: readonly CabState[],
): AnyPlace | OutsidePlace {
  if (cabs) {
    for (const cab of cabs) {
      const shaft = graph.placeById.get(cab.id);
      if (!shaft || !isElevatorShaft(shaft)) continue;
      if (Math.abs(feetY - cab.y) >= RIDE_Y_TOL_M) continue;
      if (!pointInPolygon(shaft.polygon, x, z)) continue;
      if (cab.phase === "moving") return shaft;
      const stop = graph.placeById.get(`${cab.id}@${cab.at}`);
      if (stop) return stop;
    }
  }
  let best: AnyPlace | undefined;
  let bestArea = Infinity;
  for (const place of graph.places) {
    if (place.kind === "outside" || graph.skip.has(place.id)) continue;
    const highest = isStairs(place) ? place.top + 0.5 : place.y + 1.5;
    if (place.y > feetY + 0.5 || feetY > highest) continue;
    if (x < place.bounds.minX || x > place.bounds.maxX || z < place.bounds.minZ || z > place.bounds.maxZ) continue;
    if (!pointInPolygon(place.polygon, x, z)) continue;
    const area = polygonArea(place.polygon);
    if (area < bestArea || (area === bestArea && best && place.id < best.id)) {
      best = place;
      bestArea = area;
    }
  }
  return best ?? graph.placeById.get("outside")!;
}

/**
 * Validate a scene-graph file against the compiled doors.
 * @post Structural problems leave `graph` unset. A door whose `locked` or `key`
 *       disagrees is reported and rewritten from the door, and the graph still
 *       loads.
 */
export function parseSceneGraph(
  value: unknown,
  doors: ArenaView["doors"],
): { graph?: SceneGraph; issues: Issue[] } {
  const issues: Issue[] = [];
  if (!isObject(value)) {
    issues.push({ path: "scene.sceneGraph", message: "must be an object" });
    return { issues };
  }
  if (value.formatVersion !== 1) issues.push({ path: "scene.sceneGraph.formatVersion", message: "must be 1" });
  if (value.units !== "meters") issues.push({ path: "scene.sceneGraph.units", message: "must be meters" });
  const placeList = value.places;
  const portalList = value.portals;
  if (!Array.isArray(placeList)) issues.push({ path: "scene.sceneGraph.places", message: "required array" });
  if (!Array.isArray(portalList)) issues.push({ path: "scene.sceneGraph.portals", message: "required array" });
  if (issues.length || !Array.isArray(placeList) || !Array.isArray(portalList)) return { issues };

  const seenPlaces = new Set<string>();
  const places: Array<AnyPlace | OutsidePlace> = [];
  placeList.forEach((item, index) => {
    const place = readPlace(item, index, seenPlaces, issues);
    if (place) places.push(place);
  });
  const outsideCount = places.filter((place) => place.kind === "outside").length;
  if (outsideCount !== 1) issues.push({ path: "scene.sceneGraph.places", message: "exactly one outside place" });

  const placeById = new Map(places.map((place) => [place.id, place]));
  for (const place of places) {
    if (isElevatorShaft(place)) checkShaft(place, placeById, issues);
    if (isStairs(place)) checkStairJoins(place, placeById, issues);
  }

  const seenPortals = new Set<string>();
  const portals: ScenePortal[] = [];
  portalList.forEach((item, index) => {
    const portal = readPortal(item, index, seenPortals, placeById, issues);
    if (portal) portals.push(portal);
  });

  const warnings: Issue[] = [];
  const doorById = new Map(doors.map((door) => [door.id, door]));
  for (const portal of portals) {
    if (portal.kind !== "door" || !portal.door) continue;
    const door = doorById.get(portal.door);
    if (!door) {
      issues.push({ path: `scene.sceneGraph.portals.${portal.id}`, message: `unknown door ${portal.door}` });
      continue;
    }
    if (locksMatch(portal, door)) continue;
    warnings.push({
      path: `scene.sceneGraph.portals.${portal.id}`,
      message: "locked disagrees with the door placement",
    });
    applyDoorLock(portal, door);
  }

  if (issues.length) return { issues: [...issues, ...warnings] };
  portals.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { graph: indexGraph(places, portals), issues: warnings };
}

function indexGraph(places: Array<AnyPlace | OutsidePlace>, portals: ScenePortal[]): SceneGraph {
  const placeById = new Map(places.map((place) => [place.id, place]));
  const linked = new Map<string, ScenePortal[]>();
  for (const portal of portals) {
    pushPortal(linked, portal.a, portal);
    if (portal.b !== portal.a) pushPortal(linked, portal.b, portal);
  }
  const shafts = places.filter(isElevatorShaft);
  const skip = new Set<string>();
  for (const shaft of shafts) {
    skip.add(shaft.id);
    if (shaft.room) skip.add(shaft.room);
  }
  return { formatVersion: 1, units: "meters", places, portals, placeById, portalsOf: linked, shafts, skip };
}

function pushPortal(map: Map<string, ScenePortal[]>, id: string, portal: ScenePortal): void {
  const list = map.get(id);
  if (list) list.push(portal);
  else map.set(id, [portal]);
}

function checkShaft(shaft: ElevatorPlace, places: Map<string, AnyPlace | OutsidePlace>, issues: Issue[]): void {
  for (let i = 1; i < shaft.stops.length; i += 1) {
    if (!(shaft.stops[i]! > shaft.stops[i - 1]!)) {
      issues.push({ path: `scene.sceneGraph.places.${shaft.id}.stops`, message: "stops must increase" });
      break;
    }
  }
  if (shaft.landings.length !== shaft.stops.length) {
    issues.push({ path: `scene.sceneGraph.places.${shaft.id}.landings`, message: "must match stops" });
  }
  if (shaft.joins.length !== shaft.stops.length) {
    issues.push({ path: `scene.sceneGraph.places.${shaft.id}.joins`, message: "must match stops" });
  }
  for (let i = 0; i < shaft.stops.length; i += 1) {
    const stopId = `${shaft.id}@${i}`;
    if (!places.has(stopId)) {
      issues.push({ path: `scene.sceneGraph.places.${shaft.id}`, message: `missing stop place ${stopId}` });
    }
    const join = shaft.joins[i];
    if (join && !places.has(join)) {
      issues.push({ path: `scene.sceneGraph.places.${shaft.id}.joins[${i}]`, message: `unknown place ${join}` });
    }
  }
  if (!shaft.room) return;
  const room = places.get(shaft.room);
  if (!room || room.kind !== "room") {
    issues.push({ path: `scene.sceneGraph.places.${shaft.id}.room`, message: "must be a room place" });
  }
}

function checkStairJoins(stair: StairsPlace, places: Map<string, AnyPlace | OutsidePlace>, issues: Issue[]): void {
  for (const end of ["from", "to"] as const) {
    const id = stair.joins[end];
    if (id && !places.has(id)) {
      issues.push({ path: `scene.sceneGraph.places.${stair.id}.joins.${end}`, message: `unknown place ${id}` });
    }
  }
}

function locksMatch(portal: ScenePortal, door: ArenaView["doors"][number]): boolean {
  if ((portal.locked === true) !== (door.locked === true)) return false;
  return (portal.key ?? undefined) === (door.key ?? undefined);
}

/** The compiled door wins. The portal keeps that leaf's lock. */
function applyDoorLock(portal: ScenePortal, door: ArenaView["doors"][number]): void {
  if (door.locked === true) portal.locked = true;
  else delete portal.locked;
  if (typeof door.key === "string" && door.key.length > 0) portal.key = door.key;
  else delete portal.key;
}

function readPlace(
  value: unknown,
  index: number,
  seen: Set<string>,
  issues: Issue[],
): AnyPlace | OutsidePlace | undefined {
  const id = isObject(value) && typeof value.id === "string" && value.id ? value.id : undefined;
  const path = id ? `scene.sceneGraph.places.${id}` : `scene.sceneGraph.places[${index}]`;
  if (!isObject(value)) {
    issues.push({ path, message: "must be an object" });
    return undefined;
  }
  if (!id) issues.push({ path: `${path}.id`, message: "required string" });
  if (id && seen.has(id)) {
    issues.push({ path, message: "duplicate id" });
    return undefined;
  }
  if (id) seen.add(id);
  const kind = typeof value.kind === "string" ? value.kind : undefined;
  if (!kind || !PLACE_KINDS.has(kind)) {
    issues.push({ path: `${path}.kind`, message: "unknown kind" });
    return undefined;
  }
  if (kind === "outside" && id !== "outside") {
    issues.push({ path, message: "id must be outside" });
    return undefined;
  }
  const y = finite(value.y);
  if (y === undefined) issues.push({ path: `${path}.y`, message: "required finite number" });
  const polygon = readPolygon(value.polygon, `${path}.polygon`, issues);
  const bounds = readBounds(value.bounds, `${path}.bounds`, issues);
  const building = optionalName(value, "building", `${path}.building`, issues);
  const floor = optionalName(value, "floor", `${path}.floor`, issues);
  if (!id || y === undefined || !polygon || !bounds || !building.ok || !floor.ok) return undefined;
  const base = {
    id,
    y,
    polygon,
    bounds,
    ...(building.value ? { building: building.value } : {}),
    ...(floor.value ? { floor: floor.value } : {}),
  };
  if (kind === "outside") {
    if (y !== 0) issues.push({ path: `${path}.y`, message: "must be 0" });
    if (y !== 0) return undefined;
    return { ...base, id: "outside", kind: "outside", y: 0 };
  }
  if (kind === "stairs") return readStairs(value, path, base, issues);
  if (kind === "elevator" && Object.prototype.hasOwnProperty.call(value, "stops")) {
    return readShaft(value, path, base, issues);
  }
  if (kind === "room" || kind === "hall" || kind === "platform" || kind === "elevator" || kind === "landing") {
    return { ...base, kind };
  }
  return undefined;
}

function readStairs(
  value: Record<string, unknown>,
  path: string,
  base: Omit<ScenePlace, "kind">,
  issues: Issue[],
): StairsPlace | undefined {
  const top = finite(value.top);
  const width = finite(value.width);
  const run = finite(value.run);
  if (top === undefined) issues.push({ path: `${path}.top`, message: "required finite number" });
  if (width === undefined) issues.push({ path: `${path}.width`, message: "required finite number" });
  if (run === undefined) issues.push({ path: `${path}.run`, message: "required finite number" });
  const landings = isObject(value.landings) ? value.landings : undefined;
  if (!landings) issues.push({ path: `${path}.landings`, message: "must be an object" });
  const bottom = landings ? readVec3(landings.bottom, `${path}.landings.bottom`, issues) : undefined;
  const landingTop = landings ? readVec3(landings.top, `${path}.landings.top`, issues) : undefined;
  const joins = isObject(value.joins) ? value.joins : undefined;
  if (!joins) issues.push({ path: `${path}.joins`, message: "must be an object" });
  const from = joins ? optionalName(joins, "from", `${path}.joins.from`, issues) : { ok: false as const };
  const to = joins ? optionalName(joins, "to", `${path}.joins.to`, issues) : { ok: false as const };
  if (top === undefined || width === undefined || run === undefined || !bottom || !landingTop || !from.ok || !to.ok) return undefined;
  return {
    ...base,
    kind: "stairs",
    top,
    width,
    run,
    landings: { bottom, top: landingTop },
    joins: { ...(from.value ? { from: from.value } : {}), ...(to.value ? { to: to.value } : {}) },
  };
}

function readShaft(
  value: Record<string, unknown>,
  path: string,
  base: Omit<ScenePlace, "kind">,
  issues: Issue[],
): ElevatorPlace | undefined {
  const stops = readNums(value.stops, `${path}.stops`, issues);
  const waitS = finite(value.waitS);
  const speed = finite(value.speed);
  if (waitS === undefined) issues.push({ path: `${path}.waitS`, message: "required finite number" });
  if (speed === undefined) issues.push({ path: `${path}.speed`, message: "required finite number" });
  const landings = readLandings(value.landings, `${path}.landings`, issues);
  const joins = readJoins(value.joins, `${path}.joins`, issues);
  const room = optionalName(value, "room", `${path}.room`, issues);
  if (!stops || waitS === undefined || speed === undefined || !landings || !joins || !room.ok) return undefined;
  return {
    ...base,
    kind: "elevator",
    stops,
    waitS,
    speed,
    landings,
    joins,
    ...(room.value ? { room: room.value } : {}),
  };
}

function readPortal(
  value: unknown,
  index: number,
  seen: Set<string>,
  places: Map<string, AnyPlace | OutsidePlace>,
  issues: Issue[],
): ScenePortal | undefined {
  const id = isObject(value) && typeof value.id === "string" && value.id ? value.id : undefined;
  const path = id ? `scene.sceneGraph.portals.${id}` : `scene.sceneGraph.portals[${index}]`;
  if (!isObject(value)) {
    issues.push({ path, message: "must be an object" });
    return undefined;
  }
  if (!id) issues.push({ path: `${path}.id`, message: "required string" });
  if (id && seen.has(id)) {
    issues.push({ path, message: "duplicate id" });
    return undefined;
  }
  if (id) seen.add(id);
  const kind = typeof value.kind === "string" ? value.kind : undefined;
  if (!kind || !PORTAL_KINDS.has(kind)) {
    issues.push({ path: `${path}.kind`, message: "unknown kind" });
    return undefined;
  }
  const a = typeof value.a === "string" && value.a ? value.a : undefined;
  const b = typeof value.b === "string" && value.b ? value.b : undefined;
  if (!a) issues.push({ path: `${path}.a`, message: "required string" });
  if (!b) issues.push({ path: `${path}.b`, message: "required string" });
  if (a && !places.has(a)) issues.push({ path: `${path}.a`, message: `unknown place ${a}` });
  if (b && !places.has(b)) issues.push({ path: `${path}.b`, message: `unknown place ${b}` });
  const at = isObject(value.at) ? value.at : undefined;
  if (!at) issues.push({ path: `${path}.at`, message: "must be an object" });
  const atA = at ? readVec3(at.a, `${path}.at.a`, issues) : undefined;
  const atB = at ? readVec3(at.b, `${path}.at.b`, issues) : undefined;
  const width = finite(value.width);
  const cost = finite(value.cost);
  if (width === undefined) issues.push({ path: `${path}.width`, message: "required finite number" });
  if (cost === undefined) issues.push({ path: `${path}.cost`, message: "required finite number" });
  let door: string | undefined;
  if (kind === "door") {
    if (typeof value.door !== "string" || value.door.length === 0) {
      issues.push({ path: `${path}.door`, message: "unknown door" });
    } else {
      door = value.door;
    }
  }
  const locked = optionalBool(value.locked, `${path}.locked`, issues);
  const key = optionalName(value, "key", `${path}.key`, issues);
  if (!id || !a || !b || !places.has(a) || !places.has(b) || !atA || !atB || width === undefined || cost === undefined || !locked.ok || !key.ok) {
    return undefined;
  }
  if (kind === "door" && !door) return undefined;
  const portal: ScenePortal = {
    id,
    kind: kind as PortalKind,
    a,
    b,
    ...(door ? { door } : {}),
    ...(locked.value ? { locked: true } : {}),
    ...(key.value ? { key: key.value } : {}),
    at: { a: atA, b: atB },
    width,
    cost,
  };
  return portal;
}

function readJoins(value: unknown, path: string, issues: Issue[]): Array<string | undefined> | undefined {
  if (!Array.isArray(value)) {
    issues.push({ path, message: "required array" });
    return undefined;
  }
  const out: Array<string | undefined> = [];
  for (let i = 0; i < value.length; i += 1) {
    const item = value[i];
    if (item === null || item === undefined) {
      out.push(undefined);
      continue;
    }
    if (typeof item !== "string" || item.length === 0) {
      issues.push({ path: `${path}[${i}]`, message: "must be a place id" });
      return undefined;
    }
    out.push(item);
  }
  return out;
}

function readLandings(value: unknown, path: string, issues: Issue[]): Vec3[] | undefined {
  if (!Array.isArray(value)) {
    issues.push({ path, message: "required array" });
    return undefined;
  }
  const out: Vec3[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const point = readVec3(value[i], `${path}[${i}]`, issues);
    if (!point) return undefined;
    out.push(point);
  }
  return out;
}

function readNums(value: unknown, path: string, issues: Issue[]): number[] | undefined {
  if (!Array.isArray(value)) {
    issues.push({ path, message: "required array" });
    return undefined;
  }
  const out: number[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const item = finite(value[i]);
    if (item === undefined) {
      issues.push({ path: `${path}[${i}]`, message: "required finite number" });
      return undefined;
    }
    out.push(item);
  }
  return out;
}

function readPolygon(value: unknown, path: string, issues: Issue[]): Array<[number, number]> | undefined {
  if (!Array.isArray(value) || value.length < 3) {
    issues.push({ path, message: "needs at least three points" });
    return undefined;
  }
  const out: Array<[number, number]> = [];
  for (let i = 0; i < value.length; i += 1) {
    const item = value[i];
    const at = `${path}[${i}]`;
    if (!Array.isArray(item) || item.length !== 2) {
      issues.push({ path: at, message: "must be [x,z]" });
      return undefined;
    }
    const x = finite(item[0]);
    const z = finite(item[1]);
    if (x === undefined || z === undefined) {
      issues.push({ path: at, message: "required finite number" });
      return undefined;
    }
    out.push([x, z]);
  }
  return out;
}

function readBounds(
  value: unknown,
  path: string,
  issues: Issue[],
): { minX: number; maxX: number; minZ: number; maxZ: number } | undefined {
  if (!isObject(value)) {
    issues.push({ path, message: "must be an object" });
    return undefined;
  }
  const minX = finite(value.minX);
  const maxX = finite(value.maxX);
  const minZ = finite(value.minZ);
  const maxZ = finite(value.maxZ);
  if (minX === undefined || maxX === undefined || minZ === undefined || maxZ === undefined) {
    issues.push({ path, message: "required finite number" });
    return undefined;
  }
  return { minX, maxX, minZ, maxZ };
}

function readVec3(value: unknown, path: string, issues: Issue[]): Vec3 | undefined {
  if (!Array.isArray(value) || value.length !== 3) {
    issues.push({ path, message: "must be [x,y,z]" });
    return undefined;
  }
  const x = finite(value[0]);
  const y = finite(value[1]);
  const z = finite(value[2]);
  if (x === undefined || y === undefined || z === undefined) {
    issues.push({ path, message: "required finite number" });
    return undefined;
  }
  return [x, y, z];
}

function optionalName(
  value: Record<string, unknown>,
  key: string,
  path: string,
  issues: Issue[],
): { ok: true; value?: string } | { ok: false } {
  if (!Object.prototype.hasOwnProperty.call(value, key) || value[key] === undefined || value[key] === null) {
    return { ok: true };
  }
  if (typeof value[key] !== "string" || value[key].length === 0) {
    issues.push({ path, message: "must be a non-empty string" });
    return { ok: false };
  }
  return { ok: true, value: value[key] };
}

function optionalBool(value: unknown, path: string, issues: Issue[]): { ok: true; value: boolean } | { ok: false } {
  if (value === undefined || value === null) return { ok: true, value: false };
  if (typeof value !== "boolean") {
    issues.push({ path, message: "must be true or false" });
    return { ok: false };
  }
  return { ok: true, value };
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function polygonArea(polygon: ReadonlyArray<readonly [number, number]>): number {
  let sum = 0;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    sum += polygon[j]![0] * polygon[i]![1] - polygon[i]![0] * polygon[j]![1];
  }
  return Math.abs(sum) / 2;
}
