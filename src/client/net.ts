import { EngineClient } from "conveyor-engine-client";
import { fireShotFrame, summarizeInbound } from "../shared/fire-debug.js";
import { parseAudit, type AuditCounters } from "../shared/audit.js";
import { parseHealth } from "../shared/health.js";
import { parseQaCapture, parseSceneGraphFrame, type QaCaptureFrame, type SceneGraphFrame } from "../shared/bot-protocol.js";
import { parseDoor, parseDoorSet, useFrame, type DoorFrame } from "../shared/doors.js";
import { parseElevatorSet, parseElevatorState, type ElevatorState } from "../shared/elevators.js";
import { parseGrenadePose, grenadeFrame, type GrenadePose } from "../shared/grenade.js";
import { parseLaser } from "../shared/hitscan.js";
import { modelFrame } from "../shared/model-choice.js";
import { parseLoadout, parsePickup, parsePickupSet, type LoadoutFrame, type PickupFrame } from "../shared/pickups.js";
import { asSnapshot, revive } from "../shared/wire.js";
import { isArenaSolo, loadKey } from "./auth-key.js";
import { boundLabel, createClientDiag, type ClientDiag, type DiagFields } from "./diag.js";

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

/**
 * Socket factory result. A browser `WebSocket` satisfies it, and so does the
 * solo adapter. Handler fields stay `unknown` so both function shapes fit.
 */
export type OpenSocket = {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: unknown;
  onmessage: unknown;
  onclose: unknown;
  onerror: unknown;
};

/** Handler view used after `open()`. */
export type WebSocketLike = {
  readyState: number;
  readonly OPEN: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
};

export type LiveLink = {
  sendInput(moveX: number, moveZ: number, yaw: number, buttons?: number): void;
  /** Arena frame. Returns false when the socket has no owned pawn yet. */
  sendFire(seq: number, yaw: number, pitch: number): boolean;
  /** Arena frame. Returns false when the socket has no owned pawn yet. Does not fire. */
  sendGrenade(seq: number, yaw: number, pitch: number): boolean;
  /** Arena frame. One press of E. Returns false when the socket has no owned pawn yet. */
  sendUse(seq: number): boolean;
  /** Arena frame. Call `stop` on elevator `id`. Returns false when the socket has no owned pawn yet. */
  sendElevator(id: string, stop: number): boolean;
  /**
   * Arena frame. Queued until welcome when the pawn is not owned yet.
   * Returns false when the frame was not written on this call.
   */
  sendModel(model: string): boolean;
  /** PNG data URL for a host `qaCapture`. Sent with or without an owned pawn. */
  sendQaSnapshotData(id: string, png: string): boolean;
  /** True after the socket has closed. Closing does not open another socket. */
  socketClosed(): boolean;
  /** connecting, open, closing, or closed. */
  socketState(): string;
  /**
   * Ids known to this socket for a fault log.
   * `inputAck` is omitted: a snapshot ack is not an input acknowledgement.
   */
  faultContext(): DiagFields;
  close(): void;
};

function closeInfo(ev: unknown): { code?: number; reason: string } {
  if (!ev || typeof ev !== "object") return { reason: "" };
  const rec = ev as { code?: unknown; reason?: unknown };
  return {
    code: typeof rec.code === "number" ? rec.code : undefined,
    reason: typeof rec.reason === "string" ? rec.reason : "",
  };
}

function asHealth(msg: Record<string, unknown>): HealthNotice | undefined {
  const frame = parseHealth(msg);
  if (!frame) return undefined;
  return { entity: frame.entity, hp: frame.hp, dead: frame.dead };
}

export function connectLive(opts: {
  bundleId: string;
  authoritativeHash: string;
  world: string;
  client: EngineClient;
  onStatus: (status: LiveStatus) => void;
  onApplied: () => void;
  onLaser?: (laser: LaserNotice) => void;
  onGrenade?: (grenade: GrenadePose) => void;
  onHealth?: (health: HealthNotice) => void;
  onAudit?: (audit: AuditCounters) => void;
  /** Remaining pickup ids from welcome. Taken placements are absent. */
  onPickupSet?: (ids: readonly string[]) => void;
  onPickup?: (pickup: PickupFrame) => void;
  /** One door changed. Both tabs receive the same open and locked. */
  onDoor?: (door: DoorFrame) => void;
  /** Full door list from welcome, so a late joiner matches. */
  onDoors?: (doors: readonly DoorFrame[]) => void;
  /** One cab moved. `y` is the cab floor. `stop` is the last stop it arrived at. */
  onElevator?: (elevator: ElevatorState) => void;
  /** Full cab list from welcome, so a late joiner matches. */
  onElevators?: (elevators: readonly ElevatorState[]) => void;
  /**
   * Privileged scene graph. `undefined` clears the cache (welcome, close, or a
   * frame that did not parse). The client does not fetch the file.
   */
  onSceneGraph?: (frame: SceneGraphFrame | undefined) => void;
  /** This client only. Other clients do not receive a viewmodel. */
  onLoadout?: (loadout: LoadoutFrame) => void;
  /** Host asked this browser for a PNG. QA and play tabs both receive it. */
  onQaCapture?: (capture: QaCaptureFrame) => void;
  /** Read when a shot is sent. The host logs only when this is on. */
  fireDebug?: () => boolean;
  /** One inbound frame, after it parses and before it is applied. */
  onInbound?: (summary: string) => void;
  /** Parse, inbound hook, or apply threw. The caller does not resync from this. */
  onFault?: (err: unknown) => void;
  /** A fault or host refusal was logged. The HUD may show a short console hint. */
  onConsoleHint?: () => void;
  /** Fault log for this connection. Tests pass one. The browser uses the console. */
  diag?: ClientDiag;
  /** Read when hello is sent. Empty omits the field. */
  model?: () => string | undefined;
  /** Opens one socket. Solo passes the in-tab pair. Multiplayer passes a WebSocket. */
  open: () => OpenSocket;
  /** When false, hello carries no token and welcome does not store one. Solo passes false. */
  auth?: boolean;
  /** Hello `spectate: true`. The host does not seat this client. */
  spectate?: boolean;
  /** Host closed 4401 or 4403. The page clears the key and leaves the game. */
  onAuthRejected?: (reason: string) => void;
}): LiveLink {
  const ws = opts.open() as WebSocketLike;
  const useAuth = opts.auth !== false;
  const diag = opts.diag ?? createClientDiag();
  let lastSeq = 0;
  let lastSnapAt = 0;
  let lastSnapSeq: number | undefined;
  let lastSnapTick: bigint | undefined;
  /**
   * Highest `lastProcessedInput` on a snapshot.
   * The transport writes that field when an input is admitted, not when the world applies it.
   * It is an admission high water. It is not an input ack, and it is not a snapshot sequence.
   */
  let lastProcessed: number | undefined;
  let admittedHigh: number | undefined;
  let recovering = false;
  /** Snapshot tick when this recovery started. A same-tick snapshot is too early to rebase on. */
  let recoverBaseline: bigint | undefined;
  let recoverSawTick: bigint | undefined;
  let lastSentInputId: number | undefined;
  let clientId: number | undefined;
  let inputSeq = 1;
  let ownedId: number | undefined;
  let resyncs = 0;
  let closed = false;
  let welcomed = false;
  let queuedModel: string | undefined;
  const finiteId = (value: unknown): number | undefined => {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "bigint") return Number(value);
    return undefined;
  };
  const faultFields = (extra: {
    source: string;
    messageType?: string;
    category?: string;
    reason?: string;
    code?: string | number;
  }): DiagFields => ({
    source: extra.source,
    messageType: extra.messageType,
    category: extra.category,
    reason: extra.reason,
    code: extra.code,
    connection: clientId,
    ownedEntity: ownedId,
    sentInputId: lastSentInputId,
    processedInput: lastProcessed,
    snapSeq: lastSnapSeq,
    simTick: lastSnapTick,
  });
  const ADMIT_WINDOW = 8;
  const noteAdmitted = (value: number) => {
    if (admittedHigh !== undefined && value < admittedHigh) return;
    admittedHigh = value;
    lastProcessed = value;
  };
  const finishRecovery = () => {
    if (admittedHigh === undefined) return;
    const next = admittedHigh + 1;
    // Outstanding frames were already rejected or admitted before this later tick.
    if (inputSeq <= admittedHigh || inputSeq > admittedHigh + ADMIT_WINDOW) inputSeq = next;
    recovering = false;
    diag.report({
      level: "warn",
      fields: faultFields({ source: "input", messageType: "input", category: "recovery", reason: "rebase" }),
    });
  };
  const considerRecoverySnap = (tick: bigint) => {
    if (!recovering) return;
    if (recoverBaseline === undefined) {
      if (recoverSawTick === undefined) {
        recoverSawTick = tick;
        return;
      }
      if (tick > recoverSawTick) finishRecovery();
      return;
    }
    if (tick > recoverBaseline) finishRecovery();
  };
  const enterRecovery = (reason: string) => {
    if (recovering || closed) return;
    recovering = true;
    recoverBaseline = lastSnapTick;
    recoverSawTick = undefined;
    opts.onConsoleHint?.();
    opts.onStatus({
      phase: "resync",
      text: "recovering input",
      ownedEntityId: ownedId,
      snapSeq: lastSnapSeq,
      resyncs,
    });
    diag.report({
      level: "warn",
      fields: faultFields({ source: "input", messageType: "input", category: "recovery", reason }),
    });
  };
  const rememberSnap = (snap: { seq: number; tick: bigint }, envelope: Record<string, unknown>) => {
    if (Number.isFinite(snap.seq)) lastSnapSeq = snap.seq;
    if ("lastProcessedInput" in envelope) {
      const processed = finiteId(envelope.lastProcessedInput);
      if (processed !== undefined) noteAdmitted(processed);
    }
    considerRecoverySnap(snap.tick);
    lastSnapTick = snap.tick;
  };
  const fieldCode = (value: unknown): string | number | undefined => {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    return boundLabel(value);
  };
  const flushModel = () => {
    if (!queuedModel || ownedId === undefined || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(modelFrame(queuedModel)));
    queuedModel = undefined;
  };
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
  ws.onopen = () => {
    const token = useAuth ? sessionStorage.getItem(TOKEN_KEY) ?? undefined : undefined;
    const auth = useAuth && !isArenaSolo() ? loadKey() ?? undefined : undefined;
    const model = opts.model?.();
    ws.send(JSON.stringify({
      v: 1,
      type: "hello",
      protocol: 1,
      world: opts.world,
      bundleId: opts.bundleId,
      authoritativeHash: opts.authoritativeHash,
      token,
      auth,
      ...(typeof model === "string" && model.length > 0 ? { model } : {}),
      ...(opts.spectate === true ? { spectate: true } : {}),
    }));
    opts.onStatus({ phase: "hello", text: "hello sent", resyncs });
  };
  ws.onerror = () => {
    diag.report({
      level: "error",
      fields: faultFields({ source: "socket", messageType: "error", category: "error" }),
    });
    opts.onConsoleHint?.();
    opts.onStatus({ phase: "error", text: "socket error", ownedEntityId: ownedId, resyncs });
  };
  ws.onclose = (ev) => {
    closed = true;
    opts.onSceneGraph?.(undefined);
    const info = closeInfo(ev);
    const authClose = !isArenaSolo() && (info.code === 4401 || info.code === 4403);
    diag.report({
      level: authClose ? "warn" : "error",
      fields: faultFields({
        source: "socket",
        messageType: "close",
        category: authClose ? "auth" : "close",
        reason: boundLabel(info.reason),
        code: info.code,
      }),
    });
    opts.onConsoleHint?.();
    recovering = false;
    if (authClose) {
      opts.onStatus({
        phase: "reject",
        text: "auth: " + info.reason,
        ownedEntityId: ownedId,
        resyncs,
      });
      opts.onAuthRejected?.(info.reason);
      return;
    }
    opts.onStatus({ phase: "error", text: "socket closed", ownedEntityId: ownedId, resyncs });
  };
  ws.onmessage = (ev) => {
    let msg: Record<string, unknown>;
    try {
      const text = typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer);
      msg = revive(JSON.parse(text)) as Record<string, unknown>;
    } catch (err) {
      diag.report({
        level: "error",
        error: err,
        fields: faultFields({ source: "parse", category: "parse" }),
      });
      opts.onConsoleHint?.();
      opts.onFault?.(err);
      return;
    }
    try {
      opts.onInbound?.(summarizeInbound(msg));
    } catch (err) {
      const kind = typeof msg.t === "string" ? msg.t : typeof msg.type === "string" ? msg.type : undefined;
      diag.report({
        level: "error",
        error: err,
        fields: faultFields({ source: "inbound", messageType: boundLabel(kind), category: "callback" }),
      });
      opts.onConsoleHint?.();
      opts.onFault?.(err);
    }
    if (typeof msg.t === "string") {
      if (msg.t === "sceneGraph") {
        opts.onSceneGraph?.(parseSceneGraphFrame(msg));
        return;
      }
      if (msg.t === "qaCapture") {
        const capture = parseQaCapture(msg);
        if (capture) opts.onQaCapture?.(capture);
        return;
      }
      const laser = parseLaser(msg);
      if (laser) opts.onLaser?.(laser);
      const grenade = parseGrenadePose(msg);
      if (grenade) opts.onGrenade?.(grenade);
      const health = asHealth(msg);
      if (health) opts.onHealth?.(health);
      const audit = parseAudit(msg);
      if (audit) opts.onAudit?.(audit);
      const pickup = parsePickup(msg);
      if (pickup) opts.onPickup?.(pickup);
      const door = parseDoor(msg);
      if (door) opts.onDoor?.(door);
      const elevator = parseElevatorState(msg);
      if (elevator) opts.onElevator?.(elevator);
      const loadout = parseLoadout(msg);
      if (loadout) opts.onLoadout?.(loadout);
      return;
    }
    try {
      if (msg.type === "welcome") {
        opts.onSceneGraph?.(undefined);
        const token = typeof msg.reconnectToken === "string" ? msg.reconnectToken : undefined;
        if (token && useAuth) sessionStorage.setItem(TOKEN_KEY, token);
        const owned = Number(msg.ownedEntityId);
        const welcomedId = Number(msg.clientId) || 1;
        clientId = welcomedId;
        const nextOwned = Number.isFinite(owned) ? owned : undefined;
        // A second welcome clears interpolation and would snap the view onto
        // whatever pawn the host named. Stay on the pawn we already have.
        // A spectator welcome has no pawn. Connect once so snapshots still apply.
        if (!welcomed && (nextOwned !== undefined || opts.spectate === true)) {
          if (nextOwned !== undefined) ownedId = nextOwned;
          inputSeq = 1;
          opts.client.connect(ownedId, welcomedId);
          welcomed = true;
          lastSeq = 0;
        }
        const ids = parsePickupSet(msg.pickups);
        if (ids) opts.onPickupSet?.(ids);
        const doors = parseDoorSet(msg.doors);
        if (doors) opts.onDoors?.(doors);
        const elevators = parseElevatorSet(msg.elevators);
        if (elevators) opts.onElevators?.(elevators);
        if (typeof msg.weapon === "string" || typeof msg.ammo === "number") {
          const ammo = typeof msg.ammo === "number" && Number.isFinite(msg.ammo) ? msg.ammo : 0;
          const weapon = typeof msg.weapon === "string" && msg.weapon.length > 0 ? msg.weapon : undefined;
          opts.onLoadout?.({ t: "loadout", ammo, ...(weapon ? { weapon } : {}) });
        }
        opts.onStatus({
          phase: "welcome",
          text: `welcome client ${welcomedId} owned ${ownedId ?? "none"}`,
          clientId: welcomedId,
          ownedEntityId: ownedId,
          resyncs,
        });
        flushModel();
        return;
      }
      if (msg.type === "reject" || msg.type === "error") {
        diag.report({
          level: msg.type === "reject" ? "warn" : "error",
          fields: faultFields({
            source: "host",
            messageType: msg.type,
            category: boundLabel(msg.category),
            reason: boundLabel(msg.reason),
            code: fieldCode(msg.code),
          }),
        });
        opts.onConsoleHint?.();
        if (msg.type === "error" && (msg.reason === "future" || msg.reason === "duplicate-or-old")) {
          enterRecovery(msg.reason);
        }
        return;
      }
      if (msg.type !== "snapshot" || !msg.envelope || typeof msg.envelope !== "object") return;
      const envelope = msg.envelope as Record<string, unknown>;
      const snap = asSnapshot(envelope);
      if (snap.kind !== "full" && lastSeq > 0 && snap.seq > lastSeq + 1) requestResync();
      lastSeq = Number.isFinite(snap.seq) ? snap.seq : lastSeq;
      lastSnapAt = Date.now();
      rememberSnap(snap, envelope);
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
      diag.report({
        level: "error",
        error: err,
        fields: faultFields({ source: "apply", messageType: "snapshot", category: "apply" }),
      });
      opts.onConsoleHint?.();
      opts.onFault?.(err);
      requestResync();
    }
  };
  return {
    sendInput(moveX, moveZ, yaw, buttons = 0) {
      if (ownedId === undefined || closed || ws.readyState !== WebSocket.OPEN || recovering) return;
      // Do not run further ahead of the last published admission than the gateway will accept.
      if (admittedHigh !== undefined && inputSeq > admittedHigh + ADMIT_WINDOW) {
        enterRecovery("ahead");
        return;
      }
      const seq = inputSeq++;
      lastSentInputId = seq;
      ws.send(JSON.stringify({
        v: 1,
        type: "input",
        seq,
        moveX,
        moveZ,
        yaw,
        // Bits: noclip, ascend up, ascend down. The kernel already forwards `buttons`.
        buttons,
        entity: ownedId,
      }));
    },
    sendFire(seq, yaw, pitch) {
      if (ownedId === undefined || ws.readyState !== WebSocket.OPEN) return false;
      ws.send(JSON.stringify(fireShotFrame(seq, yaw, pitch, opts.fireDebug?.() ?? false)));
      return true;
    },
    sendGrenade(seq, yaw, pitch) {
      if (ownedId === undefined || ws.readyState !== WebSocket.OPEN) return false;
      ws.send(JSON.stringify(grenadeFrame(seq, yaw, pitch)));
      return true;
    },
    sendUse(seq) {
      if (ownedId === undefined || ws.readyState !== WebSocket.OPEN) return false;
      ws.send(JSON.stringify(useFrame(seq)));
      return true;
    },
    sendElevator(id, stop) {
      if (ownedId === undefined || ws.readyState !== WebSocket.OPEN) return false;
      ws.send(JSON.stringify({ t: "elevator", id, stop }));
      return true;
    },
    sendModel(model) {
      if (!model) return false;
      queuedModel = model;
      if (ownedId === undefined || ws.readyState !== WebSocket.OPEN) return false;
      flushModel();
      return true;
    },
    sendQaSnapshotData(id, png) {
      if (ws.readyState !== WebSocket.OPEN || id.length === 0) return false;
      ws.send(JSON.stringify({ t: "qaSnapshotData", id, png }));
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
    faultContext() {
      return faultFields({ source: "client" });
    },
    close() {
      document.removeEventListener("visibilitychange", onVisibility);
      ws.close();
    },
  };
}
