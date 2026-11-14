/**
 * Arena pawn health. A hit subtracts {@link HIT_DAMAGE}, the value stays in
 * [{@link MIN_HP}, {@link MAX_HP}], and 0 is dead until {@link RESPAWN_MS} has
 * passed.
 * @why It is not a kernel field.
 */
// ARCHITECTURE: Pawn hp, damage notes, respawn timers, and the health frame.
// Wiring: server/health.ts (with fire, grenade, and pickups) mutates it;
//   server/arena-host.ts sends; client/hud.ts and client/net.ts read.

export const MAX_HP = 100;
export const MIN_HP = 0;
export const HIT_DAMAGE = 25;
export const RESPAWN_MS = 3000;

export type DamageCause = "grenade" | "laser";

export type HealthFrame = {
  t: "health";
  entity: number;
  hp: number;
  dead: boolean;
  /** Present only on a frame that reports death, and only when known. */
  cause?: DamageCause;
};

export type PawnHealthState = {
  hp: number;
  dead: boolean;
};

/**
 * Who last wounded a pawn and when (`now()` clock). `attacker` is undefined when unknown.
 * `seq` increments on every hp loss, including two wounds that share `at`.
 */
export type DamageNote = { attacker: number | undefined; at: number; seq: number; cause?: DamageCause };

export function isDamageCause(value: unknown): value is DamageCause {
  return value === "grenade" || value === "laser";
}

export function clampHealth(hp: number): number {
  if (!Number.isFinite(hp)) return MIN_HP;
  if (hp < MIN_HP) return MIN_HP;
  if (hp > MAX_HP) return MAX_HP;
  return hp;
}

export function healthFrame(entity: number, hp: number, dead: boolean, cause?: DamageCause): HealthFrame {
  const frame: HealthFrame = { t: "health", entity, hp: clampHealth(hp), dead };
  if (dead && isDamageCause(cause)) frame.cause = cause;
  return frame;
}

export function parseHealth(frame: unknown): HealthFrame | undefined {
  if (!frame || typeof frame !== "object") return undefined;
  const rec = frame as Record<string, unknown>;
  if (rec.t !== "health") return undefined;
  if (typeof rec.entity !== "number" || !Number.isInteger(rec.entity)) return undefined;
  if (typeof rec.hp !== "number" || !Number.isFinite(rec.hp)) return undefined;
  if (typeof rec.dead !== "boolean") return undefined;
  return healthFrame(rec.entity, rec.hp, rec.dead, isDamageCause(rec.cause) ? rec.cause : undefined);
}

type Vital = {
  hp: number;
  dead: boolean;
  respawnAt?: number;
  lastAttacker?: number;
  lastDamageAt?: number;
  /** How many wounds have landed since spawn. Each hp loss increments it. */
  damageSeq?: number;
  lastCause?: DamageCause;
};

/**
 * Per-pawn hp, death, and respawn timers. In memory, lost on restart.
 * @invariant hp stays in [{@link MIN_HP}, {@link MAX_HP}]. A dead pawn is
 *            unchanged by `wound` and `heal`.
 *            (test: health_stays_in_range)
 */
export interface PawnHealth {
  /** Creates a full-health row when absent. An existing row is left as it is. */
  note(id: number): void;
  /** Unknown pawns read as full health and do not create a row. Detached. */
  get(id: number): PawnHealthState;
  /** Unknown id reads as alive. Does not create a row. */
  isDead(id: number): boolean;
  /**
   * Detached note of the last wound since spawn. Survives death, cleared on respawn.
   * Absent when this pawn has no wound. Does not create a row. `at` is ms on the injected `now`.
   */
  lastDamage(id: number): DamageNote | undefined;
  /**
   * Creates the row. Omitted, non-finite, or non-positive `amount` deals {@link HIT_DAMAGE}.
   * A dead pawn is unchanged and returns undefined, so the respawn clock does not restart.
   */
  wound(id: number, attacker?: number, amount?: number, cause?: DamageCause): PawnHealthState | undefined;
  /**
   * Creates the row. A dead pawn is unchanged and returns undefined.
   * A non-positive `amount` does not add. Mutates when it does, clamped to [{@link MIN_HP}, {@link MAX_HP}].
   */
  heal(id: number, amount: number): PawnHealthState | undefined;
  /** Restores due pawns to full health and returns their ids. Mutates. Clock is the injected `now`. New array. */
  takeRespawns(): number[];
  /** Detached frames for every noted pawn. Unknown ids are absent. A cause is set only while that pawn is dead. */
  frames(): HealthFrame[];
}

/**
 * One row per pawn the host has noted.
 * @post Unknown pawns read as full health.
 */
export function createPawnHealth(now: () => number = Date.now): PawnHealth {
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
    /** Last wound on this pawn since it last spawned. Survives death (kill credit), cleared on respawn. */
    lastDamage(id: number): DamageNote | undefined {
      const row = rows.get(id);
      if (!row || row.lastDamageAt === undefined) return undefined;
      const note: DamageNote = { attacker: row.lastAttacker, at: row.lastDamageAt, seq: row.damageSeq ?? 0 };
      if (row.lastCause) note.cause = row.lastCause;
      return note;
    },
    /**
     * Subtract one hit. `amount` defaults to {@link HIT_DAMAGE}. A pawn already
     * at 0 is unchanged so a later shot does not restart the respawn clock.
     */
    wound(id: number, attacker?: number, amount: number = HIT_DAMAGE, cause?: DamageCause): PawnHealthState | undefined {
      const row = ensure(id);
      if (row.dead) return undefined;
      const dealt = Number.isFinite(amount) && amount > 0 ? amount : HIT_DAMAGE;
      const hp = clampHealth(row.hp - dealt);
      row.hp = hp;
      row.dead = hp === MIN_HP;
      row.respawnAt = row.dead ? now() + RESPAWN_MS : undefined;
      row.lastAttacker = Number.isInteger(attacker) ? attacker : undefined;
      row.lastDamageAt = now();
      row.damageSeq = (row.damageSeq ?? 0) + 1;
      row.lastCause = isDamageCause(cause) ? cause : undefined;
      return { hp: row.hp, dead: row.dead };
    },
    /** Add health and stay inside [0, 100]. A dead pawn is unchanged. */
    heal(id: number, amount: number): PawnHealthState | undefined {
      const row = ensure(id);
      if (row.dead) return undefined;
      if (!Number.isFinite(amount) || amount <= 0) return { hp: row.hp, dead: false };
      row.hp = clampHealth(row.hp + amount);
      return { hp: row.hp, dead: false };
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
        row.lastAttacker = undefined;
        row.lastDamageAt = undefined;
        row.damageSeq = undefined;
        row.lastCause = undefined;
        ids.push(id);
      }
      return ids;
    },
    frames(): HealthFrame[] {
      const out: HealthFrame[] = [];
      for (const [entity, row] of rows) out.push(healthFrame(entity, row.hp, row.dead, row.dead ? row.lastCause : undefined));
      return out;
    },
  };
}

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

/**
 * First spawn that is clear of boxes and other pawns.
 * @post Falls back to the first spawn when none is clear.
 */
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

/**
 * Same height rule as the kernel spawn check.
 * @post A missing Y pair blocks at every height.
 */
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
