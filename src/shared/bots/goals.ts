/**
 * Mission goals. Higher priority wins. `idle` is 0, so `chooseGoal` never plans it.
 * Retrieve stays ahead of arming: a fetch does not detour for a weapon first.
 */
import type { Goal, WorldState } from "./goap.js";
import { AT, HAS_WEAPON, availFact, holdingFact } from "./state.js";

/**
 * @why Priority 5, the mission goal. Beats armUp even when unarmed so the bot
 *      still goes for the key rather than detouring to a weapon.
 */
export function retrieve(pickupId: string, placeId: string): Goal {
  return {
    id: `retrieve:${pickupId}@${placeId}`,
    want: { [holdingFact(pickupId)]: true },
    priority: () => 5,
  };
}

/**
 * @why Priority 3. Loses to armUp and retrieve.
 */
export function reach(placeId: string): Goal {
  return {
    id: `reach:${placeId}`,
    want: { [AT]: placeId },
    priority: () => 3,
  };
}

/**
 * @why Priority 4, only while unarmed and a weapon is available.
 */
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

/**
 * @why Priority 0 so chooseGoal skips it. goap.ts filters p > 0 before
 *      planning, and the caller treats undefined as idle. A non-zero
 *      priority would make chooseGoal always return a plan.
 */
export function idle(): Goal {
  return {
    id: "idle",
    want: {},
    priority: () => 0,
  };
}
