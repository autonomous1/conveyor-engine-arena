/**
 * Arena pickups. A placement id is a string. The host removes that id from
 * the remaining set. It does not create or destroy a world entity.
 *
 * The obstacle resolver parks a capsule on the box face, so the touch test is
 * closed: distance <= radius counts. A strict overlap would miss the contact.
 */

export const HEALTH_PICKUP = 25;
export const AMMO_PICKUP = 30;
/** The resolver can sit a fraction of a millimeter off the expanded face. */
const TOUCH_SLOP_M = 1e-3;

export type PickupKind = "ammo" | "health" | "weapon" | "key";

export type PickupPlacement = {
  id: string;
  kind: PickupKind;
  /** GLB uri. The owning client mounts this when `kind` is weapon. */
  model: string;
  /** Asset id stored on the pawn. Present when `kind` is weapon. */
  weapon?: string;
  amount: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
};

export type PickupFrame = {
  t: "pickup";
  id: string;
  gone: true;
};

export type LoadoutFrame = {
  t: "loadout";
  ammo: number;
  weapon?: string;
};

export type PawnBody = {
  id: number;
  x: number;
  y: number;
  z: number;
  radius: number;
  height: number;
  alive: boolean;
};

export type HealthSink = {
  heal(id: number, amount: number): unknown;
};

export type PickupGrant = {
  id: string;
  pawnId: number;
  kind: PickupKind;
  gone: PickupFrame;
  /** Owner only. Absent for a health pickup. */
  loadout?: LoadoutFrame;
};

/** Placement obstacle id. The debug wire and the collision list use this name. */
export function pickupBoxSource(id: string): string {
  return `${id}-box`;
}

/** Drop the box named for this placement. A second call is a no-op. */
export function dropPickupAabb<T extends { source?: string }>(boxes: T[], placementId: string): void {
  const source = pickupBoxSource(placementId);
  for (let i = boxes.length - 1; i >= 0; i -= 1) {
    const box = boxes[i];
    if (box && (box.source === source || box.source === placementId)) boxes.splice(i, 1);
  }
}

export function parsePickupKind(value: unknown): PickupKind | undefined {
  if (value === "ammo" || value === "health" || value === "weapon" || value === "key" ) return value;
  return undefined;
}

export function pickupFrame(id: string): PickupFrame {
  return { t: "pickup", id, gone: true };
}

export function loadoutFrame(ammo: number, weapon?: string): LoadoutFrame {
  const frame: LoadoutFrame = { t: "loadout", ammo };
  if (weapon) frame.weapon = weapon;
  return frame;
}

/** A numeric id is not a placement. It is left unread. */
export function parsePickup(frame: unknown): PickupFrame | undefined {
  if (!frame || typeof frame !== "object") return undefined;
  const rec = frame as Record<string, unknown>;
  if (rec.t !== "pickup" || rec.gone !== true) return undefined;
  if (typeof rec.id !== "string" || rec.id.length === 0) return undefined;
  return pickupFrame(rec.id);
}

export function parseLoadout(frame: unknown): LoadoutFrame | undefined {
  if (!frame || typeof frame !== "object") return undefined;
  const rec = frame as Record<string, unknown>;
  if (rec.t !== "loadout") return undefined;
  if (typeof rec.ammo !== "number" || !Number.isFinite(rec.ammo)) return undefined;
  if (rec.weapon !== undefined && (typeof rec.weapon !== "string" || rec.weapon.length === 0)) return undefined;
  return loadoutFrame(rec.ammo, typeof rec.weapon === "string" ? rec.weapon : undefined);
}

/** Remaining placement ids. Numbers are dropped, not coerced. */
export function parsePickupSet(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0) continue;
    ids.push(item);
  }
  return ids;
}

export function capsuleOverlapsAabb(
  x: number,
  y: number,
  z: number,
  radius: number,
  height: number,
  box: { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number },
): boolean {
  if (![x, y, z, radius, height, box.minX, box.maxX, box.minY, box.maxY, box.minZ, box.maxZ].every(Number.isFinite)) {
    return false;
  }
  if (!(radius > 0) || !(height > 0)) return false;
  const head = y + height;
  if (y >= box.maxY || head <= box.minY) return false;
  const nearestX = Math.min(box.maxX, Math.max(box.minX, x));
  const nearestZ = Math.min(box.maxZ, Math.max(box.minZ, z));
  const dx = x - nearestX;
  const dz = z - nearestZ;
  const reach = radius + TOUCH_SLOP_M;
  return dx * dx + dz * dz <= reach * reach;
}

/**
 * First living pawn in the list that touches a remaining pickup takes it.
 * The id is reported once. The caller deletes it from the set.
 */
export function collectTouches(
  remaining: ReadonlySet<string>,
  pickups: readonly PickupPlacement[],
  pawns: readonly PawnBody[],
): { id: string; pawnId: number }[] {
  const taken: { id: string; pawnId: number }[] = [];
  const used = new Set<string>();
  for (const pickup of pickups) {
    if (!remaining.has(pickup.id) || used.has(pickup.id)) continue;
    for (const pawn of pawns) {
      if (!pawn.alive || !(pawn.radius > 0)) continue;
      if (!capsuleOverlapsAabb(pawn.x, pawn.y, pawn.z, pawn.radius, pawn.height, pickup)) continue;
      used.add(pickup.id);
      taken.push({ id: pickup.id, pawnId: pawn.id });
      break;
    }
  }
  return taken;
}

export function createPawnKit() {
  const ammo = new Map<number, number>();
  const weapon = new Map<number, string>();
  return {
    ammoOf(id: number): number {
      return ammo.get(id) ?? 0;
    },
    weaponOf(id: number): string | undefined {
      return weapon.get(id);
    },
    addAmmo(id: number, amount: number): number {
      const next = (ammo.get(id) ?? 0) + (Number.isFinite(amount) && amount > 0 ? amount : 0);
      ammo.set(id, next);
      return next;
    },
    setWeapon(id: number, weaponId: string): string {
      weapon.set(id, weaponId);
      return weaponId;
    },
  };
}

export type PawnKit = ReturnType<typeof createPawnKit>;

/**
 * Remaining pickup ids. Seeded from placements. Taking one deletes the id.
 * Health already at 100, ammo that does not rise, and a weapon the pawn
 * already holds still consume the placement. A taken key is recorded.
 * Touching an id that is already held grants nothing.
 */
export function createPickupHost(list: readonly PickupPlacement[]) {
  const placements = list.filter((pickup) => typeof pickup.id === "string" && pickup.id.length > 0);
  const remaining = new Set(placements.map((pickup) => pickup.id));
  const byId = new Map(placements.map((pickup) => [pickup.id, pickup]));
  const heldKeys = new Set<string>();
  return {
    remainingIds(): string[] {
      return [...remaining].sort();
    },
    /** True after a key pickup has been stored. */
    hasKey(): boolean {
      return heldKeys.size > 0;
    },
    /** Key placement ids the player is holding. */
    getHeldItems(): string[] {
      return [...heldKeys].sort();
    },
    take(pawns: readonly PawnBody[], health: HealthSink, kit: PawnKit): PickupGrant[] {
      const grants: PickupGrant[] = [];
      for (const touch of collectTouches(remaining, placements, pawns)) {
        const pickup = byId.get(touch.id);
        if (pickup?.kind === "key" && heldKeys.has(pickup.id)) continue;
        remaining.delete(touch.id);
        if (!pickup) continue;
        let loadout: LoadoutFrame | undefined;
        if (pickup.kind === "health") {
          health.heal(touch.pawnId, pickup.amount);
        } else if (pickup.kind === "ammo") {
          kit.addAmmo(touch.pawnId, pickup.amount);
          loadout = loadoutFrame(kit.ammoOf(touch.pawnId), kit.weaponOf(touch.pawnId));
        } else if (pickup.kind === "weapon" && pickup.weapon) {
          kit.setWeapon(touch.pawnId, pickup.weapon);
          loadout = loadoutFrame(kit.ammoOf(touch.pawnId), pickup.weapon);
        } else if (pickup.kind === "key") {
          heldKeys.add(pickup.id);
        }
        grants.push({
          id: pickup.id,
          pawnId: touch.pawnId,
          kind: pickup.kind,
          gone: pickupFrame(pickup.id),
          loadout,
        });
      }
      return grants;
    },
  };
}
