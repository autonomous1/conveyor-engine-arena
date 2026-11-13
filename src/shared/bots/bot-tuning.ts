/**
 * Every FightBack knob. One frozen object so a playtest change is a number,
 * not a hunt through the arbiter and the executor.
 * Degrees here are degrees. Callers convert when they need radians.
 */
export const BOT_TUNING = Object.freeze({
  /** Seeded wait after the target first becomes engageable. */
  reactionMinMs: 350,
  reactionMaxMs: 700,
  /** Body yaw. The pawn step can turn faster; the wish stays under this. */
  turnDegPerS: 270,
  /** σ = base + per metre + this many degrees times speed / aimSpeedMps. */
  aimBaseDeg: 2.5,
  aimDegPerM: 0.12,
  aimSpeedDeg: 3,
  aimSpeedMps: 5,
  burstMin: 2,
  burstMax: 4,
  /** Shots inside a burst. 2 Hz is 500 ms apart. */
  burstHz: 2,
  pauseMinMs: 1_200,
  pauseMaxMs: 2_000,
  /** Metres. Farther than this is not engageable. */
  engageRangeM: 30,
  /** Must be turned at least this close to the target before a shot. */
  fireConeDeg: 60,
  /** Line of sight samples. Staggered by bot id. */
  losHz: 5,
  /** Bots that may shoot one pawn at the same time. */
  perTarget: 2,
  /** Bots that may be in FightBack at the same time. */
  maxFighting: 4,
  /** Walk toward the last known feet only past this. No doors. */
  closeInM: 25,
  /** No line of sight for this long ends the fight. */
  lostMs: 6_000,
  /** A grudge dies this long after the last damage from that pawn. */
  memoryMs: 20_000,
  /** Seen this recently still counts as engageable when the latest ray missed. */
  seenMs: 3_000,
  /** Armed and above this fraction would rather fight, unless cornered. */
  fleeBelow: 0.5,
  /** Already fighting, and not cornered: hand off to Evade at or under fleeBelow minus this. */
  fightHysteresis: 0.1,
  /** FightBack does not end for a flicker inside this window. A dead target does not wait. */
  fightDwellMs: 1_500,
  /** A rival goal replaces FightBack only when it leads by at least this. */
  margin: 1,
  /** Attackers remembered at once. Oldest damage is dropped. */
  maxThreats: 4,
  /** Metres above the feet. The aim point and the sight ray use this. */
  chestM: 1,
});

export type BotTuning = typeof BOT_TUNING;
