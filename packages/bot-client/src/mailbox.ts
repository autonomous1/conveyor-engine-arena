/**
 * The bot file mailbox: commands in `<dir>/inbox.ndjson`, events out
 * `<dir>/outbox.ndjson`, `status.json`, `transcript.ndjson`, `notes.md`, and
 * the per-session `session.json` roll-up. Node-only.
 */
// ARCHITECTURE: The file mailbox a bot driver reads commands from and writes
//   events, status, a transcript, notes, and a session roll-up to.
// Wiring: driver scripts (command-host.ts) open one mailbox per directory;
//   `sendCommand` is the sending half a relay or tool uses.
// Order: `openMailbox` creates the directory; `poll` runs once per watchdog
//   tick, not per frame.
// Invariants: `poll()` returns a row at most once until the inbox is
//   truncated; a truncated inbox restarts at zero.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Inbox, outbox, and recorder file names inside a mailbox directory. */
const FILES = {
  inbox: "inbox.ndjson",
  outbox: "outbox.ndjson",
  status: "status.json",
  transcript: "transcript.ndjson",
  notes: "notes.md",
  session: "session.json",
} as const;

/** The note text is mailbox-side, so it has no 256 cap; this is its own bound. */
export const NOTE_MAX = 2_000;

const STATUS_INDENT = 1;
/** Notes and status are decimal seconds, rounded to the same 0.1 s the driver logs. */
const TENTHS = 100;

/**
 * Mailbox Files type.
 */
export type MailboxFiles = {
  inbox: string;
  outbox: string;
  status: string;
  transcript: string;
  notes: string;
  session: string;
};

/**
 * Mailbox Options type.
 */
export type MailboxOptions = {
  /** The mailbox directory. `openMailbox` creates it (and its parents). */
  dir: string;
  /** Epoch ms the session started; `status().t` is measured from here. Default now. */
  startedAt?: number;
  /** Clock. Default `Date.now`. */
  now?: () => number;
  /** Start after the rows already in the inbox (a driver ignores an earlier run's commands). Default false. */
  startAtEnd?: boolean;
};

/**
 * Mailbox type.
 */
export type Mailbox = {
  readonly files: MailboxFiles;
  /**
   * New inbox rows since the last call, as raw lines.
   * @invariant Returns a row at most once until the inbox is truncated; a
   *            truncated inbox restarts at zero.
   *            (test: mailbox_polls_only_new_rows_and_restarts_after_truncation)
   */
  poll(): string[];
  /**
   * Append one outbox row.
   * @why Verbatim, no envelope: the two drivers disagree on it (one writes
   *      `{t, at, ...event}`, the other the bare event), so the caller wraps.
   */
  out(row: Record<string, unknown>): void;
  /**
   * Atomically replace `status.json` with `{at, t, ...body}`.
   * @why tmp + rename: a reader must never see half a JSON document.
   */
  status(body: Record<string, unknown>): void;
  /** Append one transcript row as a JSON line. */
  transcript(row: unknown): void;
  /** Append `- <ISO> <text>`, clipped to `NOTE_MAX`. */
  note(text: string): void;
  /** Overwrite the session roll-up with one JSON line. */
  session(roll: unknown): void;
};

/**
 * Open (and create) the mailbox in `dir`.
 * @pre `dir` is a directory path; the module creates it, it need not exist.
 */
export function openMailbox(opts: MailboxOptions): Mailbox {
  const dir = opts.dir;
  mkdirSync(dir, { recursive: true });
  const files: MailboxFiles = {
    inbox: join(dir, FILES.inbox),
    outbox: join(dir, FILES.outbox),
    status: join(dir, FILES.status),
    transcript: join(dir, FILES.transcript),
    notes: join(dir, FILES.notes),
    session: join(dir, FILES.session),
  };
  const now = opts.now ?? (() => Date.now());
  const startedAt = opts.startedAt ?? now();
  /** Non-empty inbox lines. One read per poll; the offset is the length. */
  const readInbox = (): string[] => {
    if (!existsSync(files.inbox)) return [];
    return readFileSync(files.inbox, "utf8").split("\n").filter((line) => line.trim().length > 0);
  };
  let processed = opts.startAtEnd === true ? readInbox().length : 0;
  return {
    files,
    poll() {
      const all = readInbox();
      // A rewritten inbox is shorter than the offset; start over.
      if (all.length < processed) processed = 0;
      const rows = all.slice(processed);
      processed = all.length;
      return rows;
    },
    out(row) {
      appendFileSync(files.outbox, `${JSON.stringify(row)}\n`);
    },
    status(body) {
      const at = now();
      const tmp = `${files.status}.tmp`;
      const row = { at: new Date(at).toISOString(), t: Math.round((at - startedAt) / TENTHS) / 10, ...body };
      writeFileSync(tmp, `${JSON.stringify(row, null, STATUS_INDENT)}\n`);
      renameSync(tmp, files.status);
    },
    transcript(row) {
      appendFileSync(files.transcript, `${JSON.stringify(row)}\n`);
    },
    note(text) {
      const clipped = text.length > NOTE_MAX ? text.slice(0, NOTE_MAX) : text;
      appendFileSync(files.notes, `- ${new Date(now()).toISOString()} ${clipped}\n`);
    },
    session(roll) {
      writeFileSync(files.session, `${JSON.stringify(roll)}\n`);
    },
  };
}

/**
 * Append one command row to `<dir>/inbox.ndjson`, creating the directory.
 * @post A mailbox opened for `dir` with `startAtEnd` unset returns the row.
 */
export function sendCommand(dir: string, row: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, FILES.inbox), `${JSON.stringify(row)}\n`);
}
