/**
 * Step log for one shot. Quiet unless the client switch is on.
 * The logger records the failure. It does not reload, reconnect, or respawn.
 */

export const FIRE_DEBUG_PREFIX = "fire-debug";

export type FireDebugSink = {
  log(line: string): void;
  error(line: string): void;
};

export function fireDebugLine(step: string): string {
  return `${FIRE_DEBUG_PREFIX} ${step}`;
}

export function fireDebugErrorLine(where: string, err: unknown): string {
  const stack = err instanceof Error ? (err.stack ?? err.message) : String(err);
  return `${FIRE_DEBUG_PREFIX} error ${where}\n${stack}`;
}

/** Wire flag. Absent means the client switch is off. The host has no switch of its own. */
export function fireFrameWantsDebug(frame: unknown): boolean {
  if (!frame || typeof frame !== "object") return false;
  const debug = (frame as { debug?: unknown }).debug;
  return debug === 1 || debug === true;
}

/** Same fields as `fireFrame`. `debug` is present only when the client switch is on. */
export function fireShotFrame(seq: number, yaw: number, pitch: number, debug: boolean): {
  t: "fire";
  v: 1;
  seq: number;
  yaw: number;
  pitch: number;
  debug?: 1;
} {
  const frame: { t: "fire"; v: 1; seq: number; yaw: number; pitch: number; debug?: 1 } = {
    t: "fire",
    v: 1,
    seq,
    yaw,
    pitch,
  };
  if (debug) frame.debug = 1;
  return frame;
}

export function summarizeInbound(msg: Record<string, unknown>): string {
  if (msg.t === "laser") return `laser shooter=${String(msg.shooter)}`;
  if (typeof msg.t === "string") return String(msg.t);
  if (msg.type === "welcome") return `welcome owned=${String(msg.ownedEntityId)}`;
  if (msg.type === "reject" || msg.type === "error") {
    return `${String(msg.type)} ${String(msg.reason ?? msg.code ?? "")}`.trim();
  }
  if (msg.type === "snapshot") {
    const envelope = msg.envelope;
    const seq = envelope && typeof envelope === "object" && "seq" in envelope
      ? (envelope as { seq?: unknown }).seq
      : undefined;
    return `snapshot seq=${String(seq ?? "")}`;
  }
  return String(msg.type ?? "frame");
}

function browserSink(): FireDebugSink {
  return {
    log(line) {
      console.log(line);
    },
    error(line) {
      console.error(line);
    },
  };
}

export function createFireDebugLog(enabled: () => boolean, sink: FireDebugSink = browserSink()) {
  const write = (step: string) => {
    if (!enabled()) return;
    sink.log(fireDebugLine(step));
  };
  const vec = (p: { x: number; y: number; z: number }) => `${p.x.toFixed(3)},${p.y.toFixed(3)},${p.z.toFixed(3)}`;
  return {
    keydown() {
      write("keydown");
    },
    frameSent(seq: number, yaw: number, pitch: number) {
      write(`frame sent seq=${seq} yaw=${yaw} pitch=${pitch}`);
    },
    frameReceived(summary: string) {
      write(`frame received ${summary}`);
    },
    camera(position: { x: number; y: number; z: number }) {
      write(`camera ${vec(position)}`);
    },
    pawn(id: number | undefined) {
      write(`pawn ${id === undefined ? "none" : id}`);
    },
    socket(state: string) {
      write(`socket ${state}`);
    },
    receive(detail: string) {
      write(`receive ${detail}`);
    },
    dedupe(detail: string) {
      write(`dedupe ${detail}`);
    },
    trace(detail: string) {
      write(`trace ${detail}`);
    },
    writePawn(detail: string) {
      write(`write ${detail}`);
    },
    thrown(where: string, err: unknown) {
      if (!enabled()) return;
      sink.error(fireDebugErrorLine(where, err));
    },
  };
}

/** Message left on screen. Logging does not clear it. */
export function clientFaultText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
