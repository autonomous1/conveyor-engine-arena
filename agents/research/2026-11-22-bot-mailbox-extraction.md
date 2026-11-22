# Extract the bot mailbox from `command-host.ts` into `packages/bot-client/src`

| | |
|---|---|
| **Question** | How does the file mailbox in `packages/bot-client/tests/command-host.ts` become a first-class bot-client library, so any bot can send or receive commands? |
| **Decision it informs** | The designer's task: what moves, what stays a driver, and what the mailbox API is. |
| **Timebox** | 40 min (spent ~35). |
| **Window** | 2026-11-22 11:04 → 11:40 America/New_York. |
| **Lane** | research only — I did not edit `packages/`; the move belongs to the coder via the designer. |

## Executive summary

`command-host.ts` is **1,037 lines of runnable driver**, not a library: CLI flags, token resolution, `process`
handlers, a command registry (`arm`/`reload`/`hunt`/`patrol`/`goto`/`stand`/`walk`/`status`), a scenario runner, two
trace samplers, and — about **50 lines** of it — the mailbox: `mkdir` at start, `out()` append, `status()` atomic
rewrite, `poll`/`readInbox` with a processed offset, `transcript()` append, `note()` append with a 2,000-char clip,
and the exit-time `session.json` roll-up. Only those ~50 lines are the "mailbox". Moving it to
`packages/bot-client/src/mailbox.ts` buys three things the driver cannot have: **it is typechecked**
(`tsconfig.bot.json` includes only `packages/bot-client/src`), **it enters the codemap** (`npm run codemap:check`
already runs with `--root packages/bot-client/src`), and **any bot can import it** instead of copy-pasting
`live-link.ts`'s near-identical 219-line fork. The driver keeps its CLI, handlers and recorder calls and stays under
`tests/` where tracked bots belong. Recommendation: one extraction task — `openMailbox()` + `sendCommand()`, six unit
tests in `test/bot-mailbox.test.ts`, behaviour of `command-host.ts` byte-identical.

## 1. Question, decision, timebox

Restated: make "a mailbox to send or receive commands" a bot-client capability, not a behaviour of one script. That
means a module that owns the six files and their invariants, a function to deliver a command to a mailbox, and a
driver refactor with no behaviour change. The decision is the module boundary — mailbox vs command registry vs
transport. Moot if only `command-host.ts` will ever need it; `live-link.ts` already proves otherwise.

## 2. Sources

No external sources: this is a local extraction, and the tree is the only authority. Local evidence:

| Path | What it gives |
|---|---|
| `packages/bot-client/tests/command-host.ts` | the implementation to extract (mailbox at `:63-85`, `:189-212`, `:738-800`, `:906-944`) |
| `packages/bot-client/tests/live-link.ts` | the second copy of the same mailbox, with a different outbox envelope (`:25`, `:39-41`, `:61-66`, `:168`) |
| `packages/bot-client/tests/README.md:50`, `POCS.md:17,25,26` | the driver contract and the ledger rows that name it |
| `packages/bot-client/src/{connection,world,input,cli,brain,missions}.ts` | the library it joins; `connection.ts` is the closest module (438 lines, four-slot header) |
| `tsconfig.bot.json` | `include: ["packages/bot-client/src"]` — the reason `tests/` is not typechecked |
| `scripts/build-bot.mjs` | bundles only `src/cli.ts` — the mailbox will not enter the shipped bundle |
| `package.json` scripts | `codemap:check` runs `--root src --root packages/bot-client/src` |
| `test/scopes.json`, `test/placements-file.test.ts` | the test lane (`^bot-`) and a precedent for real tmp dirs |

## 3. Findings

**F1 — the mailbox is ~50 lines inside a 1,037-line driver.** Measured: `:63-85` (dirs, `record`, `out`,
`writeStatus`), `:189-212` (transcript type + append), `:738-748` (`processed`, `readInbox`, init skip),
`:779-790` (notes), `:906-940` (`finish` → `session.json`, log file). Everything else is bot control, CLI or probe
code. *Label: verified locally.*

**F2 — `tests/` is not typechecked; `src/` is.** `tsconfig.bot.json` includes only `packages/bot-client/src`, and
`npm run typecheck` runs it. The mailbox's row shapes (`TranscriptRow`) and optional keys are unchecked today.
*Label: verified locally.*

**F3 — `src/` is in the codemap.** `codemap:check` runs with `--root src --root packages/bot-client/src`, and
`node packages/modev/cli.mjs query file packages/bot-client/src/connection.ts` returns a module entry. So the
extraction produces a codemap delta (new symbols), and AGENTS.md's blanket line "`packages/` is not in the codemap
at all" is **stale for this subtree** — a model note for the model-developer's journal, not an edit here.
*Label: verified locally.*

**F4 — the exact behaviours the extraction must preserve.** From the source:
`out(event)` appends `JSON.stringify(event)` with **no envelope**; `writeStatus(body)` writes
`{at: ISO, t: seconds-since-start, ...body}` to `status.json.tmp` then `renameSync`s it; `readInbox()` returns all
non-empty lines and `processed` starts at the current length (old commands are ignored at startup) and resets to 0
if the file shrank; `transcript(row)` appends one JSON line; `note(text)` appends `- <ISO> <text>` clipped to
`NOTE_MAX = 2000`; `session(roll)` writes `session.json` at exit. *Label: verified locally.*

**F5 — there are two divergent copies.** `live-link.ts:61` writes `{t, at, ...event}` (enveloped) while
`command-host.ts:79` writes the bare event. A library must not silently pick one; the extraction should keep the
mailbox **shape-neutral** (`out(row)` writes the row verbatim) and let each driver wrap. `live-link.ts` migration is
a **separate** task (D4: one extraction per task). *Label: verified locally.*

**F6 — the driver stays a driver.** AGENTS.md requires bot scripts under `packages/bot-client/tests/` (tracked;
`plan/` is gitignored). `command-host.ts` has `process.exit` handlers, `process.argv` flags, a token read from
`~/.config/ce-arena/qa-token.pem`, live-mission side effects and two sampler loops. Moving that into `src/` would put
a `process.exit` in a library and import `homedir()` into a module any bot may bundle. *Label: verified locally.*

**F7 — the transport is a different problem.** `command-host.ts` has **two** ingresses: the file mailbox and a `msg`
row over the arena (`:713-747`). The `msg` path is the pending first-class `msg` frame
(`agents/research/2026-11-21-msg-frame-task.md`), which is not implemented yet. The mailbox is the out-of-band control
plane and must not grow a dependency on the arena transport. *Label: verified locally.*

**F8 — the test lane is ready.** Root `test/*.test.ts` matches `^bot-` in the `bot` scope; `bot` selects **29 of 139**
files today. Tmp-dir tests exist (`placements-file.test.ts`, `qa-snapshot-upload.test.ts`), so a real-filesystem test
needs no mocks. *Label: verified locally.*

**F9 — the bundle is unaffected.** `scripts/build-bot.mjs` bundles only `src/cli.ts` into
`dist/ce-bot.mjs`; a mailbox imported by drivers (and by `cli.ts` only if a future flag needs it) does not enter the
shipped bundle unless `cli.ts` imports it. No browser bundle is involved (`src/` here is Node-only, `platform: "node"`).
*Label: verified locally.*

**F10 — the ledger names the driver, not the mailbox.** `tests/README.md:50` and `POCS.md:17,25,26` describe
`command-host.ts` behaviour and its proven status. Since the extraction changes no behaviour and no CLI, those rows
stay accurate; the only doc change is a line in the README naming the mailbox module. *Label: verified locally.*

## 4. Local measurement

```bash
wc -l packages/bot-client/tests/command-host.ts                      # 1037
rg -n "readFileSync|appendFileSync|writeFileSync|renameSync|mkdirSync|existsSync" \
  packages/bot-client/tests/command-host.ts                          # 13 fs call sites, 9 of them the mailbox
rg -n "include" tsconfig.bot.json                                    # ["packages/bot-client/src"]
node -p "require('./package.json').scripts['codemap:check']"         # --root src --root packages/bot-client/src
node packages/modev/cli.mjs query file packages/bot-client/src/connection.ts   # codemap entry exists
node -e "…scopes bot…"                                               # 29 of 139 test files
rg -n "INBOX|OUTBOX|STATUS" packages/bot-client/tests/live-link.ts   # second copy, enveloped outbox
```

Footprint of the recommended task: **1 new module + 1 driver refactor + 1 test file**, ~150 lines net moved.
No kernel, no host, no protocol, no browser bundle.

## 5. Options

| Option | Verdict | Cost | Risk | What would change it |
|---|---|---|---|---|
| **A. Leave it in `tests/`, import it from `src/`** | **conflicts** with the layout | 0 | `src → tests` imports invert the lane; still untypechecked; still not a library | nothing — this is the wrong direction |
| **B. Extract `src/mailbox.ts` (I/O + recorder files), driver refactored to use it** | **small, recommended** | 1 module (~150 lines), ~40 lines deleted from the driver, 1 test file | low: pure move; behaviour pinned by tests | if the mailbox needs the msg transport too (F7 says no) |
| C. Move the whole `command-host.ts` into `src/` | **conflicts** with the driver rule | large | `process.exit`, CLI flags and a token read in a library; the script stops being reviewable as a tracked driver | if `src/` grew a proper `bin/` for scripts — a bigger design change |
| D. Extract the command registry and handlers too | **medium, premature** | 2 extra modules | handlers call `runMission`, `wishTo` and the live world — that is the driver's job; D4 says one extraction per task | after two drivers share a handler |
| E. Also migrate `live-link.ts`'s copy | **small, follow-up** | 20 lines deleted | touches a live QA driver while it is being used | do it after B lands and a run proves it |

## 6. Recommendation

**One action: a coder task that extracts the mailbox into `packages/bot-client/src/mailbox.ts` and rewires
`command-host.ts`.** Keep the transport, the handlers, the CLI and the probes in the driver. Ship it with six real-
filesystem tests so the file invariants are pinned before `live-link.ts` is migrated in a follow-up.

### Task proposal (designer slots)

**Architecture note.** Cite `command-host.ts:63-85` (dirs, `out`, `writeStatus`), `:189-212` (transcript), `:738-748`
(inbox offset) and `:906-940` (session roll-up) — the four behaviours that move. No decision entry yet; if the
operator accepts the module, add a `decisions.md` entry ("the mailbox is a bot-client library, the driver is a
script") in a follow-up, not in this task.

**Knowledge base.** `agents/bot-developer-role.md` (driver layout and the mailbox contract) and
`agents/README-dsh.md` (pipeline state). `agents/host-model.md` §13 is **not** relevant (no host state changes) — say
so in the task so the coder does not import host context. Query `shared-model` §13 only if the mailbox row shapes
touch `bot-protocol` (they do not).

**Files to touch.**

| File | Change |
|---|---|
| `packages/bot-client/src/mailbox.ts` (new) | `openMailbox({dir, now?})` → `{ files, poll, out, status, transcript, note, session }`; `sendCommand(dir, row)`; the six file-name constants; atomic write helper |
| `packages/bot-client/tests/command-host.ts` | delete the inline fs (`:26` import stays for the token/log reads), replace `out`/`writeStatus`/`readInbox`/`writeTranscript`/notes/`session` with mailbox calls; `processed`/`poll` move into the mailbox; `mkdir` for `logs/` stays here |
| `test/bot-mailbox.test.ts` (new) | the six tests below |
| `packages/bot-client/tests/README.md` | one line in the `command-host.ts` row: mailbox now in `src/mailbox.ts` |

**Codemap delta.** Add `openMailbox`, `sendCommand`, `Mailbox`, `MailboxFiles` (and any exported row type) under
`packages/bot-client/src/mailbox.ts`; `command-host.ts` is under `tests/` and is not in the codemap. Run
`npm run codemap` (not just `codemap:check`).

**Headers and tags.** Four-slot header modelled on `packages/bot-client/src/connection.ts`; `@invariant` "`poll()`
returns a row at most once until the inbox is truncated; a truncated inbox restarts at zero" `(test:
mailbox_polls_only_new_rows_and_restarts_after_truncation)`; `@why` on `out()` writing the row verbatim (the two
drivers disagree on the envelope, F5); `@why` on `status()`'s tmp+rename (a reader must never see half a JSON
document).

**Test-must-fail-first.** `node --import ./scripts/ts-ext-register.mjs --test test/bot-mailbox.test.ts` fails on HEAD
with `ERR_MODULE_NOT_FOUND` for `../packages/bot-client/src/mailbox.ts` — import fail-first, stated as the weaker
kind. A second, assertion-level fail-first is not available (nothing imports the mailbox today).

**Test scope.** `npm run test:scope bot` → **30/139** (29 today + `bot-mailbox.test.ts`; the `^bot-` pattern already
matches, no `test/scopes.json` change). Then `npm run typecheck` (this is what makes the extraction worthwhile — the
new module is in `tsconfig.bot.json`).

**Artifacts.** `plan/dsh-tasks/logs/<nn>-fail-first.log`, `<nn>-tests.log`, `<nn>-codemap.diff`,
`<nn>-typecheck.log`.

**Tests (real files, `mkdtempSync`, no mocks).**
1. `mailbox_creates_the_directory` — `openMailbox` on `tmp/a/b` creates it.
2. `mailbox_polls_only_new_rows_and_restarts_after_truncation` — pre-seed 2 rows → `poll()` `[]`; append 1 →
   `[row]`; `poll()` `[]`; rewrite the file with 1 row → `poll()` `[row]`.
3. `send_command_then_poll_sees_it` — `sendCommand(dir, {cmd:"ping",id:"c1"})` then `poll()` on a mailbox opened for
   `dir` returns that row (the "send or receive" contract).
4. `mailbox_out_writes_rows_verbatim` — `out({type:"ack",id:"c1"})` → one line, parsed equals the object (no envelope).
5. `mailbox_status_is_atomic_and_enveloped` — `status({hp:5})` → `{at, t, hp:5}`, no `status.json.tmp` left.
6. `mailbox_notes_cap_and_session_overwrite` — `note("x".repeat(2500))` → one bullet clipped to 2,000; two
   `session()` calls leave the last roll-up.

**Acceptance.**
- `npm run typecheck` passes (the new module is included by `tsconfig.bot.json`).
- `npm run test:scope bot` passes, 30/139, 0 fail; the standalone run of `test/bot-mailbox.test.ts` passes.
- Fail-first pasted verbatim.
- `git diff` of `command-host.ts` is a pure refactor: the same files are written with the same shapes. Evidence:
  run the driver once against a scratch dir (or `--scenario` over the loopback if the host is available) and diff
  `outbox.ndjson`/`status.json` shape against a pre-refactor run in `plan/dsh-tasks/live/`.
- `npm run codemap` run, `npm run codemap:check` passes, and `node packages/modev/cli.mjs query symbol openMailbox`
  resolves after.
- `packages/bot-client/src/cli.ts` unchanged; `dist/ce-bot.mjs` rebuild is optional (no dependency on the mailbox).

**Out of scope.**
- Migrating `live-link.ts` (follow-up, option E).
- The `msg`/claims transport (`:713-747`) — owned by the pending `msg` frame task.
- The command registry, handlers, scenarios and samplers.
- Any `src/server` or `src/shared` change.

## 7. Open questions

1. **One mailbox per process or per directory?** The driver uses one; a future relay may hold several. The API as
   proposed is per directory — fine. Reopen if a bot needs to watch two mailboxes.
2. **Should `out()` gain an optional envelope?** No: the drivers disagree (F5), so the envelope is the caller's.
   Reopen only if a third driver repeats the same wrapper.
3. **Should the mailbox own the `logs/` directory and the `plan/` conventions?** Not in this task; the driver keeps
   both. If a second driver needs the same log path, extract it with that driver.
4. **Does the mailbox belong in `src/` or `src/io/`?** `src/` is flat (9 modules today); keep it flat.
