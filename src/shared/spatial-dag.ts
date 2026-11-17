// ARCHITECTURE: Static spatial DAG: baked place hierarchy plus one BVH per
//   merged static chunk; dynamic doors, elevators, props, and pawns stay out.
// Wiring: world-loader.ts loads web/game/spatial-dag.json; fire/hitscan/nav
//   consume the queries; the bot WorldView carries the same file.
// Invariants: chunks are immutable static geometry; no door or pawn triangle.
import { Box3, BufferGeometry, DoubleSide, Float32BufferAttribute, Ray, Sphere, Vector3 } from "three";
import { MeshBVH } from "three-mesh-bvh";

/** One hierarchy node: a building or a place.
 * @invariant Static-only: a node has no door/pawn kind. (test: dag_nodes_are_places_not_dynamic_objects)
 */
export type SpatialNode = {
  id: string;
  kind: string;
  bounds: Box3;
  parentId?: string;
  childIds: string[];
  adjacency: string[];
};

/** One merged static geometry chunk and its BVH. */
export type StaticChunk = {
  id: string;
  nodeId: string;
  place: string;
  geometry: BufferGeometry;
  bvh: MeshBVH;
  bounds: Box3;
};

/** The loaded static DAG: hierarchy plus queryable chunks. */
export type SpatialDAG = {
  hash: string;
  nodes: SpatialNode[];
  chunks: StaticChunk[];
  byId: ReadonlyMap<string, SpatialNode>;
};

/** A ray hit on a static chunk. */
export type SpatialHit = {
  chunkId: string;
  nodeId: string;
  distance: number;
  point: Vector3;
};

type Encoded = { __type: string; data: number[] };

function revive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(revive);
  if (value && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    if (typeof rec.__type === "string" && Array.isArray(rec.data)) {
      const Ctor = (globalThis as Record<string, unknown>)[rec.__type] as new (data: number[]) => unknown;
      return typeof Ctor === "function" ? new Ctor(rec.data) : rec.data;
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(rec)) out[key] = revive(rec[key]);
    return out;
  }
  return value;
}

function box(min: readonly number[], max: readonly number[]): Box3 {
  return new Box3(new Vector3(min[0], min[1], min[2]), new Vector3(max[0], max[1], max[2]));
}

/**
 * Load a serialized DAG from the bake.
 * @post Returns undefined for a malformed file; a rejected file never has
 *       partially built BVHs.
 */
export function loadSpatialDAG(file: unknown): SpatialDAG | undefined {
  if (!file || typeof file !== "object" || Array.isArray(file)) return undefined;
  const rec = file as Record<string, unknown>;
  if (rec.formatVersion !== 1 || typeof rec.hash !== "string" || !Array.isArray(rec.nodes) || !Array.isArray(rec.chunks)) return undefined;
  const nodes: SpatialNode[] = [];
  for (const value of rec.nodes) {
    if (!value || typeof value !== "object") return undefined;
    const n = value as Record<string, unknown>;
    const b = n.bounds as { min?: number[]; max?: number[] } | undefined;
    if (typeof n.id !== "string" || typeof n.kind !== "string" || !b?.min || !b.max) return undefined;
    nodes.push({
      id: n.id,
      kind: n.kind,
      bounds: box(b.min, b.max),
      ...(typeof n.parentId === "string" ? { parentId: n.parentId } : {}),
      childIds: Array.isArray(n.childIds) ? n.childIds.filter((id): id is string => typeof id === "string") : [],
      adjacency: Array.isArray(n.adjacency) ? n.adjacency.filter((id): id is string => typeof id === "string") : [],
    });
  }
  const chunks: StaticChunk[] = [];
  for (const value of rec.chunks) {
    if (!value || typeof value !== "object") return undefined;
    const c = value as Record<string, unknown>;
    if (typeof c.id !== "string" || typeof c.nodeId !== "string" || typeof c.place !== "string") return undefined;
    if (!Array.isArray(c.positions) || !Array.isArray(c.indices) || !c.bvh) return undefined;
    const positions = c.positions.filter((n): n is number => typeof n === "number");
    const indices = c.indices.filter((n): n is number => typeof n === "number");
    if (positions.length % 3 !== 0 || indices.length % 3 !== 0) return undefined;
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    try {
      MeshBVH.deserialize(revive(c.bvh) as never, geometry);
      const bvh = new MeshBVH(geometry);
      chunks.push({ id: c.id, nodeId: c.nodeId, place: c.place, geometry, bvh, bounds: new Box3().setFromBufferAttribute(geometry.getAttribute("position") as never) });
    } catch {
      return undefined;
    }
  }
  return { hash: rec.hash, nodes, chunks, byId: new Map(nodes.map((node) => [node.id, node])) };
}

/**
 * First static triangle hit by a ray.
 * @post `maxDist` bounds the hit; dynamic objects are never tested.
 */
export function raycastFirst(dag: SpatialDAG, from: { x: number; y: number; z: number }, dir: { x: number; y: number; z: number }, maxDist = Infinity): SpatialHit | undefined {
  const ray = new Ray(new Vector3(from.x, from.y, from.z), new Vector3(dir.x, dir.y, dir.z).normalize());
  let best: SpatialHit | undefined;
  for (const chunk of dag.chunks) {
    const hit = chunk.bvh.raycastFirst(ray, DoubleSide, 0, Number.isFinite(maxDist) ? maxDist : undefined);
    if (!hit) continue;
    if (!best || hit.distance < best.distance) best = { chunkId: chunk.id, nodeId: chunk.nodeId, distance: hit.distance, point: hit.point.clone() };
  }
  return best;
}

/**
 * Chunks whose triangles intersect a sphere; the callback may stop the scan.
 * @post The callback sees only static chunk triangles.
 */
export function shapecast(dag: SpatialDAG, center: Vector3, radius: number, cb?: (chunk: StaticChunk) => boolean): StaticChunk[] {
  const sphere = new Sphere(center, radius);
  const hits: StaticChunk[] = [];
  for (const chunk of dag.chunks) {
    let touched = false;
    chunk.bvh.shapecast({
      intersectsBounds: (bounds) => bounds.intersectsSphere(sphere),
      intersectsTriangle: () => {
        touched = true;
        return cb ? cb(chunk) : true;
      },
    });
    if (touched) hits.push(chunk);
    if (cb && hits.length > 0 && cb(hits[hits.length - 1]!)) break;
  }
  return hits;
}

/**
 * Closest static point to `point`, with its chunk.
 * @post The returned point lies on a static triangle; no dynamic object competes.
 */
export function closestPointToPoint(dag: SpatialDAG, point: Vector3): { chunkId: string; point: Vector3; distance: number } | undefined {
  let best: { chunkId: string; point: Vector3; distance: number } | undefined;
  for (const chunk of dag.chunks) {
    const hit = chunk.bvh.closestPointToPoint(point, { point: new Vector3(), distance: 0, faceIndex: 0 });
    if (!hit) continue;
    const distance = hit.distance;
    if (!best || distance < best.distance) best = { chunkId: chunk.id, point: hit.point.clone(), distance };
  }
  return best;
}

/**
 * Smallest node whose bounds contain the point.
 * @post A point outside every node is undefined.
 */
export function nodeAt(dag: SpatialDAG, point: { x: number; y: number; z: number }): SpatialNode | undefined {
  const at = new Vector3(point.x, point.y, point.z);
  let best: SpatialNode | undefined;
  for (const node of dag.nodes) {
    if (!node.bounds.containsPoint(at)) continue;
    if (!best || node.bounds.getSize(new Vector3()).length() < best.bounds.getSize(new Vector3()).length()) best = node;
  }
  return best;
}
