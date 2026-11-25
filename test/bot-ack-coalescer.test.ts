import assert from "node:assert/strict";
import { test } from "node:test";
import { createAckCoalescer } from "../packages/bot-client/src/connection.ts";

test("ack_coalescer_one_send_per_window_highest_seq", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sent: number[] = [];
  const queue = createAckCoalescer((seq) => sent.push(seq), 50);
  for (let i = 1; i <= 20; i += 1) queue(i * 10);
  assert.deepEqual(sent, [], "no send before the window closes");
  t.mock.timers.tick(50);
  assert.deepEqual(sent, [200], "one send carrying the highest seq");
  queue(250);
  queue(150);
  assert.deepEqual(sent, [200], "no second send in the same window");
  t.mock.timers.tick(50);
  assert.deepEqual(sent, [200, 250], "the next window sends its own highest");
  queue(0);
  queue(Number.NaN);
  t.mock.timers.tick(50);
  assert.deepEqual(sent, [200, 250], "0 and NaN never send");
});
