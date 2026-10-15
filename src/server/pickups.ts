import type { AuthoritativeWorld } from "conveyor-engine-world";
import type { PawnHealth } from "../shared/health.js";
import { pickupBoxSource, type PawnBody } from "../shared/pickups.js";

/** Living capsules. A dead pawn stays in the list with `alive: false` so it cannot take. */
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
 * Remove the placement's obstacle. `listObstacles` is the live array.
 * The kernel has no remove, and this does not destroy an entity.
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
