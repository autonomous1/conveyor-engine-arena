# Task NN — Add a first-class `msg` frame for bot-to-bot signals

> **Provenance:** task description prepared by the researcher from
> `agents/research/2026-11-21-bot-messaging-framework.md` §6; the designer promotes it to
> `plan/dsh-tasks/proposed/`, renumbers it, and verifies the symbols at promotion time. The claim table
> (`src/server/claims.ts`) is **not** edited by this task.

Read `agents/AGENTS.md` first. Then this file. Then the KB sections named in **Knowledge base**: `node packages/modev/cli.mjs query section <layer> <§N>` (the map; do not edit it). Then `query symbol <name>` for each symbol in the Files table and open the source file it names — never read `agents/codemap.md`.

**Prohibitions:** `agents/AGENTS.md` (memory/skills, sibling repos).
**Codemap:** at most one exact-symbol search from the Files table, then open that source file. Do not scroll or re-open `codemap.md`.

**Repos:** all paths in `./conveyor-engine-arena`. Do not change the kernel. Do not read memory or skill bodies (see above).
**Node:** start shell commands with `cd ~/dev/conveyor-engine-arena && export PATH=~/.nvm/versions/node/v24.0.2/bin:$PATH &&`.
**Artifacts:** logs, fail-first output, scoped test output, and codemap diffs go under `plan/dsh-tasks/logs/` (name `<task>-<what>.log` / `<task>-codemap.diff`); the report goes under `plan/dsh-tasks/reports/`; live traces under `plan/dsh-tasks/live/`. Never write these to the repo root.

**Context to Inject:**

- `src/server/messages.ts` — new module; the executor writes it in full.
- `src/shared/bot-protocol.ts` — the frame union, `parseArenaFrame`, `parseClaims`, `parseWelcomeExtras`; the new types and parser mirror these.
- `src/server/claims.ts` — read-only model for the host-authored, scope-gated, broadcast frame; **not edited**.
- `src/server/bot-label.ts` — read-only model for a per-tick batched broadcast (the `texts[i] ??=` cache is the pattern to copy).
- `src/server/arena-host.ts` — the four wiring points (construction, dispatch, tick, close) and the welcome block.
- `packages/bot-client/src/connection.ts` — `applyArenaText` dispatch and the `claims` client object; `say` mirrors `acquire`.
- `packages/bot-client/src/world.ts` — the `claims` ring/flag pattern to copy for `messages`.
- `test/claims.test.ts` — the host-module test style (real objects, no mocks, injected `now`).
- `test/bot-protocol.test.ts` — where the parser round-trip test lands.
- `agents/shared-flow.md` — fallback for the wire section (§2); query, do not read whole.

**Architecture note:** implements the researcher finding that allocation stays on the claim table (`src/server/claims.ts:1-3`, D10 "the host is the only arbiter") and adds the missing *signal* half as one host-stamped, batched, append-only frame. The sender identity is a host field, not a client field: `claims.ts` takes `pawnId` from `arena-host.ts:610` and stores it as `owner`; this task does the same for `from`. The batching rule is the `bot-label.ts` pattern (build once per tick, send per client), not the `broadcast(true)`-per-change rule in `claims.ts`.

**Knowledge base:** `agents/host-model.md` §13 (the host state model — the new sub-host row) and `agents/shared-model.md` §13.1 (the wire rows) with §11 (invariant index; the new `@invariant` joins it). `agents/host-flow.md` §10 (snapshot path and per-client delivery) for the `sendAll` shape, and `agents/shared-flow.md` §2 (wire and protocol — the trust boundary the parser enforces). Query the named sections; open a file only if the query fails.

**Files to touch:**

| File | Purpose |
|---|---|
| `src/shared/bot-protocol.ts` | `MsgRow`, `MsgFrame`, `parseMsg`, `parseArenaFrame` branch, `ArenaFrame` union member, `WelcomeExtras.messages` capability flag + its parse |
| `src/server/messages.ts` (new) | `createArenaMessages`: queue, scope gate, caps, per-tick batch, seq, drop |
| `src/server/arena-host.ts` | construct beside `claimHost` (`:301`), dispatch beside `:610`, tick beside `:443`, drop beside `:634`, `welcome.messages = true` beside `:166` |
| `packages/bot-client/src/world.ts` | `msgRows` + `sawMessages`, `messages()`, `applyMessages()`, `messagesSupported()`, welcome flag |
| `packages/bot-client/src/connection.ts` | `messages.say(text, to)` on the session; `applyArenaText` branch |
| `test/messages.test.ts` (new) | host module + protocol + world tests |
| `test/bot-protocol.test.ts` | one round-trip test for `parseMsg` (the assertion fail-first) |
| `test/scopes.json` | add `"^messages"` to the `server` scope (a new test that matches no scope is a manifest step) |

**Codemap delta:** add `createArenaMessages` (`src/server/messages.ts`), `parseMsg` (`src/shared/bot-protocol.ts`), and the types `MsgRow`, `MsgFrame`, `ArenaMessages`. Change no existing signature; `parseArenaFrame` keeps its signature and gains a branch. `packages/bot-client` is not in the codemap — do not expect entries for `say`/`messages`.

**Headers and tags:** `messages.ts` opens with the four-slot header (below). Tag `createArenaMessages` with
`@invariant` — *one `seq` per sender, monotonic; a row leaves the queue only by `tick` or `drop`* `(test: msg_batches_and_stamps_the_sender)` — plus `@pre` on `tick` ("call once per host tick, after dispatch"), and `@why` on the batching rule ("a per-frame `sendAll` is the 40 KB/s rebroadcast; one frame per tick is the fix"). `parseMsg` gets `@post` ("returns `undefined` for a non-`msg` frame; a malformed row is dropped, not fatal"). Update `bot-protocol.ts`'s header only if it exports more than one symbol and the new exports change its description.

**Test-must-fail-first:**

1. Assertion fail-first (state this one in the report): in `test/bot-protocol.test.ts`,
   `assert.deepEqual(parseArenaFrame(JSON.stringify({ t: "msg", rows: [] })), { t: "msg", rows: [] })` fails on
   current `HEAD` because `parseArenaFrame` (`src/shared/bot-protocol.ts:166`) returns `undefined` for `msg`.
2. Import fail-first for the new module: `node --import ./scripts/ts-ext-register.mjs --test test/messages.test.ts`
   fails with `ERR_MODULE_NOT_FOUND` for `../src/server/messages.ts`. This one is weaker; say so.

**Test scope:** `npm run test:scope bot,server` (after adding `"^messages"` to the `server` scope in
`test/scopes.json`) → expect **67/137** files selected (66 today + `messages.test.ts`). Standalone:
`node --import ./scripts/ts-ext-register.mjs --test test/messages.test.ts test/bot-protocol.test.ts`.

**Artifacts:** `plan/dsh-tasks/logs/<task>-fail-first.log`, `<task>-tests.log`, `<task>-codemap.diff`.

---

### Problem

Bots can already allocate work without a message: `createArenaClaims` (`src/server/claims.ts:23`) is host-authoritative,
TTL'd, first-claim-wins, and `claimGoal` (`packages/bot-client/src/brain.ts:116`) makes a bot acquire its goal id before
it plans. What they cannot do is *signal* — "I have the key, take the other door", "I am stuck at `door-1-1-9-22`".
The only carrier today is the claim table itself, prototyped in `packages/bot-client/tests/live-link.ts:8-13`: each
message becomes a claim key `msg:<to>:<stamp36>:<base64url(text)>`. Measured, that carrier costs 185 bytes for one
row and 8,137 bytes for a 50-row table — 40.7 KB/s per client at 5 msg/s — because `claims.ts` rebroadcasts the whole
table on every change (`broadcast(true)`). It also clips text at 80 bytes after a 33 % base64 expansion, loses a
message when two share the same millisecond-stamped key (`claims.ts:74` rejects a second owner), and has no sender
field, sequence, or delivery guarantee.

A silent rejection is the worst failure mode: `createArenaClaims.allowed()` drops a frame from a token without `chat`
and `connection.ts`'s `claims.acquire` is fire-and-forget, so a client that cannot send cannot tell. The QA role's
default scope list has no `chat` (`src/server/auth/tokens.ts:32-37`); the local `qa-token.pem` happens to carry it.

This task adds one frame type, `msg`, that the host stamps, batches once per tick, caps, and delivers to every
client. Allocation stays exactly where it is; nothing in `claims.ts` changes.

### Design

1. **Protocol (`src/shared/bot-protocol.ts`).** Add
   `export type MsgRow = { from: number; to: number; seq: number; text: string; at: number };` (`to: 0` means
   broadcast) and `export type MsgFrame = { t: "msg"; rows: MsgRow[] };`, add `| MsgFrame` to `ArenaFrame`
   (`:127`), and branch `if (t === "msg") return parseMsg(value);` in `parseArenaFrame` (`:166`). `parseMsg` validates
   every row (`from` a positive integer, `to` a non-negative integer, `seq` a positive integer, `at` finite, `text` a
   string), drops bad rows, and caps at 64 rows. Add `messages?: boolean` to `WelcomeExtras` (`:149`, beside
   `claims?` at `:159`) and parse it in `parseWelcomeExtras` (`:373`) as `rec.messages === true ? { messages: true } : {}`.
2. **Host module (`src/server/messages.ts`, new).** `createArenaMessages({ sendAll, log?, maxText?, perSecond?, perTick? })`
   returns `{ onFrame, tick, drop, stats }`. `onFrame` only queues — no clock, no send. `tick(now)` is the only place
   time advances: it resets a one-second window, takes at most `min(perTick, perSecond - sentInWindow)` rows, stamps
   `at: now` and a per-sender `seq`, and emits **one** `sendAll({ t: "msg", rows })` when at least one row survived.
   Scope gate: a client whose scope lacks `chat` is rejected and counted; the warning is emitted at the next `tick`
   through `createRateLimitedLog(60_000)` (`src/server/rate-limited-log.ts:24`) so the module keeps no clock.
3. **Host wiring (`src/server/arena-host.ts`).** Construct `messages` next to `claimHost` (`:301`) using the same
   `sendAll` loop (`encodeFrame(frame)` + `engine.session(clientId)?.socket.send(text)`), dispatch
   `messages.onFrame(clientId, frame, conn.claims?.scope, engine.replicator.get(clientId)?.ownedEntity)` next to
   `:610`, hoist the existing `Date.now()` at `:443` into `const now = Date.now();` and call `messages.tick(now)`
   beside `claimHost.tick(now)`, call `messages.drop(pawnId)` beside `claimHost.drop(pawnId)` at `:634`, and set
   `welcome.messages = true` beside `welcome.claims = claimHost.snapshot()` at `:166`.
4. **Bot model (`packages/bot-client/src/world.ts`).** `const msgRows: MsgRow[] = []` and `let sawMessages = false`
   beside `claimRows`/`sawClaims` (`:212-213`); `applyMessages(rows)` appends and shifts past a 64-row ring;
   `messages()` returns the ring; `messagesSupported()` returns `sawMessages`, set by the welcome flag or the first
   frame. Apply the flag where the welcome is consumed (beside `if (welcome.claims)`).
5. **Bot client (`packages/bot-client/src/connection.ts`).** Add `say(text, to = 0): boolean` to the session object
   beside `claims` (`:126`) — local validation only (socket open, owned pawn, `1 <= text.length <= 256`, integer
   `to >= 0`), then `ws.send(JSON.stringify({ v: 1, t: "msg", to, text }))`. It has **no** ack; the host's `stats()`
   drop counter is the only evidence of a host-side rejection. Add
   `else if (frame.t === "msg") world.applyMessages(frame.rows);` to `applyArenaText` (`:354`).

### Implementation note

```ts
// src/server/messages.ts
// ARCHITECTURE: Host-authoritative bot signals: clients post untrusted `msg`
//   frames; the host stamps the sender's pawn and batches the survivors into
//   one `msg` frame per tick.
// Wiring: arena-host.ts creates it beside claimHost, dispatches onFrame, calls
//   tick on the host tick and drops a pawn on close; bot clients post through
//   connection.say and read world.messages().
// Order: onFrame only queues; tick is the only place time advances.
// Invariants: `from` is the host's pawn id, never a client field; a row leaves
//   the queue only by tick or drop; seq is per sender and monotonic.
import type { MsgFrame, MsgRow } from "../shared/bot-protocol.js";
import { createRateLimitedLog } from "./rate-limited-log.js";

type Pending = { from: number; to: number; text: string };

const MAX_TEXT = 256;
const PER_SECOND = 4;
const PER_TICK = 8;
const MAX_PENDING = 64;

/** Client → host frame. */
type MsgIn = { t?: unknown; to?: unknown; text?: unknown };

export type ArenaMessages = {
  onFrame(clientId: number, frame: unknown, scope: readonly string[] | undefined, pawnId: number | undefined): void;
  tick(now: number): void;
  drop(pawnId: number): void;
  stats(): { sent: number; dropped: number };
};

/**
 * Creates Arena Messages.
 */
export function createArenaMessages(opts: {
  sendAll(frame: MsgFrame): void;
  log?(line: string): void;
  maxText?: number;
  perSecond?: number;
  perTick?: number;
}): ArenaMessages {
  const maxText = opts.maxText ?? MAX_TEXT;
  const perSecond = opts.perSecond ?? PER_SECOND;
  const perTick = opts.perTick ?? PER_TICK;
  const pending: Pending[] = [];
  const seqBySender = new Map<number, number>();
  const rejected = new Set<number>();
  const warn = createRateLimitedLog(60_000);
  let sent = 0;
  let dropped = 0;
  let windowStart = Number.NEGATIVE_INFINITY;
  let sentInWindow = 0;
  const queuedBy = (from: number): number => pending.reduce((n, row) => (row.from === from ? n + 1 : n), 0);
  return {
    onFrame(_clientId, frame, scope, pawnId) {
      if (pawnId === undefined) return;
      if (!frame || typeof frame !== "object" || Array.isArray(frame)) return;
      const rec = frame as MsgIn;
      if (rec.t !== "msg" || typeof rec.text !== "string") return;
      const text = rec.text.trim();
      if (text.length === 0 || text.length > maxText) {
        rejected.add(pawnId);
        dropped++;
        return;
      }
      const to = typeof rec.to === "number" && Number.isInteger(rec.to) && rec.to >= 0 ? rec.to : 0;
      if (scope !== undefined && !scope.includes("chat")) {
        rejected.add(pawnId);
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
      const budget = Math.min(perTick, Math.max(0, perSecond - sentInWindow));
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
```

Protocol additions (`src/shared/bot-protocol.ts`, beside `ClaimsFrame` at `:122` and `parseClaims` at `:198`):

```ts
export type MsgRow = { from: number; to: number; seq: number; text: string; at: number };
export type MsgFrame = { t: "msg"; rows: MsgRow[] };
const MAX_MSG_ROWS = 64;
export function parseMsg(frame: unknown): MsgFrame | undefined {
  if (!frame || typeof frame !== "object" || Array.isArray(frame)) return undefined;
  const rec = frame as Record<string, unknown>;
  if (rec.t !== "msg" || !Array.isArray(rec.rows)) return undefined;
  const rows: MsgRow[] = [];
  for (const value of rec.rows) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    const { from, to, seq, at } = row;
    if (typeof from !== "number" || !Number.isInteger(from) || from <= 0) continue;
    if (typeof to !== "number" || !Number.isInteger(to) || to < 0) continue;
    if (typeof seq !== "number" || !Number.isInteger(seq) || seq <= 0) continue;
    if (typeof at !== "number" || !Number.isFinite(at)) continue;
    if (typeof row.text !== "string") continue;
    rows.push({ from, to, seq, text: row.text, at });
    if (rows.length >= MAX_MSG_ROWS) break;
  }
  return { t: "msg", rows };
}
```

Bot client (`connection.ts`, `say` beside `claims` at `:126`; the session return at `:319` gains `messages`):

```ts
const messages = {
  say(text: string, to = 0): boolean {
    const ws = current;
    const body = text.trim();
    if (!ws || ws.readyState !== 1 || ownedId === undefined) return false;
    if (body.length === 0 || body.length > 256 || !Number.isInteger(to) || to < 0) return false;
    ws.send(JSON.stringify({ v: 1, t: "msg", to, text: body }));
    return true;
  },
};
```

### Tests

- **`test/messages.test.ts`** — new, 7 tests: `msg_batches_and_stamps_the_sender` (two senders, one `tick`, one frame,
  `from` = pawn id, `seq` 1…n per sender, `at` = `now`); `msg_broadcast_and_directed_rows_are_both_sent` (`to: 0` and
  `to: 5` both leave the host — receivers filter); `msg_requires_chat_scope` (play-only frame → no rows, no frame,
  `stats().dropped` increments, the warning is logged once at the next tick); `msg_rejects_long_and_empty_text`;
  `msg_rate_caps_rows_per_second` (6 queued, `perSecond: 4` → 4 sent, 2 dropped; a `tick` inside the same second sends
  nothing; `now + 1_000` resets); `msg_drop_removes_pending_rows_of_a_closed_pawn`; `msg_empty_tick_sends_nothing`.
  Use real objects, an injected `now`, and a `sendAll` collector — the `test/claims.test.ts` style.
- **`test/bot-protocol.test.ts`** — one round-trip test (`parseMsg` keeps good rows, drops a row with `seq: 0`, and
  `parseArenaFrame` returns the frame) plus an unknown-`t` regression assert. 6 tests today → 7.
- **Existing tests unchanged:** `test/claims.test.ts` and `test/bot-client.test.ts` must pass untouched (the claim
  table is not edited; the world gains a method, not a behavior).
- **Test count:** 66 → 67 files in the `bot,server` selection; +8 tests (7 new file + 1 protocol).

### Acceptance (hard gate)

- `npm run typecheck` passes; `npm run test:scope bot,server` passes — **67/137 selected, 0 fail**.
- Standalone `test/messages.test.ts` and `test/bot-protocol.test.ts` pass; both test names appear in the report.
- **Fail-first is demonstrated** — the `parseArenaFrame` assertion failure before the protocol change, and the
  `ERR_MODULE_NOT_FOUND` for `messages.ts` before it exists, both verbatim in the report.
- `npm run codemap:check` passes; the codemap diff contains only `createArenaMessages`, `parseMsg`, `MsgFrame`,
  `MsgRow`, `ArenaMessages` and their `:line` shifts.
- Four-slot header on `messages.ts`; `@invariant` with `(test: msg_batches_and_stamps_the_sender)`; `test/module-headers.test.ts`
  and `test/contract-grep.test.ts` pass in the scoped run.
- `src/server/claims.ts` and `src/shared/bots/goap.ts` are byte-identical: `git diff --exit-code src/server/claims.ts src/shared/bots/goap.ts`.
- No new `Date.now()` / `Math.random()` in touched source; the host reuses the one at `arena-host.ts:443`, and
  `messages.ts` takes `now` as a parameter.
- `welcome.messages === true` in the welcome on a fresh connection (assert in `test/messages.test.ts` or note the
  manual check).

### Out of scope

- `packages/bot-client/src/brain.ts` consuming messages (a follow-up: `say("stuck " + goal.id)` on `giveUp`, and a
  replan on a peer's failure report).
- Sub-claims (door/pickup) and any host-side squad table — D10 defers both.
- Message journaling into the audit counters, persistence, or replay.
- Changing `claims.ts`, its TTLs, or its broadcast rule.

### Open questions

- Body cap 256 chars and 4 msg/s per sender: the defaults in the scaffold. Reopen if live runs need longer text
  (a `reach:place` id plus a coordinate is ~60 chars) or more rate.
- `to: 0` as broadcast is a sentinel; an explicit `"*"` would be clearer but breaks the integer validation and the
  `MsgRow` type. Reopen only with a second consumer.
- Host-side rejection is silent to the sender (no ack). If that bites a live run, the follow-up is a
  `{ t: "msgReject", seq, reason }` frame — not a change to this task.

### Files (read only these)

| File | Repo | Use |
|---|---|---|
| `src/server/messages.ts` | conveyor-engine-arena | New |
| `src/shared/bot-protocol.ts` | conveyor-engine-arena | Edit |
| `src/server/arena-host.ts` | conveyor-engine-arena | Edit (five wiring points) |
| `packages/bot-client/src/world.ts` | conveyor-engine-arena | Edit |
| `packages/bot-client/src/connection.ts` | conveyor-engine-arena | Edit |
| `test/messages.test.ts` | conveyor-engine-arena | New |
| `test/bot-protocol.test.ts` | conveyor-engine-arena | Edit |
| `test/scopes.json` | conveyor-engine-arena | Edit (`^messages` → `server`) |
| `src/server/claims.ts` | conveyor-engine-arena | Read-only reference (must not change) |
| `src/server/bot-label.ts` | conveyor-engine-arena | Read-only reference (the per-tick batch pattern) |
| `src/server/rate-limited-log.ts` | conveyor-engine-arena | Read-only reference (`createRateLimitedLog`) |
| `agents/codemap.md` | conveyor-engine-arena | Regenerate; symbol lookup only. Do not edit by hand. |
| `agents/host-model.md`, `agents/shared-model.md`, `agents/host-flow.md`, `agents/shared-flow.md` | conveyor-engine-arena | Read-only. The §… named in Knowledge base; `*-kb.md` is the split's index page. |
| `src/shared/bots/goap.ts` | conveyor-engine-arena | Read-only reference to confirm it is **not** edited. |

---

## Promotion notes for the designer

- Number: next free task id; log paths become `plan/dsh-tasks/logs/<NN>-*`.
- Verify at promotion: `src/shared/bot-protocol.ts:166` still is `parseArenaFrame`, `:149` `WelcomeExtras`, `:198`
  `parseClaims`; `src/server/arena-host.ts:301` (claims construction), `:443` (tick), `:610` (dispatch), `:634`
  (drop), `:166` (welcome claims); `test/scopes.json` `server` scope line. The task's pre-flight `rg` is in the
  evidence table of `agents/research/2026-11-21-bot-messaging-framework.md` §4.
- The KB slot names four sections; the designer may trim to `host-model` §13 and `shared-model` §13.1 if the coder's
  window is tight — the other two are flow context.
- Alternative if the designer wants a smaller first step: ship only steps 1–2 (protocol + host module) and defer the
  bot-lane API. That halves the files table but leaves the frame unconsumed; not recommended.
