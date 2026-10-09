/**
 * Host-only fire counters. A client paints the latest frame.
 * It does not count shots of its own.
 *
 * A repeated seq is not a new receive: it increments `droppedDuplicate`
 * and leaves the other five counters alone. A newer seq increments `fired`.
 * `accepted` waits until that seq also clears the cadence window.
 */

export const AUDIT_FIELDS = [
  "fired",
  "accepted",
  "droppedDuplicate",
  "droppedRate",
  "hits",
  "kills",
] as const;

export type AuditField = (typeof AUDIT_FIELDS)[number];

export type AuditCounters = Record<AuditField, number>;

export type AuditFrame = { t: "audit" } & AuditCounters;

export function emptyAudit(): AuditCounters {
  return {
    fired: 0,
    accepted: 0,
    droppedDuplicate: 0,
    droppedRate: 0,
    hits: 0,
    kills: 0,
  };
}

export function auditFrame(counters: AuditCounters): AuditFrame {
  return {
    t: "audit",
    fired: counters.fired,
    accepted: counters.accepted,
    droppedDuplicate: counters.droppedDuplicate,
    droppedRate: counters.droppedRate,
    hits: counters.hits,
    kills: counters.kills,
  };
}

export function parseAudit(frame: unknown): AuditFrame | undefined {
  if (!frame || typeof frame !== "object") return undefined;
  const rec = frame as Record<string, unknown>;
  if (rec.t !== "audit") return undefined;
  const counters = emptyAudit();
  for (const key of AUDIT_FIELDS) {
    const value = rec[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return undefined;
    counters[key] = value;
  }
  return auditFrame(counters);
}

/** Six lines for the options panel. Not the crosshair HUD. */
export function formatAudit(counters: AuditCounters): string {
  return AUDIT_FIELDS.map((key) => `${key} ${counters[key]}`).join("\n");
}

export function createAudit() {
  const counts = emptyAudit();

  function add(key: AuditField): void {
    counts[key] += 1;
  }

  return {
    get counts(): AuditCounters {
      return { ...counts };
    },
    frame(): AuditFrame {
      return auditFrame(counts);
    },
    /**
     * Result of dedupe and cadence. `repeat` is an old seq.
     * `fast` is a new seq still inside the window. `accept` passed both.
     */
    gate(result: "accept" | "repeat" | "fast"): void {
      if (result === "repeat") {
        add("droppedDuplicate");
        return;
      }
      add("fired");
      if (result === "fast") {
        add("droppedRate");
        return;
      }
      add("accepted");
    },
    /** The trace hit another pawn. `killed` means that hit crossed health to 0. */
    pawnHit(killed: boolean): void {
      add("hits");
      if (killed) add("kills");
    },
  };
}

export type Audit = ReturnType<typeof createAudit>;
