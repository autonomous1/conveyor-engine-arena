/**
 * Walks each leg of a portal route. Elevator portals are left out: riding the
 * cab is a later task. Grids are reused until a door or a cab that touches
 * the area changes.
 */
import type { ArenaView } from "../arena-view.js";
import { doorLeafBox } from "../doors.js";
import type { FloorBox } from "../movements.js";
import type { CabState, SceneGraph, Vec3 } from "../scene-graph.js";
import type { Route, Vec3Like } from "./route.js";
import {
  buildGrid,
  navBoxes,
  findLocalPath,
  specForCrossing,
  specForPlace,
  type Grid,
  type GridArea,
  type PlaceGridSpec,
} from "./grid.js";

export type LegPlan =
  | { ok: true; points: Vec3[] }
  | { ok: false; step: number };

export type NavCache = {
  get(key: string): Grid | undefined;
  set(key: string, grid: Grid): void;
  /** Grids actually built. A second lookup of the same key does not increment. */
  misses: number;
};

export type PlanLegsOptions = {
  doorsShut?: ReadonlySet<string>;
  cabs?: readonly CabState[];
  cache?: NavCache;
  cell?: number;
};

type NavView = Pick<ArenaView, "aabbs" | "doors" | "pawnRadius" | "pawnHeight">;

export function createNavCache(): NavCache {
  const grids = new Map<string, Grid>();
  const cache: NavCache = {
    misses: 0,
    get(key) {
      return grids.get(key);
    },
    set(key, grid) {
      if (!grids.has(key)) cache.misses += 1;
      grids.set(key, grid);
    },
  };
  return cache;
}

export function planLegs(
  graph: SceneGraph,
  view: NavView,
  route: Route,
  from: Vec3Like,
  opts: PlanLegsOptions = {},
): LegPlan {
  if (!route.ok) return { ok: false, step: -1 };
  const shut = opts.doorsShut ?? shutDoors(view);
  const cache = opts.cache ?? createNavCache();
  const cell = opts.cell ?? 0.25;
  let boxes: FloorBox[] | undefined;
  const obstacles = (): readonly FloorBox[] => (boxes ??= navBoxes(view, graph, shut, opts.cabs));
  const points: Vec3[] = [];
  let prevX = from.x;
  let prevZ = from.z;

  for (let stepIndex = 0; stepIndex < route.steps.length; stepIndex += 1) {
    const step = route.steps[stepIndex]!;
    if (step.portal.kind === "elevator") continue;
    const inside = walk(cache, graph, view, obstacles, shut, opts.cabs, cell, specForPlace(graph, step.from), prevX, prevZ, step.enter[0], step.enter[2]);
    if (!inside) return { ok: false, step: stepIndex };
    append(points, inside);
    const crossed = walk(
      cache,
      graph,
      view,
      obstacles,
      shut,
      opts.cabs,
      cell,
      specForCrossing(graph, step.from, step.to),
      step.enter[0],
      step.enter[2],
      step.exit[0],
      step.exit[2],
    );
    if (!crossed) return { ok: false, step: stepIndex };
    append(points, crossed);
    prevX = step.exit[0];
    prevZ = step.exit[2];
  }
  if (points.length === 0) points.push([from.x, from.y, from.z]);
  return { ok: true, points };
}

function walk(
  cache: NavCache,
  graph: SceneGraph,
  view: NavView,
  obstacles: () => readonly FloorBox[],
  shut: ReadonlySet<string>,
  cabs: readonly CabState[] | undefined,
  cell: number,
  spec: PlaceGridSpec | undefined,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
): Vec3[] | undefined {
  if (!spec) return undefined;
  const grid = cachedGrid(cache, graph, view, obstacles, shut, cabs, cell, spec);
  return findLocalPath(grid, { x: x0, z: z0 }, { x: x1, z: z1 });
}

function cachedGrid(
  cache: NavCache,
  graph: SceneGraph,
  view: NavView,
  obstacles: () => readonly FloorBox[],
  shut: ReadonlySet<string>,
  cabs: readonly CabState[] | undefined,
  cell: number,
  spec: PlaceGridSpec,
): Grid {
  const key = gridKey(graph, view, shut, cabs, cell, spec);
  const hit = cache.get(key);
  if (hit) return hit;
  const grid = buildGrid(spec.area, obstacles(), {
    cell,
    radius: view.pawnRadius,
    height: view.pawnHeight,
    baseY: spec.baseY,
    block: spec.block,
  });
  cache.set(key, grid);
  return grid;
}

function gridKey(
  graph: SceneGraph,
  view: NavView,
  shut: ReadonlySet<string>,
  cabs: readonly CabState[] | undefined,
  cell: number,
  spec: PlaceGridSpec,
): string {
  const area = spec.area;
  return [
    area.minX,
    area.maxX,
    area.minZ,
    area.maxZ,
    spec.baseY,
    cell,
    view.pawnRadius,
    view.pawnHeight,
    doorKey(view, shut, area),
    cabStamp(graph, area, cabs),
    polygonKey(spec.block),
  ].join("|");
}

function doorKey(view: NavView, shut: ReadonlySet<string>, area: GridArea): string {
  const ids: string[] = [];
  for (const door of view.doors) {
    if (!shut.has(door.id)) continue;
    if (!hitsArea(doorLeafBox(door), area, view.pawnRadius)) continue;
    ids.push(door.id);
  }
  ids.sort();
  return ids.join(",");
}

function cabStamp(graph: SceneGraph, area: GridArea, cabs: readonly CabState[] | undefined): string {
  if (!cabs || cabs.length === 0) return "";
  const parts: string[] = [];
  for (const shaft of graph.shafts) {
    if (shaft.bounds.maxX < area.minX || shaft.bounds.minX > area.maxX) continue;
    if (shaft.bounds.maxZ < area.minZ || shaft.bounds.minZ > area.maxZ) continue;
    const cab = cabs.find((item) => item.id === shaft.id);
    if (!cab) {
      parts.push(`${shaft.id}:none`);
      continue;
    }
    parts.push(`${shaft.id}@${cab.at}:${Math.round(cab.y * 1000)}`);
  }
  parts.sort();
  return parts.join(",");
}

function polygonKey(blocks: ReadonlyArray<ReadonlyArray<readonly [number, number]>>): string {
  return blocks.map((poly) => poly.map((point) => `${point[0]},${point[1]}`).join(";")).join("|");
}

function hitsArea(box: { minX: number; maxX: number; minZ: number; maxZ: number }, area: GridArea, pad: number): boolean {
  const minX = Math.min(box.minX, box.maxX);
  const maxX = Math.max(box.minX, box.maxX);
  const minZ = Math.min(box.minZ, box.maxZ);
  const maxZ = Math.max(box.minZ, box.maxZ);
  return maxX >= area.minX - pad && minX <= area.maxX + pad && maxZ >= area.minZ - pad && minZ <= area.maxZ + pad;
}

function shutDoors(view: NavView): ReadonlySet<string> {
  const shut = new Set<string>();
  for (const door of view.doors) {
    if (!door.open) shut.add(door.id);
  }
  return shut;
}

function append(out: Vec3[], extra: readonly Vec3[]): void {
  for (const point of extra) {
    const last = out[out.length - 1];
    if (last && Math.abs(last[0] - point[0]) < 1e-4 && Math.abs(last[2] - point[2]) < 1e-4) {
      last[1] = point[1];
      continue;
    }
    out.push([point[0], point[1], point[2]]);
  }
}
