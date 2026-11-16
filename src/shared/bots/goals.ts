/**
 * Mission goals. Higher priority wins. `idle` is 0, so `chooseGoal` never plans it.
 * Retrieve stays ahead of arming: a fetch does not detour for a weapon first.
 */
// ARCHITECTURE: Goal factories and priorities: retrieve, reach, armUp, idle.
// Wiring: server/bot-brain.ts builds goals; shared/bots/actions.ts plans
//   against them.
import type { Goal, WorldState } from "./goap.js";
import { AT, HAS_WEAPON, STAND, availFact, holdingFact } from "./state.js";
import { standKey, type StandTarget } from "../nav/stand.js";

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
 * Stand Goal type.
 */
export type StandGoal = Goal & { stand: StandTarget };

/**
 * Stand at a point or one side of a door. The brain resolves the target and
 * derives the `stand` fact from the pose.
 * @why Priority 3, the reach class.
 */
export function standAt(target: StandTarget): StandGoal {
  const key = standKey(target);
  return {
    id: `stand:${key}`,
    want: { [STAND]: key },
    priority: () => 3,
    stand: target,
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
