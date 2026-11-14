import assert from "node:assert/strict";
import { test } from "node:test";
import { createTickMetrics } from "../src/server/tick-metrics.ts";

test("tick_metrics_percentiles", () => {
  let t = 0;
  const m = createTickMetrics({ window: 200, tickMs: 50, now: () => t });
  for (let i = 1; i <= 100; i++) {
    m.beginTick();
    t += i;
    m.endTick();
  }
  const r = m.report();
  assert.equal(r.ticks, 100);
  assert.equal(r.total.p50Ms, 50);
  assert.equal(r.total.p95Ms, 95);
  assert.equal(r.total.p99Ms, 99);
  assert.equal(r.total.maxMs, 100);
});

test("tick_metrics_window", () => {
  let t = 0;
  const m = createTickMetrics({ window: 4, tickMs: 50, now: () => t });
  for (let i = 1; i <= 8; i++) {
    m.beginTick();
    t += i;
    m.endTick();
  }
  const r = m.report();
  assert.equal(r.ticks, 4);
  assert.equal(r.total.p50Ms, 6);
  assert.equal(r.total.maxMs, 8);
});

test("tick_metrics_lag", () => {
  let t = 0;
  const m = createTickMetrics({ window: 100, tickMs: 50, now: () => t });
  m.beginTick();
  t += 10;
  m.endPhase("agents");
  t += 10;
  m.endTick();
  t = 50;
  m.beginTick();
  t += 10;
  m.endTick();
  assert.equal(m.report().lagMs, 0);
  t = 130;
  m.beginTick();
  t += 5;
  m.endTick();
  assert.equal(m.report().lagMs, 30);
});

test("tick_metrics_format", () => {
  let t = 0;
  const m = createTickMetrics({ tickMs: 50, now: () => t });
  m.beginTick();
  t += 3;
  m.endPhase("agents");
  t += 1;
  m.endTick();
  const line = m.format();
  assert.match(line, /^\[tick\] n=1/);
  assert.match(line, /agents 3\.00\/3\.00/);
});
