// ARCHITECTURE: Host pickup grants: remaining ids, per-pawn keys/loadout, and
//   obstacle release.
// Wiring: arena-host.ts builds `createPickupHost`, filters the tick's bodies with
//   `pickupCandidates`, calls `take` and `releasePickupObstacle` in `onTick`, and
//   reads `pawnBodies`.
// Order: `take` runs before grenades in `onTick`.
// Invariants: A taken id leaves the remaining set; a key is recorded on one
//   pawn only.
import type { AuthoritativeWorld } from "conveyor-engine-world";
import type { PawnHealth } from "../shared/health.js";
import { pickupBoxSource, type PawnBody } from "../shared/pickups.js";

/**
 * Living capsules.
 * @why A dead pawn stays in the list with `alive: false` so it cannot take.
 */
export function pawnBodies(world: AuthoritativeWorld, health: PawnHealth): PawnBody[] {
  const height = Number.isFinite(world.pawnHeight) ? world.pawnHeight : 1.8;
  const out: PawnBody[] = [];
  for (const entity of world.query()) {
    if (entity.lifecycle !== "alive" || !(entity.radius > 0)) continue;
    out.push({
      id: entity.id,
      x: entity.position.x,
      y: entity.position.y,
      z: entity.position.z,
      radius: entity.radius,
      height,
      alive: !health.isDead(entity.id),
    });
  }
  return out;
}

/**
 * The pawn bodies a prop pickup may take this tick.
 * @why The NPC-vs-client policy is authored in the manifest; this filter is the
 *      host's enforcement of it, not a policy source.
 * @post A filtered pawn cannot take; the kept bodies keep their input order, and an
 *       id in neither group is kept. The NPC set wins if an id is in both.
 */
export function pickupCandidates(
  bodies: readonly PawnBody[],
  npcIds: ReadonlySet<number>,
  padIds: ReadonlySet<number>,
  allow: { npc: boolean; client: boolean },
): PawnBody[] {
  return bodies.filter((body) => {
    if (npcIds.has(body.id)) return allow.npc;
    if (padIds.has(body.id)) return allow.client;
    return true;
  });
}

/**
 * @why The kernel has no remove and this does not destroy an entity, so the
 *      live `listObstacles` array is spliced in place.
 */
export function releasePickupObstacle(
  world: AuthoritativeWorld,
  boxes: readonly { id: number; source?: string }[],
  placementId: string,
): void {
  const source = pickupBoxSource(placementId);
  const numeric = boxes.find((box) => box.source === source)?.id;
  if (typeof numeric !== "number") return;
  const live = world.listObstacles() as unknown as { id: number }[];
  const index = live.findIndex((box) => box.id === numeric);
  if (index >= 0) live.splice(index, 1);
}
