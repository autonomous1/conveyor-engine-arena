import * as THREE from "three";

/**
 * Wireframe overlay for obstacles the client already loaded.
 * Meshes are built when that list is applied. The frame loop only sets
 * `group.visible`. Nothing here raycasts, and nothing is sent to the host.
 */

export const AABB_DEBUG_NAME = "aabb-debug";

/** Walls and building runs share this color. Door gaps are not drawn. */
export const AABB_DEBUG_COLOR = 0x3dff9a;

const DEFAULT_MIN_Y = 0;
const DEFAULT_MAX_Y = 3;

export type WorldAabb = {
  id?: string | number;
  kind?: string;
  role?: string;
  hinge?: string;
  min?: readonly number[];
  max?: readonly number[];
  minX?: number;
  maxX?: number;
  minY?: number;
  maxY?: number;
  minZ?: number;
  maxZ?: number;
};

type Extents = {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
};

export type AabbDebug = {
  group: THREE.Group;
  /** Replace meshes from a newly loaded obstacle list. Does not change visibility. */
  rebuild(obstacles: readonly WorldAabb[]): void;
  /** Hide or show the group. Does not rebuild meshes. */
  setVisible(on: boolean): void;
};

export function createAabbDebug(obstacles: readonly WorldAabb[]): AabbDebug {
  const group = new THREE.Group();
  group.name = AABB_DEBUG_NAME;
  group.visible = false;
  group.raycast = ignoreRaycast;
  const material = new THREE.LineBasicMaterial({
    color: AABB_DEBUG_COLOR,
    transparent: true,
    opacity: 1,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    fog: false,
  });
  const rebuild = (next: readonly WorldAabb[]) => {
    clearMeshes(group);
    for (const obstacle of next) {
      const mesh = meshFor(obstacle, material);
      if (mesh) group.add(mesh);
    }
  };
  rebuild(obstacles);
  return {
    group,
    rebuild,
    setVisible(on: boolean) {
      group.visible = on;
    },
  };
}

function ignoreRaycast(): void {}

function clearMeshes(group: THREE.Group): void {
  for (const child of group.children) {
    const mesh = child as THREE.Mesh;
    mesh.geometry?.dispose();
  }
  group.clear();
}

function meshFor(obstacle: WorldAabb, material: THREE.Material): THREE.LineSegments | null {
  if (isDoorGap(obstacle) || isDoorLeaf(obstacle)) return null;
  const box = extents(obstacle);
  if (!box) return null;
  const width = box.maxX - box.minX;
  const height = box.maxY - box.minY;
  const depth = box.maxZ - box.minZ;
  const solid = new THREE.BoxGeometry(width, height, depth);
  const edges = new THREE.EdgesGeometry(solid);
  solid.dispose();
  const mesh = new THREE.LineSegments(edges, material);
  mesh.name = "aabb";
  mesh.position.set(
    (box.minX + box.maxX) / 2,
    (box.minY + box.maxY) / 2,
    (box.minZ + box.maxZ) / 2,
  );
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.raycast = ignoreRaycast;
  return mesh;
}

/** A door gap is empty space. It is not a collider and has no wireframe. */
function isDoorGap(obstacle: WorldAabb): boolean {
  return obstacle.role === "door-gap" || obstacle.kind === "door-gap" || obstacle.role === "gap";
}

/** A hinged leaf is a visual panel. The overlay does not invent a box for it. */
function isDoorLeaf(obstacle: WorldAabb): boolean {
  return obstacle.role === "door-leaf"
    || obstacle.kind === "door-leaf"
    || obstacle.kind === "door"
    || obstacle.hinge === "left"
    || obstacle.hinge === "right";
}

/**
 * World-space box. Y is the AABB span when both ends are finite.
 * A client record with no y uses 0..3.
 */
function extents(obstacle: WorldAabb): Extents | null {
  const fromArray = obstacle.min !== undefined || obstacle.max !== undefined;
  const minX = fromArray ? coord(obstacle.min, 0) : finite(obstacle.minX);
  const maxX = fromArray ? coord(obstacle.max, 0) : finite(obstacle.maxX);
  const minZ = fromArray ? coord(obstacle.min, 2) : finite(obstacle.minZ);
  const maxZ = fromArray ? coord(obstacle.max, 2) : finite(obstacle.maxZ);
  if (minX === undefined || maxX === undefined || minZ === undefined || maxZ === undefined) return null;
  if (maxX < minX || maxZ < minZ) return null;
  const minYIn = fromArray ? coord(obstacle.min, 1) : finite(obstacle.minY);
  const maxYIn = fromArray ? coord(obstacle.max, 1) : finite(obstacle.maxY);
  let minY = DEFAULT_MIN_Y;
  let maxY = DEFAULT_MAX_Y;
  if (minYIn !== undefined && maxYIn !== undefined) {
    if (maxYIn < minYIn) return null;
    minY = minYIn;
    maxY = maxYIn;
  }
  return { minX, maxX, minY, maxY, minZ, maxZ };
}

function coord(value: readonly number[] | undefined, index: number): number | undefined {
  if (!value || index >= value.length) return undefined;
  return finite(value[index]);
}

function finite(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
