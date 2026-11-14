import { test } from "node:test";
import assert from "node:assert/strict";
import { createRateLimitedLog } from "../src/server/rate-limited-log.ts";

test("rate_limited_log_throttle", () => {
  const log = createRateLimitedLog();
  assert.equal(log.shouldLog(1, 1_000), true);
  assert.equal(log.shouldLog(1, 1_001), false);
  assert.equal(log.shouldLog(1, 1_000 + 59_999), false);
  // Exactly windowMs after the recorded call logs again.
  assert.equal(log.shouldLog(1, 1_000 + 60_000), true);
  // A false result recorded nothing: 61_000 was accepted, 61_001 is inside.
  assert.equal(log.shouldLog(1, 1_001 + 60_000), false);
  // Per client: client 2 is not throttled by client 1's record.
  assert.equal(log.shouldLog(2, 1_001 + 60_000), true);
});

test("rate_limited_log_boundary", () => {
  // Default window is 60_000.
  const dflt = createRateLimitedLog();
  assert.equal(dflt.shouldLog(1, 1_000_000), true);
  assert.equal(dflt.shouldLog(1, 1_059_999), false);
  assert.equal(dflt.shouldLog(1, 1_060_000), true);

  // windowMs is a constructor argument.
  const fast = createRateLimitedLog(250);
  assert.equal(fast.shouldLog(1, 10), true);
  assert.equal(fast.shouldLog(1, 259), false);
  assert.equal(fast.shouldLog(1, 260), true);
});

test("rate_limited_log_clear", () => {
  const log = createRateLimitedLog();
  assert.equal(log.shouldLog(1, 1_000), true);
  assert.equal(log.shouldLog(1, 1_500), false);
  log.clear();
  // The record is gone: the instant that was throttled logs again.
  assert.equal(log.shouldLog(1, 1_500), true);
  // A second clear drops the re-established record the same way.
  log.clear();
  assert.equal(log.shouldLog(1, 1_500), true);
});
