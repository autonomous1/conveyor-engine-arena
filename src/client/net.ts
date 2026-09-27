import { EngineClient, type IncomingSnapshot } from "conveyor-engine-client";

const TOKEN_KEY = "ce-arena-token";

export type LiveStatus = {
  text: string;
  clientId?: number;
  ownedEntityId?: number;
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
}): () => void {
  const ws = new WebSocket(`${location.origin.replace(/^http/, "ws")}/`);
  let lastSeq = 0;
  let lastSnapAt = 0;
  const onVisibility = () => {
    if (document.visibilityState !== "visible" || ws.readyState !== WebSocket.OPEN) return;
    if (Date.now() - lastSnapAt < 2500) return;
    ws.send(JSON.stringify({ v: 1, type: "resync" }));
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
    opts.onStatus({ text: "hello sent" });
  });
  ws.addEventListener("error", () => opts.onStatus({ text: "socket error" }));
  ws.addEventListener("message", (ev) => {
    try {
      const text = typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer);
      const msg = revive(JSON.parse(text)) as Record<string, unknown>;
      if (msg.type === "welcome") {
        const token = typeof msg.reconnectToken === "string" ? msg.reconnectToken : undefined;
        if (token) sessionStorage.setItem(TOKEN_KEY, token);
        const owned = Number(msg.ownedEntityId);
        const clientId = Number(msg.clientId) || 1;
        if (Number.isFinite(owned)) opts.client.connect(owned, clientId);
        lastSeq = 0;
        opts.onStatus({
          text: `welcome client ${clientId} owned ${Number.isFinite(owned) ? owned : "?"}`,
          clientId,
          ownedEntityId: Number.isFinite(owned) ? owned : undefined,
        });
        return;
      }
      if (msg.type === "reject" || msg.type === "error") {
        opts.onStatus({ text: `${String(msg.type)} ${String(msg.reason ?? msg.code ?? "")}` });
        return;
      }
      if (msg.type !== "snapshot" || !msg.envelope || typeof msg.envelope !== "object") return;
      const snap = asSnapshot(msg.envelope as Record<string, unknown>);
      if (snap.kind !== "full" && lastSeq > 0 && snap.seq > lastSeq + 1) {
        ws.send(JSON.stringify({ v: 1, type: "resync" }));
      }
      lastSeq = Number.isFinite(snap.seq) ? snap.seq : lastSeq;
      lastSnapAt = Date.now();
      if (!opts.client.connected) {
        const first = snap.spawns[0] ?? snap.updates[0];
        if (first) opts.client.connect(Number(first.entity), 1);
      }
      opts.client.applySnapshot(snap);
      ws.send(JSON.stringify({ v: 1, type: "ack", snapshotSeq: snap.seq }));
      if (snap.kind === "delta" && opts.client.renderSnapshot().entities.length === 0) {
        ws.send(JSON.stringify({ v: 1, type: "resync" }));
      }
      opts.onStatus({
        text: `snap ${snap.seq} tick ${snap.tick} ${snap.kind} pawns ${opts.client.renderSnapshot().entities.length}`,
      });
      opts.onApplied();
    } catch (err) {
      opts.onStatus({ text: `apply failed ${err instanceof Error ? err.message : String(err)}` });
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ v: 1, type: "resync" }));
    }
  });
  return () => {
    document.removeEventListener("visibilitychange", onVisibility);
    ws.close();
  };
}
