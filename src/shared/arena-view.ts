/**
 * What the server derived from the game manifest and serves to the client.
 * The client renders this. It does not author collision or rules.
 *
 * `authoritativeHash` is the engine static-world hash (collision, spawns, bounds,
 * and the stable visual-layout bytes). Swapping a texture or model file changes
 * `presentationHash` only, so the handshake does not force a reconnect.
 * Changing collision, spawns, bounds, or which asset id a surface uses changes
 * `authoritativeHash` and does force a reconnect.
 */
import type { Movement } from "./movements.js";
import type { ShadowQuality } from "./shadows.js";

export type BackdropShape = "cylinder" | "dome";

export type CharacterAnimation = { clip: string; speed: number };

export type ArenaView = {
  bundleId: string;
  bundleVersion: string;
  authoritativeHash: string;
  presentationHash: string;
  collisionContentHash: string;
  world: string;
  bounds: { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number };
  /** Omitted when the manifest has no floor block. */
  floor?: { y: number; texture: string };
  walls: Array<{
    face: "north" | "south" | "east" | "west";
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
    height: number;
    model: string;
    /** World meters. Omitted on an old manifest: the face anchor. */
    position?: [number, number, number];
    /** Degrees about +Y, the same y-up-90 turn as a baked placement. Omitted: the face anchor. */
    yaw?: number;
    /** Uniform visual scale. Omitted: 1. This is the baked stencil scale, not a fit to the wall span. */
    scale?: number;
  }>;
  /** Instances loaded from `scene.placements`. The mesh uses this scale, not the asset scale. */
  buildings: Array<{
    id: string;
    model: string;
    position: [number, number, number];
    yaw: number;
    scale: number;
  }>;
  /** Omitted when the manifest has no sky block. */
  sky?: { kind: "sky-dome"; texture: string; shape: BackdropShape; radius: number; height: number };
  /** Omitted when the manifest has no cityscape block. */
  cityscape?: { texture: string; shape: BackdropShape; radius: number; height: number };
  /** Omitted when the manifest has no shadows block. */
  shadows?: { quality: ShadowQuality };
  props: Array<{
    id: string;
    model: string;
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    minZ: number;
    maxZ: number;
  }>;
  /**
   * Hinged panels from a doors placements file. `model` is that placement's
   * GLB uri, the same lookup a prop uses. The file faces out on +Z with the
   * hinge at the mesh origin. Placement yaw is the wall face, applied once.
   * `open` yaws only the hinge node. The frame stays on that yaw. There is no AABB.
   */
  doors: Array<{
    id: string;
    model: string;
    position: [number, number, number];
    yaw: number;
    hinge: "left" | "right";
    size: [number, number, number];
    open: boolean;
  }>;
  characters: Array<{ id: string; model: string; scale: number; animations: Record<Movement, CharacterAnimation> }>;
  aabbs: Array<{ id: number; minX: number; maxX: number; minZ: number; maxZ: number }>;
  pawnRadius: number;
  pawnHeight: number;
};
