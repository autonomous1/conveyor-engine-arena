/**
 * Hinged doors. KeyE sends `{ t: "use", v: 1, seq }`. The host swings the one
 * door whose clear volume the pawn capsule overlaps. A locked door opens only
 * when that pawn holds `key`, and that id is then consumed.
 *
 * The volume is the stamped passage (2 m inward of the hinge plane) plus a
 * short reach outside it. It is not an obstacle.
 * A closed leaf is: the host holds one obstacle per door (`doorLeafBox`) while
 * it is shut and parks that box out of the world while it is open. The stamped
 * wall gap itself is never re-sealed.
 * Door frames go out on the socket. They are not snap envelopes.
 */
import { capsuleOverlapsAabb, type PawnBody } from "./pickups.js";

/** Inward depth of the stamped doorway, in meters. The leaf does not fill this. */
export const DOOR_GAP_DEPTH_M = 2;
/** Meters outside the hinge plane where a pawn in front of the leaf can still use it. */
export const DOOR_USE_OUTWARD_M = 0.75;
/**
 * Thinnest closed-leaf blocker, in meters. The GLB leaf is 8 cm (local z 0..depth,
 * outside the hinge plane). The blocker keeps that outer face and grows inward
 * into the stamped gap, so a fast step cannot cross the push-out midpoint.
 */
export const DOOR_LEAF_MIN_THICKNESS_M = 0.2;

export type DoorFrame = { t: "door"; id: string; open: boolean; locked: boolean };

export type UseFrame = { t: "use"; v: 1; seq: number };

export type DoorRuntime = {
  id: string;
  hinge: "left" | "right";
  open: boolean;
  locked: boolean;
  /** Pickup placement id. Read only while `locked` is true. */
  key?: string;
  position: [number, number, number];
  size: [number, number, number];
  yaw: number;
};

export type DoorUseVolume = {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
};

export function doorFrame(id: string, open: boolean, locked: boolean): DoorFrame {
  return { t: "door", id, open, locked };
}

export function useFrame(seq: number): UseFrame {
  return { t: "use", v: 1, seq };
}

/**
 * Same quarter turns as `orientDoorFrame` in the client. 90° is +π/2 about Y,
 * which sends local +Z to world +X. 270° is −π/2, which sends local +X to world +Z.
 */
export function doorYawRadians(degrees: number): number {
  const wrapped = ((degrees % 360) + 360) % 360;
  if (wrapped < 1e-6 || wrapped > 360 - 1e-6) return 0;
  if (Math.abs(wrapped - 90) < 1e-6) return Math.PI / 2;
  if (Math.abs(wrapped - 180) < 1e-6) return Math.PI;
  if (Math.abs(wrapped - 270) < 1e-6) return -Math.PI / 2;
  return degrees * (Math.PI / 180);
}

/**
 * World box of the passage a pawn must overlap to use this door.
 * Left hinge: local x is 0..width. Right hinge: local x is −width..0.
 * Local −Z is inward, through the stamped gap. Local +Z is outside the leaf.
 * Yaw is the placement yaw. This box is never added to the obstacle list.
 */
export function doorUseVolume(door: Pick<DoorRuntime, "position" | "yaw" | "hinge" | "size">): DoorUseVolume {
  return doorLocalBox(door, -DOOR_GAP_DEPTH_M, DOOR_USE_OUTWARD_M);
}

/**
 * World box of the closed leaf: the panel span along the wall (hinge..hinge+width,
 * mirrored for a right hinge), y from the sill (`position[1]`) to sill + height,
 * and local z from the leaf's outer face (`size[2]`) inward by at least
 * `DOOR_LEAF_MIN_THICKNESS_M`. The host blocks with it only while the door is shut.
 */
export function doorLeafBox(door: Pick<DoorRuntime, "position" | "yaw" | "hinge" | "size">): DoorUseVolume {
  const depth = door.size[2] > 0 ? door.size[2] : 0;
  return doorLocalBox(door, depth - Math.max(depth, DOOR_LEAF_MIN_THICKNESS_M), depth);
}

function doorLocalBox(
  door: Pick<DoorRuntime, "position" | "yaw" | "hinge" | "size">,
  minLZ: number,
  maxLZ: number,
): DoorUseVolume {
  const width = door.size[0];
  const height = door.size[1];
  const minLX = door.hinge === "left" ? 0 : -width;
  const maxLX = door.hinge === "left" ? width : 0;
  const yaw = doorYawRadians(door.yaw);
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const lx of [minLX, maxLX]) {
    for (const lz of [minLZ, maxLZ]) {
      // rotation.y: local +X → (cos θ, 0, −sin θ), local +Z → (sin θ, 0, cos θ).
      const x = door.position[0] + lx * c + lz * s;
      const z = door.position[2] - lx * s + lz * c;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
  }
  return {
    minX,
    maxX,
    minY: door.position[1],
    maxY: door.position[1] + height,
    minZ,
    maxZ,
  };
}

/** Nearest overlapping door. Equal distance keeps the smaller id. */
export function pickDoorForUse(doors: readonly DoorRuntime[], pawn: PawnBody): DoorRuntime | undefined {
  let best: DoorRuntime | undefined;
  let bestDist = Infinity;
  for (const door of doors) {
    const volume = doorUseVolume(door);
    if (!capsuleOverlapsAabb(pawn.x, pawn.y, pawn.z, pawn.radius, pawn.height, volume)) continue;
    const cx = (volume.minX + volume.maxX) / 2;
    const cz = (volume.minZ + volume.maxZ) / 2;
    const dist = (pawn.x - cx) * (pawn.x - cx) + (pawn.z - cz) * (pawn.z - cz);
    if (!best || dist < bestDist - 1e-9 || (Math.abs(dist - bestDist) <= 1e-9 && door.id < best.id)) {
      best = door;
      bestDist = dist;
    }
  }
  return best;
}

export type KeyRing = {
  hasKey(pawnId: number, keyId: string): boolean;
  consumeKey(pawnId: number, keyId: string): boolean;
};

/**
 * Unlocked: toggle `open`. Locked with this pawn's key: consume it, unlock, and open.
 * Locked without that key: no change.
 */
export function tryUseDoor(door: DoorRuntime, pawnId: number, keys: KeyRing): DoorFrame | undefined {
  if (door.locked) {
    if (!door.key || !keys.hasKey(pawnId, door.key)) return undefined;
    if (!keys.consumeKey(pawnId, door.key)) return undefined;
    door.locked = false;
    door.open = true;
    return doorFrame(door.id, door.open, door.locked);
  }
  door.open = !door.open;
  return doorFrame(door.id, door.open, door.locked);
}

export function parseUse(frame: unknown): UseFrame | undefined {
  if (!frame || typeof frame !== "object") return undefined;
  const rec = frame as Record<string, unknown>;
  if (rec.t !== "use" || rec.v !== 1) return undefined;
  if (typeof rec.seq !== "number" || !Number.isFinite(rec.seq)) return undefined;
  return useFrame(rec.seq);
}

export function parseDoor(frame: unknown): DoorFrame | undefined {
  if (!frame || typeof frame !== "object") return undefined;
  const rec = frame as Record<string, unknown>;
  if (rec.t !== "door") return undefined;
  if (typeof rec.id !== "string" || rec.id.length === 0) return undefined;
  if (typeof rec.open !== "boolean" || typeof rec.locked !== "boolean") return undefined;
  return doorFrame(rec.id, rec.open, rec.locked);
}

/** Welcome rows are `{ id, open, locked }` and may omit `t`. */
export function parseDoorSet(value: unknown): DoorFrame[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: DoorFrame[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.id !== "string" || rec.id.length === 0) continue;
    if (typeof rec.open !== "boolean" || typeof rec.locked !== "boolean") continue;
    out.push(doorFrame(rec.id, rec.open, rec.locked));
  }
  return out;
}
