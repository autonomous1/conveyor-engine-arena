import { EngineClient, type IncomingSnapshot } from "conveyor-engine-client";
import { fireShotFrame, summarizeInbound } from "../shared/fire-debug.js";
import { parseHealth } from "../shared/health.js";

const TOKEN_KEY = "ce-arena-token";

export type LiveStatus = {
  phase: "hello" | "welcome" | "snap" | "resync" | "reject" | "error";
  text: string;
  clientId?: number;
  ownedEntityId?: number;
  snapSeq?: number;
  resyncs: number;
};

export type LaserNotice = {
  shooter: number;
  from: { x: number; y: number; z: number };
  to: { x: number; y: number; z: number };
  until: number;
};

export type HealthNotice = {
  entity: number;
  hp: number;
  dead: boolean;
};

export type LiveLink = {
  sendInput(moveX: number, moveZ: number, yaw: number): void;
  /** Arena frame. Returns false when the socket has no owned pawn yet. */
  sendFire(seq: number, yaw: number, pitch: number): boolean;
  /** True after the socket has closed. Closing does not open another socket. */
  socketClosed(): boolean;
  /** connecting, open, closing, or closed. */
  socketState(): string;
  close(): void;
};

function revive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(revive);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.$i === "string" && Object.keys(record).length === 1) return BigInt(record.$i);
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(record)) out[key] = revive(item);
    return out;
  }
  return value;
}

function asVec(value: unknown): { x: number; y: number; z: number } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const rec = value as { x?: unknown; y?: unknown; z?: unknown };
  if (typeof rec.x !== "number" || typeof rec.y !== "number" || typeof rec.z !== "number") return undefined;
  if (!Number.isFinite(rec.x) || !Number.isFinite(rec.y) || !Number.isFinite(rec.z)) return undefined;
  return { x: rec.x, y: rec.y, z: rec.z };
}

function asLaser(msg: Record<string, unknown>): LaserNotice | undefined {
  if (msg.t !== "laser") return undefined;
  const shooter = Number(msg.shooter);
  const from = asVec(msg.from);
  const to = asVec(msg.to);
  const until = Number(msg.until);
  if (!Number.isFinite(shooter) || !from || !to || !Number.isFinite(until)) return undefined;
  return { shooter, from, to, until };
}

function asHealth(msg: Record<string, unknown>): HealthNotice | undefined {
  const frame = parseHealth(msg);
  if (!frame) return undefined;
  return { entity: frame.entity, hp: frame.hp, dead: frame.dead };
}

function asSnapshot(envelope: Record<string, unknown>): IncomingSnapshot {
  const tick = envelope.tick;
  return {
    kind: envelope.kind === "full" ? "full" : "delta",
    seq: Number(envelope.seq),
    tick: typeof tick === "bigint" ? tick : BigInt(Number(tick ?? 0)),
    lastProcessedInput: Number(envelope.lastProcessedInput ?? 0),
    spawns: (envelope.spawns as IncomingSnapshot["spawns"]) ?? [],
    updates: (envelope.updates as IncomingSnapshot["updates"]) ?? [],
    despawns: (envelope.despawns as IncomingSnapshot["despawns"]) ?? [],
  };
}

export function connectLive(opts: {
  bundleId: string;
  authoritativeHash: string;
  world: string;
  client: EngineClient;
  onStatus: (status: LiveStatus) => void;
  onApplied: () => void;
  onLaser?: (laser: LaserNotice) => void;
  onHealth?: (health: HealthNotice) => void;
  /** Read when a shot is sent. The host logs only when this is on. */
  fireDebug?: () => boolean;
  /** One inbound frame, after it parses and before it is applied. */
  onInbound?: (summary: string) => void;
  /** Parse or apply threw. The caller pins the message. This does not resync. */
  onFault?: (err: unknown) => void;
}): LiveLink {
  const ws = new WebSocket(`${location.origin.replace(/^http/, "ws")}/`);
  let lastSeq = 0;
  let lastSnapAt = 0;
  let inputSeq = 1;
  let ownedId: number | undefined;
  let resyncs = 0;
  let closed = false;
  let welcomed = false;
  const requestResync = () => {
    if (ws.readyState !== WebSocket.OPEN) return;
    resyncs += 1;
    ws.send(JSON.stringify({ v: 1, type: "resync" }));
    opts.onStatus({
      phase: "resync",
      text: `resync ${resyncs}`,
      ownedEntityId: ownedId,
      snapSeq: lastSeq || undefined,
      resyncs,
    });
  };
  const onVisibility = () => {
    if (document.visibilityState !== "visible" || ws.readyState !== WebSocket.OPEN) return;
    if (Date.now() - lastSnapAt < 2500) return;
    requestResync();
  };
  document.addEventListener("visibilitychange", onVisibility);
  ws.addEventListener("open", () => {
    const token = sessionStorage.getItem(TOKEN_KEY) ?? undefined;
    ws.send(JSON.stringify({
      v: 1,
      type: "hello",
      protocol: 1,
      world: opts.world,
      bundleId: opts.bundleId,
      authoritativeHash: opts.authoritativeHash,
      token,
    }));
    opts.onStatus({ phase: "hello", text: "hello sent", resyncs });
  });
  ws.addEventListener("error", () => opts.onStatus({ phase: "error", text: "socket error", ownedEntityId: ownedId, resyncs }));
  ws.addEventListener("close", () => {
    closed = true;
    console.log("socket closed");
    opts.onStatus({ phase: "error", text: "socket closed", ownedEntityId: ownedId, resyncs });
  });
  ws.addEventListener("message", (ev) => {
    let msg: Record<string, unknown>;
    try {
      const text = typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer);
      msg = revive(JSON.parse(text)) as Record<string, unknown>;
    } catch (err) {
      console.error(err);
      opts.onFault?.(err);
      opts.onStatus({
        phase: "error",
        text: `frame error ${err instanceof Error ? err.message : String(err)}`,
        ownedEntityId: ownedId,
        resyncs,
      });
      return;
    }
    try {
      opts.onInbound?.(summarizeInbound(msg));
    } catch (err) {
      opts.onFault?.(err);
    }
    if (typeof msg.t === "string") {
      const laser = asLaser(msg);
      if (laser) opts.onLaser?.(laser);
      const health = asHealth(msg);
      if (health) opts.onHealth?.(health);
      return;
    }
    try {
      if (msg.type === "welcome") {
        const token = typeof msg.reconnectToken === "string" ? msg.reconnectToken : undefined;
        if (token) sessionStorage.setItem(TOKEN_KEY, token);
        const owned = Number(msg.ownedEntityId);
        const clientId = Number(msg.clientId) || 1;
        const nextOwned = Number.isFinite(owned) ? owned : undefined;
        // A second welcome clears interpolation and would snap the view onto
        // whatever pawn the host named. Stay on the pawn we already have.
        if (!welcomed && nextOwned !== undefined) {
          ownedId = nextOwned;
          inputSeq = 1;
          opts.client.connect(ownedId, clientId);
          welcomed = true;
          lastSeq = 0;
        }
        opts.onStatus({
          phase: "welcome",
          text: `welcome client ${clientId} owned ${ownedId ?? "none"}`,
          clientId,
          ownedEntityId: ownedId,
          resyncs,
        });
        return;
      }
      if (msg.type === "reject" || msg.type === "error") {
        opts.onStatus({
          phase: msg.type,
          text: `${String(msg.type)} ${String(msg.reason ?? msg.code ?? "")}`,
          ownedEntityId: ownedId,
          resyncs,
        });
        return;
      }
      if (msg.type !== "snapshot" || !msg.envelope || typeof msg.envelope !== "object") return;
      const snap = asSnapshot(msg.envelope as Record<string, unknown>);
      if (snap.kind !== "full" && lastSeq > 0 && snap.seq > lastSeq + 1) requestResync();
      lastSeq = Number.isFinite(snap.seq) ? snap.seq : lastSeq;
      lastSnapAt = Date.now();
      opts.client.applySnapshot(snap);
      ws.send(JSON.stringify({ v: 1, type: "ack", snapshotSeq: snap.seq }));
      const rendered = opts.client.renderSnapshot();
      if (snap.kind === "delta" && rendered.entities.length === 0) requestResync();
      opts.onStatus({
        phase: "snap",
        text: `snap ${snap.seq} tick ${snap.tick} ${snap.kind} owned ${ownedId ?? "?"} pawns ${rendered.entities.length}`,
        clientId: opts.client.clientId,
        ownedEntityId: ownedId,
        snapSeq: snap.seq,
        resyncs,
      });
      opts.onApplied();
    } catch (err) {
      opts.onFault?.(err);
      opts.onStatus({
        phase: "error",
        text: `apply failed ${err instanceof Error ? err.message : String(err)}`,
        ownedEntityId: ownedId,
        resyncs,
      });
      requestResync();
    }
  });
  return {
    sendInput(moveX, moveZ, yaw) {
      if (ownedId === undefined || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({
        v: 1,
        type: "input",
        seq: inputSeq++,
        moveX,
        moveZ,
        yaw,
        buttons: 0,
        entity: ownedId,
      }));
    },
    sendFire(seq, yaw, pitch) {
      if (ownedId === undefined || ws.readyState !== WebSocket.OPEN) return false;
      ws.send(JSON.stringify(fireShotFrame(seq, yaw, pitch, opts.fireDebug?.() ?? false)));
      return true;
    },
    socketClosed() {
      return closed || ws.readyState === WebSocket.CLOSED;
    },
    socketState() {
      if (closed || ws.readyState === WebSocket.CLOSED) return "closed";
      if (ws.readyState === WebSocket.OPEN) return "open";
      if (ws.readyState === WebSocket.CLOSING) return "closing";
      return "connecting";
    },
    close() {
      document.removeEventListener("visibilitychange", onVisibility);
      ws.close();
    },
  };
}
