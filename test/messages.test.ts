import assert from "node:assert/strict";
import { test } from "node:test";
import { createArenaMessages } from "../src/server/messages.ts";
import { createBotWorld } from "../packages/bot-client/src/world.ts";
import type { MsgFrame, MsgRow } from "../src/shared/bot-protocol.ts";

function host(overrides: { log?: (line: string) => void; maxText?: number; perSecond?: number } = {}) {
  const sent: MsgFrame[] = [];
  const messages = createArenaMessages({ sendAll: (frame) => sent.push(frame), ...overrides });
  return { messages, sent };
}

const scope = ["play", "chat"];
const say = (text: string, to = 0) => ({ v: 1, t: "msg", to, text });

test("msg_batches_and_stamps_the_sender", () => {
  const { messages, sent } = host();
  messages.onFrame(1, say("one"), scope, 7);
  messages.onFrame(1, say("two"), scope, 7);
  messages.onFrame(2, say("three"), scope, 8);
  messages.tick(1_000);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], {
    t: "msg",
    rows: [
      { from: 7, to: 0, seq: 1, text: "one", at: 1_000 },
      { from: 7, to: 0, seq: 2, text: "two", at: 1_000 },
      { from: 8, to: 0, seq: 1, text: "three", at: 1_000 },
    ],
  });
});

test("msg_broadcast_and_directed_rows_are_both_sent", () => {
  const { messages, sent } = host();
  messages.onFrame(1, say("all", 0), scope, 7);
  messages.onFrame(2, say("you", 5), scope, 8);
  messages.tick(1_000);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0]!.rows.map((row) => [row.text, row.to]), [["all", 0], ["you", 5]]);
});

test("msg_requires_chat_scope", () => {
  const lines: string[] = [];
  const { messages, sent } = host({ log: (line) => lines.push(line) });
  messages.onFrame(1, say("hi"), ["play"], 7);
  assert.equal(sent.length, 0);
  assert.deepEqual(messages.stats(), { sent: 0, dropped: 1 });
  messages.tick(1_000);
  assert.deepEqual(lines, ["[msg] client 1 rejected (scope or text)"]);
  messages.onFrame(1, say("hi again"), ["play"], 7);
  messages.tick(2_000);
  assert.equal(lines.length, 1);
  messages.onFrame(3, say("solo"), undefined, 9);
  messages.tick(3_000);
  assert.deepEqual(sent.at(-1)!.rows.map((row) => row.from), [9]);
});

test("msg_rejects_long_and_empty_text", () => {
  const { messages, sent } = host();
  const frames = [
    say(""),
    say("   "),
    say("x".repeat(257)),
    { v: 1, t: "msg", to: -1, text: "bad" },
    { v: 1, t: "msg", to: 1.5, text: "bad" },
    { v: 1, t: "msg", to: "5", text: "bad" },
  ];
  for (const frame of frames) messages.onFrame(1, frame, scope, 7);
  assert.deepEqual(messages.stats(), { sent: 0, dropped: 6 });
  messages.tick(1_000);
  assert.equal(sent.length, 0);
});

test("msg_rate_caps_rows_per_second", () => {
  const { messages, sent } = host();
  for (let i = 0; i < 4; i++) messages.onFrame(1, say(`a${i}`), scope, 7);
  for (let i = 0; i < 4; i++) messages.onFrame(2, say(`b${i}`), scope, 8);
  assert.deepEqual(messages.stats(), { sent: 0, dropped: 0 });
  messages.onFrame(1, say("a4"), scope, 7);
  assert.deepEqual(messages.stats(), { sent: 0, dropped: 1 });
  messages.tick(1_000);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0]!.rows.map((row) => row.text), ["a0", "a1", "a2", "a3"]);
  messages.tick(1_050);
  assert.equal(sent.length, 1);
  messages.tick(2_000);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1]!.rows.map((row) => row.text), ["b0", "b1", "b2", "b3"]);
});

test("msg_drop_removes_pending_rows_of_a_closed_pawn", () => {
  const { messages, sent } = host();
  messages.onFrame(1, say("a"), scope, 7);
  messages.onFrame(2, say("b"), scope, 8);
  messages.drop(7);
  messages.tick(1_000);
  assert.deepEqual(sent[0]!.rows.map((row) => [row.from, row.text, row.seq]), [[8, "b", 1]]);
  messages.onFrame(1, say("a2"), scope, 7);
  messages.tick(2_000);
  assert.deepEqual(sent[1]!.rows.map((row) => [row.from, row.seq]), [[7, 1]]);
});

test("msg_empty_tick_sends_nothing", () => {
  const { messages, sent } = host();
  messages.tick(1_000);
  messages.tick(2_000);
  assert.equal(sent.length, 0);
  assert.deepEqual(messages.stats(), { sent: 0, dropped: 0 });
});

test("msg_world_ring_and_supported_flag", () => {
  const world = createBotWorld({ aabbs: [], doors: [], playerSpawns: [] });
  assert.equal(world.messagesSupported(), false);
  world.applyWelcome({ pickups: [], doors: [], ammo: 0, keys: [], messages: true });
  assert.equal(world.messagesSupported(), true);
  for (let i = 0; i < 65; i++) {
    world.applyMessages([{ from: 7, to: 0, seq: i + 1, text: `m${i}`, at: i }]);
  }
  const rows = world.messages();
  assert.equal(rows.length, 64);
  assert.equal(rows[0]!.text, "m1");
  assert.equal(rows.at(-1)!.text, "m64");
  (world.messages() as MsgRow[]).pop();
  assert.equal(world.messages().length, 64);
  assert.equal(world.messages().at(-1)!.text, "m64");
});
