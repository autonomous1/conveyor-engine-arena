# Command handlers as a bot-client interface — extraction and the bot-developer switch

| | |
|---|---|
| **Question** | How do the nine command handlers in `command-host.ts` become a typed bot-client API, so any bot can command its owned pawn and read status without the test script or a CLI? |
| **Decision it informs** | Two tasks the operator routes: a coder extraction and a bot-developer adoption run — and the boundary between them. |
| **Timebox** | 40 min (spent ~35). |
| **Window** | 2026-11-22 11:16 → 11:55 America/New_York. |
| **Lane** | research only — no `packages/` edit; the proposals are for the designer to promote. |

## Executive summary

The handlers are a self-contained command layer wearing a driver's clothes: **`arm`, `goto`, `stand`, `walk`,
`reload`, `hunt`, `patrol`, `retrieve`, `getkey`** (lines 287–606) plus a `status` projection (113–138) and one
pathing helper, `walkWithRecovery` (241–286). Their whole dependency surface is `session`, `world`, `selfId`, a log
sink, `sleep`, `parseMission`/`runMission`, and a cooperative abort — **no CLI, no fs, no argv**. What keeps them in
`tests/` is not a dependency but the driver's module-scope state: `record()`, `players`, `busy`/`lastResult`, the
trace `let`s (`brainStep`/`replanReason`/`planSteps`), and the `Result` type. Extracting them as
`createCommandHost({ session, log })` with typed `Command`/`CommandResult`/`CommandStatus` gives every bot
`host.dispatch(parseCommand({name:"goto",args:{place:"hall"}}))` and `host.status()` with no CLI in sight, and lets
the bot-developer drive a parity run by importing `parseCommand` + `createCommandHost` instead of running the test
script. Recommendation: **coder task first** (extract + rewire the driver, typed, no CLI), **bot-developer task
second** (new tracked driver `command-parity.ts` imports the interface, runs the nine-command matrix live, records
the report and POCS row).

## 1. Question, decision, timebox

Restated: turn "the commands a live bot can run" into a library call with typed arguments and a typed status, keeping
one runtime behaviour. The two decisions are (a) the API shape — one `dispatch` with a discriminated union, not nine
exported functions; (b) who owns what — the coder owns the module, the bot-developer owns the live adoption and the
evidence. Moot only if no bot outside the test script will ever command a pawn; the request says otherwise.

## 2. Sources

No external sources: the tree is the authority. Local evidence, all line numbers on HEAD 2026-11-22:

| Path | What it gives |
|---|---|
| `packages/bot-client/tests/command-host.ts` | the nine handlers (287–606), `runMissionTask` (303), `walkWithRecovery` (241), `sleep` (239), `buildStatus` (113–138), abort (`AbortMission` 167), registry (596), trace coupling (944–1037) |
| `packages/bot-client/src/{connection,brain,missions,world}.ts` | the session/world surface the handlers use; `runMission` and `parseMission` signatures |
| `src/shared/nav/follow.ts` | `wishTo`, the only `src/` import the command layer needs |
| `agents/bot-task-template.md`, `agents/bot-developer-role.md` | the second task's slots and the `live-*.md` + POCS reporting rule |
| `tsconfig.bot.json`, `package.json` | `src/` is typechecked and in the codemap (`codemap:check --root packages/bot-client/src`); `tests/` is neither |
| `test/scopes.json` | `^bot-` scope, 29/139 today |

## 3. Findings

**F1 — the handlers are CLI-free already.** They close over `session`, `world`, `selfId`, `players`, `record`,
`sleep`, `walkWithRecovery`, `abortTick`/`abortRequested`, `brainStep`/`replanReason`/`planSteps`, `TASK_TIMEOUT_MS`.
No `process`, no `argv`, no fs. The CLI lives in the driver's top 40 lines and the scenario/sampler blocks.
*Label: verified locally.*

**F2 — one helper is part of the command layer.** `walkWithRecovery` (241–286) is a wishTo loop with stuck detection
and a 2.2 m side-step; `stand`, `walk` and `arm` depend on it, and nothing CLI does. It moves with the handlers.
*Label: verified locally.*

**F3 — `status` is a pure projection with a trim rule.** `buildStatus` (113–138) reads `world.self/healthOf/placeOf/
weapon/ammo`, adds `task` and `last`, then drops `pos` and then `last` until `JSON.stringify(body).length <= 256`
(`MAX_TEXT`, :60). The trim order is observable behaviour and must survive the move.
*Label: verified locally.*

**F4 — the trace coupling is the only thing that must be cut, not moved.** The handlers' `runMission` log callbacks
write `brainStep`, `replanReason` and `planSteps` because the driver's 250 ms sampler (944–1037) reads them. A
library must not own a driver's trace: `dispatch(cmd, { onLine })` should hand the raw mission lines back and let
the driver parse them exactly as it does today. Remove the three `let`s from the extracted module.
*Label: verified locally.*

**F5 — cooperative abort is a library concern.** `AbortMission` (167) + `abortRequested` + `abortTick` are passed as
`runMission`'s `onTick`; `runTask` resets the flag per task and maps the throw to `{ok:false,code:4,why:"aborted"}`.
This belongs on the host (`host.abort()`), with `dispatch` owning the reset, so a caller never reaches into the loop.
*Label: verified locally.*

**F6 — argument validation is inline and per-handler.** `goto` requires a non-empty `place`; `stand` requires finite
`x/y/z` and an optional finite `yaw`; `walk` accepts `points` or a single `x/z`; `hunt` requires `minutes` in
[0.5, 10] and `weapon === "laser"`; `patrol` requires ≥2 non-empty places; `retrieve` requires `pickup`; `reload`
takes an optional `crate`; `arm`/`getkey` take nothing. Every failure returns `{ok:false, code:1, why:"bad-args"}`
(or a specific `no-crate`/`no-key`/`not-armed`). A typed `parseCommand` must preserve those `why` strings — the
bot-developer's logs and transcript greps depend on them.
*Label: verified locally.*

**F7 — a second module join point: the mailbox.** The driver also owns the inbox/outbox/status files (see
`agents/research/2026-11-22-bot-mailbox-extraction.md`). The handlers do **not** touch them; the driver does. Extract
the handlers first (this task), the mailbox second — one extraction per task (D4) — and the driver's two rewires stay
small and reviewable.
*Label: verified locally.*

**F8 — `src/` is typechecked and in the codemap; `tests/` is neither.** `tsconfig.bot.json` includes only
`packages/bot-client/src`; `codemap:check` runs with `--root src --root packages/bot-client/src`. Extraction buys
typechecking of the typed args and a codemap entry (`createCommandHost`, `parseCommand`, the types). *Label: verified
locally.*

**F9 — the bot-developer's parity matrix already exists as prose.** The README row (`tests/README.md:50`) lists every
command and its semantics; POCS rows 4, 12, 13 mark the surface "proven". The adoption run does not invent behaviour —
it replays that matrix through the new interface and diffs the evidence. *Label: verified locally.*

**F10 — no CLI means no token in the module.** The token read (`~/.config/ce-arena/qa-token.pem`) and the `args` map
stay in the driver; `createCommandHost` receives a connected `session`. Acceptance can assert this mechanically:
`rg -n "process\.|argv|node:fs|homedir" packages/bot-client/src/commands.ts` returns nothing. *Label: verified
locally.*

## 4. Local measurement

```bash
wc -l packages/bot-client/tests/command-host.ts                         # 1037
rg -n "const (arm|goto|stand|walk|reload|hunt|patrol|retrieve|getkey)Handler" \
  packages/bot-client/tests/command-host.ts                             # 287,334,343,576,374,411,481,532,567
rg -n "brainStep|replanReason|planSteps" packages/bot-client/tests/command-host.ts   # 6 sites: 3 writes in handlers, reads in the sampler
rg -n "include" tsconfig.bot.json                                       # ["packages/bot-client/src"]
node -e "…scopes bot…"                                                  # 29 of 139
```

Footprint: **1 new module (~420 lines moved + ~60 typed surface) + a driver shrink of ~400 lines + 1 test file**.
No host, no kernel, no protocol, no browser bundle (`build-bot.mjs` bundles only `cli.ts`).

## 5. Semantics to preserve (the contract of the move)

| Command | Args today | Success | Failure `why` |
|---|---|---|---|
| `arm` | — | `code 0`, note `already-armed` when armed | `not-armed` |
| `goto` | `place` | `code 0` | `bad-args`, `no-plan:<x>`, `timeout`, `aborted` |
| `stand` | `x,y,z,yaw?` | `{x,z,yaw}` | `bad-args`, `no-self`, `wrong-floor` (>0.75 m in y), `stuck:<x>,<z>`, `aborted` |
| `walk` | `points[]` or `x,z` | `{points}` | `bad-args`, `stuck:<x>,<z>`, `aborted` |
| `reload` | `crate?` | `{ammo,crate}`, note `already-loaded` | `no-crate`, `bad-args`, `no-plan:<x>`, `timeout`, `no-ammo` |
| `hunt` | `minutes?` 0.5–10, `weapon?` `"laser"` | `{minutes,kills,shots,hp}` | `bad-args`, `unsupported-weapon`, `not-armed`, `no-ammo`, `died`, `lost-self`, `no-target` |
| `patrol` | `places[≥2]`, `minutes?` | `{minutes,places}` | `bad-args`, `died`, `no-plan:<x>`, `code:<n>` |
| `retrieve` | `pickup`, `place?` | `{pickup,place}` | `bad-args`, `no-pickup`, `not-picked`, `no-plan:<x>`, `timeout` |
| `getkey` | — | as `retrieve` for the key | `no-key`, `not-picked`, `no-plan:<x>`, `timeout` |
| `status` | `id?` | `CommandStatus` ≤256 chars | — |

The `start` → one `done`/`fail` envelope, the `ms` window, and the transcript row are **driver** behaviour (F4) and
stay in `command-host.ts`.

## 6. Task 1 — coder: extract the command interface

**Architecture note.** Cite `command-host.ts:287-606` (the handlers and registry) and `:113-138` (`buildStatus`). No
decision entry exists for this; the module is a straight extraction with a typed surface, so the architecture note is
the code being moved plus the no-CLI rule (F10).

**Knowledge base.** `agents/bot-developer-role.md` (driver layout, the command surface, POCS) and
`agents/README-dsh.md` (pipeline state). Not `host-model`/`shared-model` — the host state does not change; say so in
the task so the coder does not import host context. Query `shared-model` §13 only if the `CommandStatus` row is added
to a KB (it is not, in this task).

**Files to touch.**

| File | Change |
|---|---|
| `packages/bot-client/src/commands.ts` (new) | types (`Command`, `CommandArgs` union, `CommandResult`, `CommandStatus`, `CommandHost`), `parseCommand`, `createCommandHost`, `walkWithRecovery`, handler bodies moved with `record` → `log`, `sleep` local |
| `packages/bot-client/tests/command-host.ts` | delete the moved bodies; build `host = createCommandHost({session, log: record})`; `runTask` calls `host.dispatch(cmd, {onLine})`; `sendStatus`/`buildStatus` calls become `host.status(id)`; keep CLI, token, mailbox, recorder, samplers, scenario |
| `test/bot-commands.test.ts` (new) | parse, status, registry, unknown-command |
| `packages/bot-client/tests/README.md` | one line: handlers now in `src/commands.ts`; the driver is the mailbox/recorder |

**Codemap delta.** Add `createCommandHost`, `parseCommand`, `Command`, `CommandArgs`, `CommandResult`,
`CommandStatus`, `CommandHost`, `CommandName` under `packages/bot-client/src/commands.ts`. Remove none (the old
handlers were in `tests/`, which is not in the codemap). Run `npm run codemap`.

**Headers and tags.** Four-slot header modelled on `connection.ts`; `@invariant` "one dispatch at a time: a second
`dispatch` while busy rejects with `code:1, why:"busy"`" `(test: dispatch_rejects_while_busy)`; `@why` on the status
trim order (pos, then last, to stay ≤256); `@why` on `abort()` being cooperative (`runMission`'s `onTick` throws);
`@pre` "the session is connected and owns a pawn".

**Test-must-fail-first.** `node --import ./scripts/ts-ext-register.mjs --test test/bot-commands.test.ts` fails on
HEAD with `ERR_MODULE_NOT_FOUND` for `../packages/bot-client/src/commands.ts` (import fail-first — state it is the
weaker kind; the module is new, so no assertion-level failure exists).

**Test scope.** `npm run test:scope bot` → **30/139** (29 today + `bot-commands.test.ts`; `^bot-` already matches).
Then `npm run typecheck` — the point of the move.

**Artifacts.** `plan/dsh-tasks/logs/<nn>-fail-first.log`, `<nn>-tests.log`, `<nn>-typecheck.log`, `<nn>-codemap.diff`.

**Tests.**
1. `parse_command_accepts_every_handler` — one valid example per name, table-driven.
2. `parse_command_preserves_every_bad_args_why` — `goto` no place, `stand` NaN, `walk` empty, `hunt` 0.2/11,
   `patrol` one place, unknown name → the exact `bad-args`/`unknown-command` strings (F6).
3. `status_is_typed_and_trimmed_in_order` — fake world port; 300-char `place` drops `pos` then `last`, length ≤256.
4. `command_names_match_the_registry` — the nine names, no duplicates, `getkey` and `arm` argument-free.
5. `dispatch_rejects_unknown_command_before_touching_the_session` — a host with a minimal port; returns
   `{ok:false,code:1,why:"unknown-task"}` and the port saw no call.
6. `dispatch_rejects_while_busy` — the `@invariant` above.

**Acceptance.** `npm run typecheck`; `npm run test:scope bot` 30/139, 0 fail; standalone run passes; fail-first
verbatim; `rg -n "process\.|argv|node:fs|homedir" packages/bot-client/src/commands.ts` empty; the driver diff is a
move, not a behaviour change — one live `status` + one `goto` before/after in `plan/dsh-tasks/live/` with the same
`outbox` shape; `npm run codemap` + `codemap:check`; `cli.ts` unchanged; `src/shared/bots/goap.ts` untouched.

**Out of scope.** The mailbox extraction (task 2 of the pair, turn-9 report); the `msg` transport; the scenario
runner; the trace samplers; any new command.

## 7. Task 2 — bot-developer: import the interface and switch off the test script

**Question.** Does a bot driven by `createCommandHost` + `parseCommand` from `packages/bot-client/src/commands.ts`
execute the nine-command matrix with the same observable behaviour and status as the pre-extraction script?

**Hypothesis.** The handler logic is unchanged (a move), so the run should reproduce the README matrix row-for-row:
`arm` → `goto` → `stand` → `walk` → `reload` → `hunt` → `patrol` → `retrieve` → `getkey`, with a `status` after each
and identical `why` strings on the deliberate failures (`bad-args`, `wrong-floor`, `no-crate` when the map has none).

**Knowledge base.** `agents/bot-developer-role.md` (the run protocol, POCS, the report shape) and
`agents/host-flow.md` §2 (tick/snapshot cadence) — the run needs no host state model change.

**Setup.** One seat, operator's pawn not targeted, `CE_TOKEN` from env or the qa token file; a new tracked driver
`packages/bot-client/tests/command-parity.ts` that imports `createCommandHost` and `parseCommand` from `../src/commands.ts`
and runs the matrix in order (no mailbox, no CLI flags beyond `--url`); the scenario is data in the test file, not a
separate CLI. Artifacts under `plan/dsh-tasks/logs/`, report under `plan/dsh-tasks/reports/live-<date>-command-parity.md`.

**Instrumentation.** Per command: `start`, `done`/`fail` with `code`, `why`, `ms`, and the `status` fields before and
after; for `walk`/`stand` the final `pos` and `d`; for `hunt` `kills`/`shots`; for `reload` `ammo`/`crate`. The
driver logs one NDJSON row per command in the run.

**Baseline / comparison.** The pre-extraction run of `command-host.ts` on the same map (the README row), plus the
`status` shape and trim behaviour; diff the two NDJSON transcripts by `name` and `why`.

**Evidence.** The run log (`plan/dsh-tasks/logs/<nn>-parity.log`), the NDJSON transcript, and the parity table in the
report; paste the rows, not a summary.

**Report.** `plan/dsh-tasks/reports/live-<date>-command-parity.md` — matrix table, any `why` drift, the seat-cleanup
line, and the POCS row update (row 4 stays `proven`; add the driver path). If a command needs a new handler, that is a
**designer** task, not a live edit.

**Safety and abort.** One long-lived session; clean `close()`; wait for the seat to free before any retry; abort via
`host.abort()` and record where it landed; never target the operator's pawn; if `alien-weapon-1 present=false`, ask
for a fresh map instead of chasing it.

**Out of scope.** Editing `src/` (that is the coder); the mailbox driver; new commands; performance tuning.

## 8. Recommendation

Route **Task 1 to the coder now**, then **Task 2 to the bot-developer** once the module merges. Do the mailbox
extraction (turn-9 report) as a third, independent coder task after Task 1 — it touches the same driver but a
different block, and keeping them separate keeps each diff reviewable (D4).

## 9. Open questions

1. **One module or a folder?** `commands.ts` at ~420 lines is large but flat (the package's style). Split into
   `commands/` when a second driver needs a subset. Default: one module.
2. **`busy` semantics.** Today a second command queues (`pending`) instead of rejecting. The proposal rejects with
   `busy` for the library and lets the driver queue before calling `dispatch`. If the bot-developer needs the old
   queue, keep it in the driver — the two-row behaviour must not drift silently.
3. **`players` snapshot.** Handlers read `world.playerIds()` per dispatch; a long `hunt` holds the set for its
   duration. Keep as-is (same behaviour) and note it; changing it is a separate bug-fix task.
4. **Transcript row ownership.** `statusAfter` is built at task end by the driver via `host.status(id)`; if a future
   reader wants the handler to return it, that is a second task.
