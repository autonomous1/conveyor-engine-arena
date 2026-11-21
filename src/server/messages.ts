// ARCHITECTURE: Host-authoritative bot signals: clients post untrusted `msg`
//   frames; the host stamps the sender's pawn and batches the survivors into
//   one `msg` frame per tick.
// Wiring: arena-host.ts creates it beside claimHost, dispatches onFrame, calls
//   tick on the host tick and drops a pawn on close; bot clients post through
//   session.messages.say and read world.messages().
// Order: onFrame only queues; tick is the only place time advances.
// Invariants: `from` is the host's pawn id, never a client field; a row leaves
//   the queue only by tick or drop; seq is per sender and monotonic.
import type { MsgFrame, MsgRow } from "../shared/bot-protocol.js";
import { createRateLimitedLog } from "./rate-limited-log.js";

type Pending = { from: number; to: number; text: string };
/** One client → host `msg` frame. Untrusted: every field is checked. */
type MsgIn = { v?: unknown; t?: unknown; to?: unknown; text?: unknown };

const MAX_TEXT = 256;
const PER_SECOND = 4;
const MAX_PENDING = 64;

/**
 * Host-owned signal queue: gate, caps, per-tick batch, per-sender seq.
 */
export type ArenaMessages = {
  /**
   * Queue one client frame. No clock, no send, no ack.
   * @post A no-chat client, a bad `to`, and empty or over-long text are dropped and counted.
   */
  onFrame(clientId: number, frame: unknown, scope: readonly string[] | undefined, pawnId: number | undefined): void;
  /**
   * Emit at most `perSecond` rows as one frame.
   * @pre Call once per host tick, after frames are dispatched; `now` is that tick's clock.
   */
  tick(now: number): void;
  /** Forget a closed pawn's queued rows and its seq. */
  drop(pawnId: number): void;
  /** Rows sent and rows dropped since construction. */
  stats(): { sent: number; dropped: number };
};

/**
 * Creates Arena Messages.
 * @why One `sendAll` per tick, not per change: claims.ts rebroadcasts the whole
 *      table on each write, which is ~39 KB/s per client at 5 msg/s.
 * @invariant One `seq` per sender, monotonic; a row leaves the queue only by
 *            `tick` or `drop`. (test: msg_batches_and_stamps_the_sender)
 */
export function createArenaMessages(opts: {
  sendAll(frame: MsgFrame): void;
  log?(line: string): void;
  maxText?: number;
  perSecond?: number;
}): ArenaMessages {
  const maxText = opts.maxText ?? MAX_TEXT;
  const perSecond = opts.perSecond ?? PER_SECOND;
  const pending: Pending[] = [];
  const seqBySender = new Map<number, number>();
  const rejected = new Set<number>();
  const warn = createRateLimitedLog(60_000);
  let sent = 0;
  let dropped = 0;
  let windowStart = Number.NEGATIVE_INFINITY;
  let sentInWindow = 0;
  const queuedBy = (from: number): number => {
    let n = 0;
    for (const row of pending) if (row.from === from) n++;
    return n;
  };
  return {
    onFrame(clientId, frame, scope, pawnId) {
      if (pawnId === undefined) return;
      if (!frame || typeof frame !== "object" || Array.isArray(frame)) return;
      const rec = frame as MsgIn;
      if (rec.t !== "msg" || typeof rec.text !== "string") return;
      const text = rec.text.trim();
      const to = rec.to === undefined ? 0 : rec.to;
      if (
        text.length === 0 ||
        text.length > maxText ||
        typeof to !== "number" ||
        !Number.isInteger(to) ||
        to < 0
      ) {
        rejected.add(clientId);
        dropped++;
        return;
      }
      if (scope !== undefined && !scope.includes("chat")) {
        rejected.add(clientId);
        dropped++;
        return;
      }
      if (pending.length >= MAX_PENDING || queuedBy(pawnId) >= perSecond) {
        dropped++;
        return;
      }
      pending.push({ from: pawnId, to, text });
    },
    tick(now) {
      for (const id of rejected) if (warn.shouldLog(id, now)) opts.log?.(`[msg] client ${id} rejected (scope or text)`);
      rejected.clear();
      if (now - windowStart >= 1_000) {
        windowStart = now;
        sentInWindow = 0;
      }
      if (pending.length === 0) return;
      const budget = Math.max(0, perSecond - sentInWindow);
      const rows: MsgRow[] = [];
      while (rows.length < budget && pending.length > 0) {
        const row = pending.shift()!;
        const seq = (seqBySender.get(row.from) ?? 0) + 1;
        seqBySender.set(row.from, seq);
        rows.push({ from: row.from, to: row.to, seq, text: row.text, at: now });
      }
      if (rows.length === 0) return;
      sentInWindow += rows.length;
      sent += rows.length;
      opts.sendAll({ t: "msg", rows });
    },
    drop(pawnId) {
      for (let i = pending.length - 1; i >= 0; i--) if (pending[i]!.from === pawnId) pending.splice(i, 1);
      seqBySender.delete(pawnId);
    },
    stats() {
      return { sent, dropped };
    },
  };
}
