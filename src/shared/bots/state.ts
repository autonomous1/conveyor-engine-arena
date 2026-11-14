/**
 * World-state keys for the shared planner.
 * The bot client builds a record from its welcome snapshot and later frames.
 * A held key stays held: unlock does not clear `hasKey`.
 *
 * @why String keys, not an enum, because goap.ts is copied verbatim and cannot
 *      change. The schema lives here, in actions.ts, and in goals.ts.
 */
// ARCHITECTURE: World-state schema for the GOAP planner. Fact keys are strings
//   consumed by actions.ts and goals.ts, and read by plan() and chooseGoal().
// Wiring: Built by the bot client (task 15) from its world model; imported by
//   actions.ts and goals.ts; not imported by the server.
// Invariants: `hasKey:<id>` stays true once set (keys are never consumed).
//   `avail:<id>` transitions true → false on pickup and never back.
import type { Fact, WorldState } from "./goap.js";

export const AT = "at";
export const HAS_WEAPON = "hasWeapon";
export const HAS_AMMO = "hasAmmo";

export const DOOR_AT_PREFIX = "door:";
export const PICKUP_AT_PREFIX = "pickup:";

export function hasKeyFact(pickupId: string): string {
  return `hasKey:${pickupId}`;
}

export function availFact(pickupId: string): string {
  return `avail:${pickupId}`;
}

export function doorOpenFact(doorId: string): string {
  return `doorOpen:${doorId}`;
}

export function doorLockedFact(doorId: string): string {
  return `doorLocked:${doorId}`;
}

/**
 * Retrieve is satisfied when this is true. For a key it matches `hasKey`.
 * @see hasKeyFact
 */
export function holdingFact(pickupId: string): string {
  return `holding:${pickupId}`;
}

export function atDoor(doorId: string): string {
  return `${DOOR_AT_PREFIX}${doorId}`;
}

export function atPickup(pickupId: string): string {
  return `${PICKUP_AT_PREFIX}${pickupId}`;
}

export type WorldSnapshot = {
  /** Place id, or `door:<id>` / `pickup:<id>` when an action ended on that spot. */
  at: string;
  /** Welcome pickup ids. */
  pickups: readonly string[];
  /** Ids named by a `pickup` gone frame. */
  gone?: readonly string[];
  /** Key ids this bot holds. Sets `hasKey` and `holding`. */
  heldKeys?: readonly string[];
  doors: readonly { id: string; open: boolean; locked: boolean }[];
  /** Welcome or loadout weapon id. */
  weapon?: string;
  /** Welcome or loadout ammo count. */
  ammo?: number;
};

/**
 * Flat record `plan` reads.
 * @invariant A held key sets both `hasKey` and `holding`. An absent fact is
 *            omitted, so readers treat it as false.
 *            (test: world_state_key_sets_both_facts)
 */
export function buildWorldState(world: WorldSnapshot): WorldState {
  const gone = new Set(world.gone ?? []);
  const state: Record<string, Fact> = { [AT]: world.at };
  for (const id of world.pickups) {
    if (!gone.has(id)) state[availFact(id)] = true;
  }
  for (const id of world.heldKeys ?? []) {
    state[hasKeyFact(id)] = true;
    state[holdingFact(id)] = true;
  }
  for (const door of world.doors) {
    state[doorOpenFact(door.id)] = door.open;
    state[doorLockedFact(door.id)] = door.locked;
  }
  if (typeof world.weapon === "string" && world.weapon.length > 0) state[HAS_WEAPON] = true;
  if (typeof world.ammo === "number" && world.ammo > 0) state[HAS_AMMO] = true;
  return state;
}
