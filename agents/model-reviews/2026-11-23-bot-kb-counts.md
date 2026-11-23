# Model review — bot-kb counts (2026-11-23)

## 1. Scope

Read: `agents/bot-kb.md` in full; `agents/model-developer-role.md`'s **Current
state** block; `packages/bot-client/src/commands.ts` (`CommandName`, `HANDLERS`);
the `packages/bot-client/tests/` listing, its README table, and `POCS.md`.

Changed: `agents/bot-kb.md` §1 and §5; `agents/model-developer-role.md` (the POC
ledger count). No `src/`, no `packages/`.

## 2. Findings

1. **`bot-kb` §5 said "ten typed handlers".** The source has eleven:
   `CommandName` is an 11-member union and `HANDLERS` (`commands.ts`) maps all
   eleven (`arm`, `goto`, `stand`, `path`, `walk`, `reload`, `hunt`, `patrol`,
   `retrieve`, `getkey`, `projectile`). The codemap already said "eleven typed
   handlers", so the KB was the outlier. **Fixed.**
2. **`bot-kb` §1 scale was stale.** Claimed "11 modules, ~4,550 lines; 17 tracked
   drivers". Measured: 11 modules, 4,666 lines; 64 `tests/*.ts` drivers; 8 NDJSON
   scenarios (that one was right). The driver count had drifted by 47 — the lane
   added probes without refreshing the snapshot. **Fixed, re-dated 2026-11-23.**
3. **Two stale handler counts in package files** (not my write surface):
   `packages/bot-client/tests/command-host.ts:2` ("the ten handlers") and
   `packages/bot-client/tests/README.md:53` ("the ten handlers (`projectile`
   included)"). **Reported, not edited** — the bot-developer/coder lane owns
   `packages/`.
4. **Role brief's POC ledger count was stale.** "17 rows, 7 landed"; the ledger is
   now 18 rows, 7 landed. **Fixed.**
5. **Two dated research reports carry older counts**
   (`2026-11-22-squad-commander.md` "ten typed commands",
   `2026-11-22-bot-command-handlers-extraction.md` "the nine handlers"). They are
   dated evidence, not current claims; **left as written** — the KB is the live
   model.

## 3. Edits

- `agents/bot-kb.md:8` — scale snapshot: `~4,550` → `~4.7k` lines, `17` → `64`
  drivers, date `2026-11-22` → `2026-11-23`.
- `agents/bot-kb.md:95` — "ten typed handlers" → "eleven typed handlers".
- `agents/model-developer-role.md:101` — "17 rows" → "18 rows" in the POC ledger
  claim.

## 4. Task proposals

None. The two package comments need a one-line fix by the lane that owns
`packages/`, not a designer task.

## 5. Open loops

- The two stale comments in `packages/bot-client/tests/` (finding 3) — the bot
  lane should fix them when it next touches those files.
- A driver count is a moving target (47 added since the KB's first snapshot).
  Either refresh the scale line at each structural change or state the shape
  ("dozens of tracked drivers") instead of a number; today's entry keeps the
  number, dated.

## 6. `modev` status

`modev:check` green — `kb-count-claims`, `kb-length`, `kb-section-refs` ok,
self-check ok, 11 tests pass; `drift` clean; `codemap:check` up to date.

## 7. Follow-up — drivers stay in git, out of the KB (2026-11-23, operator correction)

The operator's phrasing — "are we tracking drivers? if so, this should not be done.
drivers are rapid prototyping only" — was read as **git** tracking. It was not:
"tracked" meant **tracked in the knowledge base**. The drivers stay in git.

What happened, in order:

1. **Misread.** 64 drivers were `git rm --cached`, `.gitignore` gained the pattern,
   six doc statements were rewritten from "tracked, reviewable" to "local,
   gitignored", D14 recorded the untracking, and the package templates carried the
   same change. Committed as `b141fef` — local only, never pushed.
2. **Corrected.** The operator clarified the reading. The commit was undone with
   `git reset --mixed HEAD~1`; the drivers are tracked again (64), `.gitignore` is
   clean, and the D14-only files were restored from `HEAD`.
3. **The rule that survives.** Drivers are git-tracked; the **KB does not inventory
   them** — no count, no per-driver list. `bot-kb` §1 drops the driver count, §6
   drops the "core drivers" list and points at `POCS.md`, and **D14 was rewritten**
   to that rule with a note recording the misfire.

Package templates were reverted to "tracked, reviewable"; `agent-alley` verify is
green (31 tests). The handler and scale count fixes from the first pass are kept.

