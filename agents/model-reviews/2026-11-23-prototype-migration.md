# Model review — prototype migration (2026-11-23)

## 1. Scope

Read: `plan/dsh-tasks/reports/live-2026-11-23-command-attack-5min.md` (task 154);
the hand-off language in `agents/designer-role.md` (rule 14, "A proven POC is a
task"), `agents/coder-role.md` (read order, Pass 5), `agents/bot-developer-role.md`
(craft rules, journal item 7), and both task templates.

Changed: `agents/designer-role.md`, `agents/coder-role.md`,
`agents/bot-developer-role.md`, `agents/task-template.md`,
`agents/bot-task-template.md`, `agents/decisions.md` (D15); the same rule in
`agent-alley/agents/templates/`.

## 2. Findings

1. **The hand-off lost the prototype's fixes, and the gate could not see it.** The
   brief already said the POC package is the executable spec and "do not re-derive."
   That was not enough: task 154 ran the *product* `arm` handler and it failed live —
   the retrieve walked off the crate at t=10.2 s and the pawn pressed for 25 s,
   ending `not-armed` — while the driver's arm works. The task carried no statement
   that a working prototype existed, no step-by-step mapping, and no live parity
   run; the unit tests passed because they were written against the port. Layer:
   designer/coder briefs, task template. **Fixed: the migration rule.**
2. **The coder's gate is tests; parity is a live run.** The coder cannot connect to
   a host, so a port that diverges from the driver passes the only gate it has. The
   parity run belongs to the bot-developer, running the driver's scenario against
   the product path (the command-host driver over `commands.ts`). The acceptance now
   says so, and the coder's Pass 6 says the migration map is reviewed against the
   driver before the report. Layer: coder brief, task template. **Fixed.**
3. **The POC hand-off required the conclusions, not the analysis.** Journal item 7
   asked for "what production must preserve" — a summary — but not the ordered
   operations, the constants/guards, and the failure each one encodes. That is
   exactly the knowledge a re-derivation drops. Layer: bot-developer brief, bot-task
   template. **Fixed.**

## 3. Edits

Arena:

- `agents/designer-role.md` — a new "A proven POC is a migration" paragraph: the
  `**Rapid prototype solution:**` line, the **Migration analysis**, and the
  **prototype-parity** acceptance; rule 14 now says "analyze the driver operation by
  operation", not "do not re-derive" alone.
- `agents/coder-role.md` — a "prototype-derived task is a migration" paragraph in
  the read order; a Pass 5 bullet ("port it operation-for-operation"); a Pass 6
  instruction to review the migration map against the driver.
- `agents/bot-developer-role.md` — a "the driver is the reference implementation"
  craft rule; the POC hand-off now requires the **migration analysis**.
- `agents/task-template.md` — a `**Rapid prototype solution:**` slot, a
  `### Migration analysis` section (driver step → const/guard → source behaviour),
  and a **Prototype parity** acceptance bullet.
- `agents/bot-task-template.md` — the report's POC hand-off now includes the
  migration analysis.
- `agents/decisions.md` — **D15**, citing task 154.

Package (`agent-alley`): the same six edits in the generic templates
(`designer-role`, `coder-role`, `bot-developer-role`, `task-template`,
`bot-task-template`); `npm run verify` green (31 tests). Needs a 0.1.2 publish.

## 4. Task proposals

None here: the 154 follow-up (make the product `arm` robust — stand on the crate top
after the climb, one re-climb retry, fail fast) is already proposed in the live
report's POC hand-off, for the designer to pick up.

## 5. Open loops

- **No mechanical gate on the rule.** A task that cites a `proven` POC row but has
  no `**Rapid prototype solution:**` line or no `### Migration analysis` still
  passes. A lint over `{{task_dir}}` would be the durable fix — a candidate for the
  tooling lane (`kb-*` lints already read the repo; a `task-prototype` lint could
  check the two sections when the Architecture note names a POC row).
- **The package templates ship only with a publish** (0.1.2).
- The 154 arm fix itself is unlanded; the live report carries the proposal.

## 6. `modev` status

Arena: `modev:check` green (3 lints, 11 tests), `drift` clean, codemap up to date.
Package: `npm run verify` green (31 tests).

**Tooling (same day).** The shared query cache was reviewed and purged before the
next sessions: 344 rows over three days, of which **116 (34%) were test fixtures**
(`symbol plan` ×70, `symbol nope` ×46) because `packages/modev/test/cli.test.mjs`
had no cache override and the CLI hardcoded `.cache`. Ported the isolation the
package already had: `cli.mjs` now honours `MODEV_CACHE` (`CACHE_DIR`), and every
test spawn points at `os.tmpdir()/modev-test-cache`. Verified: the suite passes,
`packages/modev/.cache/` stays empty, and `modev stats` still reports no queries.
Still open (not ported): the CLI's section regex is `(host|client|shared)`, so
`query section bot-kb 13` misses — the package's config-driven version has `bot`.

## 7. Lane inversion — the prototype imported production (D16)

The operator restated the flow: **rapid prototype → production source**.
`command-parity.ts` is meant to be the prototype; `src/commands.ts` is production.
But the driver imports `createCommandHost` (and `command-host.ts` does too), so the
"prototype" was production wearing a driver: every live fix edited reviewed source,
and the unit tests against that same file passed while the arena disagreed. The
prototype lane's speed comes from iterating a file that can be wrong cheaply;
importing production removes exactly that.

**Evidence.** `command-parity.ts` imports `createCommandHost`/`parseCommand` from
`../src/commands.ts`; `command-host.ts` the same; `attack-run.ts` imports
`runMission`; `probe-patrol-freeze.ts` imports `runMission`. Task 157 landed the arm
fix in `brain.ts` + `commands.ts`, with a test that passes on the pre-fix tree.

**Rule (D16).** A prototype imports the plumbing (connect, socket, world, hitscan)
and implements the behaviour under test itself, iterated live with no tests. A
driver that imports the behaviour is a **production probe** (parity): it verifies
the port, its findings are coder tasks, and a row whose script is a probe is a
production-fix task, not a port.

**Edits.** `bot-developer-role` (craft step 1 + "a prototype owns its behaviour");
`bot-kb` §6 (the two driver kinds); `designer-role` ("first check that the driver is
a prototype"); `coder-role` (nothing to port if it imports production);
`task-template` + `bot-task-template` (self-contained requirement); **D16**; the
package templates mirrored (31 tests green).

**Open.** `POCS.md` row 4 is `proven` with script `command-host.ts` — a production
probe, not a prototype. The bot lane should relabel it or produce the real
prototype; 157's test is a regression guard, not a fail-first.

## 8. A task's base tree is part of the contract (D17)

Operator: "the actions.ts fix is still uncommitted, so the task should either be
written against that tree explicitly or the coder should land it first — otherwise
the designer's spec and the coder's HEAD won't match, and the 4/20 passes may
disappear."

**Evidence.** The 161 report's setup table says `HEAD 52f166c + dirty`; the dirty
list includes `M src/shared/bots/actions.ts` (the coder's door-token fix) plus
`connection.ts`, `input.ts` and `test/bot-brain-real-graph.test.ts`. The `4/20`
patrol passes were measured on that tree; on bare `HEAD` the same probe reads 16/20
`no-plan: unsatisfiable`. The fix and its test
(`estimateSeconds_is_finite_at_an_open_door_token` in
`test/bot-brain-real-graph.test.ts`) are both uncommitted and correctly paired, so
they can land as one commit.

**Rule.** Every task carries a **Base tree** line — the commit plus any prerequisite
task or uncommitted paths. A cited number that needs an uncommitted change becomes a
prerequisite task the coder lands first, or is re-taken on `HEAD`. The coder's
Pre-Flight prints the Base tree; a dirty file the task does not name, or a number it
cannot reproduce, is a HALT (D17).

**Edits.** `task-template` (Base tree slot), `designer-role` ("the base tree is part
of the contract"), `coder-role` (Pre-Flight line + two HALT conditions), **D17**; the
package templates mirrored (31 tests green).

**Open.** The `actions.ts` fix should land as its own commit with its paired test
before the patrol spec is written; the spec's Base tree is then plain `HEAD`.
