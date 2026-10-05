import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

/** First free id for baked obstacles. Hand-authored collision stays below this. */
export const PLACEMENT_ID_START = 100;

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const RESERVED_IDS = new Set([10, 11, 12, 13]);

export type PlacementIssue = { path: string; message: string };

export type BakedBuilding = {
  id: string;
  model: string;
  position: [number, number, number];
  yaw: number;
  scale: number;
};

export type BakedBox = {
  id: number;
  sourceId: string;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
};

/** A hinged panel. It is not a building and it has no AABB. `model` is an asset id. */
export type BakedDoor = {
  id: string;
  model: string;
  position: [number, number, number];
  yaw: number;
  hinge: "left" | "right";
  size: [number, number, number];
  open: boolean;
};

/**
 * Resolve `scene.placements` against the arena root.
 * The file may live in this repo or in the sibling `blueprint-scene` checkout.
 * Absolute paths and anything outside those two trees are rejected.
 */
export function resolvePlacementsPath(root: string, ref: string): string {
  const trimmed = ref.trim();
  if (!trimmed || trimmed.includes("\0") || isAbsolute(trimmed)) {
    throw new Error("must be a relative path");
  }
  const file = resolve(root, trimmed);
  const bases = [resolve(root)];
  const sibling = resolve(root, "..", "blueprint-scene");
  if (existsSync(sibling)) bases.push(sibling);
  if (!bases.some((base) => inside(base, file))) {
    throw new Error(`path is outside the arena and blueprint-scene trees: ${trimmed}`);
  }
  if (!existsSync(file)) throw new Error(`file not found: ${trimmed}`);
  const realFile = realpathSync(file);
  const realBases = bases.map((base) => realpathSync(base));
  if (!realBases.some((base) => inside(base, realFile))) {
    throw new Error(`path is outside the arena and blueprint-scene trees: ${trimmed}`);
  }
  return realFile;
}

function inside(base: string, file: string): boolean {
  const rel = relative(base, file);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * Turn a blueprint-scene placements file into building instances and numbered AABBs.
 * `knownModels` is the set of manifest asset ids. Collision ids start at 100 and
 * skip ids already used by the manifest or reserved for the room shell.
 */
export function interpretPlacements(
  value: unknown,
  knownModels: ReadonlySet<string>,
  usedCollisionIds: ReadonlySet<number>,
): { issues: PlacementIssue[]; buildings: BakedBuilding[]; boxes: BakedBox[]; doors: BakedDoor[] } {
  const issues: PlacementIssue[] = [];
  const buildings: BakedBuilding[] = [];
  const boxes: BakedBox[] = [];
  const doors: BakedDoor[] = [];
  if (!isObject(value)) {
    issues.push({ path: "scene.placements", message: "must be an object" });
    return { issues, buildings, boxes, doors };
  }
  if (value.formatVersion !== 1) issues.push({ path: "scene.placements.formatVersion", message: "must be 1" });
  if (value.units !== "meters") issues.push({ path: "scene.placements.units", message: "must be meters" });
  const placementList = Array.isArray(value.placements) ? value.placements : undefined;
  const obstacleList = Array.isArray(value.obstacles) ? value.obstacles : undefined;
  if (!placementList) issues.push({ path: "scene.placements.placements", message: "required array" });
  if (!obstacleList) issues.push({ path: "scene.placements.obstacles", message: "required array" });
  if (issues.length || !placementList || !obstacleList) return { issues, buildings, boxes, doors };

  const seenBuildings = new Set<string>();
  for (let index = 0; index < placementList.length; index += 1) {
    const item = placementList[index];
    const path = `scene.placements.placements[${index}]`;
    if (!isObject(item)) {
      issues.push({ path, message: "must be an object" });
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(item, "hinge")) {
      const door = takeDoor(item, path, knownModels, issues);
      if (door && seenBuildings.has(door.id)) issues.push({ path: `${path}.id`, message: `duplicate id ${door.id}` });
      if (door) seenBuildings.add(door.id);
      if (door && !issues.some((issue) => issue.path.startsWith(path))) doors.push(door);
      continue;
    }
    const id = str(item.id, `${path}.id`, issues);
    const model = str(item.model, `${path}.model`, issues);
    const position = vec3(item.position, `${path}.position`, issues);
    const yaw = item.yaw === undefined ? undefined : cardinalYaw(item.yaw, `${path}.yaw`, issues);
    const scale = positive(item.scale, `${path}.scale`, issues);
    if (item.yaw === undefined) issues.push({ path: `${path}.yaw`, message: "required finite number" });
    if (id && seenBuildings.has(id)) issues.push({ path: `${path}.id`, message: `duplicate id ${id}` });
    if (id) seenBuildings.add(id);
    if (model && !knownModels.has(model)) issues.push({ path: `${path}.model`, message: `unknown asset ${model}` });
    if (id && model && position && yaw !== undefined && scale !== undefined && knownModels.has(model) && !issues.some((issue) => issue.path.startsWith(path))) {
      buildings.push({ id, model, position, yaw, scale });
    }
  }

  const seenObstacles = new Set<string>();
  const used = new Set<number>(usedCollisionIds);
  for (const reserved of RESERVED_IDS) used.add(reserved);
  let nextId = PLACEMENT_ID_START;
  for (let index = 0; index < obstacleList.length; index += 1) {
    const item = obstacleList[index];
    const path = `scene.placements.obstacles[${index}]`;
    if (!isObject(item)) {
      issues.push({ path, message: "must be an object" });
      continue;
    }
    if (item.kind !== "aabb") issues.push({ path: `${path}.kind`, message: "must be aabb" });
    const id = str(item.id, `${path}.id`, issues);
    const min = vec3(item.min, `${path}.min`, issues);
    const max = vec3(item.max, `${path}.max`, issues);
    if (id && seenObstacles.has(id)) issues.push({ path: `${path}.id`, message: `duplicate id ${id}` });
    if (id) seenObstacles.add(id);
    if (min && max && (max[0] < min[0] || max[1] < min[1] || max[2] < min[2])) {
      issues.push({ path, message: "max must exceed min" });
      continue;
    }
    if (!id || !min || !max || item.kind !== "aabb") continue;
    while (used.has(nextId)) nextId += 1;
    const numeric = nextId;
    nextId += 1;
    used.add(numeric);
    boxes.push({
      id: numeric,
      sourceId: id,
      minX: min[0], maxX: max[0],
      minY: min[1], maxY: max[1],
      minZ: min[2], maxZ: max[2],
    });
  }
  return { issues, buildings, boxes, doors };
}

/**
 * A placement with `hinge` is a door. `model` is an asset id, the same check a
 * building uses. It does not need a scale, and it does not become an obstacle.
 */
function takeDoor(
  item: Record<string, unknown>,
  path: string,
  knownModels: ReadonlySet<string>,
  issues: PlacementIssue[],
): BakedDoor | undefined {
  const id = str(item.id, `${path}.id`, issues);
  const model = str(item.model, `${path}.model`, issues);
  const position = vec3(item.position, `${path}.position`, issues);
  const yaw = item.yaw === undefined ? undefined : cardinalYaw(item.yaw, `${path}.yaw`, issues);
  if (item.yaw === undefined) issues.push({ path: `${path}.yaw`, message: "required finite number" });
  const hinge = item.hinge === "left" || item.hinge === "right" ? item.hinge : undefined;
  if (!hinge) issues.push({ path: `${path}.hinge`, message: "must be left or right" });
  const size = vec3(item.size, `${path}.size`, issues);
  if (size && (size[0] <= 0 || size[1] <= 0 || size[2] <= 0)) {
    issues.push({ path: `${path}.size`, message: "must be > 0" });
  }
  let open = false;
  if (item.open !== undefined && typeof item.open !== "boolean") {
    issues.push({ path: `${path}.open`, message: "must be true or false" });
    open = false;
  } else if (item.open === true) open = true;
  if (model && !knownModels.has(model)) issues.push({ path: `${path}.model`, message: `unknown asset ${model}` });
  if (!id || !model || !position || yaw === undefined || !hinge || !size || size[0] <= 0 || size[1] <= 0 || size[2] <= 0) {
    return undefined;
  }
  if (!knownModels.has(model)) return undefined;
  if (issues.some((issue) => issue.path.startsWith(path))) return undefined;
  return { id, model, position, yaw, hinge, size, open };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function str(value: unknown, path: string, issues: PlacementIssue[]): string | undefined {
  if (typeof value !== "string" || !ID_RE.test(value)) {
    issues.push({ path, message: "required id" });
    return undefined;
  }
  return value;
}

function positive(value: unknown, path: string, issues: PlacementIssue[]): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    issues.push({ path, message: "required finite number" });
    return undefined;
  }
  if (value <= 0) {
    issues.push({ path, message: "must be > 0" });
    return undefined;
  }
  return value;
}

function vec3(value: unknown, path: string, issues: PlacementIssue[]): [number, number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 3) {
    issues.push({ path, message: "must be [x,y,z]" });
    return undefined;
  }
  const coords: number[] = [];
  for (let index = 0; index < 3; index += 1) {
    const item = value[index];
    if (typeof item !== "number" || !Number.isFinite(item)) {
      issues.push({ path: `${path}[${index}]`, message: "required finite number" });
      return undefined;
    }
    coords.push(item);
  }
  return coords as [number, number, number];
}

/** −90° is the same turn as 270°. */
function cardinalYaw(value: unknown, path: string, issues: PlacementIssue[]): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    issues.push({ path, message: "required finite number" });
    return undefined;
  }
  const wrapped = ((value % 360) + 360) % 360;
  for (const card of [0, 90, 180, 270]) {
    if (Math.abs(wrapped - card) < 1e-6) return card;
  }
  issues.push({ path, message: "must be 0, 90, 180, or 270 degrees" });
  return undefined;
}
