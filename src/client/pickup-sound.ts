import type { ArenaSoundName, ArenaSounds } from "../shared/arena-view.js";
import type { PickupPlacement } from "../shared/pickups.js";

/**
 * Pickup sounds, from what the host confirms.
 *
 * The host sends `pickup gone` to every client when a placement is taken. It does not
 * say who took it. The taker alone gets what follows in the same host tick: `loadout`
 * for an ammo crate, `inventory` (the keys it holds) for a key. So a gone frame waits
 * a short grace for that follow-up:
 *  - follow-up arrives: your pickup, played non-positional at once;
 *  - none arrives within `graceMs`: someone else's, played at the pickup's position.
 *
 * Welcome state never plays. A loadout or inventory with no gone frame waiting is
 * ignored, `onSet` (the welcome pickup list) clears everything, and a placement that
 * already went is never played again.
 *
 * Which effect a kind plays comes from the manifest: each sound's `pickupKinds`.
 * A kind no effect lists is silent. Kinds with no follow-up frame (health, weapon) play
 * at once at the pickup's position; the taker is standing at it.
 */

/** Used for any kind the manifest's sounds do not claim. */
export const DEFAULT_KIND_SOUND: Readonly<Record<string, ArenaSoundName>> = {
  ammo: "cratePickup",
  key: "keyPickup",
  health: "medkitPickup",
};

/** Kind to effect, from each sound's `pickupKinds`, else the defaults. */
export function kindSoundsOf(sounds: ArenaSounds | undefined): Record<string, ArenaSoundName> {
  const out: Record<string, ArenaSoundName> = {};
  let declared = false;
  for (const [name, effect] of Object.entries(sounds ?? {})) {
    for (const kind of effect?.pickupKinds ?? []) {
      out[kind] = name as ArenaSoundName;
      declared = true;
    }
  }
  return declared ? out : { ...DEFAULT_KIND_SOUND };
}

type Point = { x: number; y: number; z: number };

type Pending = { id: string; sound: ArenaSoundName; kind: "ammo" | "key"; at: number; where: Point };

/** One play per placement. Your follow-up has no position. Anyone else's plays at the pickup. */
export interface PickupSounds {
  /** Welcome ids still present. Anything else is already spent. Silent, and drops waits. */
  onSet(ids: readonly string[]): void;
  /** One placement, at most once. Health and weapons play at once. Ammo and keys wait. Unknown is silent. */
  onGone(id: string, now: number): void;
  /** Oldest waiting ammo inside the grace, with no position. A welcome loadout must not call this. */
  onLoadout(now: number): void;
  /** A waiting key listed in `keys`, inside the grace. Plays with no position. `now` is ms. */
  onInventory(keys: readonly string[], now: number): void;
  /** Once per frame. No-op when nothing waits. A wait past the grace plays at the pickup. `now` is ms. */
  update(now: number): void;
  /** Gone frames still inside the grace. */
  readonly waiting: number;
  /** Drop waits. A placement already gone stays spent. */
  clear(): void;
}

export function createPickupSounds(opts: {
  pickups: readonly PickupPlacement[];
  /** `at` set: positional. Unset: your own. */
  play: (name: ArenaSoundName, at?: Point) => unknown;
  /** Kind to effect. Default {@link DEFAULT_KIND_SOUND}. */
  kindSounds?: Readonly<Record<string, ArenaSoundName | undefined>>;
  graceMs?: number;
}): PickupSounds {
  const graceMs = opts.graceMs ?? 250;
  const kindSounds = opts.kindSounds ?? DEFAULT_KIND_SOUND;
  const byId = new Map<string, PickupPlacement>();
  for (const pickup of opts.pickups) byId.set(pickup.id, pickup);
  const gone = new Set<string>();
  let pending: Pending[] = [];

  function centre(pickup: PickupPlacement): Point {
    return { x: (pickup.minX + pickup.maxX) / 2, y: (pickup.minY + pickup.maxY) / 2, z: (pickup.minZ + pickup.maxZ) / 2 };
  }

  return {
    /** Welcome: the placements still there. The rest were taken before we joined. Silent. */
    onSet(ids: readonly string[]) {
      pending = [];
      gone.clear();
      const left = new Set(ids);
      for (const id of byId.keys()) if (!left.has(id)) gone.add(id);
    },
    /** `pickup gone` for one placement. Plays at most once per placement. */
    onGone(id: string, now: number) {
      const pickup = byId.get(id);
      if (!pickup || gone.has(id)) return;
      gone.add(id);
      const sound = kindSounds[pickup.kind];
      if (!sound) return;
      if (pickup.kind !== "ammo" && pickup.kind !== "key") {
        opts.play(sound, centre(pickup));
        return;
      }
      pending.push({ id, sound, kind: pickup.kind, at: now, where: centre(pickup) });
    },
    /** Owner-only `loadout` (not the welcome one): the oldest waiting ammo crate was yours. */
    onLoadout(now: number) {
      const index = pending.findIndex((entry) => entry.kind === "ammo" && now - entry.at <= graceMs);
      if (index < 0) return;
      const [entry] = pending.splice(index, 1);
      opts.play(entry!.sound);
    },
    /** Owner-only `inventory`: a waiting key listed in it was yours. */
    onInventory(keys: readonly string[], now: number) {
      const index = pending.findIndex((entry) => entry.kind === "key" && keys.includes(entry.id) && now - entry.at <= graceMs);
      if (index < 0) return;
      const [entry] = pending.splice(index, 1);
      opts.play(entry!.sound);
    },
    /** Once per frame. Free when nothing waits. Expired entries were someone else's. */
    update(now: number) {
      if (pending.length === 0) return;
      let kept = 0;
      for (const entry of pending) {
        if (now - entry.at > graceMs) opts.play(entry.sound, entry.where);
        else pending[kept++] = entry;
      }
      pending.length = kept;
    },
    get waiting() {
      return pending.length;
    },
    clear() {
      pending = [];
    },
  };
}
