/**
 * Goal arbitration for a host wander bot. Pure: the caller passes the sensed
 * state and the clock. Wander is the fallback. Escape (KeepMoving) takes over
 * once a bot inside a building is trapped and holds until it is outside.
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

export type GoalId = "wander" | "escape";

export const WANDER_PRIORITY = 1;
export const ESCAPE_PRIORITY = 6;
/** The place a bot is trying to reach. Same id as the sensor's exit. */
export const EXIT_PLACE = "outside";

/** What the arbiter reads. `BotSense` satisfies it. */
export type MindSense = Pick<BotSense, "alive" | "place" | "msNoProgress" | "routeOut">;

export type Mind = {
  /** First time the current place had no open route out. */
  noRouteSince?: number;
  noRoutePlace?: string;
  /** Set while Escape holds. The time the bot became trapped. */
  escapeSince?: number;
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
}

/**
 * One decision. Wander is 1 and Escape is 6 while it holds, so Escape wins by
 * more than any margin. It is latched: it begins when the bot is trapped and
 * ends only once the bot is outside and moving, so a place change or an opened
 * door on the way out does not hand the bot back to Wander half way.
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
