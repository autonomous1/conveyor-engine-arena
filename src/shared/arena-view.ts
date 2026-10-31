/**
 * What the server derived from the game manifest and serves to the client.
 * The client renders this. It does not author collision or rules.
 *
 * `authoritativeHash` is the engine static-world hash (collision, spawns, bounds,
 * and the stable visual-layout bytes). Swapping a texture or model file changes
 * `presentationHash` only, so the handshake does not force a reconnect.
 * Changing collision, spawns, bounds, or which asset id a surface uses changes
 * `authoritativeHash` and does force a reconnect.
 * Room lights change `presentationHash` only.
 */
import type { ProfileRing } from "./building-profile.js";
import type { Movement } from "./movements.js";
import type { PickupKind, PickupPlacement } from "./pickups.js";
import type { ShadowQuality } from "./shadows.js";

export type BackdropShape = "cylinder" | "dome";

/**
 * `speed` is the wander gait ratio on the host. `referenceSpeed` (m/s the feet
 * travel at 1x on the unscaled model) and the time-scale clamp are client-only.
 */
export type CharacterAnimation = {
  clip: string;
  speed: number;
  referenceSpeed?: number;
  minTimeScale?: number;
  maxTimeScale?: number;
};
export type Prop = {
  id: string;
  idNum: number;
  model: string;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
  /** Asset animation key, such as `"idle"`. Absent when the prop does not play a clip. */
  animation: string | undefined;
  /** Asset clip table. The client plays `animations[animation].clip`. */
  animations?: Record<Movement, CharacterAnimation>;
  /** Placement position. Set when the prop comes from a placements file. */
  position?: [number, number, number];
  /** Degrees about +Y, the same quarter turn as a baked placement. */
  yaw?: number;
  /** Uniform scale: asset.scale * placement.scale. */
  scale?: number;
  /** Placement type when this prop is consumed: ammo, health, or weapon. Scenery omits it. */
  type?: PickupKind;
  /** Asset id equipped when `type` is weapon. */
  weapon?: string;
};

/** Clip name for a prop, from `animations[animation].clip`. Absent when the prop is still. */
export function propClipName(prop: {
  animation: string | undefined;
  animations?: Partial<Record<string, { clip: string }>>;
}): string | undefined {
  if (!prop.animation || !prop.animations) return undefined;
  const clip = prop.animations[prop.animation]?.clip;
  return clip || undefined;
}

/**
 * One elevator cab. `stops` are world y, ascending. `polygon` is the cab
 * footprint in world XZ. `landings` is one point per stop, outside the door.
 */
export type ArenaElevator = {
  id: string;
  stops: number[];
  speed: number;
  waitS: number;
  polygon: Array<[number, number]>;
  landings: Array<[number, number, number]>;
};

/** One room light. `color` is `#rrggbb`. A rect carries `yaw`, `width`, and `height`. */
export type ArenaLight = {
  id: string;
  type: "point" | "rect";
  position: [number, number, number];
  color: string;
  intensity: number;
  /** Point distance. Absent is unlimited (`0` on the client). */
  range?: number;
  /** Degrees about +Y. 0, 90, 180, or 270. Rect lights set it. */
  yaw?: number;
  width?: number;
  height?: number;
};

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
    /**
     * SVG outline in model space, unscaled, around the model origin.
     * Model +X and +Z. Absent when this placement has no path.
     * Not part of either content hash.
     */
    profile?: ProfileRing[];
    /** Degrees. The SVG group yaw, before the mesh quaternion. */
    authorYaw?: number;
  }>;
  /** Omitted when the manifest has no sky block. */
  sky?: { kind: "sky-dome"; texture: string; shape: BackdropShape; radius: number; height: number };
  /** Omitted when the manifest has no cityscape block. */
  cityscape?: { texture: string; shape: BackdropShape; radius: number; height: number };
  /** Omitted when the manifest has no shadows block. */
  shadows?: { quality: ShadowQuality };
  props: Array<Prop>;
  /**
   * Placements the host can remove. Ids are strings. Decorative props are absent.
   * The bounds are the prop AABB already drawn for that placement.
   */
  pickups?: PickupPlacement[];
  /**
   * Local prop clips. Props are string ids, not entities, so this is not a world command.
   * The host does not run the mixer. Each client plays the same clip.
   */
  propClips?: Array<{ id: string; clip: string }>;
  /**
   * Hinged panels from a doors placements file. `model` is that placement's
   * GLB uri, the same lookup a prop uses. The file faces out on +Z with the
   * hinge at the mesh origin. Placement yaw is the wall face, applied once.
   * `open` yaws only the hinge node. The frame stays on that yaw. There is no AABB.
   * `locked` starts the leaf shut until the pawn uses `key`. Neither field is a collider.
   */
  doors: Array<{
    id: string;
    model: string;
    position: [number, number, number];
    yaw: number;
    hinge: "left" | "right";
    size: [number, number, number];
    open: boolean;
    /** Absent or false: `open` toggles. True: the host starts the leaf shut. */
    locked?: boolean;
    /** Pickup placement id. The host reads it only while `locked` is true. */
    key?: string;
  }>;
  characters: Array<{ id: string; model: string; scale: number; animations: Record<Movement, CharacterAnimation> }>;
  /** Human-selectable character ids, in `player.modelChoices` order. */
  modelChoices: string[];
  /** Wander-pawn character ids. Absent when bots use `modelChoices`. */
  npcModelChoices?: string[];
  /**
   * Model URIs whose asset says `"instance": "static"`. Repeated placements of
   * one of these share one InstancedMesh per source mesh. URIs absent from this
   * list are cloned. Skinned pawns are never instanced, even if listed.
   */
  staticModels: string[];
  /**
   * `minY` / `maxY` are present when the obstacle has a vertical span.
   * `mesh` is set for a prop obstacle (`<id>-box`). The host min/max stay the
   * mesh bounds. The debug wireframe draws that box slightly larger.
   * `source` is that obstacle's placement id, such as `cover-crate-2-9-box`.
   * It is not part of the collision hash. A taken pickup removes its box.
   */
  aabbs: Array<{ id: number; minX: number; maxX: number; minZ: number; maxZ: number; minY?: number; maxY?: number; mesh?: boolean; source?: string }>;
  pawnRadius: number;
  pawnHeight: number;
  /**
   * Spawn marks for the scene map. `yaw` is degrees about +Y, the same number
   * the placements file stores. Omitted on a host that predates the map.
   * Not part of either content hash.
   */
  spawns?: Array<{ id: string; x: number; z: number; yaw: number }>;
  /**
   * Human pads from `scene.playerSpawnPoints`. Wander spawns stay in `spawns`.
   * Not part of either content hash.
   */
  playerSpawns?: Array<{ id: string; x: number; z: number; yaw: number }>;
  /**
   * Room lights from `scene.lights`. Empty when that field is absent.
   * Part of `presentationHash` only.
   */
  lights: ArenaLight[];
  /**
   * Elevator cabs from `scene.elevators`. Omitted when there are none.
   * Not part of either content hash.
   */
  elevators?: ArenaElevator[];
  /** Thrown grenade mesh. Absent when the manifest has no `grenade` model. */
  grenade?: string;
  /**
   * Set when the host process was started with `ARENA_NOCLIP=1`.
   * The client shows the Noclip switch only then. Not part of either content hash.
   */
  noclip?: boolean;
};
