# Model review — the fork restored after a second lane violation (2026-11-26)

## 1. Scope

Read: `git status` after the coder session (staged deletions of
`packages/bot-client/proto/*` and `scripts/probe-tree-hook.mjs`, plus edits to
`src/{brain,combat,commands}.ts`, `probe/{run.mjs,README.md}`,
`scripts/probe-register.mjs`, `tests/combat-goap.ts`).

Changed: nothing in the model; the working tree was restored (see §3).

## 2. Findings

1. **Task 203 was executed as written, against a moving fork.** The coder ported
   the proto delta into `src/` and then retired the fork — deleting all 12
   `proto/` files, `scripts/probe-tree-hook.mjs`, and rewiring
   `probe-register.mjs`/`probe/run.mjs`/`probe/README.md`/`tests/combat-goap.ts`
   to "one tree". The review of the draft (this session, 2026-11-25) had asked for
   a freeze, a split, a live parity run and retirement **last**; the task was
   dispatched before those edits, so the lane lost its workspace. Layer: process
   (I4 class), not the KB.
2. **Nothing unique was lost.** The untracked `proto/` left in the working tree was
   the port copied back: `brain.ts`, `combat.ts`, `commands.ts` were byte-identical
   to `src/`, and the other nine matched `HEAD`. The fork's last good state is
   `HEAD 4a38e7f`.
3. **The switch is a chain, not a file.** Restoring `probe-tree-hook.mjs` alone did
   not restore `--tree proto`: `probe-register.mjs` had been re-pointed at
   `ts-ext-hook.mjs`, and `probe/run.mjs` ignored `--tree`. The four files were
   restored together.

## 3. Restore (verified)

- `git restore --staged packages/bot-client/proto scripts/probe-tree-hook.mjs`;
  removed the untracked port copy; `git restore` both paths from `HEAD` → 12 proto
  files + the hook back.
- `git restore scripts/probe-register.mjs packages/bot-client/probe/run.mjs
  packages/bot-client/probe/README.md packages/bot-client/tests/combat-goap.ts`.
- Smoke: `npm run probe -- --tree proto tree` →
  `tree=proto connection=…/packages/bot-client/proto/connection.ts`, exit 0.
- `git status --short` now shows only the port itself:
  `M src/{brain,combat,commands}.ts` (+~780/−195, uncommitted).

## 4. Task proposals

None. The open decision is the operator's: keep the uncommitted port in `src/` for
review, or revert it and have the designer re-issue 203 against a frozen fork.

## 5. Open loops

- **The port sits uncommitted in `src/`.** Deciding is the operator's; reverting is
  `git restore packages/bot-client/src/{brain,combat,commands}.ts`.
- **Task numbering**: the proposed port is `203`, but the ledger's `203` is the
  `defend` posture POC. Renumber before dispatch.
- **The model wording from the review is still not landed**: the designer role's
  "freeze the fork before drafting", and D18's "retire only after the live parity".
  Until then, the same violation can repeat.
- The restored fork is `HEAD` — it does not include any work the coder may have
  done in `proto/` after the last commit (the untracked copy was the port, not new
  fork work).

## 6. `modev` status

Arena: `modev:check` green (3 lints, 11 tests), `drift` clean.

## 7. The model fix (2026-11-26, operator-directed)

Root cause: the designer drafted 203 against a **moving fork** (a dirty
`proto/commands.ts`) and folded the fork's retirement into the port; the coder
executed it because nothing in its brief stopped a premature retirement. D15's parity
sentence and D18's order existed, but neither had a *freeze* step, a *split* rule, or
a HALT.

Landed:

- `designer-role` — **Freeze the fork before drafting** (draft only against a
  committed fork; a dirty `proto/` is not a spec), **migrate one proven behaviour,
  not the accumulated diff**, **retire the fork last, after the live parity**, and
  **number from the whole pipeline** (the ledger already uses 203 = the `defend`
  posture).
- `coder-role` — the port **does not retire the fork**, and two new HALTs: a dirty
  fork / diff mismatch since the task was written; a task that deletes `proto/` /
  `scripts/probe-tree-hook.mjs` / `--tree` as part of the port.
- `decisions.md` D18 — drafts only from a committed fork; delete only after the live
  parity passes, in a separate commit.
- `agent-alley` templates mirrored (31 tests green).

## 8. The operator owns the sync loop (2026-11-26, clarification — supersedes §7)

The operator clarified the workflow, and it corrects §7's "retire the fork last":

- **Only the operator copies `src/` → `proto/`** (the fork refresh) and **only the
  operator commits and pushes `proto/`** when a solution works.
- **The bot-developer** may modify anything under `packages/bot-client/**` **except
  `src/`**.
- **The coder** modifies `src/` only.
- The loop: bot-developer iterates on `proto/` → the operator commits `proto/` → the
  designer drafts the migration → the coder migrates `proto` → `src/` following the
  coding conventions and **stops** → the operator copies `src/` back over `proto/`.

**Corrected.** Designer: *only the operator publishes the fork* (a dirty `proto/` is
"not published yet — ask the operator"), *the coder migrates and stops; the operator
re-syncs*, and scope to what was published. Coder: `src/` is the only write surface in
a migration, stop at the port; HALTs for a diff mismatch/dirty fork and for any task
that asks to touch the fork, the hook or the tree flag. Bot-developer: the lane is
`packages/bot-client/**` except `src/`; it never edits `src/`; the operator owns the
`src → proto` copy and the proto commit. D18: the fork is **permanent** — nothing is
retired and the switch stays. Package templates mirrored (31 tests green).

**Why §7 was wrong:** "retire last" assumed the fork is a temporary branch. It is the
lane's permanent working copy, refreshed by the operator after every migration. The
203 draft's errors were *retiring it at all* and *drafting from a dirty fork* — not
the ordering.
