# Decisions

Design rationale for the comment-as-contract pipeline and the agent-context
architecture around it. Each entry is a decision that is *not* obvious from the
code, with the reasoning that would otherwise be re-litigated every session.

Every agent session reads this once. Do not edit entries to reflect new
choices — add a new entry and mark the old one superseded.

---

## D1 — Comment as contract, with a closed tag vocabulary

Comments carry what types cannot: **why**, **when**, and cross-call invariants.
The vocabulary is closed: `@invariant`, `@pre`, `@post`, `@why`, `@when`,
`@see`, `@internal`. Additions need a consumer; without one, they rot.

**Why:** a comment that restates the signature duplicates information and will
eventually contradict it. A comment that carries *why* or *when* cannot be
derived from the code and is the only place that fact can live. The closed
vocabulary forces the writer to pick a tag whose consumer will use it —
`@invariant` is checked by `test/contract-grep.test.ts`, `@when`/`@why` are
surfaced by the codemap.

**In practice:** do not tag `@param`/`@returns`. Do not convert existing
`/** … */` prose that already reads as `@why`. Tag on touch, never bulk.

---

## D2 — `@invariant` lives on the type, not on bindings that hold instances

The invariant belongs to the declaration that owns the state — the type or the
module-level binding, not every `const` that holds an instance of that type.

**Why:** duplicating the invariant text means two edits for one change, and the
copy will drift. Task 13 produced exactly this: a stale `@invariant` above
`const snapStore = createSnapshotStore()` that named `snapByRequester`/`snapById`,
symbols that no longer existed in that file after the extraction. The gate did
not catch it because it enforces pairing, not accuracy (see D6).

**In practice:** one tag, on the authoritative declaration. A binding that holds
an instance gets no tag. Readers follow the import.

---

## D3 — Pure bookkeeping extraction

When state and lifecycle are entangled, extract the *state* into a module-level
factory that owns no timers, no clocks, no I/O. The caller creates the timer,
passes the handle in, and clears it when the value leaves.

**Why:** a store that owns timers needs fake timers to test, couples to the
runtime, and cannot be exercised by a one-line property check. A store that is
pure data can be tested with real objects and no mocks — `snapshot-store.test.ts`
runs in ~1.5 ms with real `setTimeout` sentinels cleared in `after`. The same
split applies to `RateLimitedLog` (D9): `nowMs` is passed in, so the throttle
test is deterministic and the store has no clock.

**In practice:** if you find yourself reaching for `vi.useFakeTimers()` to test
extracted state, the state is not yet pure.

---

## D4 — One extraction per task

When two siblings share a shape (e.g. `SnapshotStore` and `RateLimitedLog`),
extract them in separate tasks even if the second is "small."

**Why:** combined extractions double the review surface and give the executor
twice the chance to change behavior in a way that passes tests. The second
extraction is cheap once the first pattern exists; combining them saves a task
file and costs a careful review.

**In practice:** the task file names one new module. A second extraction is its
own task with its own fail-first.

---

## D5 — Codemap is gitignored; review via pre-regeneration delta

`agents/codemap.md` is generated, deterministic, and regenerated after every
task. It is not tracked. The reviewer-visible diff is produced by:

    cp agents/codemap.md /tmp/codemap-prev.md
    npm run codemap
    git diff --no-index /tmp/codemap-prev.md agents/codemap.md

**Why:** tracking a regenerated file produces diff noise and merge conflicts
for a file that can be reproduced at any time. But the codemap *is* the
comprehension surface the convention is built around, so the delta needs to be
visible at task boundaries. `--no-index` compares two paths without requiring
either to be tracked, which gives the familiar hunk format with no gitignore
interaction.

**In practice:** the three commands run in this order, once, at the end of the
task, *after* all source edits. Do not wrap them in an npm script yet — a
`codemap:diff` script double-run produces an empty diff that passes trivially.
Run the acceptance step for enough tasks to prove it stable, then script it.

---

## D6 — The invariant gate enforces pairing, not accuracy

`test/contract-grep.test.ts` checks that every `@invariant` names a real test
(`(test: <name>)`) or defers honestly (`(test lands …)`). It does **not** check
that the tag's text matches the code the tag is attached to.

**Why:** text-to-code matching requires an LLM or hand review; pairing is
mechanically decidable and catches the failure that matters most — silent
omission. A stale tag that names a real test will pass the gate (see D2).

**In practice:** review comment diffs for accuracy. The gate is a floor, not a
ceiling.

---

## D7 — Task template has five slots

Every task file carries:

- **Architecture note:** cites the `ARCHITECTURE` paragraph or `@invariant` the
  task implements. If it can't cite one, the task is speculative.
- **Files to touch:** the files table, so codemap scope is bounded.
- **Codemap delta:** entries expected to add, move, or (rarely) remove. "Remove"
  only for symbols that had entries in the prior codemap — verify with `rg`
  before writing.
- **Test-must-fail-first:** for a new invariant, the test that fails on current
  `HEAD`, with the expected failure pasted in the report.
- **Preamble:** standard read-order, memory/skill prohibitions, codemap usage
  rule, Node path export.

**Why:** the five slots are the minimum that lets an executor work without
wandering and a reviewer check without re-reading the whole task. Every
correction made across tasks 10–13 traced to one of these being missing or
being specified loosely.

**In practice:** tasks written by a designer session with source access verify
every symbol and line number with `rg` before writing it in. Tasks written
blind (no source access) carry known line drift — the executor should run the
pre-flight `rg` in the task's Appendix before starting, and stop if it finds
an unexpected reference.

---

## D8 — Designer session (read-only `src/`) vs executor session (r/w)

Two dsh sessions, different workspace scopes, different contexts. The
filesystem is the only communication channel.

**Designer:** reads `src/`, `test/`, `docs/`, `tasks/`, `agents/`; writes
`tasks/proposed/`. Its job is to draft tasks and review reports. It verifies
every symbol and line number against current source before writing it into a
task.

**Executor:** reads one task file, `src/`, `test/`, `agents/`; writes `src/`,
`test/`, `tasks/reports/<task>.md`, and regenerates `agents/codemap.md`. Its
job is to execute one task and paste verbatim output.

**User:** read everything; promote `tasks/proposed/` → `tasks/`; resolve open
questions; update this file.

**Why:** the executor holds a plan and will rationalize against it; the
designer doesn't share that state. Self-graded work is the failure mode the
whole pipeline exists to prevent. Permission asymmetry enforces the split
physically; the report path (`tasks/reports/`) keeps the designer sighted
without giving it write access to source.

**In practice:** if dsh workspace scoping can enforce read-only on `src/` for
the designer, do it. If it cannot, the discipline comes from the prompt — and
the first time it slips, the gate is a wrong `@invariant` that names a real
test (D6).

---

## D9 — `RateLimitedLog` (superseded 2026-11-19 — see the superseding entry at the end)

Same shape as `SnapshotStore`, different semantics. API:

- `shouldLog(clientId: number, nowMs: number): boolean` — returns `true` and
  records `nowMs` if the last recorded value is older than `windowMs` (or
  absent); `false` otherwise.
- `clear(): void`.
- `windowMs` is a constructor argument; default `60_000`.

**Why:** the two deny-log maps (`teleportDeniedAt`, `qaSnapshotDeniedAt`) have
identical throttle semantics and are duplicated. `nowMs` is passed in so the
store has no clock, and the throttle boundary (`firstMs + window - 1` vs
`firstMs + window`) is testable without fake timers.

**In practice:** the two `Date.now()` call sites in `arena-host.ts` become one
`now = Date.now()` per handler, passed to the store. The behavior is identical;
the test surface is throttle, boundary, and clear.
---

## D10 — Host-mediated claim frame for bot cooperation

Two client bots can only coordinate through world effects today (`arbiter.ts`
is single-bot; there is no chat or intent frame). The user chose the
**host-mediated** option: a bot claims a key (its goal id) through the host,
which stamps the owner and expires the claim; the host broadcasts the claim
table to every client.

- **Frame:** client → host `{ v: 1, t: "claim", key, ttlMs }` and
  `{ v: 1, t: "release", key }`; host → all `{ t: "claims", rows }` plus a
  `claims` field in the welcome.
- **Owner:** the pawn entity id (the host maps client → pawn); the bot compares
  `world.self()?.id`. No client id leaks into the protocol.
- **Authority:** the host is the only arbiter. First claim wins; the owner may
  renew; expiry (clamped 5–120 s) and disconnect release; a non-owner's claim is
  ignored. Movement is not blocked — the claim is advisory.
- **Authorization:** the existing `chat` scope (bot and player have it; QA does
  not). No new scope, no token change. A host without the frame simply never
  broadcasts `claims`; the bot proceeds unclaimed.
- **Key:** the mission goal id (`retrieve:key@room`, `reach:place`). Two bots on
  the same order contend; different orders do not. Door/pickup sub-claims are a
  later refinement.
- **Why not a bot-side store:** co-located only, no single arbiter, and the
  host already broadcasts every effect. Why not chat: a claim needs an owner
  and an expiry, not a message log.

The race report (task 37) is the before-measurement; task 38 implements the
claim and tests the after.


## Superseding entry — D9 implemented (2026-11-19)

`RateLimitedLog` is implemented (`src/server/rate-limited-log.ts`); the host uses
it for both deny throttles. D9 is closed. See `agents/host-kb.md` §12/§13.3.
