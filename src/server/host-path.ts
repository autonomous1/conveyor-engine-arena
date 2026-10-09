import type { ClientId } from "conveyor-engine-core";
import { DirectNetPath, type NetPath, type NetSendOptions, type SnapshotEnvelope } from "conveyor-engine-replication";
import { decodeFrame, encodeFrame } from "conveyor-engine-transport-ws";

/** Wire `snapshot` is the snap frame. Other names already match the protocol. */
const WIRE_KIND: Record<string, string> = {
  snapshot: "snap",
};

export type HostSnapFrame = {
  type: "snap";
  clientId: ClientId;
  envelope: SnapshotEnvelope;
};

export function hostFrameKind(frame: unknown): string | undefined {
  if (!frame || typeof frame !== "object" || !("type" in frame)) return undefined;
  const type = (frame as { type?: unknown }).type;
  if (typeof type !== "string" || type.length === 0) return undefined;
  return WIRE_KIND[type] ?? type;
}

/**
 * Arena frames use `t` and have no kernel `type`. `parseWire` would reject
 * them, so the inbound path hands them to the arena and does not forward them.
 */
export function isArenaFrame(frame: unknown): frame is { t: string } {
  if (!frame || typeof frame !== "object") return false;
  const rec = frame as { t?: unknown; type?: unknown };
  return typeof rec.t === "string" && rec.t.length > 0 && rec.type === undefined;
}

export function hostSnapPath(
  write: (clientId: ClientId, envelope: SnapshotEnvelope) => void,
): DirectNetPath<HostSnapFrame> {
  return new DirectNetPath((frame) => {
    if (frame.type !== "snap") return;
    write(frame.clientId, frame.envelope);
  });
}

export function dispatchHostFrame<Frame>(path: NetPath<Frame>, frame: Frame, options?: NetSendOptions): void {
  void path.send(frame, options).catch((err: unknown) => {
    console.error("[live] direct net path failed", err);
  });
}

export type HostSocketPaths = {
  sendEncoded(text: string): void;
  deliverEncoded(text: string): void;
  close(): void;
};

/**
 * Outbound sink writes the encoded frame (the `socket.send` inside
 * `EngineWsServer.sendSnapshot`). Inbound sink hands the frame to the
 * handlers `attach` already registered.
 */
export function createHostSocketPaths(io: {
  writeWire: (text: string) => void;
  onEngineText: (text: string) => void;
  onArenaFrame?: (frame: unknown) => void;
}): HostSocketPaths {
  const outbound = new DirectNetPath<unknown>((frame) => {
    io.writeWire(encodeFrame(frame));
  });
  const inbound = new DirectNetPath<unknown>((frame) => {
    io.onEngineText(encodeFrame(frame));
  });
  const accept = (path: DirectNetPath<unknown>, text: string, raw: (text: string) => void) => {
    let frame: unknown;
    try {
      frame = decodeFrame(text);
    } catch {
      raw(text);
      return;
    }
    dispatchHostFrame(path, frame, { kind: hostFrameKind(frame) });
  };
  return {
    sendEncoded(text) {
      accept(outbound, text, io.writeWire);
    },
    deliverEncoded(text) {
      let frame: unknown;
      try {
        frame = decodeFrame(text);
      } catch {
        io.onEngineText(text);
        return;
      }
      if (isArenaFrame(frame)) {
        io.onArenaFrame?.(frame);
        return;
      }
      dispatchHostFrame(inbound, frame, { kind: hostFrameKind(frame) });
    },
    close() {
      outbound.close();
      inbound.close();
    },
  };
}
