/**
 * Goal arbitration for a host wander bot. Pure: the caller passes the sensed
 * state and the clock. Wander is the fallback. Escape (KeepMoving) takes over
 * once a bot inside a building is trapped and holds until it is outside.
 * Evade runs from a recent hit and holds until the bot has been safe. It does
 * not clear an Escape latch, so Escape resumes with the same timer.
 */
import type { BotSense } from "./sense.js";

export type ArbiterTuning = {
  /** No route out of the place, or no net movement, for this long means trapped. */
  trappedMs: number;
  /** Still trapped this long after it began: the bot respawns itself. */
  respawnMs: number;
  /**
   * Outside and not moving this long: a jammed capsule, not a trap. There is
   * nothing to escape to, so the bot respawns without an Escape.
   */
  outsideWedgedMs: number;
};

/** 60 s, 120 s, 180 s. */
export const DEFAULT_ARBITER_TUNING: Readonly<ArbiterTuning> = Object.freeze({
  trappedMs: 60_000,
  respawnMs: 120_000,
  outsideWedgedMs: 180_000,
});

export type GoalId = "wander" | "escape" | "evade";

export const WANDER_PRIORITY = 1;
export const ESCAPE_PRIORITY = 6;
/** Hurt, but not shot in the last {@link UNDER_FIRE_MS}. */
export const EVADE_HURT_PRIORITY = 8.5;
/** Damaged within {@link UNDER_FIRE_MS}. */
export const EVADE_UNDER_FIRE_PRIORITY = 9.5;
/** The place a bot is trying to reach. Same id as the sensor's exit. */
export const EXIT_PLACE = "outside";

/** Recent damage still counts as hurt. */
export const HURT_MS = 10_000;
/** Recent damage counts as under fire, which raises Evade's priority. */
export const UNDER_FIRE_MS = 2_000;
/** No damage for this long is the quiet half of `safe`. */
export const SAFE_QUIET_MS = 5_000;
/** `safe` must stay true this long, with no new damage, before Evade lets go. */
export const SAFE_HOLD_MS = 3_000;
/** Evade does not end before this, even when `safe` already held. */
export const EVADE_DWELL_MS = 1_500;
/** After Evade ends, the same damage note cannot start it again until this passes. A new `seq` does not wait. */
export const EVADE_COOLDOWN_MS = 5_000;
/** Metres from the threat. This far is `safe` even while the threat can still see the bot. */
export const SAFE_DISTANCE_M = 35;
/**
 * Armed and above this fraction of hp, the bot would rather fight.
 * `armed` stays false until a later task, so a hit flees unless the bot is cornered.
 */
export const FLEE_BELOW = 0.5;

/** What the arbiter reads. `BotSense` satisfies it. The threat fields are optional. */
export type MindSense = Pick<BotSense, "alive" | "place" | "msNoProgress" | "routeOut"> & {
  damage?: BotSense["damage"];
  hpFrac?: number;
  /** False until the bot carries a weapon. */
  armed?: boolean;
  /** Horizontal metres from the bot to the threat position. */
  threatDist?: number;
  /** Place of the threat. The place the bot was standing when the attacker is unknown. */
  threatPlace?: string;
  /**
   * Timestamp of the current damage note (`sense.at - ageMs`).
   * The same note keeps this value. Absent: `now - damage.ageMs`.
   */
  damageAt?: number;
  /** `SensedDamage.seq`. A change is a new hp loss even when `damageAt` is unchanged. */
  damageSeq?: number;
  /**
   * The threat's eye can see the bot's chest. The caller checks this with
   * `losGate(5)`. Absent is not hidden: only {@link SAFE_DISTANCE_M} then counts.
   */
  threatSeen?: boolean;
};

/** Latch for one bot. Timestamps are ms on the `now` passed to `judge`. */
export type Mind = {
  /** ms when this place first had no open route out. Cleared when that is no longer true. */
  noRouteSince?: number;
  /** Place id for `noRouteSince`. Cleared with it. */
  noRoutePlace?: string;
  /** ms when Escape latched. Absent unless Escape holds. Survives Evade. */
  escapeSince?: number;
  /** ms when Evade latched. Absent unless Evade holds. */
  evadeSince?: number;
  /** ms when `safe` became true during this Evade. Cleared when `safe` is false. */
  safeSince?: number;
  /** ms when Evade last ended because it was safe. Starts the cool-down. */
  evadeEndedAt?: number;
  /** `damageAt` of the note that ended that Evade. Used when the note has no `seq`. */
  coolHitAt?: number;
  /** `damageSeq` of that note. A different seq is a new hit and does not cool down. */
  coolSeq?: number;
  /** Last `damageSeq` applied. The tick it changes counts as fresh damage. */
  hurtSeq?: number;
  /** No flee point, or two more hits while fleeing. Suppresses Evade until hurt expires. */
  cornered?: boolean;
};

export type Verdict = {
  goal: GoalId;
  priority: number;
  /** The trap condition holds right now. */
  trapped: boolean;
  /** Milliseconds since Escape began, 0 under Wander. */
  escapeMs: number;
  /** Escape has run `respawnMs` and the bot is still not out. */
  respawn: boolean;
};

export function createMind(): Mind {
  return {};
}

export function resetMind(mind: Mind): void {
  mind.noRouteSince = undefined;
  mind.noRoutePlace = undefined;
  mind.escapeSince = undefined;
  mind.evadeSince = undefined;
  mind.safeSince = undefined;
  mind.evadeEndedAt = undefined;
  mind.coolHitAt = undefined;
  mind.coolSeq = undefined;
  mind.hurtSeq = undefined;
  mind.cornered = undefined;
}

/**
 * One decision. Wander is 1, Escape is 6 while it holds, and Evade is 9.5
 * under fire or 8.5 while the hurt memory lasts. Escape is latched: it begins
 * when the bot is trapped and ends only once the bot is outside, so a place
 * change or an opened door on the way out does not drop it. Evade is latched
 * the same way and does not clear that Escape timer.
 */
export function judge(
  mind: Mind,
  sense: MindSense,
  now: number,
  tuning: Readonly<ArbiterTuning> = DEFAULT_ARBITER_TUNING,
): Verdict {
  if (!sense.alive) {
    resetMind(mind);
    return { goal: "wander", priority: WANDER_PRIORITY, trapped: false, escapeMs: 0, respawn: false };
  }
  const base = escapeVerdict(mind, sense, now, tuning);
  const evade = evadeVerdict(mind, sense, now);
  if (!evade) return base;
  return { goal: "evade", priority: evade, trapped: base.trapped, escapeMs: base.escapeMs, respawn: base.respawn };
}

function escapeVerdict(mind: Mind, sense: MindSense, now: number, tuning: Readonly<ArbiterTuning>): Verdict {
  const out = sense.place === EXIT_PLACE;
  const noRoute = sense.place !== undefined && !out && sense.routeOut !== undefined && !sense.routeOut.open;
  if (!noRoute) {
    mind.noRouteSince = undefined;
    mind.noRoutePlace = undefined;
  } else if (mind.noRouteSince === undefined || mind.noRoutePlace !== sense.place) {
    mind.noRouteSince = now;
    mind.noRoutePlace = sense.place;
  }
  // A bot that is already outside has nowhere to escape to. It never starts
  // Escape, and one that arrives outside lets go at once. Wander finds it a walk.
  if (out) {
    mind.escapeSince = undefined;
    return {
      goal: "wander",
      priority: WANDER_PRIORITY,
      trapped: false,
      escapeMs: 0,
      respawn: sense.msNoProgress >= tuning.outsideWedgedMs,
    };
  }
  const wedged = sense.msNoProgress >= tuning.trappedMs;
  const walled = mind.noRouteSince !== undefined && now - mind.noRouteSince >= tuning.trappedMs;
  const trapped = wedged || walled;
  if (mind.escapeSince === undefined && trapped) mind.escapeSince = now;
  if (mind.escapeSince === undefined) {
    return { goal: "wander", priority: WANDER_PRIORITY, trapped, escapeMs: 0, respawn: false };
  }
  const escapeMs = now - mind.escapeSince;
  return { goal: "escape", priority: ESCAPE_PRIORITY, trapped, escapeMs, respawn: escapeMs >= tuning.respawnMs };
}

/**
 * Evade priority while the latch holds, otherwise undefined.
 * `safe` is quiet for {@link SAFE_QUIET_MS} and either out of the threat's
 * sight or {@link SAFE_DISTANCE_M} away. A different place is not enough.
 * The caller passes `threatSeen` from `losGate(5)`. This function casts no rays.
 */
function evadeVerdict(mind: Mind, sense: MindSense, now: number): number | undefined {
  const damage = sense.damage;
  const seq = sense.damageSeq;
  const seqChanged = seq !== undefined && seq !== mind.hurtSeq;
  if (seq !== undefined) mind.hurtSeq = seq;
  const hurt = seqChanged || (damage !== undefined && damage.ageMs <= HURT_MS);
  const underFire = seqChanged || (damage !== undefined && damage.ageMs <= UNDER_FIRE_MS);
  if (!hurt) mind.cornered = undefined;
  const armed = sense.armed === true;
  const hpFrac = sense.hpFrac ?? 1;
  const fightPreferred = mind.cornered === true || (armed && hpFrac > FLEE_BELOW);
  const far = sense.threatDist !== undefined && sense.threatDist >= SAFE_DISTANCE_M;
  const hidden = sense.threatSeen === false;
  const quiet = !seqChanged && (damage === undefined || damage.ageMs >= SAFE_QUIET_MS);
  const safe = quiet && (hidden || far);
  const hitAt = sense.damageAt ?? (damage !== undefined ? now - damage.ageMs : undefined);

  if (mind.evadeSince !== undefined) {
    if (safe) {
      if (mind.safeSince === undefined) mind.safeSince = now;
    } else {
      mind.safeSince = undefined;
    }
    const dwellOk = now - mind.evadeSince >= EVADE_DWELL_MS;
    const safeHeld = mind.safeSince !== undefined && now - mind.safeSince >= SAFE_HOLD_MS;
    const done = dwellOk && safeHeld;
    if (done || fightPreferred) {
      if (done) {
        mind.evadeEndedAt = now;
        mind.coolHitAt = hitAt;
        mind.coolSeq = seq;
      }
      mind.evadeSince = undefined;
      mind.safeSince = undefined;
    }
  }

  const sameNote = seq !== undefined ? mind.coolSeq === seq : hitAt !== undefined && mind.coolHitAt === hitAt;
  const cooling =
    mind.evadeEndedAt !== undefined && now - mind.evadeEndedAt < EVADE_COOLDOWN_MS && sameNote;
  if (mind.evadeSince === undefined && hurt && !fightPreferred && !cooling) {
    mind.evadeSince = now;
    mind.safeSince = undefined;
  }
  if (mind.evadeSince === undefined) return undefined;
  return underFire ? EVADE_UNDER_FIRE_PRIORITY : EVADE_HURT_PRIORITY;
}
