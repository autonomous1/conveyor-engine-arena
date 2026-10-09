/**
 * Arena pawn health. It is not a kernel field. A hit subtracts
 * {@link HIT_DAMAGE}, the value stays in [{@link MIN_HP}, {@link MAX_HP}],
 * and 0 is dead until {@link RESPAWN_MS} has passed.
 */

export const MAX_HP = 100;
export const MIN_HP = 0;
export const HIT_DAMAGE = 25;
export const RESPAWN_MS = 3000;

export type HealthFrame = {
  t: "health";
  entity: number;
  hp: number;
  dead: boolean;
};

export type PawnHealthState = {
  hp: number;
  dead: boolean;
};

export function clampHealth(hp: number): number {
  if (!Number.isFinite(hp)) return MIN_HP;
  if (hp < MIN_HP) return MIN_HP;
  if (hp > MAX_HP) return MAX_HP;
  return hp;
}

export function healthFrame(entity: number, hp: number, dead: boolean): HealthFrame {
  return { t: "health", entity, hp: clampHealth(hp), dead };
}

export function parseHealth(frame: unknown): HealthFrame | undefined {
  if (!frame || typeof frame !== "object") return undefined;
  const rec = frame as Record<string, unknown>;
  if (rec.t !== "health") return undefined;
  if (typeof rec.entity !== "number" || !Number.isInteger(rec.entity)) return undefined;
  if (typeof rec.hp !== "number" || !Number.isFinite(rec.hp)) return undefined;
  if (typeof rec.dead !== "boolean") return undefined;
  return healthFrame(rec.entity, rec.hp, rec.dead);
}

type Vital = { hp: number; dead: boolean; respawnAt?: number };

/** One row per pawn the host has noted. Unknown pawns read as full health. */
export function createPawnHealth(now: () => number = Date.now) {
  const rows = new Map<number, Vital>();

  function ensure(id: number): Vital {
    let row = rows.get(id);
    if (!row) {
      row = { hp: MAX_HP, dead: false };
      rows.set(id, row);
    }
    return row;
  }

  return {
    note(id: number) {
      ensure(id);
    },
    get(id: number): PawnHealthState {
      const row = rows.get(id);
      if (!row) return { hp: MAX_HP, dead: false };
      return { hp: row.hp, dead: row.dead };
    },
    isDead(id: number): boolean {
      return rows.get(id)?.dead ?? false;
    },
    /**
     * Subtract one hit. A pawn already at 0 is unchanged so a later shot
     * does not restart the respawn clock.
     */
    wound(id: number): PawnHealthState | undefined {
      const row = ensure(id);
      if (row.dead) return undefined;
      const hp = clampHealth(row.hp - HIT_DAMAGE);
      row.hp = hp;
      row.dead = hp === MIN_HP;
      row.respawnAt = row.dead ? now() + RESPAWN_MS : undefined;
      return { hp: row.hp, dead: row.dead };
    },
    /** Pawns whose respawn time has arrived. They come back at full health. */
    takeRespawns(): number[] {
      const at = now();
      const ids: number[] = [];
      for (const [id, row] of rows) {
        if (!row.dead || row.respawnAt === undefined || at < row.respawnAt) continue;
        row.hp = MAX_HP;
        row.dead = false;
        row.respawnAt = undefined;
        ids.push(id);
      }
      return ids;
    },
    frames(): HealthFrame[] {
      const out: HealthFrame[] = [];
      for (const [entity, row] of rows) out.push(healthFrame(entity, row.hp, row.dead));
      return out;
    },
  };
}

export type PawnHealth = ReturnType<typeof createPawnHealth>;

export type SpawnPick = { x: number; y: number; z: number; yaw: number };

export type BlockAabb = {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  minY?: number;
  maxY?: number;
};

export type BlockPawn = { id: number; x: number; y: number; z: number; radius: number };

export type SpawnBlockers = {
  self: number;
  radius: number;
  height: number;
  aabbs: readonly BlockAabb[];
  pawns: readonly BlockPawn[];
};

/** First spawn that is clear of boxes and other pawns. If none are, the first spawn. */
export function pickRespawnSpawn<T extends SpawnPick>(spawns: readonly T[], blockers: SpawnBlockers): T | undefined {
  if (spawns.length === 0) return undefined;
  for (const spawn of spawns) {
    if (!spawnBlocked(spawn, blockers)) return spawn;
  }
  return spawns[0];
}

function spawnBlocked(spawn: SpawnPick, blockers: SpawnBlockers): boolean {
  for (const box of blockers.aabbs) {
    if (pawnHitsBox(spawn.x, spawn.z, blockers.radius, spawn.y, blockers.height, box)) return true;
  }
  for (const pawn of blockers.pawns) {
    if (pawn.id === blockers.self) continue;
    if (bodiesOverlap(spawn.x, spawn.y, spawn.z, blockers.radius, pawn.x, pawn.y, pawn.z, pawn.radius, blockers.height)) return true;
  }
  return false;
}

/** Same height rule as the kernel spawn check. A missing Y pair blocks at every height. */
export function pawnHitsBox(
  x: number,
  z: number,
  radius: number,
  feetY: number,
  height: number,
  box: BlockAabb,
): boolean {
  if (box.minY !== undefined && box.maxY !== undefined) {
    const head = feetY + height;
    if (feetY >= box.maxY || head <= box.minY) return false;
  }
  return x + radius > box.minX && x - radius < box.maxX && z + radius > box.minZ && z - radius < box.maxZ;
}

function bodiesOverlap(
  ax: number,
  ay: number,
  az: number,
  ar: number,
  bx: number,
  by: number,
  bz: number,
  br: number,
  height: number,
): boolean {
  const dx = ax - bx;
  const dz = az - bz;
  const reach = ar + br;
  if (dx * dx + dz * dz >= reach * reach) return false;
  return ay < by + height && ay + height > by;
}
