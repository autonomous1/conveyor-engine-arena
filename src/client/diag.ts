/**
 * Browser fault log. The first distinct fault is full. Repeats are counted.
 * Snapshot sequence, simulation tick, and any input acknowledgement stay separate fields.
 * An input acknowledgement is never filled from a tick or a snapshot sequence.
 */
// ARCHITECTURE: Browser fault log: first full fault, repeats counted, bounded
//   labels.
// Wiring: boot.ts, net.ts, and bot-label.ts report faults; boot.ts paints the
//   hint.

const UNKNOWN = "unknown";
const MAX_KEYS = 32;
const SUMMARY_EVERY = 32;
const MAX_TEXT = 160;

export type DiagFields = {
  source: string;
  messageType?: string;
  category?: string;
  reason?: string;
  code?: string | number;
  /** Host client id once welcome has named this socket. */
  connection?: number;
  ownedEntity?: number;
  /** Last movement input id this client sent. Not a snapshot sequence. */
  sentInputId?: number;
  /**
   * Authoritative acknowledgement of an input id.
   * Leave unset when the host has not acked an input. Never a snapshot sequence or sim tick.
   */
  inputAck?: number;
  /**
   * Last applied input carried on a snapshot envelope, when that field was present.
   * This is processed input, not admission, and not `inputAck`.
   */
  processedInput?: number;
  snapSeq?: number;
  simTick?: number | bigint;
};

export type DiagReport = {
  level: "error" | "warn";
  /** Thrown value when one exists. A parse fault is rewritten so the payload is not logged. */
  error?: unknown;
  fields: DiagFields;
};

export type DiagRecord = Record<string, string | number>;

export type DiagSink = {
  error(error: unknown, fields: DiagRecord): void;
  warn(fields: DiagRecord): void;
};

export type ClientDiag = {
  report(event: DiagReport): void;
};

type Row = {
  suppressed: number;
  fields: DiagRecord;
};

function browserSink(): DiagSink {
  return {
    error(error, fields) {
      if (error === undefined) console.error(fields);
      else console.error(error, fields);
    },
    warn(fields) {
      console.warn(fields);
    },
  };
}

function sensitive(value: string): boolean {
  if (value.length > MAX_TEXT) return true;
  if (/reconnectToken|ce-arena-token|authorization:\s|bearer\s/i.test(value)) return true;
  if (/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(value)) return true;
  return false;
}

/**
 * Short label safe to print.
 * @post Credentials and long payloads become "omitted".
 */
export function boundLabel(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  if (sensitive(value)) return "omitted";
  return value;
}

function label(value: string | number | undefined): string | number {
  if (value === undefined) return UNKNOWN;
  if (typeof value === "number") return Number.isFinite(value) ? value : UNKNOWN;
  return boundLabel(value) ?? UNKNOWN;
}

export function presentDiag(fields: DiagFields): DiagRecord {
  const sim = fields.simTick;
  return {
    source: fields.source,
    messageType: label(fields.messageType),
    category: label(fields.category),
    reason: label(fields.reason),
    code: label(fields.code),
    connection: label(fields.connection),
    ownedEntity: label(fields.ownedEntity),
    sentInputId: label(fields.sentInputId),
    inputAck: label(fields.inputAck),
    processedInput: label(fields.processedInput),
    snapSeq: label(fields.snapSeq),
    simTick: sim === undefined ? UNKNOWN : String(sim),
  };
}

/** Stack frames only. The original message can quote a frame body, so it is dropped. */
function stripped(error: unknown, message: string): Error {
  const clean = new Error(message);
  if (error instanceof Error && typeof error.stack === "string") {
    const frames = error.stack.split("\n").slice(1, 12).filter((line) => !sensitive(line));
    clean.stack = `${clean.name}: ${clean.message}\n${frames.join("\n")}`;
  }
  return clean;
}

function publicError(error: unknown, source: string): unknown {
  if (source === "parse") return stripped(error, "invalid frame");
  if (typeof error === "string") {
    if (sensitive(error)) return stripped(error, "fault");
    return error;
  }
  if (!(error instanceof Error)) return error;
  if (sensitive(error.message)) return stripped(error, "fault");
  return error;
}

function faultKey(level: string, fields: DiagRecord, error: unknown): string {
  const message = error instanceof Error ? `${error.name}:${error.message}` : typeof error === "string" ? error : "";
  return [
    level,
    String(fields.source),
    String(fields.messageType),
    String(fields.category),
    String(fields.reason),
    String(fields.code),
    message,
  ].join("\0");
}

export function createClientDiag(opts?: {
  sink?: DiagSink;
  maxKeys?: number;
  summaryEvery?: number;
}): ClientDiag {
  const sink = opts?.sink ?? browserSink();
  const maxKeys = opts?.maxKeys ?? MAX_KEYS;
  const summaryEvery = opts?.summaryEvery ?? SUMMARY_EVERY;
  const seen = new Map<string, Row>();

  const summarize = (row: Row) => {
    if (row.suppressed <= 0) return;
    sink.warn({ ...row.fields, suppressed: row.suppressed });
  };

  return {
    report(event) {
      const shown = publicError(event.error, event.fields.source);
      const fields = presentDiag(event.fields);
      const key = faultKey(event.level, fields, shown);
      const row = seen.get(key);
      if (row) {
        row.suppressed += 1;
        row.fields = fields;
        if (row.suppressed % summaryEvery === 0) summarize(row);
        return;
      }
      if (seen.size >= maxKeys) {
        const oldest = seen.keys().next().value;
        if (oldest !== undefined) {
          const evicted = seen.get(oldest);
          seen.delete(oldest);
          if (evicted && evicted.suppressed > 0) summarize(evicted);
        }
      }
      seen.set(key, { suppressed: 0, fields });
      if (event.level === "warn") sink.warn(fields);
      else sink.error(shown, fields);
    },
  };
}

const CONSOLE_HINT = "see console";

/**
 * Gameplay or connection line.
 * @why A fault adds a short hint and never the raw message.
 */
export function presentFaultHud(gameplay: string, hint: boolean): string {
  if (!hint) return gameplay;
  return `${gameplay} · ${CONSOLE_HINT}`;
}

/** One animation-frame failure. The Error object is logged when its message is safe to print. */
export function reportFrameFault(diag: ClientDiag, err: unknown, fields: DiagFields): void {
  diag.report({
    level: "error",
    error: err,
    fields: {
      ...fields,
      source: "frame",
      messageType: fields.messageType ?? "frame",
      category: fields.category ?? "exception",
    },
  });
}
