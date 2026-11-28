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

## - Model developer role D11
Model developer role: owns the model substrate; writes only agents/** and packages/modev/**; hands code findings to the designer


## Superseding entry — D7 slot count (2026-11-20)

D7 says the task template has **five** slots. The template now carries **nine**
plus the preamble: Context to Inject, Architecture note, Knowledge base, Files
to touch, Codemap delta, Headers and tags, Test-must-fail-first, Test scope,
Artifacts. D7's five are the review *floor* it argued for, not the current file;
the additions came with the tasks 10–14 corrections (the KB slot, tag-on-touch,
the scoped-run split, the artifacts rule, the paste list).

**In practice:** count `agents/task-template.md`, not this file. When a count in
prose disagrees with the file it describes (slots, always-gates, scopes), the
file wins and the prose is a model finding.

## D12 — Host-mediated `msg` signal frame (task 121)

A bot needs to signal a player without a chat log. The frame is host-mediated,
like D10's claims: client → host `{ v: 1, t: "msg", to, text }` (untrusted; the
host stamps `from` with the sender's pawn and never reads a client `from`); the
host queues per sender and emits **at most one `msg` batch per tick** —
`{ t: "msg", rows: [{ from, to, seq, text, at }] }`, `seq` per sender and
monotonic, ≤4 rows/s and ≤64 queued. The welcome carries `messages: true`; the
client keeps a 64-row ring, and `parseMsg` drops rows past `MAX_MSG_ROWS` (64).

- **Scope:** the existing `chat` scope (bot and player have it; QA does not); no
  new scope, no token change.
- **Why one batch per tick, not per write:** claims rebroadcasts the whole table
  on each write (~39 KB/s per client at 5 msg/s); a signal is fire-and-forget, so
  the tick is the cost bound.
- **Why the host stamps the sender:** it is the only arbiter and the only place
  `from` can be trusted.
- **Not a chat:** no persistence, no ordering across senders, no ack. A dropped
  row is counted (`stats().dropped`) and logged; a `msgReject` frame is a
  follow-up, not this design.

## D13 — The prototype lane is pair programming; the coder is not in the inner loop

The first full cycle (2026-11-22: tasks 120–136) validated the two-flow pipeline.
The bot-developer and the operator iterate together on a live bot through the
client interface; the coder joins only once the prototype works repeatedly and
its runs table shows it.

**Why the coder is not in the loop:** every inner iteration would need a task
file, types and tests for a harness that may be thrown away. The cost is far
higher than the iteration's value. The bot-developer's script is the executable
spec; the operator supplies the host, the orders, and the judgment. The coder's
work starts at the formalization boundary: the prototype plus its measurements
become a designer task, and the coder re-expresses the behaviour in `src/` with
headers, tags, and tests.

**What the cycle found:** several production bugs, not just harness bugs — the
open hall leaf froze the follower for 90 s (133), the patrol's first plan did not
fit its budget (134/136), the interior-door wedge and the place-goal gap (128),
and the planner's door-token estimate (131). The prototype lane is therefore also
a discovery lane for the main tree; the coder's task is the audit point where a
prototype's shortcuts are either justified or removed.

**What made the loop cheap:** a persistent command surface (`command-host.ts`,
`live-link.ts`), the host-mediated `msg` frame, and the POC ledger that records
what was proven. **In practice:** a prototype is not merged, it is *read*. The
designer drafts from the script plus the report, the coder productionizes, and
the ledger row moves `proven` → `proposed` → `landed`.

## D14 — Drivers are git-tracked prototypes, not model content (2026-11-23)

The bot lane's scripts under `packages/bot-client/tests/` stay in git — the POCS row
cites the script and a reader can run it — but **the KB does not inventory them**:
no driver count, no per-driver list. The ledger row and the run report are the
durable record; the driver set changes with every probe and is not part of the
model.

**Why:** a count in the KB drifts with each prototype (64 when this was written) and
tells a reader nothing the ledger does not. `tests/README.md` may list the drivers —
it is a driver index, not the model.

**In practice:** `bot-kb` §1 keeps the module/line scale and the scenario count, not
a driver count; §6 says the drivers are prototypes and points at `POCS.md`. Git
tracking is unchanged.

*Corrected the same day:* an earlier revision of this entry untracked the drivers
from git. That read "tracked" as git tracking; the operator meant the KB inventory.
The git change was reverted (`git reset` — it was never pushed) and the rule above
is the one that holds.

## D15 — A prototype hand-off is a migration, verified live (2026-11-23)

A rapid prototype that works live encodes fixes the prose does not: orders, guards
and thresholds discovered in the loop. When the coder re-implements from the task
text, those fixes are silently dropped and the unit tests — written against the
port — still pass. Task 154 is the case: the product `arm` handler passed its tests
and failed live by walking off the crate, while the driver's arm works.

**Why:** the prototype's value is in the details that never make the summary — the
"why" behind each step. A port that re-derives from prose is a second design, not a
migration.

**In practice:** a POC-derived task names the driver in the Architecture note
(`**Rapid prototype solution:**`), carries a **Migration analysis** (driver step →
source behaviour), and its acceptance includes a **prototype-parity** run of the
driver's scenario against the product path by the bot-developer. The coder reports
any divergence (dropped step, changed constant, swapped order) and justifies it;
the live run, not the unit test, is the gate. When the port fails where the driver
works, that divergence is a finding for the designer.

## D16 — A prototype owns its behaviour; a driver that imports production is a probe (2026-11-23)

The rapid-prototype lane exists to find a working behaviour **without** the coder's
unit-test loop. That only holds if the prototype carries its own implementation. A
driver that imports the behaviour under test — `command-parity.ts` importing
`createCommandHost` from `src/commands.ts`, `attack-run.ts` importing `runMission` —
is a **production probe**: it runs production and can only report what production
does. A live "fix" made through it is a production edit in the coder's lane, and the
unit tests written against the same file pass while the arena disagrees.

**Why:** the prototype's value is that it can be wrong cheaply — one file, live,
edited in the loop. Importing production removes exactly that: every iteration edits
reviewed source, and prototype and product can no longer diverge, so there is
nothing to port and nothing to compare.

**In practice:** a prototype imports the plumbing (connect, socket, world, hitscan)
and implements the handler/plan/policy itself; it is iterated live with no tests.
When it works, the designer checks the imports, drafts the migration (D15), the coder
ports it into `src/`, and the driver becomes the parity probe that imports production.
Task 157 is the counter-example: the arm fix landed in `brain.ts` and `commands.ts`,
and its test passed on the pre-fix tree. A row whose script is a production probe is a
**production fix** task, not a port.

## D17 — A task's base tree is part of the contract (2026-11-23)

A measurement is evidence only for the tree it was taken on. The 161 probe ran on
`HEAD 52f166c` **plus** the coder's uncommitted `src/shared/bots/actions.ts`
door-token fix (with the connection/input instrumentation); its `4/20` patrol passes
depend on that fix. A task citing the 4/20 but executed on `HEAD` will read `0/20`,
and that difference is a different tree, not a regression.

**Why:** a spec is a claim about a diff. If the designer's tree and the coder's tree
differ, the fail-first, the acceptance counts and any `proven` ledger row describe
different code. The 161 report already declares "HEAD + dirty" in its setup table;
the task must declare the same.

**In practice:** every task carries a **Base tree** line — the commit, plus any
prerequisite task or uncommitted paths. If a cited measurement needs an uncommitted
change, it is either a prerequisite task the coder lands first, or the number is
re-taken on `HEAD`. The coder's Pre-Flight prints the Base tree; a dirty file the
task does not name, or a number it cannot reproduce, is a HALT.

## D18 — The rapid loop runs on a fork of the package (`proto/`) (2026-11-24)

The operator's procedure: copy `packages/bot-client/src` to
`packages/bot-client/proto`, edit only `proto/`, run the probe against it on the
live host, fix and iterate, then publish the diff to the designer/coder to
integrate back into `src`.

**Why:** the single-file prototype (`commands-prototype.ts`, 73 KB) had to duplicate
the command surface by hand and re-thread every import; a package fork gets every
module, the real import graph and the real types for free. Prototype and production
stay structurally comparable, so the diff is a file-by-file migration spec instead
of a re-derivation.

**In practice:** the probe runner switches trees — `npm run probe -- --tree
src|proto` — and probes keep their canonical `../src/…` imports; a loader hook
redirects them to `proto/…` under `--tree proto` (task 165), so no probe source
names a tree. `proto/` is **tracked** while the branch lives: a POC can run over
several sessions, an untracked fork dies with the working tree, and a tracked fork
lets the designer diff `src` against it at any time. The fork is **permanent**:
only the operator copies `src/` → `proto/` (after a migration lands) and commits and
pushes `proto/` when a solution works; the designer drafts only from that published
state; the coder migrates `proto` → `src/` and stops; the operator copies `src/` back
over `proto/`. Nothing is retired, and the switch stays.
Publish
`git diff --no-index packages/bot-client/src packages/bot-client/proto >
logs/<task>-proto.diff` with the runs table. The designer drafts from the diff, the
coder ports it, the driver switches back to `../src/…` for the parity run, and
`proto/` is re-copied from `src/` for the next POC — never deleted (corrected
2026-11-26: the fork is permanent, nothing is retired). A driver that still imports
`src/` is a production probe, not a prototype (D16).

The harness itself (`command-suite.ts`, its trial table and the prototype surface)
lives in `packages/bot-client/probe/`, tracked; `proto/` is the tracked fork.

`.gitignore` gains `packages/bot-client/proto/` — a repo-root change, so the bot
lane or the operator applies it.

## D19 — The build output is the coder's; the bot lane attaches or uses `--no-build` (2026-11-25)

`npm run build` / `build:server` writes `dist/`, and the coder's scoped tests build
and read the same directory. The bot-developer's suite also starts hosts from
`dist/server`, so it built too — two builds interleaving leave a half-written
`dist/`, and the coder's gate flakes on code nobody changed.

**Why:** `dist/` is one shared artifact with no lock. Whoever writes it last wins,
and a half-written tree is a silent wrong-binary. The lane that owns the code should
own the build.

**In practice:** the bot lane never builds. It attaches to the operator's host
(`--attach`, no build) or runs with `--no-build` against a `dist/` the operator or
the coder just built. A run that needs a build asks the operator, or takes a
worktree. Probes need no build — Node strips types; only the host does. `--shell`
was changed to never build by default (2026-11-25, `--build 1` still forces it);
`--test`/`--suite` still build unless `--no-build`/`--attach`, so those two modes
must opt out.

## D20 — `packages/bot-client/src` is migration output, never a behaviour surface (2026-11-27)

A coder task's Files table names a `packages/bot-client/src/**` path only when the
task cites a published `proto/` diff in its **Rapid prototype solution** line. With
no such diff the task is bot-lane behaviour design in disguise, and the coder HALTs.
A planner, brain or command change is a bot task on `proto/` first. When it also
needs a shared-tree change, the halves split: the `src/shared/**` change is its own
coder task, and the bot wiring follows later as a migration of the proto diff.

**Why:** D18's fork only prevents divergence if `src/` is written by one author per
change. `212` asked for the door list in `src/shared/nav/**` **and** the wiring in
`packages/bot-client/src/brain.ts` as one coder task; both halves were implemented
and rejected, while the proto lane built the same behaviour in `proto/brain.ts`
(`214`). Two copies of one behaviour, one per tree: the next `src → proto` copy
would delete the proto work, and the next migration would overwrite the src work.
The lane table already said the coder modifies `src/` only and the bot-developer
works on `packages/bot-client/**` except `src/`; both are true and both are silent
about what a coder task may *put* in that `src/`.

**In practice:** the designer checks a bot-package path against the
`Rapid prototype solution` line before dispatch, and the coder checks it again at
intake. A shared-contract change is named by the coder task; the bot half waits for
its own proto POC and migration. No lint enforces this yet: the check reads a task
file under the gitignored `plan/`, which `modev:check` cannot see in CI, so it stays
a dispatch/intake read until a lint over the tracked tree exists (open loop in the
model review of 2026-11-27).

## D21 — A migration accounts for the whole published diff, and is never applied as one (2026-11-28)

On a **migration task** the coder's spec is `git diff --no-index
packages/bot-client/src packages/bot-client/proto` at the task's base commit — the
diff itself, not a prose summary of it. Every file and hunk gets one row in the migration map: migrated (and
which source symbol it becomes), or deferred/out-of-scope with the reason. The task
is done only when the residual diff contains nothing but the hunks the task names as
instrumentation or as deferred, and the coder pastes that residual in the report.

The diff is a **checklist, never a patch**: `git apply` is forbidden. The prototype
is not production — each hunk is re-expressed with the four-slot header, tags, types,
error handling, naming and `.js` imports, preserving its order, constants and guards.

**Why:** the 219 migration moved `proto/world.ts` but the fork also carried team
goto-at (`brain.ts`, `combat.ts`, `commands.ts`, `connection.ts`). The task's map was
driver-step shaped, so files the coder never opened had no row, nothing failed, and
the operator's `cp -r src proto` silently deleted the un-migrated work. It survived
only because the fork commits (`5524a14`, `2c05dc9`) still held it, and the operator
restored from them. A map with a row per file and hunk cannot pass an untouched file
unnoticed; a map of steps can.

**In practice:** the designer hands the diff file, the coder's report opens with the
file table, and completion is checked by diffing the two trees after the task — the
residual must equal the named complement. The operator's re-sync is the destructive
step, so the residual is read before it, never after.
