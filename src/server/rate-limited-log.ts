// ARCHITECTURE: Throttle state for the host's deny logs. Owns no clock, no
//   timers and no I/O; the caller passes nowMs.
// Wiring: arena-host.ts creates one instance per deny path beside snapStore,
//   calls shouldLog() from denyTeleport and denyQaSnapshot, and clear()s both
//   in stop(). test/rate-limited-log.test.ts drives it with literal nowMs.

/**
 * @why nowMs is an argument, not a clock read inside the store: the throttle
 *      boundary is then testable with literals and the store stays pure
 *      bookkeeping with no clock.
 * @invariant At most one log per client per windowMs. shouldLog returns true
 *            and records nowMs exactly when the client has no record or
 *            nowMs - record >= windowMs; a false result records nothing.
 *            (test: rate_limited_log_throttle)
 */
export type RateLimitedLog = {
  shouldLog(clientId: number, nowMs: number): boolean;
  clear(): void;
};

export function createRateLimitedLog(windowMs = 60_000): RateLimitedLog {
  const lastAt = new Map<number, number>();
  return {
    shouldLog(clientId, nowMs) {
      const prev = lastAt.get(clientId);
      if (prev !== undefined && nowMs - prev < windowMs) return false;
      lastAt.set(clientId, nowMs);
      return true;
    },
    clear() {
      lastAt.clear();
    },
  };
}
