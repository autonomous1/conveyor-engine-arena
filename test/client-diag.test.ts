import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import test from "node:test";
import { createClientDiag, presentFaultHud, reportFrameFault, type DiagRecord, type DiagSink } from "../src/client/diag.ts";

// Shared and client modules import siblings as `.js`. Strip-types loads this
// file from source, so those specifiers resolve to the `.ts` files.
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

const SECRET = "super-secret-token";

function captureSink() {
  const errors: { error: unknown; fields: DiagRecord }[] = [];
  const warns: DiagRecord[] = [];
  const sink: DiagSink = {
    error(error, fields) {
      errors.push({ error, fields });
    },
    warn(fields) {
      warns.push(fields);
    },
  };
  return { errors, warns, sink };
}

function blob(value: unknown): string {
  if (value instanceof Error) return `${value.name}\n${value.message}\n${value.stack ?? ""}`;
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function withDocument<T>(run: (listeners: Map<string, Set<(ev: unknown) => void>>) => T): T {
  const previous = globalThis.document;
  const listeners = new Map<string, Set<(ev: unknown) => void>>();
  (globalThis as { document: unknown }).document = {
    addEventListener(type: string, fn: (ev: unknown) => void) {
      const set = listeners.get(type) ?? new Set();
      set.add(fn);
      listeners.set(type, set);
    },
    removeEventListener(type: string, fn: (ev: unknown) => void) {
      listeners.get(type)?.delete(fn);
    },
    visibilityState: "visible",
  };
  try {
    return run(listeners);
  } finally {
    (globalThis as { document: unknown }).document = previous;
  }
}

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key) {
      return map.get(key) ?? null;
    },
    key(index) {
      return [...map.keys()][index] ?? null;
    },
    removeItem(key) {
      map.delete(key);
    },
    setItem(key, value) {
      map.set(key, value);
    },
  };
}

function fakeSocket() {
  const sent: string[] = [];
  const ws = {
    readyState: WebSocket.OPEN,
    send(data: string) {
      sent.push(data);
    },
    close() {
      this.readyState = WebSocket.CLOSED;
    },
    onopen: null as ((ev: unknown) => void) | null,
    onmessage: null as ((ev: { data: unknown }) => void) | null,
    onclose: null as ((ev: unknown) => void) | null,
    onerror: null as ((ev: unknown) => void) | null,
  };
  return { ws, sent };
}

function stubClient(apply: () => void = () => {}) {
  return {
    connect() {},
    applySnapshot: apply,
    renderSnapshot() {
      return { entities: [{ id: 3 }] };
    },
    clientId: 7,
    metrics: { snapshotReceive: 1 },
  } as never;
}

function openLink(opts?: {
  apply?: () => void;
  diag?: ReturnType<typeof createClientDiag>;
  onStatus?: (status: { phase: string; text: string }) => void;
  onFault?: (err: unknown) => void;
  onConsoleHint?: () => void;
  onAuthRejected?: (reason: string) => void;
  auth?: boolean;
}) {
  const { ws, sent } = fakeSocket();
  const statuses: { phase: string; text: string }[] = [];
  const faults: unknown[] = [];
  let hints = 0;
  const link = connectLive({
    bundleId: "arena",
    authoritativeHash: "hash",
    world: "arena",
    client: stubClient(opts?.apply),
    onStatus(status) {
      statuses.push({ phase: status.phase, text: status.text });
      opts?.onStatus?.(status);
    },
    onApplied() {},
    onFault(err) {
      faults.push(err);
      opts?.onFault?.(err);
    },
    onConsoleHint() {
      hints += 1;
      opts?.onConsoleHint?.();
    },
    onAuthRejected: opts?.onAuthRejected,
    diag: opts?.diag,
    auth: opts?.auth,
    open: () => ws,
  });
  return { ws, sent, statuses, faults, link, hints: () => hints };
}

function welcome(ws: { onmessage: ((ev: { data: unknown }) => void) | null }, extra?: Record<string, unknown>) {
  ws.onmessage?.({
    data: JSON.stringify({ type: "welcome", clientId: 7, ownedEntityId: 3, ...extra }),
  });
}

function parsed(sent: string[]) {
  return sent.map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("diagnostics keep the Error, leave input ack unknown, and suppress repeats", () => {
  const cap = captureSink();
  const diag = createClientDiag({ sink: cap.sink, summaryEvery: 2, maxKeys: 2 });
  const err = new Error("apply boom");
  const fields = {
    source: "apply",
    messageType: "snapshot",
    category: "apply",
    snapSeq: 2,
    simTick: 9n,
    processedInput: 4,
    sentInputId: 1,
    connection: 7,
    ownedEntity: 3,
  };
  diag.report({ level: "error", error: err, fields });
  diag.report({ level: "error", error: err, fields: { ...fields, snapSeq: 3, simTick: 10n } });
  diag.report({ level: "error", error: err, fields });
  assert.equal(cap.errors.length, 1);
  assert.equal(cap.errors[0]?.error, err);
  assert.equal(cap.errors[0]?.fields.inputAck, "unknown");
  assert.equal(cap.errors[0]?.fields.snapSeq, 2);
  assert.equal(cap.errors[0]?.fields.simTick, "9");
  assert.equal(cap.errors[0]?.fields.processedInput, 4);
  assert.equal(cap.errors[0]?.fields.sentInputId, 1);
  assert.notEqual(cap.errors[0]?.fields.inputAck, cap.errors[0]?.fields.snapSeq);
  assert.notEqual(cap.errors[0]?.fields.inputAck, cap.errors[0]?.fields.simTick);
  assert.equal(cap.warns.length, 1);
  assert.equal(cap.warns[0]?.suppressed, 2);
  assert.equal(cap.warns[0]?.snapSeq, 2);

  diag.report({ level: "error", error: new Error("other fault"), fields: { ...fields, category: "render" } });
  assert.equal(cap.errors.length, 2);
  assert.equal((cap.errors[1]?.error as Error).message, "other fault");
});

test("diagnostics omit credentials and bound the key set", () => {
  const cap = captureSink();
  const diag = createClientDiag({ sink: cap.sink, maxKeys: 2, summaryEvery: 50 });
  diag.report({
    level: "warn",
    fields: {
      source: "host",
      messageType: "reject",
      reason: "eyJhbGciOiJIUzI1NiJ9.payload.sig",
      code: "SERVER_FULL",
    },
  });
  diag.report({ level: "error", error: new Error("a"), fields: { source: "a", category: "a" } });
  diag.report({ level: "error", error: new Error("a"), fields: { source: "a", category: "a" } });
  diag.report({ level: "error", error: new Error("b"), fields: { source: "b", category: "b" } });
  diag.report({ level: "error", error: new Error("c"), fields: { source: "c", category: "c" } });
  const text = [...cap.errors.map((row) => blob(row.error) + blob(row.fields)), ...cap.warns.map(blob)].join("\n");
  assert.equal(text.includes("eyJhbGciOiJIUzI1NiJ9"), false);
  assert.equal(cap.warns[0]?.reason, "omitted");
  assert.equal(cap.warns.some((row) => row.suppressed === 1 && row.source === "a"), true);
  assert.equal(cap.errors.some((row) => (row.error as Error).message === "c"), true);
});

test("frame fault log is not copied onto the HUD line", () => {
  const cap = captureSink();
  const diag = createClientDiag({ sink: cap.sink, summaryEvery: 2 });
  const err = new Error("frame blew up");
  const ctx = { source: "client", sentInputId: 4, snapSeq: 8, simTick: 11n, connection: 2, ownedEntity: 6 };
  reportFrameFault(diag, err, ctx);
  reportFrameFault(diag, err, ctx);
  reportFrameFault(diag, err, { ...ctx, category: "render" });
  assert.equal(cap.errors.length, 2);
  assert.equal(cap.errors[0]?.error, err);
  assert.equal(cap.errors[0]?.fields.source, "frame");
  assert.equal(cap.errors[0]?.fields.category, "exception");
  assert.equal(cap.errors[0]?.fields.inputAck, "unknown");
  assert.equal(cap.errors[1]?.fields.category, "render");
  const hud = presentFaultHud("snap 8 tick 11 delta owned 6", true);
  assert.equal(hud, "snap 8 tick 11 delta owned 6 · see console");
  assert.equal(hud.includes("frame blew up"), false);
  assert.equal(hud.includes("future"), false);
  assert.equal(presentFaultHud("connecting", false), "connecting");
  const boot = readFileSync("src/client/boot.ts", "utf8");
  assert.equal(boot.includes("pinnedError"), false);
  assert.equal(boot.includes("frame error"), false);
  assert.equal(boot.includes("presentFaultHud"), true);
  assert.equal(boot.includes("reportFrameFault"), true);
});

test("parse, apply, reject, and socket faults reach the console and stay off the status line", () => {
  withDocument(() => {
    const cap = captureSink();
    const diag = createClientDiag({ sink: cap.sink, summaryEvery: 2 });
    const applyErr = new Error("apply boom");
    let apply = false;
    const harness = openLink({
      diag,
      auth: false,
      apply() {
        if (apply) throw applyErr;
      },
    });
    welcome(harness.ws, { reconnectToken: SECRET, token: SECRET });
    assert.equal(harness.statuses.at(-1)?.text, "welcome client 7 owned 3");
    harness.link.sendInput(1, 0, 0.2);
    harness.ws.onmessage?.({ data: `NOTJSON ${SECRET}` });
    harness.ws.onmessage?.({ data: `NOTJSON ${SECRET}` });
    harness.ws.onmessage?.({ data: `NOTJSON ${SECRET}` });
    const parseLog = blob(cap.errors[0]?.error) + blob(cap.errors[0]?.fields);
    assert.equal(parseLog.includes(SECRET), false);
    assert.equal((cap.errors[0]?.error as Error).message, "invalid frame");
    assert.equal(cap.errors[0]?.fields.source, "parse");
    assert.equal(cap.errors[0]?.fields.inputAck, "unknown");
    assert.equal(cap.errors[0]?.fields.sentInputId, 1);
    assert.equal(cap.warns.some((row) => row.suppressed === 2 && row.source === "parse"), true);
    assert.equal(harness.statuses.some((row) => row.text.includes(SECRET) || row.text.includes("NOTJSON")), false);
    assert.equal(parsed(harness.sent).some((row) => row.type === "resync"), false);
    harness.link.sendInput(0, 1, 0.2);
    const earlyInputs = parsed(harness.sent).filter((row) => row.type === "input");
    assert.deepEqual(earlyInputs.map((row) => row.seq), [1, 2]);

    apply = true;
    harness.ws.onmessage?.({
      data: JSON.stringify({
        type: "snapshot",
        envelope: { kind: "delta", seq: 2, tick: 9, lastProcessedInput: 4, spawns: [], updates: [], despawns: [] },
      }),
    });
    const applyLog = cap.errors.find((row) => row.fields.source === "apply");
    assert.equal(applyLog?.error, applyErr);
    assert.equal(applyLog?.fields.snapSeq, 2);
    assert.equal(applyLog?.fields.simTick, "9");
    assert.equal(applyLog?.fields.processedInput, 4);
    assert.equal(applyLog?.fields.inputAck, "unknown");
    assert.equal(applyLog?.fields.connection, 7);
    assert.equal(applyLog?.fields.ownedEntity, 3);
    assert.equal(harness.statuses.at(-1)?.text, "resync 1");
    assert.equal(harness.statuses.some((row) => row.text.includes("apply boom")), false);
    assert.equal(harness.faults.includes(applyErr), true);

    harness.ws.onmessage?.({
      data: JSON.stringify({
        type: "reject",
        reason: "no free pawn",
        code: "SERVER_FULL",
        token: SECRET,
        reconnectToken: SECRET,
        auth: SECRET,
        png: "data:image/png;base64,AAAA",
      }),
    });
    harness.ws.onmessage?.({
      data: JSON.stringify({ type: "error", category: "input-sequence", reason: "future", token: SECRET }),
    });
    harness.ws.onmessage?.({
      data: JSON.stringify({ type: "error", category: "input-sequence", reason: "duplicate-or-old" }),
    });
    const joined = [...cap.errors.map((row) => blob(row.fields)), ...cap.warns.map(blob)].join("\n");
    assert.equal(joined.includes(SECRET), false);
    assert.equal(cap.warns.some((row) => row.reason === "no free pawn" && row.code === "SERVER_FULL" && row.messageType === "reject"), true);
    const future = cap.errors.find((row) => row.fields.reason === "future");
    assert.ok(future);
    assert.equal(future?.fields.category, "input-sequence");
    assert.equal(future?.fields.inputAck, "unknown");
    assert.equal(cap.errors.some((row) => row.fields.reason === "duplicate-or-old"), true);
    assert.equal(harness.statuses.some((row) => row.text.includes("future") || row.text.includes("no free pawn")), false);

    harness.ws.onerror?.({});
    harness.ws.onclose?.({ code: 1006, reason: "" });
    assert.equal(cap.errors.some((row) => row.fields.source === "socket" && row.fields.category === "error"), true);
    assert.equal(cap.errors.some((row) => row.fields.source === "socket" && row.fields.category === "close" && row.fields.code === 1006), true);
    assert.equal(harness.statuses.some((row) => row.text === "socket error"), true);
    assert.equal(harness.statuses.some((row) => row.text === "socket closed"), true);
    assert.equal(harness.hints() > 0, true);

    const bodies = parsed(harness.sent);
    assert.deepEqual(
      bodies.find((row) => row.type === "input"),
      { v: 1, type: "input", seq: 1, moveX: 1, moveZ: 0, yaw: 0.2, buttons: 0, entity: 3 },
    );
    assert.equal(bodies.some((row) => row.type === "resync" && row.v === 1), true);
    assert.equal(bodies.some((row) => row.type === "ack"), false);
  });
});

test("socket auth rejection stays on the status line and is a warning", () => {
  withDocument(() => {
    const cap = captureSink();
    const diag = createClientDiag({ sink: cap.sink });
    const reasons: string[] = [];
    const harness = openLink({ diag, onAuthRejected(reason) { reasons.push(reason); } });
    harness.ws.onclose?.({ code: 4401, reason: "missing" });
    assert.equal(harness.statuses.at(-1)?.phase, "reject");
    assert.equal(harness.statuses.at(-1)?.text, "auth: missing");
    assert.deepEqual(reasons, ["missing"]);
    assert.equal(cap.errors.length, 0);
    assert.equal(cap.warns[0]?.category, "auth");
    assert.equal(cap.warns[0]?.code, 4401);
    assert.equal(cap.warns[0]?.reason, "missing");
  });
});

test("default console logs one parse fault and one later socket fault", () => {
  withDocument(() => {
    const errors: unknown[][] = [];
    const warns: unknown[][] = [];
    const prevErr = console.error;
    const prevWarn = console.warn;
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
    console.warn = (...args: unknown[]) => {
      warns.push(args);
    };
    try {
      const harness = openLink({ auth: false });
      for (let i = 0; i < 5; i += 1) harness.ws.onmessage?.({ data: `NOTJSON ${SECRET}` });
      harness.ws.onerror?.({});
      const text = [...errors, ...warns].map((row) => row.map(blob).join(" ")).join("\n");
      assert.equal(text.includes(SECRET), false);
      assert.equal(errors.length, 2);
      assert.equal((errors[0]?.[0] as Error).message, "invalid frame");
      assert.equal((errors[0]?.[1] as DiagRecord).source, "parse");
      assert.equal((errors[1]?.[0] as DiagRecord).source, "socket");
      assert.equal(harness.statuses.every((row) => !row.text.includes(SECRET)), true);
    } finally {
      console.error = prevErr;
      console.warn = prevWarn;
    }
  });
});

test("sending, snapshot ack, gap resync, and visibility resync keep their old shape", () => {
  withDocument((listeners) => {
    const prevNow = Date.now;
    let now = 5_000_000;
    Date.now = () => now;
    try {
      const harness = openLink({ auth: false });
      const logs: unknown[][] = [];
      const prevErr = console.error;
      console.error = (...args: unknown[]) => {
        logs.push(args);
      };
      try {
        welcome(harness.ws);
        harness.ws.onmessage?.({
          data: JSON.stringify({
            type: "snapshot",
            envelope: { kind: "full", seq: 1, tick: 3, spawns: [], updates: [], despawns: [] },
          }),
        });
        harness.ws.onmessage?.({
          data: JSON.stringify({
            type: "snapshot",
            envelope: { kind: "delta", seq: 4, tick: 6, spawns: [], updates: [], despawns: [] },
          }),
        });
        for (const fn of listeners.get("visibilitychange") ?? []) fn({});
        now += 3_000;
        for (const fn of listeners.get("visibilitychange") ?? []) fn({});
        harness.link.sendInput(1, 0, 1);
        const bodies = parsed(harness.sent);
        assert.deepEqual(bodies[0], { v: 1, type: "ack", snapshotSeq: 1 });
        assert.deepEqual(bodies[1], { v: 1, type: "resync" });
        assert.deepEqual(bodies[2], { v: 1, type: "ack", snapshotSeq: 4 });
        const resyncs = bodies.filter((row) => row.type === "resync");
        assert.equal(resyncs.length, 2);
        assert.deepEqual(bodies.at(-1), { v: 1, type: "input", seq: 1, moveX: 1, moveZ: 0, yaw: 1, buttons: 0, entity: 3 });
        assert.equal(harness.link.faultContext().inputAck, undefined);
        assert.equal(harness.link.faultContext().sentInputId, 1);
        assert.equal(harness.link.faultContext().snapSeq, 4);
        assert.equal(harness.link.faultContext().simTick, 6n);
        assert.equal(harness.link.faultContext().processedInput, undefined);
        assert.equal(logs.length, 0);
      } finally {
        console.error = prevErr;
      }
    } finally {
      Date.now = prevNow;
    }
  });
});

test("hello still sends the reconnect token and the console does not record it", () => {
  withDocument(() => {
    const prevSession = globalThis.sessionStorage;
    const prevLocal = globalThis.localStorage;
    const session = memoryStorage();
    session.setItem("ce-arena-token", SECRET);
    (globalThis as { sessionStorage: Storage }).sessionStorage = session;
    (globalThis as { localStorage: Storage }).localStorage = memoryStorage();
    const errors: unknown[][] = [];
    const warns: unknown[][] = [];
    const prevErr = console.error;
    const prevWarn = console.warn;
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
    console.warn = (...args: unknown[]) => {
      warns.push(args);
    };
    try {
      const harness = openLink();
      harness.ws.onopen?.({});
      const hello = parsed(harness.sent)[0];
      assert.equal(hello?.type, "hello");
      assert.equal(hello?.token, SECRET);
      const text = [...errors, ...warns].map((row) => row.map(blob).join(" ")).join("\n");
      assert.equal(text.includes(SECRET), false);
      assert.equal(errors.length, 0);
      assert.equal(warns.length, 0);
      assert.equal(harness.statuses.at(-1)?.text, "hello sent");
    } finally {
      console.error = prevErr;
      console.warn = prevWarn;
      (globalThis as { sessionStorage: Storage }).sessionStorage = prevSession;
      (globalThis as { localStorage: Storage }).localStorage = prevLocal;
    }
  });
});
