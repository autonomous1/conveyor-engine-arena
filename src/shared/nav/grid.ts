/**
 * Occupancy grid for one place. `planRoute` names the portals; this finds a
 * walk around the walls, props, slabs and steps between two stand points.
 *
 * Floors follow `floorHeight`: a cell stands on its neighbour's floor, so a
 * run of short steps climbs and one tall box stays a wall. An elevated place
 * blocks any cell more than a step below that place, so the path does not
 * drop off a ledge.
 */
import { doorLeafBox } from "../doors.js";
import { pointInPolygon } from "../elevators.js";
import { STEP_HEIGHT, floorHeight, type FloorBox } from "../movements.js";
import {
  isElevatorShaft,
  stopOf,
  type AnyPlace,
  type CabState,
  type ElevatorPlace,
  type OutsidePlace,
  type SceneGraph,
  type StairsPlace,
  type Vec3,
} from "../scene-graph.js";
import type { ArenaView } from "../arena-view.js";

export type GridArea = { minX: number; maxX: number; minZ: number; maxZ: number };

export type Grid = {
  minX: number;
  minZ: number;
  cell: number;
  w: number;
  h: number;
  floor: Float32Array;
  blocked: Uint8Array;
};

export type GridOptions = {
  cell?: number;
  radius: number;
  height: number;
  baseY: number;
  /** Shaft polygons. A cell whose centre lies inside one is blocked. */
  block?: ReadonlyArray<ReadonlyArray<readonly [number, number]>>;
};

type PlaceLike = AnyPlace | OutsidePlace;

const MARGIN = 1;
const SNAP = 0.5;
const LEDGE_Y = 0.05;
const FLOOR_SLOP = 1e-4;
const WINDOW_ABOVE = 0.5;
const WINDOW_BELOW = 1;
const BUCKET = 4;
/** Permanent block: a shaft polygon. Flood fill does not clear it. */
const POLY = 2;

type PlanXZ = { x: number; z: number };

type BoxIndex = {
  boxes: FloorBox[];
  originX: number;
  originZ: number;
  cols: number;
  bins: Array<number[] | undefined>;
};

export function placeGridArea(graph: SceneGraph, placeId: string): GridArea | undefined {
  const place = graph.placeById.get(placeId);
  if (!place) return undefined;
  const stop = stopOf(placeId);
  if (stop) {
    const shaft = graph.placeById.get(stop.shaft);
    if (shaft && isElevatorShaft(shaft)) return shaftStopArea(shaft, stop.index);
  }
  if (isStairsPlace(place)) {
    return boundsArea(place.bounds, [
      [place.landings.bottom[0], place.landings.bottom[2]],
      [place.landings.top[0], place.landings.top[2]],
    ]);
  }
  return boundsArea(place.bounds, []);
}

export function crossingGridArea(graph: SceneGraph, fromId: string, toId: string): GridArea | undefined {
  const left = placeGridArea(graph, fromId);
  const right = placeGridArea(graph, toId);
  if (!left || !right) return undefined;
  return {
    minX: Math.min(left.minX, right.minX),
    maxX: Math.max(left.maxX, right.maxX),
    minZ: Math.min(left.minZ, right.minZ),
    maxZ: Math.max(left.maxZ, right.maxZ),
  };
}

/**
 * Shafts whose footprint meets `area`, except a shaft named by one of
 * `placeIds` (`<shaft>@<i>`). Slabs cover the shaft, so the hall grid has to
 * block it; the stop grid is the cab and its landing.
 */
export function shaftBlocks(
  graph: SceneGraph,
  area: GridArea,
  placeIds: readonly string[],
): Array<Array<[number, number]>> {
  const allow = new Set<string>();
  for (const id of placeIds) {
    const stop = stopOf(id);
    if (stop) allow.add(stop.shaft);
  }
  const out: Array<Array<[number, number]>> = [];
  for (const shaft of graph.shafts) {
    if (allow.has(shaft.id)) continue;
    if (!boundsOverlap(shaft.bounds, area)) continue;
    out.push(shaft.polygon.map((point) => [point[0], point[1]]));
  }
  return out;
}

export type PlaceGridSpec = {
  area: GridArea;
  baseY: number;
  block: Array<Array<[number, number]>>;
};

export function specForPlace(graph: SceneGraph, placeId: string): PlaceGridSpec | undefined {
  const place = graph.placeById.get(placeId);
  const area = placeGridArea(graph, placeId);
  if (!place || !area) return undefined;
  return { area, baseY: place.y, block: shaftBlocks(graph, area, [placeId]) };
}

export function specForCrossing(graph: SceneGraph, fromId: string, toId: string): PlaceGridSpec | undefined {
  const from = graph.placeById.get(fromId);
  const to = graph.placeById.get(toId);
  const area = crossingGridArea(graph, fromId, toId);
  if (!from || !to || !area) return undefined;
  // A stair place's y is the bottom of the run. Crossing onto a landing stands on the landing.
  const baseY = from.kind === "landing" && to.kind === "stairs"
    ? from.y
    : to.kind === "landing" && from.kind === "stairs"
      ? to.y
      : from.kind === "stairs" ? from.y : to.kind === "stairs" ? to.y : from.y;
  return { area, baseY, block: shaftBlocks(graph, area, [fromId, toId]) };
}

/**
 * Static obstacles for a grid. Elevator room walls ride with the cab, so they
 * are dropped until `cabs` supplies a height. A shut door contributes its leaf.
 */
export function navBoxes(
  view: Pick<ArenaView, "aabbs" | "doors">,
  graph: SceneGraph,
  doorsShut: ReadonlySet<string>,
  cabs?: readonly CabState[],
): FloorBox[] {
  const out: FloorBox[] = [];
  for (const box of view.aabbs) {
    const shift = box.source ? roomShift(graph, box.source, cabs) : undefined;
    if (shift === "drop") continue;
    const dy = shift ?? 0;
    out.push({
      minX: box.minX,
      maxX: box.maxX,
      minZ: box.minZ,
      maxZ: box.maxZ,
      ...(box.minY !== undefined ? { minY: box.minY + dy } : {}),
      ...(box.maxY !== undefined ? { maxY: box.maxY + dy } : {}),
    });
  }
  for (const door of view.doors) {
    if (!doorsShut.has(door.id)) continue;
    out.push(doorLeafBox(door));
  }
  return out;
}

export function buildGrid(area: GridArea, boxes: readonly FloorBox[], opts: GridOptions): Grid {
  const cell = opts.cell && opts.cell > 0 ? opts.cell : 0.25;
  const radius = opts.radius > 0 ? opts.radius : 0;
  const height = opts.height > 0 ? opts.height : 0;
  const baseY = opts.baseY;
  const spanX = area.maxX - area.minX;
  const spanZ = area.maxZ - area.minZ;
  if (!(spanX > 0) || !(spanZ > 0) || !Number.isFinite(spanX) || !Number.isFinite(spanZ)) {
    return { minX: area.minX, minZ: area.minZ, cell, w: 0, h: 0, floor: new Float32Array(), blocked: new Uint8Array() };
  }
  const w = Math.ceil(spanX / cell);
  const h = Math.ceil(spanZ / cell);
  const floor = new Float32Array(w * h);
  const blocked = new Uint8Array(w * h);
  const polys = opts.block ?? [];
  const index = indexBoxes(boxes, area, radius, baseY);
  const scratch: FloorBox[] = [];
  const ledge = baseY > LEDGE_Y;

  for (let j = 0; j < h; j += 1) {
    const cz = area.minZ + (j + 0.5) * cell;
    for (let i = 0; i < w; i += 1) {
      const idx = j * w + i;
      const cx = area.minX + (i + 0.5) * cell;
      if (polys.length > 0 && insideAny(polys, cx, cz)) {
        blocked[idx] = POLY;
        continue;
      }
      collect(index, scratch, cx, cz, radius, height, baseY, baseY);
      if (scratch.length === 0) {
        if (ledge) blocked[idx] = 1;
        continue;
      }
      const stance = floorHeight(scratch, cx, cz, radius, baseY, STEP_HEIGHT);
      floor[idx] = stance;
      if (ledge && stance < baseY - STEP_HEIGHT - FLOOR_SLOP) blocked[idx] = 1;
      else if (capsuleBlocked(scratch, cx, cz, radius, stance, height)) blocked[idx] = 1;
    }
  }

  raiseSteps(index, scratch, floor, blocked, area, cell, w, h, radius, height, baseY, ledge);
  return { minX: area.minX, minZ: area.minZ, cell, w, h, floor, blocked };
}

export function findLocalPath(grid: Grid, start: PlanXZ | Vec3, goal: PlanXZ | Vec3): Vec3[] | undefined {
  if (grid.w <= 0 || grid.h <= 0) return undefined;
  const from = readXZ(start);
  const to = readXZ(goal);
  const a = snapFree(grid, from.x, from.z);
  const b = snapFree(grid, to.x, to.z);
  if (!a || !b) return undefined;
  const floors = grid.floor;
  if (a.i === b.i && a.j === b.j) {
    return [[a.snapped ? centerX(grid, a.i) : from.x, floors[a.j * grid.w + a.i]!, a.snapped ? centerZ(grid, a.j) : from.z]];
  }
  const cells = search(grid, a.i, a.j, b.i, b.j);
  if (!cells) return undefined;
  const points: Vec3[] = cells.map((idx, n) => {
    const i = idx % grid.w;
    const j = (idx - i) / grid.w;
    const y = floors[idx]!;
    if (n === 0 && !a.snapped) return [from.x, y, from.z];
    if (n === cells.length - 1 && !b.snapped) return [to.x, y, to.z];
    return [centerX(grid, i), y, centerZ(grid, j)];
  });
  return smooth(grid, points);
}

function raiseSteps(
  index: BoxIndex,
  scratch: FloorBox[],
  floor: Float32Array,
  blocked: Uint8Array,
  area: GridArea,
  cell: number,
  w: number,
  h: number,
  radius: number,
  height: number,
  baseY: number,
  ledge: boolean,
): void {
  const queue: number[] = [];
  let head = 0;
  for (let idx = 0; idx < floor.length; idx += 1) {
    if (blocked[idx] !== 0) continue;
    if (floor[idx]! > baseY + FLOOR_SLOP) queue.push(idx);
  }
  while (head < queue.length) {
    const idx = queue[head++]!;
    const i = idx % w;
    const j = (idx - i) / w;
    const feet = floor[idx]!;
    const next: Array<readonly [number, number]> = [];
    if (i > 0) next.push([i - 1, j]);
    if (i + 1 < w) next.push([i + 1, j]);
    if (j > 0) next.push([i, j - 1]);
    if (j + 1 < h) next.push([i, j + 1]);
    for (const [ni, nj] of next) {
      const nIdx = nj * w + ni;
      if (blocked[nIdx] === POLY) continue;
      const nx = area.minX + (ni + 0.5) * cell;
      const nz = area.minZ + (nj + 0.5) * cell;
      const stance = stanceAt(index, scratch, nx, nz, radius, height, baseY, feet);
      if (stance <= floor[nIdx]! + FLOOR_SLOP) continue;
      if (Math.abs(stance - feet) > STEP_HEIGHT + FLOOR_SLOP) continue;
      if (cellBlocked(index, scratch, nx, nz, radius, height, baseY, stance, ledge)) continue;
      floor[nIdx] = stance;
      blocked[nIdx] = 0;
      queue.push(nIdx);
    }
  }
}

function cellBlocked(
  index: BoxIndex,
  scratch: FloorBox[],
  x: number,
  z: number,
  radius: number,
  height: number,
  baseY: number,
  stance: number,
  ledge: boolean,
): boolean {
  if (ledge && stance < baseY - STEP_HEIGHT - FLOOR_SLOP) return true;
  collect(index, scratch, x, z, radius, height, baseY, stance);
  return capsuleBlocked(scratch, x, z, radius, stance, height);
}

/** Highest stand from `feet`, ignoring boxes outside this place's height window. */
function stanceAt(
  index: BoxIndex,
  scratch: FloorBox[],
  x: number,
  z: number,
  radius: number,
  height: number,
  baseY: number,
  feet: number,
): number {
  collect(index, scratch, x, z, radius, height, baseY, feet);
  if (scratch.length === 0) return 0;
  return floorHeight(scratch, x, z, radius, feet, STEP_HEIGHT);
}

function capsuleBlocked(
  boxes: readonly FloorBox[],
  x: number,
  z: number,
  r: number,
  floor: number,
  height: number,
): boolean {
  const bodyLo = floor + STEP_HEIGHT;
  const bodyHi = floor + height;
  for (const box of boxes) {
    const lo = box.minY ?? -Infinity;
    const hi = box.maxY ?? Infinity;
    if (hi <= bodyLo || lo >= bodyHi) continue;
    const minX = Math.min(box.minX, box.maxX) - r;
    const maxX = Math.max(box.minX, box.maxX) + r;
    const minZ = Math.min(box.minZ, box.maxZ) - r;
    const maxZ = Math.max(box.minZ, box.maxZ) + r;
    if (x > minX && x < maxX && z > minZ && z < maxZ) return true;
  }
  return false;
}

function collect(
  index: BoxIndex,
  scratch: FloorBox[],
  x: number,
  z: number,
  radius: number,
  height: number,
  baseY: number,
  feet: number,
): void {
  scratch.length = 0;
  let col = Math.floor((x - index.originX) / BUCKET);
  let row = Math.floor((z - index.originZ) / BUCKET);
  if (col < 0) col = 0;
  else if (col >= index.cols) col = index.cols - 1;
  if (row < 0) row = 0;
  const bin = index.bins[row * index.cols + col];
  if (!bin) return;
  const ceiling = feet + height + WINDOW_ABOVE;
  const basement = baseY - WINDOW_BELOW;
  for (const id of bin) {
    const box = index.boxes[id]!;
    const lo = box.minY ?? -Infinity;
    const hi = box.maxY ?? Infinity;
    if (lo > ceiling || hi < basement) continue;
    const minX = Math.min(box.minX, box.maxX) - radius;
    const maxX = Math.max(box.minX, box.maxX) + radius;
    const minZ = Math.min(box.minZ, box.maxZ) - radius;
    const maxZ = Math.max(box.minZ, box.maxZ) + radius;
    if (x <= minX || x >= maxX || z <= minZ || z >= maxZ) continue;
    scratch.push(box);
  }
}

function indexBoxes(boxes: readonly FloorBox[], area: GridArea, radius: number, baseY: number): BoxIndex {
  const cols = Math.max(1, Math.ceil((area.maxX - area.minX) / BUCKET));
  const rows = Math.max(1, Math.ceil((area.maxZ - area.minZ) / BUCKET));
  const bins: Array<number[] | undefined> = new Array(cols * rows);
  const kept: FloorBox[] = [];
  const basement = baseY - WINDOW_BELOW;
  for (const box of boxes) {
    const hi = box.maxY ?? Infinity;
    if (hi < basement) continue;
    const minX = Math.min(box.minX, box.maxX);
    const maxX = Math.max(box.minX, box.maxX);
    const minZ = Math.min(box.minZ, box.maxZ);
    const maxZ = Math.max(box.minZ, box.maxZ);
    if (maxX < area.minX - radius || minX > area.maxX + radius) continue;
    if (maxZ < area.minZ - radius || minZ > area.maxZ + radius) continue;
    const id = kept.length;
    kept.push(box);
    let c0 = Math.floor((minX - radius - area.minX) / BUCKET);
    let c1 = Math.floor((maxX + radius - area.minX) / BUCKET);
    let r0 = Math.floor((minZ - radius - area.minZ) / BUCKET);
    let r1 = Math.floor((maxZ + radius - area.minZ) / BUCKET);
    if (c0 < 0) c0 = 0;
    if (r0 < 0) r0 = 0;
    if (c1 >= cols) c1 = cols - 1;
    if (r1 >= rows) r1 = rows - 1;
    if (c1 < c0 || r1 < r0) continue;
    for (let r = r0; r <= r1; r += 1) {
      const row = r * cols;
      for (let c = c0; c <= c1; c += 1) {
        const bin = bins[row + c];
        if (bin) bin.push(id);
        else bins[row + c] = [id];
      }
    }
  }
  return { boxes: kept, originX: area.minX, originZ: area.minZ, cols, bins };
}

function search(grid: Grid, i0: number, j0: number, i1: number, j1: number): number[] | undefined {
  const { w, h, cell, floor, blocked } = grid;
  const count = w * h;
  const start = j0 * w + i0;
  const goal = j1 * w + i1;
  const g = new Float64Array(count);
  g.fill(Infinity);
  g[start] = 0;
  const parent = new Int32Array(count);
  parent.fill(-1);
  const closed = new Uint8Array(count);
  const heapI: number[] = [start];
  const heapF: number[] = [octile(i0, j0, i1, j1) * cell];
  const stepOrtho = cell;
  const stepDiag = cell * Math.SQRT2;

  while (heapI.length > 0) {
    const idx = pop(heapI, heapF);
    if (closed[idx]) continue;
    closed[idx] = 1;
    if (idx === goal) return trace(parent, goal);
    const i = idx % w;
    const j = (idx - i) / w;
    const base = g[idx]!;
    const here = floor[idx]!;
    for (let dj = -1; dj <= 1; dj += 1) {
      const nj = j + dj;
      if (nj < 0 || nj >= h) continue;
      for (let di = -1; di <= 1; di += 1) {
        if (di === 0 && dj === 0) continue;
        const ni = i + di;
        if (ni < 0 || ni >= w) continue;
        if (di !== 0 && dj !== 0) {
          if (blocked[j * w + ni] !== 0 || blocked[nj * w + i] !== 0) continue;
        }
        const next = nj * w + ni;
        if (blocked[next] !== 0 || closed[next]) continue;
        if (Math.abs(floor[next]! - here) > STEP_HEIGHT + FLOOR_SLOP) continue;
        const cost = base + (di !== 0 && dj !== 0 ? stepDiag : stepOrtho);
        if (!(cost < g[next]!)) continue;
        g[next] = cost;
        parent[next] = idx;
        push(heapI, heapF, next, cost + octile(ni, nj, i1, j1) * cell);
      }
    }
  }
  return undefined;
}

function trace(parent: Int32Array, goal: number): number[] {
  const cells: number[] = [];
  for (let cursor = goal; cursor >= 0; cursor = parent[cursor]!) cells.push(cursor);
  cells.reverse();
  return cells;
}

function smooth(grid: Grid, points: Vec3[]): Vec3[] {
  if (points.length <= 2) return points;
  const out: Vec3[] = [points[0]!];
  let anchor = 0;
  for (let i = 2; i < points.length; i += 1) {
    if (!lineClear(grid, points[anchor]!, points[i]!)) {
      out.push(points[i - 1]!);
      anchor = i - 1;
    }
  }
  out.push(points[points.length - 1]!);
  return out;
}

/** Supercover of the segment. A corner visits both side cells, so a diagonal cannot clip a blocked cell. */
function lineClear(grid: Grid, from: Vec3, to: Vec3): boolean {
  const { minX, minZ, cell, w, h, floor, blocked } = grid;
  const x0 = (from[0] - minX) / cell;
  const z0 = (from[2] - minZ) / cell;
  const x1 = (to[0] - minX) / cell;
  const z1 = (to[2] - minZ) / cell;
  let ix = Math.floor(x0);
  let iz = Math.floor(z0);
  const ixEnd = Math.floor(x1);
  const izEnd = Math.floor(z1);
  const dx = x1 - x0;
  const dz = z1 - z0;
  const stepX = Math.sign(dx);
  const stepZ = Math.sign(dz);
  const tDeltaX = stepX === 0 ? Infinity : Math.abs(1 / dx);
  const tDeltaZ = stepZ === 0 ? Infinity : Math.abs(1 / dz);
  let tMaxX = stepX > 0 ? (Math.floor(x0) + 1 - x0) * tDeltaX : stepX < 0 ? (x0 - Math.floor(x0)) * tDeltaX : Infinity;
  let tMaxZ = stepZ > 0 ? (Math.floor(z0) + 1 - z0) * tDeltaZ : stepZ < 0 ? (z0 - Math.floor(z0)) * tDeltaZ : Infinity;
  if (!Number.isFinite(tMaxX)) tMaxX = Infinity;
  if (!Number.isFinite(tMaxZ)) tMaxZ = Infinity;

  let prev = Number.NaN;
  const visit = (i: number, j: number): boolean => {
    if (i < 0 || j < 0 || i >= w || j >= h) return false;
    const idx = j * w + i;
    if (blocked[idx] !== 0) return false;
    const y = floor[idx]!;
    if (!Number.isNaN(prev) && Math.abs(y - prev) > STEP_HEIGHT + FLOOR_SLOP) return false;
    prev = y;
    return true;
  };
  if (!visit(ix, iz)) return false;
  const limit = Math.abs(ixEnd - ix) + Math.abs(izEnd - iz) + 4;
  for (let n = 0; n < limit && (ix !== ixEnd || iz !== izEnd); n += 1) {
    if (Math.abs(tMaxX - tMaxZ) <= 1e-9) {
      if (!visit(ix + stepX, iz) || !visit(ix, iz + stepZ)) return false;
      tMaxX += tDeltaX;
      tMaxZ += tDeltaZ;
      ix += stepX;
      iz += stepZ;
    } else if (tMaxX < tMaxZ) {
      tMaxX += tDeltaX;
      ix += stepX;
    } else {
      tMaxZ += tDeltaZ;
      iz += stepZ;
    }
    if (!visit(ix, iz)) return false;
  }
  return ix === ixEnd && iz === izEnd;
}

type Snap = { i: number; j: number; snapped: boolean };

function snapFree(grid: Grid, x: number, z: number): Snap | undefined {
  const i = Math.floor((x - grid.minX) / grid.cell);
  const j = Math.floor((z - grid.minZ) / grid.cell);
  if (inside(grid, i, j) && grid.blocked[j * grid.w + i] === 0) return { i, j, snapped: false };
  const reach = Math.ceil(SNAP / grid.cell);
  let bestI = -1;
  let bestJ = -1;
  let best = SNAP + 1;
  for (let dj = -reach; dj <= reach; dj += 1) {
    const nj = j + dj;
    if (nj < 0 || nj >= grid.h) continue;
    for (let di = -reach; di <= reach; di += 1) {
      const ni = i + di;
      if (ni < 0 || ni >= grid.w) continue;
      if (grid.blocked[nj * grid.w + ni] !== 0) continue;
      const dx = centerX(grid, ni) - x;
      const dz = centerZ(grid, nj) - z;
      const dist = Math.hypot(dx, dz);
      if (dist > SNAP || dist >= best) continue;
      best = dist;
      bestI = ni;
      bestJ = nj;
    }
  }
  if (bestI < 0) return undefined;
  return { i: bestI, j: bestJ, snapped: true };
}

function inside(grid: Grid, i: number, j: number): boolean {
  return i >= 0 && j >= 0 && i < grid.w && j < grid.h;
}

function centerX(grid: Grid, i: number): number {
  return grid.minX + (i + 0.5) * grid.cell;
}

function centerZ(grid: Grid, j: number): number {
  return grid.minZ + (j + 0.5) * grid.cell;
}

function readXZ(point: PlanXZ | Vec3): PlanXZ {
  if (Array.isArray(point)) return { x: point[0], z: point[2] };
  return { x: point.x, z: point.z };
}

function insideAny(polys: ReadonlyArray<ReadonlyArray<readonly [number, number]>>, x: number, z: number): boolean {
  for (const poly of polys) {
    if (pointInPolygon(poly, x, z)) return true;
  }
  return false;
}

function roomShift(graph: SceneGraph, source: string, cabs: readonly CabState[] | undefined): number | "drop" | undefined {
  for (const shaft of graph.shafts) {
    if (!shaft.room) continue;
    if (!source.startsWith(`${shaft.room}.`)) continue;
    if (!cabs) return "drop";
    const cab = cabs.find((item) => item.id === shaft.id);
    if (!cab) return "drop";
    return cab.y - (shaft.stops[0] ?? 0);
  }
  return undefined;
}

function shaftStopArea(shaft: ElevatorPlace, index: number): GridArea {
  const landing = shaft.landings[index];
  return boundsArea(shaft.bounds, landing ? [[landing[0], landing[2]]] : []);
}

function boundsArea(
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number },
  extra: ReadonlyArray<readonly [number, number]>,
): GridArea {
  let minX = bounds.minX;
  let maxX = bounds.maxX;
  let minZ = bounds.minZ;
  let maxZ = bounds.maxZ;
  for (const [x, z] of extra) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  return { minX: minX - MARGIN, maxX: maxX + MARGIN, minZ: minZ - MARGIN, maxZ: maxZ + MARGIN };
}

function boundsOverlap(bounds: { minX: number; maxX: number; minZ: number; maxZ: number }, area: GridArea): boolean {
  return bounds.maxX >= area.minX && bounds.minX <= area.maxX && bounds.maxZ >= area.minZ && bounds.minZ <= area.maxZ;
}

function isStairsPlace(place: PlaceLike): place is StairsPlace {
  return place.kind === "stairs" && "landings" in place;
}

function octile(i: number, j: number, goalI: number, goalJ: number): number {
  const dx = Math.abs(goalI - i);
  const dz = Math.abs(goalJ - j);
  return Math.max(dx, dz) + (Math.SQRT2 - 1) * Math.min(dx, dz);
}

function before(fA: number, iA: number, fB: number, iB: number): boolean {
  if (fA !== fB) return fA < fB;
  return iA < iB;
}

function push(heapI: number[], heapF: number[], item: number, f: number): void {
  heapI.push(item);
  heapF.push(f);
  let index = heapI.length - 1;
  while (index > 0) {
    const up = (index - 1) >> 1;
    if (!before(heapF[index]!, heapI[index]!, heapF[up]!, heapI[up]!)) break;
    swapHeap(heapI, heapF, index, up);
    index = up;
  }
}

function pop(heapI: number[], heapF: number[]): number {
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
    if (left < heapI.length && before(heapF[left]!, heapI[left]!, heapF[best]!, heapI[best]!)) best = left;
    if (right < heapI.length && before(heapF[right]!, heapI[right]!, heapF[best]!, heapI[best]!)) best = right;
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
