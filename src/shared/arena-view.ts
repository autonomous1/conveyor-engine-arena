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
  floor: { y: number; texture: string };
  walls: Array<{
    face: "north" | "south" | "east" | "west";
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
    height: number;
    model: string;
  }>;
  sky: { kind: "sky-dome"; texture: string; shape: BackdropShape; radius: number; height: number };
  cityscape: { texture: string; shape: BackdropShape; radius: number; height: number };
  shadows: { quality: ShadowQuality };
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
  characters: Array<{ id: string; model: string; scale: number; animations: Record<Movement, CharacterAnimation> }>;
  aabbs: Array<{ id: number; minX: number; maxX: number; minZ: number; maxZ: number }>;
  pawnRadius: number;
  pawnHeight: number;
};
