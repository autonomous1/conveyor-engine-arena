/**
 * Mission goals. Higher priority wins. `idle` is 0, so `chooseGoal` never plans it.
 * Retrieve stays ahead of arming: a fetch does not detour for a weapon first.
 */
import type { Goal, WorldState } from "./goap.js";
import { AT, HAS_WEAPON, availFact, holdingFact } from "./state.js";

export function retrieve(pickupId: string, placeId: string): Goal {
  return {
    id: `retrieve:${pickupId}@${placeId}`,
    want: { [holdingFact(pickupId)]: true },
    priority: () => 5,
  };
}

export function reach(placeId: string): Goal {
  return {
    id: `reach:${placeId}`,
    want: { [AT]: placeId },
    priority: () => 3,
  };
}

/** Priority 4 while unarmed and one of `weaponIds` is still available. */
export function armUp(weaponIds: readonly string[]): Goal {
  return {
    id: "armUp",
    want: { [HAS_WEAPON]: true },
    priority(s: WorldState): number {
      if (s[HAS_WEAPON] === true) return 0;
      for (const id of weaponIds) {
        if (s[availFact(id)] === true) return 4;
      }
      return 0;
    },
  };
}

export function idle(): Goal {
  return {
    id: "idle",
    want: {},
    priority: () => 0,
  };
}
