/**
 * Scene map panel. The picture is the baked top-down image from `npm run bake:map`.
 * The canvas over it stays empty so pawn markers can be drawn later.
 * World +X is panel right and world +Z is panel up, the same frame as the bake.
 * `layoutSceneMap` is that mapping. The footprint helpers stay for tests and a
 * yaw check. The panel does not paint them, and nothing here runs in the WebGL frame.
 */

import * as THREE from "three";
import type { ProfileRing } from "../shared/building-profile.ts";
import { aimDirection, yawFromQuat } from "../shared/look.ts";
import { MAP_BAKE_URL, SCENE_MAP_SIZE, mapFrame } from "../shared/map-frame.ts";

export { MAP_BAKE_URL, SCENE_MAP_SIZE };
export const YAW_MATCH_DEGREES = 5;
export const YAW_LARGE_DEGREES = 45;

/** Fill colors for file-yaw error. Match is green, a small gap is yellow, 45° and over is red. */
export const YAW_COLOR = {
  match: "#3dff9a",
  small: "#e6c84a",
  large: "#ff5a6a",
  unknown: "#8aa0c8",
} as const;

/** Stroke for the outline turned by the SVG yaw, when it differs from the mesh. */
export const AUTHOR_PROFILE_COLOR = "#7ecbff";

export type YawMark = keyof typeof YAW_COLOR;
export type MapKind = "building" | "prop" | "door" | "wall" | "spawn";

export type MapAnchor = {
  /** Placement origin. The model origin sits here, not the box center. */
  x: number;
  z: number;
  /** Uniform placement scale. Node scale is already in the profile points. */
  scale: number;
};

export type MapSample = {
  id: string;
  kind: Exclude<MapKind, "spawn">;
  /** Degrees about +Y from the placements file. Absent when the file has no yaw. */
  expectedYaw?: number;
  /** Degrees. The SVG group yaw, before the mesh quaternion. */
  authorYaw?: number;
  /**
   * Model-space rings, unscaled. Model +X / +Z. The map turns these by the
   * mesh yaw. Absent when this sample has no SVG outline.
   */
  profile?: ProfileRing[];
  /** Where `profile` is planted. Absent when there is no profile. */
  anchor?: MapAnchor;
  /** Geometry local to world. For an InstancedMesh this includes that instance. */
  matrix: THREE.Matrix4;
  min: [number, number, number];
  max: [number, number, number];
};

export type MapSpawn = { id: string; x: number; z: number; yaw: number };

export type SceneMapWorld = {
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  samples: readonly MapSample[];
  spawns?: readonly MapSpawn[];
};

export type MapEntity = {
  id: string;
  kind: MapKind;
  x: number;
  z: number;
  /** Radians, `yawFromQuat` of the mesh world quaternion. Spawn yaw is the file yaw. */
  yaw: number;
  /** Radians. The placements-file yaw, when it was still on the view. */
  expectedYaw?: number;
  /** Radians. The SVG group yaw. Absent when the view has no profile yaw. */
  authorYaw?: number;
  /** World XZ outline of the mesh box. Empty for a spawn. */
  polygon: Array<[number, number]>;
  /** SVG outline in world XZ at the mesh yaw. Empty when there is no profile. */
  profile: ProfileRing[];
  /** Same outline at the authoring yaw. Empty when that yaw matches the mesh. */
  authorProfile: ProfileRing[];
  /** World XZ unit direction of the mesh's local +X. */
  axisX: [number, number];
  /** World XZ unit direction of the mesh's local +Z. Spawn forward is this axis. */
  axisZ: [number, number];
};

export type MapLayout = {
  width: number;
  height: number;
  scale: number;
  toPixel(x: number, z: number): [number, number];
  toWorld(px: number, py: number): [number, number];
  floor: Array<[number, number]>;
  plusZ: [number, number];
  plusX: [number, number];
  entities: Array<MapEntity & {
    pixel: Array<[number, number]>;
    profilePixel: Array<Array<[number, number]>>;
    authorPixel: Array<Array<[number, number]>>;
    mark: YawMark;
    tip: string;
  }>;
};

export type SampleMeta = {
  id: string;
  kind: MapSample["kind"];
  expectedYaw?: number;
  authorYaw?: number;
  profile?: ProfileRing[];
  anchor?: MapAnchor;
};

const UP = new THREE.Vector3(0, 1, 0);
const SPAWN_HIT_M = 1.25;

const KIND_RANK: Record<MapKind, number> = {
  wall: 0,
  prop: 1,
  door: 2,
  building: 3,
  spawn: 4,
};

export function yawMark(actual: number, expected: number | undefined): YawMark {
  if (expected === undefined || !Number.isFinite(expected) || !Number.isFinite(actual)) return "unknown";
  const delta = Math.abs(Math.atan2(Math.sin(actual - expected), Math.cos(actual - expected)));
  if (delta <= YAW_MATCH_DEGREES * Math.PI / 180) return "match";
  if (delta >= YAW_LARGE_DEGREES * Math.PI / 180) return "large";
  return "small";
}

/**
 * Walk `root` and record each mesh's world matrix. Names in `skipNames`
 * are not entered, so a door hinge does not replace the frame footprint.
 * InstancedMesh batches are ignored here; use `collectInstanceSamples`.
 */
export function collectObjectSamples(
  out: MapSample[],
  meta: SampleMeta,
  root: THREE.Object3D,
  skipNames: readonly string[] = [],
): void {
  root.updateMatrixWorld(true);
  const skip = new Set(skipNames);
  const walk = (object: THREE.Object3D, isRoot: boolean) => {
    if (!isRoot && skip.has(object.name)) return;
    const mesh = object as THREE.Mesh;
    const instanced = mesh as THREE.InstancedMesh;
    if (mesh.isMesh && !instanced.isInstancedMesh) pushSample(out, meta, mesh.matrixWorld, mesh.geometry);
    for (const child of object.children) walk(child, false);
  };
  walk(root, true);
}

/**
 * One sample per instance. The stored matrix is `mesh.matrixWorld * instanceMatrix`,
 * the same product the instanced vertex shader applies to the geometry.
 */
export function collectInstanceSamples(
  out: MapSample[],
  meshes: readonly THREE.InstancedMesh[],
  entries: readonly SampleMeta[],
): void {
  const instance = new THREE.Matrix4();
  const world = new THREE.Matrix4();
  for (const mesh of meshes) {
    mesh.updateMatrixWorld(true);
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    const box = mesh.geometry.boundingBox;
    if (!box) continue;
    const count = Math.min(mesh.count, entries.length);
    for (let index = 0; index < count; index += 1) {
      const meta = entries[index]!;
      mesh.getMatrixAt(index, instance);
      world.multiplyMatrices(mesh.matrixWorld, instance);
      out.push({
        id: meta.id,
        kind: meta.kind,
        expectedYaw: meta.expectedYaw,
        authorYaw: meta.authorYaw,
        profile: meta.profile,
        anchor: meta.anchor,
        matrix: world.clone(),
        min: [box.min.x, box.min.y, box.min.z],
        max: [box.max.x, box.max.y, box.max.z],
      });
    }
  }
}

export function assembleSceneMap(samples: readonly MapSample[], spawns: readonly MapSpawn[] = []): MapEntity[] {
  const groups = new Map<string, MapSample[]>();
  for (const sample of samples) {
    if (!sample.id) continue;
    const list = groups.get(sample.id);
    if (list) list.push(sample);
    else groups.set(sample.id, [sample]);
  }
  const entities: MapEntity[] = [];
  for (const [id, group] of groups) {
    const entity = entityFromGroup(id, group);
    if (entity) entities.push(entity);
  }
  for (const spawn of spawns) {
    if (!Number.isFinite(spawn.x) || !Number.isFinite(spawn.z) || !spawn.id) continue;
    const yaw = (spawn.yaw || 0) * Math.PI / 180;
    // Pawn forward at this yaw is aimDirection, which is local +Z. The building
    // arrow uses local +X. Those are different axes on purpose.
    const facing = aimDirection(yaw, 0);
    const basis = yawBasis(yaw);
    entities.push({
      id: spawn.id,
      kind: "spawn",
      x: spawn.x,
      z: spawn.z,
      yaw,
      polygon: [],
      profile: [],
      authorProfile: [],
      axisX: basis.axisX,
      axisZ: [facing.x, facing.z],
    });
  }
  return entities;
}

export function layoutSceneMap(world: SceneMapWorld, width = SCENE_MAP_SIZE, height = SCENE_MAP_SIZE): MapLayout | undefined {
  const { bounds } = world;
  const frame = mapFrame(bounds, width, height);
  if (!frame) return undefined;
  const { toPixel, toWorld, scale } = frame;
  const entities = assembleSceneMap(world.samples, world.spawns ?? []).map((entity) => ({
    ...entity,
    mark: entity.kind === "spawn" ? "unknown" as const : yawMark(entity.yaw, entity.expectedYaw),
    pixel: entity.polygon.map(([x, z]) => toPixel(x, z)),
    profilePixel: entity.profile.map((ring) => ring.map(([x, z]) => toPixel(x, z))),
    authorPixel: entity.authorProfile.map((ring) => ring.map(([x, z]) => toPixel(x, z))),
    tip: tipOf(entity),
  }));
  entities.sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.id.localeCompare(b.id));
  const north = toPixel((bounds.minX + bounds.maxX) / 2, bounds.maxZ);
  const east = toPixel(bounds.maxX, (bounds.minZ + bounds.maxZ) / 2);
  return {
    width,
    height,
    scale,
    toPixel,
    toWorld,
    floor: [
      toPixel(bounds.minX, bounds.minZ),
      toPixel(bounds.maxX, bounds.minZ),
      toPixel(bounds.maxX, bounds.maxZ),
      toPixel(bounds.minX, bounds.maxZ),
    ],
    plusZ: [north[0], north[1] + 12],
    plusX: [east[0] - 8, east[1]],
    entities,
  };
}

export function hitSceneMap(layout: MapLayout, px: number, py: number): MapLayout["entities"][number] | undefined {
  const [x, z] = layout.toWorld(px, py);
  for (let index = layout.entities.length - 1; index >= 0; index -= 1) {
    const entity = layout.entities[index]!;
    if (entity.kind === "spawn") {
      if (Math.hypot(entity.x - x, entity.z - z) <= SPAWN_HIT_M) return entity;
      continue;
    }
    const shape = entity.profile.length > 0 ? entity.profile : [entity.polygon];
    if (containsRings(shape, x, z)) return entity;
  }
  return undefined;
}

export type MapDraw = {
  clear(): void;
  polygon(points: Array<[number, number]>, fill: string, stroke: string): void;
  /** Closed rings. `dash` is the authoring-yaw overlay. Optional: each ring is a polygon otherwise. */
  rings?(rings: ReadonlyArray<ReadonlyArray<readonly [number, number]>>, fill: string, stroke: string, dash: boolean): void;
  line(x0: number, y0: number, x1: number, y1: number, color: string, dash: boolean): void;
  circle(x: number, y: number, r: number, fill: string): void;
  text(text: string, x: number, y: number, align: "center" | "left" | "right"): void;
};

export function paintSceneMap(layout: MapLayout, draw: MapDraw): void {
  draw.clear();
  draw.polygon(layout.floor, "", "rgba(255,255,255,0.45)");
  for (const entity of layout.entities) {
    if (entity.kind === "spawn") {
      const [px, py] = layout.toPixel(entity.x, entity.z);
      const radius = Math.max(2.5, layout.scale * 0.4);
      draw.circle(px, py, radius, "#f2f6fb");
      const len = layout.scale * 1.5;
      draw.line(px, py, px + entity.axisZ[0] * len, py - entity.axisZ[1] * len, "#f2f6fb", false);
      continue;
    }
    const color = YAW_COLOR[entity.mark];
    if (entity.profilePixel.length > 0) {
      draw.polygon(entity.pixel, "rgba(170, 186, 210, 0.16)", "rgba(255,255,255,0.28)");
      paintRings(draw, entity.profilePixel, rgba(color, fillAlpha(entity.kind)), rgba(color, 0.95), false);
      if (entity.authorPixel.length > 0) paintRings(draw, entity.authorPixel, "", AUTHOR_PROFILE_COLOR, true);
    } else {
      draw.polygon(entity.pixel, rgba(color, fillAlpha(entity.kind)), rgba(color, 0.95));
    }
  }
  for (const entity of layout.entities) {
    if (entity.kind === "spawn" || entity.pixel.length < 3) continue;
    const [px, py] = layout.toPixel(entity.x, entity.z);
    const len = Math.max(layout.scale * 0.75, arrowReach(entity) * layout.scale);
    draw.line(px, py, px + entity.axisX[0] * len, py - entity.axisX[1] * len, "#ffffff", false);
    if (entity.expectedYaw !== undefined && (entity.mark === "small" || entity.mark === "large")) {
      const expected = yawBasis(entity.expectedYaw).axisX;
      draw.line(px, py, px + expected[0] * len, py - expected[1] * len, "#ffd27a", true);
    }
  }
  draw.text("+Z", layout.plusZ[0], layout.plusZ[1], "center");
  draw.text("+X", layout.plusX[0], layout.plusX[1], "right");
}

export type SceneMap = {
  readonly visible: boolean;
  setVisible(on: boolean): void;
  setWorld(world: SceneMapWorld): void;
  /** Panel mapping for a later pawn layer. Absent until `setWorld`. */
  layout(): MapLayout | undefined;
};

export function createSceneMap(): SceneMap {
  const root = document.createElement("div");
  root.id = "scene-map";
  root.hidden = true;
  root.setAttribute("aria-label", "Scene map");
  root.style.cssText = [
    "position:fixed", "right:12px", "bottom:12px", "z-index:3",
    `width:${SCENE_MAP_SIZE}px`, `height:${SCENE_MAP_SIZE}px`,
    "background:#12151ccc", "border:1px solid #3c4454", "border-radius:6px",
    "overflow:hidden", "pointer-events:auto",
  ].join(";");
  const image = document.createElement("img");
  image.id = "scene-map-image";
  image.alt = "Top-down arena";
  image.src = MAP_BAKE_URL;
  image.draggable = false;
  image.style.cssText = `position:absolute;inset:0;width:${SCENE_MAP_SIZE}px;height:${SCENE_MAP_SIZE}px;display:block;pointer-events:none;`;
  const canvas = document.createElement("canvas");
  canvas.id = "scene-map-canvas";
  canvas.width = SCENE_MAP_SIZE;
  canvas.height = SCENE_MAP_SIZE;
  // index.html sizes every canvas to the viewport. The inline size keeps this one in the corner.
  // The bitmap stays blank. Pawn markers use `layout()` and draw here later.
  canvas.setAttribute("data-role", "pawn-overlay");
  canvas.style.cssText = `position:absolute;inset:0;width:${SCENE_MAP_SIZE}px;height:${SCENE_MAP_SIZE}px;display:block;`;
  root.append(image, canvas);
  document.body.append(root);
  const stop = (ev: Event) => {
    ev.stopPropagation();
  };
  root.addEventListener("pointerdown", stop);
  root.addEventListener("mousedown", stop);

  let visible = false;
  let world: SceneMapWorld | undefined;

  return {
    get visible() {
      return visible;
    },
    setVisible(on: boolean) {
      visible = on;
      root.hidden = !on;
    },
    setWorld(next: SceneMapWorld) {
      world = next;
    },
    layout() {
      if (!world) return undefined;
      return layoutSceneMap(world, SCENE_MAP_SIZE, SCENE_MAP_SIZE);
    },
  };
}

function pushSample(out: MapSample[], meta: SampleMeta, matrix: THREE.Matrix4, geometry: THREE.BufferGeometry | undefined): void {
  if (!geometry) return;
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  if (!box) return;
  out.push({
    id: meta.id,
    kind: meta.kind,
    expectedYaw: meta.expectedYaw,
    authorYaw: meta.authorYaw,
    profile: meta.profile,
    anchor: meta.anchor,
    matrix: matrix.clone(),
    min: [box.min.x, box.min.y, box.min.z],
    max: [box.max.x, box.max.y, box.max.z],
  });
}

function entityFromGroup(id: string, group: readonly MapSample[]): MapEntity | undefined {
  let best: { sample: MapSample; area: number } | undefined;
  const all: Array<[number, number]> = [];
  for (const sample of group) {
    const corners = cornersOf(sample);
    if (corners.length === 0) continue;
    all.push(...corners);
    const area = xzArea(corners);
    if (!best || area > best.area) best = { sample, area };
  }
  const polygon = footprintPolygon(all);
  if (!best || polygon.length < 3) return undefined;
  let x = 0;
  let z = 0;
  for (const point of polygon) {
    x += point[0];
    z += point[1];
  }
  x /= polygon.length;
  z /= polygon.length;
  const basis = basisFromMatrix(best.sample.matrix);
  const fileYaw = best.sample.expectedYaw;
  const outline = group.find((sample) => sample.profile && sample.profile.length > 0 && sample.anchor);
  const local = outline?.profile ?? [];
  const anchor = outline?.anchor;
  const profile = anchor ? placeRings(local, anchor, basis.yaw) : [];
  // SVG yaw when the plan stored one. Otherwise the placements-file yaw.
  const authorDegrees = outline?.authorYaw ?? outline?.expectedYaw;
  const authorRadians = authorDegrees === undefined || !Number.isFinite(authorDegrees) ? undefined : authorDegrees * Math.PI / 180;
  const authorProfile = anchor && authorRadians !== undefined && yawMark(basis.yaw, authorRadians) !== "match"
    ? placeRings(local, anchor, authorRadians)
    : [];
  return {
    id,
    kind: best.sample.kind,
    x,
    z,
    yaw: basis.yaw,
    expectedYaw: fileYaw === undefined || !Number.isFinite(fileYaw) ? undefined : fileYaw * Math.PI / 180,
    authorYaw: outline?.authorYaw === undefined || !Number.isFinite(outline.authorYaw) ? undefined : outline.authorYaw * Math.PI / 180,
    polygon,
    profile,
    authorProfile,
    axisX: basis.axisX,
    axisZ: basis.axisZ,
  };
}

function cornersOf(sample: MapSample): Array<[number, number]> {
  const corner = new THREE.Vector3();
  const points: Array<[number, number]> = [];
  const [x0, y0, z0] = sample.min;
  const [x1, y1, z1] = sample.max;
  for (const x of [x0, x1]) {
    for (const y of [y0, y1]) {
      for (const z of [z0, z1]) {
        corner.set(x, y, z).applyMatrix4(sample.matrix);
        if (Number.isFinite(corner.x) && Number.isFinite(corner.z)) points.push([corner.x, corner.z]);
      }
    }
  }
  return points;
}

function xzArea(points: readonly [number, number][]): number {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const [x, z] of points) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  return Math.max(0, maxX - minX) * Math.max(0, maxZ - minZ);
}

function footprintPolygon(points: Array<[number, number]>): Array<[number, number]> {
  const hull = convexHull(points);
  if (hull.length >= 3) return hull;
  if (hull.length === 0) return [];
  const a = hull[0]!;
  const b = hull[1] ?? [a[0] + 0.2, a[1]];
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const len = Math.hypot(dx, dz) || 1;
  const px = (-dz / len) * 0.15;
  const pz = (dx / len) * 0.15;
  return [
    [a[0] + px, a[1] + pz],
    [b[0] + px, b[1] + pz],
    [b[0] - px, b[1] - pz],
    [a[0] - px, a[1] - pz],
  ];
}

function convexHull(points: readonly [number, number][]): Array<[number, number]> {
  const sorted = points.filter((point) => Number.isFinite(point[0]) && Number.isFinite(point[1]))
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const unique: Array<[number, number]> = [];
  for (const point of sorted) {
    const last = unique[unique.length - 1];
    if (last && Math.abs(last[0] - point[0]) < 1e-6 && Math.abs(last[1] - point[1]) < 1e-6) continue;
    unique.push(point);
  }
  if (unique.length <= 2) return unique;
  const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Array<[number, number]> = [];
  for (const point of unique) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, point) <= 0) lower.pop();
    lower.push(point);
  }
  const upper: Array<[number, number]> = [];
  for (let index = unique.length - 1; index >= 0; index -= 1) {
    const point = unique[index]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, point) <= 0) upper.pop();
    upper.push(point);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function basisFromMatrix(matrix: THREE.Matrix4): { yaw: number; axisX: [number, number]; axisZ: [number, number] } {
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  matrix.decompose(position, quaternion, scale);
  const yaw = yawFromQuat(quaternion);
  const fallback = yawBasis(yaw);
  return {
    yaw,
    axisX: horizontal(new THREE.Vector3(1, 0, 0).applyQuaternion(quaternion), fallback.axisX),
    axisZ: horizontal(new THREE.Vector3(0, 0, 1).applyQuaternion(quaternion), fallback.axisZ),
  };
}

/** Local +X / +Z after `rotation.y = radians`. 90° sends +X to world −Z. */
function yawBasis(radians: number): { axisX: [number, number]; axisZ: [number, number] } {
  const quaternion = new THREE.Quaternion().setFromAxisAngle(UP, radians);
  return {
    axisX: horizontal(new THREE.Vector3(1, 0, 0).applyQuaternion(quaternion), [1, 0]),
    axisZ: horizontal(new THREE.Vector3(0, 0, 1).applyQuaternion(quaternion), [0, 1]),
  };
}

function horizontal(vector: THREE.Vector3, fallback: [number, number]): [number, number] {
  const length = Math.hypot(vector.x, vector.z);
  if (length < 1e-5) return fallback;
  return [vector.x / length, vector.z / length];
}

function tipOf(entity: MapEntity): string {
  if (entity.kind === "spawn") return `${entity.id}\nspawn\nyaw ${formatYaw(entity.yaw)}`;
  const lines = [entity.id, entity.kind, `mesh ${formatYaw(entity.yaw)}`];
  if (entity.expectedYaw !== undefined) {
    lines.push(`file ${formatYaw(entity.expectedYaw)}`, `off ${formatDelta(entity.yaw, entity.expectedYaw)}`);
  }
  if (entity.authorYaw !== undefined) lines.push(`svg ${formatYaw(entity.authorYaw)}`);
  return lines.join("\n");
}

function formatYaw(radians: number): string {
  const wrapped = ((radians * 180 / Math.PI) % 360 + 360) % 360;
  return `${Math.round(wrapped)}°`;
}

function formatDelta(actual: number, expected: number): string {
  const delta = Math.abs(Math.atan2(Math.sin(actual - expected), Math.cos(actual - expected)));
  return `${Math.round(delta * 180 / Math.PI)}°`;
}

function fillAlpha(kind: MapKind): number {
  if (kind === "building") return 0.72;
  if (kind === "prop") return 0.55;
  if (kind === "door") return 0.5;
  return 0.4;
}

function arrowReach(entity: MapEntity): number {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const [x, z] of entity.polygon) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  return Math.max(0.75, Math.hypot(maxX - minX, maxZ - minZ) * 0.28);
}

function rgba(hex: string, alpha: number): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
}

function placeRings(rings: readonly ProfileRing[], anchor: MapAnchor, yaw: number): ProfileRing[] {
  const basis = yawBasis(yaw);
  const placed: ProfileRing[] = [];
  for (const ring of rings) {
    const next: ProfilePoint[] = [];
    for (const [x, z] of ring) {
      const lx = x * anchor.scale;
      const lz = z * anchor.scale;
      const wx = anchor.x + lx * basis.axisX[0] + lz * basis.axisZ[0];
      const wz = anchor.z + lx * basis.axisX[1] + lz * basis.axisZ[1];
      if (Number.isFinite(wx) && Number.isFinite(wz)) next.push([wx, wz]);
    }
    if (next.length >= 3) placed.push(next);
  }
  return placed;
}

type ProfilePoint = [number, number];

function paintRings(
  draw: MapDraw,
  rings: ReadonlyArray<ReadonlyArray<readonly [number, number]>>,
  fill: string,
  stroke: string,
  dash: boolean,
): void {
  if (draw.rings) {
    draw.rings(rings, fill, stroke, dash);
    return;
  }
  for (const ring of rings) draw.polygon(ring as Array<[number, number]>, fill, stroke);
}

function containsRings(rings: readonly ProfileRing[], x: number, z: number): boolean {
  let inside = false;
  for (const ring of rings) {
    if (ring.length >= 3 && contains(ring, x, z)) inside = !inside;
  }
  return inside;
}

function contains(polygon: readonly [number, number][], x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const [xi, zi] = polygon[i]!;
    const [xj, zj] = polygon[j]!;
    const crosses = (zi > z) !== (zj > z);
    if (!crosses) continue;
    const at = ((xj - xi) * (z - zi)) / (zj - zi) + xi;
    if (x < at) inside = !inside;
  }
  return inside;
}

function canvasDraw(ctx: CanvasRenderingContext2D): MapDraw {
  return {
    clear() {
      ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    },
    polygon(points, fill, stroke) {
      if (points.length < 2) return;
      ctx.beginPath();
      ctx.moveTo(points[0]![0], points[0]![1]);
      for (let index = 1; index < points.length; index += 1) ctx.lineTo(points[index]![0], points[index]![1]);
      ctx.closePath();
      if (fill) {
        ctx.fillStyle = fill;
        ctx.fill();
      }
      if (stroke) {
        ctx.strokeStyle = stroke;
        ctx.lineWidth = 1;
        ctx.setLineDash([]);
        ctx.stroke();
      }
    },
    rings(rings, fill, stroke, dash) {
      ctx.beginPath();
      for (const ring of rings) {
        if (ring.length < 2) continue;
        ctx.moveTo(ring[0]![0], ring[0]![1]);
        for (let index = 1; index < ring.length; index += 1) ctx.lineTo(ring[index]![0], ring[index]![1]);
        ctx.closePath();
      }
      if (fill) {
        ctx.fillStyle = fill;
        ctx.fill("evenodd");
      }
      if (stroke) {
        ctx.strokeStyle = stroke;
        ctx.lineWidth = 1.25;
        ctx.setLineDash(dash ? [4, 3] : []);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    },
    line(x0, y0, x1, y1, color, dash) {
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      const dx = x1 - x0;
      const dy = y1 - y0;
      const len = Math.hypot(dx, dy);
      if (len > 1) {
        const ux = dx / len;
        const uy = dy / len;
        const head = Math.min(6, len * 0.35);
        ctx.lineTo(x1 - ux * head - uy * head * 0.55, y1 - uy * head + ux * head * 0.55);
        ctx.moveTo(x1, y1);
        ctx.lineTo(x1 - ux * head + uy * head * 0.55, y1 - uy * head - ux * head * 0.55);
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.25;
      ctx.setLineDash(dash ? [3, 2] : []);
      ctx.stroke();
      ctx.setLineDash([]);
    },
    circle(x, y, r, fill) {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = fill;
      ctx.fill();
    },
    text(text, x, y, align) {
      ctx.font = "11px ui-sans-serif, system-ui, sans-serif";
      ctx.fillStyle = "rgba(255,255,255,0.8)";
      ctx.textAlign = align;
      ctx.textBaseline = "middle";
      ctx.fillText(text, x, y);
    },
  };
}
