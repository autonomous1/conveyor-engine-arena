import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { EngineWsServer, memoryPair } from "conveyor-engine-transport-ws";

// Evidence (installed gateway and transport, one tick, no world step):
// A same-tick burst admits seq 1..8, rate-limits the rest, and leaves lastSeq at 8.
// The replicator copies that admitted seq into lastProcessedInput. It is not a sim ack.
// The next send (seq 31) is `future` because 31 > 8 + 8. Later sends stay future.
// Recovery waits for a newer snapshot tick, then sends admitted+1 at the normal cadence.
// Snapshot repair alone does not move the input id.

register(
  "data:text/javascript," +
    encodeURIComponent(`
      import { existsSync } from "node:fs";
      import { fileURLToPath } from "node:url";
      export async function resolve(specifier, context, nextResolve) {
        const parent = context.parentURL ?? "";
        if ((specifier.startsWith("./") || specifier.startsWith("../")) && specifier.endsWith(".js") && parent.includes("/src/")) {
          const ts = specifier.slice(0, -3) + ".ts";
          if (existsSync(fileURLToPath(new URL(ts, parent)))) return nextResolve(ts, context);
        }
        return nextResolve(specifier, context);
      }
    `),
);

const { connectLive } = await import("../src/client/net.ts");
const { createClientDiag } = await import("../src/client/diag.ts");

const OWNED = 4;

function withDocument<T>(run: () => T): T {
  const previous = globalThis.document;
  (globalThis as { document: unknown }).document = {
    addEventListener() {},
    removeEventListener() {},
    visibilityState: "visible",
  };
  try {
    return run();
  } finally {
    (globalThis as { document: unknown }).document = previous;
  }
}

type Admit = { seq: number; moveX: number };

function harness(opts?: {
  diag?: ReturnType<typeof createClientDiag>;
  onAuthRejected?: (reason: string) => void;
}) {
  const admitted: Admit[] = [];
  const server = new EngineWsServer({
    compatibility: { protocol: 1, world: "arena" },
    bundle: { bundleId: "arena", authoritativeHash: "hash" },
    onHello: () => OWNED,
    onAdmit: (input: { seq: number; moveX: number }) => {
      admitted.push({ seq: input.seq, moveX: input.moveX });
    },
  });
  const pair = memoryPair();
  server.attach(pair.server);
  const sent: string[] = [];
  const statuses: string[] = [];
  const ws = {
    readyState: WebSocket.OPEN as number,
    send(data: string) {
      sent.push(data);
      pair.client.send(data);
    },
    close() {
      this.readyState = WebSocket.CLOSED;
      pair.client.close();
    },
    onopen: null as ((ev: unknown) => void) | null,
    onmessage: null as ((ev: { data: unknown }) => void) | null,
    onclose: null as ((ev: unknown) => void) | null,
    onerror: null as ((ev: unknown) => void) | null,
  };
  pair.client.onMessage((text: string) => {
    ws.onmessage?.({ data: text });
  });
  const link = connectLive({
    bundleId: "arena",
    authoritativeHash: "hash",
    world: "arena",
    auth: false,
    client: {
      connect() {},
      applySnapshot() {},
      renderSnapshot() {
        return { entities: [{ id: OWNED }] };
      },
      clientId: 1,
      metrics: { snapshotReceive: 0 },
    } as never,
    onStatus(status) {
      statuses.push(status.text);
    },
    onApplied() {},
    onAuthRejected: opts?.onAuthRejected,
    diag: opts?.diag,
    open: () => ws,
  });
  ws.onopen?.({});
  const inputs = () => sent.map((line) => JSON.parse(line) as { type?: string; seq?: number; moveX?: number }).filter((row) => row.type === "input");
  const publish = (tick: number, snapSeq: number) => {
    const high = server.replicator.get(1)!.lastProcessedInput;
    server.sendSnapshot(1, {
      kind: "full",
      seq: snapSeq,
      tick,
      lastProcessedInput: high,
      spawns: [],
      updates: [],
      despawns: [],
    });
  };
  return { server, pair, link, ws, sent, statuses, admitted, inputs, publish };
}

test("a same-tick burst locks on future, then two recovery episodes admit movement again", () => {
  withDocument(() => {
    const { server, pair, link, statuses, admitted, inputs, publish, sent } = harness();
    assert.equal(server.connected.length, 1);
    for (let i = 0; i < 30; i += 1) link.sendInput(1, 0, 0);
    const gate = server.gateway.get(1)!;
    assert.equal(gate.lastSeq, 8);
    assert.equal(server.replicator.get(1)!.lastProcessedInput, 8);
    assert.equal(inputs().length, 30);
    assert.equal(inputs().at(-1)!.seq, 30);

    server.setTick(1n);
    link.sendInput(1, 0, 0);
    assert.equal(inputs().at(-1)!.seq, 31);
    assert.equal(gate.lastSeq, 8);
    assert.equal(statuses.includes("recovering input"), true);
    assert.equal(statuses.some((text) => text.includes("future")), false);

    const held = inputs().length;
    link.sendInput(0, 0, 0);
    link.sendInput(0, 0, 0);
    link.sendInput(0, 0, 0);
    link.sendInput(0, 0, 0);
    assert.equal(inputs().length, held);

    publish(1, 1);
    link.sendInput(1, 0, 0);
    assert.equal(inputs().length, held);
    publish(2, 2);
    link.sendInput(1, 0, 0);
    link.sendInput(1, 0, 0);
    link.sendInput(1, 0, 0);
    assert.deepEqual(admitted.map((row) => row.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    assert.deepEqual(admitted.slice(8).map((row) => row.moveX), [1, 1, 1]);

    publish(3, 3);
    const session = server.session(1) as { framesThisTick: number };
    server.setTick(4n);
    while (session.framesThisTick <= 16) {
      pair.client.send(JSON.stringify({ v: 1, type: "resync" }));
    }
    const beforeSecond = inputs().length;
    while (inputs().length === beforeSecond || inputs().at(-1)!.seq! <= gate.lastSeq + 8) {
      const count = inputs().length;
      link.sendInput(-1, 0, 0);
      if (inputs().length === count) break;
      if (inputs().length > beforeSecond + 20) break;
    }
    const parked = inputs().length;
    link.sendInput(0, 0, 0);
    link.sendInput(0, 0, 0);
    assert.equal(inputs().length, parked);
    const high = gate.lastSeq;
    // The resync flood left this tick's frame cap full. The snapshot rebases.
    // Admission of the rebased ids needs a later host tick, or the transport
    // rejects them as rate-limit and the gateway never sees the movement.
    publish(5, 4);
    server.setTick(5n);
    const resumed = inputs().length;
    link.sendInput(-1, 0, 0);
    link.sendInput(-1, 0, 0);
    link.sendInput(-1, 0, 0);
    assert.equal(inputs().length, resumed + 3);
    const second = admitted.filter((row) => row.seq > 11);
    assert.deepEqual(second.map((row) => row.moveX), [-1, -1, -1]);
    assert.equal(second[0]!.seq, high + 1);
    assert.deepEqual(second.map((row) => row.seq), [high + 1, high + 2, high + 3]);
    const seqs = admitted.map((row) => row.seq);
    assert.equal(new Set(seqs).size, seqs.length);

    const forgedAt = gate.lastSeq;
    // Installed validateInput clamps a numeric axis into range. A non-numeric
    // axis is still rejected, and an unowned entity is still rejected.
    // Neither advances lastSeq. The client's next id is then admitted.
    pair.client.send(JSON.stringify({
      v: 1,
      type: "input",
      seq: forgedAt + 1,
      moveX: "no",
      moveZ: 0,
      yaw: 0,
      buttons: 0,
      entity: OWNED,
    }));
    pair.client.send(JSON.stringify({
      v: 1,
      type: "input",
      seq: forgedAt + 1,
      moveX: 1,
      moveZ: 0,
      yaw: 0,
      buttons: 0,
      entity: OWNED + 1,
    }));
    assert.equal(gate.lastSeq, forgedAt);
    server.setTick(6n);
    link.sendInput(1, 0, 0);
    assert.equal(admitted.at(-1)!.seq, forgedAt + 1);
    assert.equal(admitted.at(-1)!.moveX, 1);
    assert.equal(server.connected.length, 1);
    assert.equal(sent.filter((line) => JSON.parse(line).type === "resync").length, 0);
    assert.equal(sent.filter((line) => JSON.parse(line).type === "hello").length, 1);
  });
});

test("duplicate-or-old does not rewind to seq 1, and a same-tick snapshot does not rebase", () => {
  withDocument(() => {
    const { server, pair, link, inputs, publish } = harness();
    publish(1, 1);
    link.sendInput(1, 0, 0);
    link.sendInput(1, 0, 0);
    link.sendInput(1, 0, 0);
    assert.equal(server.gateway.get(1)!.lastSeq, 3);
    publish(2, 2);
    pair.client.send(JSON.stringify({
      v: 1, type: "input", seq: 1, moveX: 1, moveZ: 0, yaw: 0, buttons: 0, entity: OWNED,
    }));
    const held = inputs().length;
    link.sendInput(1, 0, 0);
    link.sendInput(1, 0, 0);
    assert.equal(inputs().length, held);
    publish(2, 3);
    link.sendInput(1, 0, 0);
    assert.equal(inputs().length, held);
    publish(3, 4);
    link.sendInput(1, 0, 0);
    assert.equal(inputs().at(-1)!.seq, 4);
    assert.equal(inputs().some((row) => row.seq === 1 && inputs().indexOf(row) > 2), false);
  });
});

test("a background gap does not skip input ids, and a snapshot gap still asks for one resync", () => {
  withDocument(() => {
    const { server, link, sent, statuses, inputs, publish } = harness();
    publish(1, 1);
    link.sendInput(1, 0, 0);
    link.sendInput(0, 1, 0);
    link.sendInput(-1, 0, 0);
    assert.deepEqual(inputs().map((row) => row.seq), [1, 2, 3]);
    assert.equal(statuses.includes("recovering input"), false);
    assert.equal(server.gateway.get(1)!.lastSeq, 3);
    server.sendSnapshot(1, {
      kind: "delta",
      seq: 4,
      tick: 2,
      lastProcessedInput: 3,
      spawns: [],
      updates: [],
      despawns: [],
    });
    const resyncs = sent.map((line) => JSON.parse(line) as { type?: string }).filter((row) => row.type === "resync");
    assert.equal(resyncs.length, 1);
    link.sendInput(1, 0, 0);
    assert.equal(inputs().at(-1)!.seq, 4);
  });
});

test("a stale lower admission mark does not rewind, and a stalled tick does not resume", () => {
  withDocument(() => {
    const { server, pair, link, admitted, inputs, publish } = harness();
    publish(1, 1);
    server.setTick(1n);
    link.sendInput(1, 0, 0);
    link.sendInput(1, 0, 0);
    link.sendInput(1, 0, 0);
    assert.equal(server.gateway.get(1)!.lastSeq, 3);
    publish(2, 2);
    pair.client.send(JSON.stringify({
      v: 1, type: "input", seq: 1, moveX: 1, moveZ: 0, yaw: 0, buttons: 0, entity: OWNED,
    }));
    const held = inputs().length;
    server.sendSnapshot(1, {
      kind: "full",
      seq: 3,
      tick: 2,
      lastProcessedInput: 0,
      spawns: [],
      updates: [],
      despawns: [],
    });
    link.sendInput(-1, 0, 0);
    assert.equal(inputs().length, held);
    server.sendSnapshot(1, {
      kind: "full",
      seq: 4,
      tick: 3,
      lastProcessedInput: 0,
      spawns: [],
      updates: [],
      despawns: [],
    });
    server.setTick(3n);
    link.sendInput(-1, 0, 0);
    assert.equal(inputs().at(-1)!.seq, 4);
    assert.equal(server.gateway.get(1)!.lastSeq, 4);
    assert.equal(admitted.at(-1)!.moveX, -1);
    assert.equal(inputs().filter((row) => row.seq === 1).length, 1);
  });
});

test("a simulation stall keeps the next id parked until a newer snapshot tick", () => {
  withDocument(() => {
    const { server, link, admitted, inputs, publish } = harness();
    for (let i = 0; i < 30; i += 1) link.sendInput(0, 0, 0);
    server.setTick(1n);
    link.sendInput(0, 0, 0);
    const held = inputs().length;
    publish(1, 1);
    link.sendInput(1, 0, 0);
    publish(1, 2);
    link.sendInput(1, 0, 0);
    assert.equal(inputs().length, held);
    publish(2, 3);
    server.setTick(2n);
    link.sendInput(1, 0, 0);
    assert.equal(inputs().at(-1)!.seq, 9);
    assert.equal(admitted.at(-1)!.moveX, 1);
    assert.equal(admitted.filter((row) => row.seq > 8).length, 1);
  });
});

test("auth rejection and disconnect end recovery without another hello or send", () => {
  withDocument(() => {
    const reasons: string[] = [];
    const auth = harness({ onAuthRejected: (reason) => reasons.push(reason) });
    for (let i = 0; i < 30; i += 1) auth.link.sendInput(1, 0, 0);
    auth.server.setTick(1n);
    auth.link.sendInput(1, 0, 0);
    assert.equal(auth.statuses.includes("recovering input"), true);
    const authInputs = auth.inputs().length;
    auth.ws.readyState = WebSocket.CLOSED;
    auth.ws.onclose?.({ code: 4401, reason: "expired" });
    auth.link.sendInput(1, 0, 0);
    auth.publish(2, 2);
    auth.link.sendInput(1, 0, 0);
    assert.equal(auth.inputs().length, authInputs);
    assert.equal(auth.inputs().at(-1)!.seq, 31);
    assert.deepEqual(reasons, ["expired"]);
    assert.equal(auth.statuses.includes("auth: expired"), true);
    assert.equal(auth.sent.filter((line) => JSON.parse(line).type === "hello").length, 1);
    assert.equal(auth.server.connected.length, 1);

    const dropped = harness();
    for (let i = 0; i < 30; i += 1) dropped.link.sendInput(1, 0, 0);
    dropped.server.setTick(1n);
    dropped.link.sendInput(1, 0, 0);
    const droppedInputs = dropped.inputs().length;
    dropped.ws.readyState = WebSocket.CLOSED;
    dropped.ws.onclose?.({ code: 1006, reason: "gone" });
    dropped.link.sendInput(1, 0, 0);
    dropped.publish(4, 4);
    dropped.link.sendInput(1, 0, 0);
    assert.equal(dropped.inputs().length, droppedInputs);
    assert.equal(dropped.statuses.includes("socket closed"), true);
    assert.equal(dropped.statuses.some((text) => text.includes("future")), false);
    assert.equal(dropped.sent.filter((line) => JSON.parse(line).type === "hello").length, 1);
  });
});

test("repeated rate-limit faults collapse and leave input ack unknown", () => {
  const errors: Array<Record<string, string | number>> = [];
  const warns: Array<Record<string, string | number>> = [];
  const diag = createClientDiag({
    summaryEvery: 4,
    sink: {
      error(_error, fields) {
        errors.push(fields);
      },
      warn(fields) {
        warns.push(fields);
      },
    },
  });
  withDocument(() => {
    const { link } = harness({ diag });
    for (let i = 0; i < 30; i += 1) link.sendInput(1, 0, 0);
  });
  const rateErrors = errors.filter((row) => row.reason === "rate-limit");
  const rateWarns = warns.filter((row) => row.reason === "rate-limit");
  assert.equal(rateErrors.length, 1);
  assert.equal(rateWarns.length, 5);
  assert.equal(rateErrors[0]!.inputAck, "unknown");
  assert.equal(rateWarns.every((row) => Number(row.suppressed) > 0 && Number(row.suppressed) % 4 === 0), true);
});
