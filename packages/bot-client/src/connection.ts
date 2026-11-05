/**
 * Headless arena client. The access JWT goes in hello `auth`.
 * Reconnect uses welcome `reconnectToken` as `token`. No WebSocket subprotocol.
 * This file does not import `ws` or Node builtins. The CLI injects `openSocket`.
 */
import { EngineClient } from "conveyor-engine-client";
import { parseArenaFrame, parseWelcomeExtras } from "../../../src/shared/bot-protocol.js";
import { asSnapshot, revive } from "../../../src/shared/wire.js";
import { createBotInput, type BotInput } from "./input.js";
import type { SocketLike } from "./socket.js";
import { createBotWorld, type BotWorld, type WorldView } from "./world.js";

export class BotAuthRejected extends Error {
  readonly code: 4401 | 4403;
  readonly reason: string;

  constructor(code: 4401 | 4403, reason: string) {
    super(`${code} ${reason}`.trim());
    this.name = "BotAuthRejected";
    this.code = code;
    this.reason = reason;
  }
}

export class BotRejected extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "BotRejected";
    this.code = code;
  }
}

export type ConnectBotOptions = {
  url: string;
  /** Access JWT. Sent as hello `auth`. Empty omits the field (the host closes 4401). */
  token: string;
  name: string;
  /** Mint role. Compared with welcome `role` when both are set. Not a hello field. */
  role?: "bot" | "qa" | "player";
  model?: string;
  /** Recorded for the caller. Admission stays the JWT scope. */
  spectate?: boolean;
  openSocket?: (url: string) => SocketLike;
  /** Parsed scene-graph file. A later `sceneGraph` frame replaces it. */
  sceneGraph?: unknown;
  onLog?: (line: string) => void;
};

export type BotSession = {
  world: BotWorld;
  input: BotInput;
  spectate: boolean;
  close(): void;
};

type ArenaHelloView = WorldView & {
  world: string;
  bundleId: string;
  authoritativeHash: string;
  modelChoices?: string[];
};

const WELCOME_MS = 8_000;
const BACKOFF_START_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

export async function connectBot(o: ConnectBotOptions): Promise<BotSession> {
  const http = httpOf(o.url);
  const res = await fetch(new URL("/arena.json", http));
  if (!res.ok) throw new Error(`arena.json ${res.status}`);
  const view = (await res.json()) as ArenaHelloView;
  if (!view.world || !view.bundleId || !view.authoritativeHash) {
    throw new Error("arena.json missing world / bundleId / authoritativeHash");
  }
  const world = createBotWorld(view);
  if (o.sceneGraph !== undefined) {
    const reason = world.loadSceneGraph(o.sceneGraph);
    if (reason) o.onLog?.(`scene graph: ${reason}`);
  }

  const open = o.openSocket ?? defaultOpen;
  const wsUrl = wsOf(o.url);
  const model = o.model ?? view.modelChoices?.[0];
  const client = new EngineClient(1, { delayMs: 80, extraMs: 0, predictOwned: false });
  let reconnectToken: string | undefined;
  let ownedId: number | undefined;
  let current: SocketLike | undefined;
  let stopped = false;
  let ready = false;
  let cancelSleep: (() => void) | undefined;

  const input = createBotInput({
    send(text) {
      const ws = current;
      if (!ws || ws.readyState !== 1) return false;
      ws.send(text);
      return true;
    },
    ownedId() {
      return ownedId;
    },
  });

  let resolveReady!: () => void;
  let rejectReady!: (err: unknown) => void;
  const readyPromise = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  const noteWelcome = (msg: Record<string, unknown>): void => {
    const token = typeof msg.reconnectToken === "string" ? msg.reconnectToken : undefined;
    if (token) reconnectToken = token;
    const extras = parseWelcomeExtras(msg);
    if (extras) world.applyWelcome(extras);
    const owned = Number(msg.ownedEntityId);
    const clientId = Number(msg.clientId) || 1;
    if (ownedId === undefined && Number.isFinite(owned)) {
      ownedId = owned;
      world.noteOwned(owned);
      client.connect(owned, clientId);
      input.resetSeq();
    }
    if (o.role && extras?.role && extras.role !== o.role) {
      o.onLog?.(`welcome role ${extras.role} != ${o.role}`);
    }
    if (!ready) {
      ready = true;
      resolveReady();
    }
  };

  const startSocket = (): Promise<void> => new Promise((resolve, reject) => {
    const ws = open(wsUrl);
    current = ws;
    let gotWelcome = false;
    let settled = false;
    const timer = setTimeout(() => {
      fail(new Error("no welcome"));
      try {
        ws.close();
      } catch {
        // already closing
      }
    }, WELCOME_MS);
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    let lastSeq = 0;

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify(helloFrame(view, o, reconnectToken, model)));
    });
    ws.addEventListener("error", () => {
      // The close event carries 4401 / 4403. An error with no close still hits the timer.
    });
    ws.addEventListener("close", (ev) => {
      if (ws !== current && current !== undefined) return;
      if (gotWelcome) {
        finish();
        return;
      }
      const info = closeInfo(ev);
      if (info.code === 4401 || info.code === 4403) fail(new BotAuthRejected(info.code, info.reason));
      else fail(new Error(`socket closed ${info.code ?? ""} ${info.reason}`.trim()));
    });
    ws.addEventListener("message", (ev) => {
      if (ws !== current) return;
      const text = frameText(ev.data);
      let msg: Record<string, unknown>;
      try {
        msg = revive(JSON.parse(text)) as Record<string, unknown>;
      } catch {
        return;
      }
      if (typeof msg.t === "string") {
        applyArenaText(world, text, o.onLog);
        return;
      }
      if (msg.type === "welcome") {
        gotWelcome = true;
        clearTimeout(timer);
        noteWelcome(msg);
        return;
      }
      if (msg.type === "reject" || msg.type === "error") {
        const code = typeof msg.code === "string" && msg.code.length > 0 ? msg.code : String(msg.reason ?? msg.type);
        fail(new BotRejected(code));
        try {
          ws.close();
        } catch {
          // already closing
        }
        return;
      }
      if (msg.type !== "snapshot" || !msg.envelope || typeof msg.envelope !== "object") return;
      try {
        const snap = asSnapshot(msg.envelope as Record<string, unknown>);
        if (snap.kind !== "full" && lastSeq > 0 && snap.seq > lastSeq + 1 && ws.readyState === 1) {
          ws.send(JSON.stringify({ v: 1, type: "resync" }));
        }
        lastSeq = Number.isFinite(snap.seq) ? snap.seq : lastSeq;
        client.applySnapshot(snap);
        world.applySnapshot(snap);
        if (ws.readyState === 1) ws.send(JSON.stringify({ v: 1, type: "ack", snapshotSeq: snap.seq }));
      } catch {
        if (ws.readyState === 1) ws.send(JSON.stringify({ v: 1, type: "resync" }));
      }
    });
  });

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => {
    const timer = setTimeout(() => {
      cancelSleep = undefined;
      resolve();
    }, ms);
    cancelSleep = () => {
      clearTimeout(timer);
      cancelSleep = undefined;
      resolve();
    };
  });

  void (async () => {
    let backoff = BACKOFF_START_MS;
    while (!stopped) {
      try {
        await startSocket();
      } catch (err) {
        if (!ready) {
          rejectReady(err);
          return;
        }
        if (stopped) return;
        if (err instanceof BotAuthRejected || err instanceof BotRejected) return;
        o.onLog?.(`connection lost: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (stopped) return;
      o.onLog?.(`reconnect in ${backoff / 1000}s`);
      await sleep(backoff);
      backoff = Math.min(BACKOFF_MAX_MS, backoff * 2);
    }
  })();

  try {
    await readyPromise;
  } catch (err) {
    stopped = true;
    cancelSleep?.();
    try {
      current?.close();
    } catch {
      // already closing
    }
    throw err;
  }

  return {
    world,
    input,
    spectate: o.spectate === true,
    close() {
      stopped = true;
      cancelSleep?.();
      const ws = current;
      if (!ws) return;
      if (ws.readyState === 0 || ws.readyState === 1) ws.close();
    },
  };
}

/** Same fields as `connectLive` in `src/client/net.ts`, plus optional `name`. */
function helloFrame(
  view: ArenaHelloView,
  o: ConnectBotOptions,
  token: string | undefined,
  model: string | undefined,
): Record<string, unknown> {
  return {
    v: 1,
    type: "hello",
    protocol: 1,
    world: view.world,
    bundleId: view.bundleId,
    authoritativeHash: view.authoritativeHash,
    token,
    auth: o.token.length > 0 ? o.token : undefined,
    ...(typeof model === "string" && model.length > 0 ? { model } : {}),
    ...(o.name.length > 0 ? { name: o.name } : {}),
  };
}

function applyArenaText(world: BotWorld, text: string, onLog?: (line: string) => void): void {
  const frame = parseArenaFrame(text);
  if (!frame) return;
  if (frame.t === "inventory") world.applyInventory(frame.keys);
  else if (frame.t === "pickup") world.applyPickupGone(frame.id);
  else if (frame.t === "door") world.applyDoor(frame);
  else if (frame.t === "elevator") {
    world.applyElevator({ id: frame.id, y: frame.y, doorsOpen: frame.doorsOpen, stop: frame.stop });
  } else if (frame.t === "health") world.applyHealth(frame);
  else if (frame.t === "loadout") world.applyLoadout(frame);
  else if (frame.t === "sceneGraph") {
    const reason = world.loadSceneGraph(frame.graph, frame.hash);
    if (reason) onLog?.(`scene graph: ${reason}`);
  }
}

function frameText(data: unknown): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data as Uint8Array);
  return String(data);
}

function closeInfo(ev: { code?: number; reason?: unknown }): { code?: number; reason: string } {
  return {
    code: typeof ev.code === "number" ? ev.code : undefined,
    reason: reasonText(ev.reason),
  };
}

function reasonText(reason: unknown): string {
  if (typeof reason === "string") return reason;
  if (reason instanceof Uint8Array) return new TextDecoder().decode(reason);
  return "";
}

export function httpOf(url: string): URL {
  const parsed = new URL(url);
  if (parsed.protocol === "ws:") parsed.protocol = "http:";
  else if (parsed.protocol === "wss:") parsed.protocol = "https:";
  else if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`bad url: ${url}`);
  return parsed;
}

export function wsOf(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol === "http:") parsed.protocol = "ws:";
  else if (parsed.protocol === "https:") parsed.protocol = "wss:";
  else if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") throw new Error(`bad url: ${url}`);
  return parsed.toString();
}

function defaultOpen(url: string): SocketLike {
  const Ctor = (globalThis as { WebSocket?: new (url: string) => SocketLike }).WebSocket;
  if (!Ctor) throw new Error("pass openSocket");
  return new Ctor(url);
}
