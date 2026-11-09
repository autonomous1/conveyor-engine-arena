import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeFrame } from "conveyor-engine-transport-ws";
import { mayBeWelcome, socketFromConn, type HostConn } from "../dist/server/arena-host.js";
import { createHostSocketPaths } from "../dist/server/host-path.js";

function fakeConn(): HostConn & { sent: string[]; open: boolean } {
  const conn = {
    sent: [] as string[],
    open: true,
    send(text: string) {
      conn.sent.push(text);
    },
    close() {
      conn.open = false;
    },
    onText() {},
    onClose() {},
    isOpen() {
      return conn.open;
    },
  };
  return conn;
}

test("sendEncoded writes engine text byte-for-byte without a decode round trip", () => {
  const wires: string[] = [];
  const paths = createHostSocketPaths({ writeWire: (t) => wires.push(t), onEngineText() {} });
  // A decode/encode round trip would rewrite 1.50 as 1.5 and drop the spaces.
  const snap = '{"v":1,"type":"snapshot","envelope":{"kind":"delta","seq":4,"tick":{"$i":"7"},"x":1.50} }';
  paths.sendEncoded(snap);
  paths.sendEncoded("not json");
  assert.deepEqual(wires, [snap, "not json"]);
  paths.close();
  paths.sendEncoded(snap);
  assert.equal(wires.length, 2, "closed path drops outbound text");
});

test("a throwing writeWire is logged, not thrown into the engine", async () => {
  const errors: unknown[][] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => void errors.push(args);
  try {
    const paths = createHostSocketPaths({ writeWire() { throw new Error("boom"); }, onEngineText() {} });
    assert.doesNotThrow(() => paths.sendEncoded(encodeFrame({ v: 1, type: "snapshot" })));
    await new Promise((r) => setTimeout(r, 0));
  } finally {
    console.error = orig;
  }
  assert.equal(errors.some((row) => row[0] === "[live] direct net path failed"), true);
});

test("mayBeWelcome matches every encodeFrame welcome and skips snapshots", () => {
  assert.equal(mayBeWelcome(encodeFrame({ v: 1, type: "welcome", clientId: 3 })), true);
  assert.equal(mayBeWelcome(encodeFrame({ v: 1, type: "snapshot", envelope: { kind: "full" } })), false);
  assert.equal(mayBeWelcome(encodeFrame({ v: 1, type: "error", reason: "future" })), false);
});

test("socketFromConn stamps welcomes, passes snapshots untouched and still refuses full welcomes", () => {
  const conn = fakeConn();
  const refused = new Set<number>();
  const dropped: number[] = [];
  let afterWelcome = 0;
  const stamp = (text: string): string => {
    const frame = JSON.parse(text) as Record<string, unknown>;
    if (frame.type !== "welcome") return text;
    frame.pickups = ["key-a"];
    return JSON.stringify(frame);
  };
  const socket = socketFromConn(conn, refused, (id) => dropped.push(id), () => {}, stamp, () => afterWelcome++);

  const snap = encodeFrame({ v: 1, type: "snapshot", envelope: { kind: "full", seq: 1, tick: 2n } });
  socket.send(snap);
  assert.equal(conn.sent[0], snap);
  assert.equal(afterWelcome, 0);

  socket.send(encodeFrame({ v: 1, type: "welcome", clientId: 1, ownedEntityId: 5 }));
  const welcome = JSON.parse(conn.sent[1]!) as { type: string; pickups?: string[] };
  assert.equal(welcome.type, "welcome");
  assert.deepEqual(welcome.pickups, ["key-a"]);
  assert.equal(afterWelcome, 1);

  refused.add(2);
  socket.send(encodeFrame({ v: 1, type: "welcome", clientId: 2, ownedEntityId: 6 }));
  const reject = JSON.parse(conn.sent[2]!) as { type: string; code: string; reason: string };
  assert.deepEqual([reject.type, reject.code, reject.reason], ["reject", "SERVER_FULL", "no free pawn"]);
  assert.deepEqual(dropped, [2]);
  assert.equal(refused.has(2), false);
  assert.equal(afterWelcome, 1);

  // A snapshot that only mentions welcome inside a nested field is not a welcome.
  const nested = encodeFrame({ v: 1, type: "snapshot", envelope: { note: { type: "welcome" } } });
  refused.add(9);
  socket.send(nested);
  assert.equal(conn.sent[3], nested);
  assert.equal(afterWelcome, 1);
});
