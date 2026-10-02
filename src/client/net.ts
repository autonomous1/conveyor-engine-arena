import { EngineClient, type IncomingSnapshot } from "conveyor-engine-client";

const TOKEN_KEY = "ce-arena-token";

export type LiveStatus = {
  phase: "hello" | "welcome" | "snap" | "resync" | "reject" | "error";
  text: string;
  clientId?: number;
  ownedEntityId?: number;
  snapSeq?: number;
  resyncs: number;
};

export type LiveLink = {
  sendInput(moveX: number, moveZ: number, yaw: number): void;
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
}): LiveLink {
  const ws = new WebSocket(`${location.origin.replace(/^http/, "ws")}/`);
  let lastSeq = 0;
  let lastSnapAt = 0;
  let inputSeq = 1;
  let ownedId: number | undefined;
  let resyncs = 0;
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
  ws.addEventListener("message", (ev) => {
    try {
      const text = typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer);
      const msg = revive(JSON.parse(text)) as Record<string, unknown>;
      if (msg.type === "welcome") {
        const token = typeof msg.reconnectToken === "string" ? msg.reconnectToken : undefined;
        if (token) sessionStorage.setItem(TOKEN_KEY, token);
        const owned = Number(msg.ownedEntityId);
        const clientId = Number(msg.clientId) || 1;
        ownedId = Number.isFinite(owned) ? owned : undefined;
        inputSeq = 1;
        if (ownedId !== undefined) opts.client.connect(ownedId, clientId);
        lastSeq = 0;
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
    close() {
      document.removeEventListener("visibilitychange", onVisibility);
      ws.close();
    },
  };
}
