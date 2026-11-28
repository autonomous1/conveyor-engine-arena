# Model review — the incomplete migration and the residual diff (2026-11-28)

## 1. Scope

Read: `git status`/`git log`/`git reflog`; `git diff --no-index` of the two bot trees;
the 219 commits (`2c05dc9`, `016031b`) and the 219 POC row; `agents/{decisions,coder-role,designer-role,task-template,bot-developer-role}.md`;
`packages/bot-client/README.md`; `plan/dsh-tasks/reports/live-2026-11-27-219-pickup-trap.md`.

Changed: `agents/decisions.md` (D21), `agents/coder-role.md`, `agents/designer-role.md`,
`agents/task-template.md`, `packages/bot-client/README.md`. No `src/`, `test/` or
`proto/` edit.

## 2. Findings

1. **The migration map was step-shaped, so an untouched file had no row.** The 219
   migration moved `proto/world.ts` into `src/world.ts` and stopped. The fork also
   carried the team goto-at work — `brain.ts` 626/55, `combat.ts` 193/29,
   `commands.ts` 428/138, `connection.ts` 1/1 — none of it opened, none of it in a
   map that enumerated driver steps. Nothing failed. The operator's `cp -r src proto`
   then overwrote the fork, and the work survived only because the fork commits
   still held it: `git checkout HEAD -- packages/bot-client/proto` restored it.
   Layer: decision + coder role + task template. Action: D21 and the edits in §3.

2. **The published diff was cited but never used as the completion test.** The role
   said "keep the migration map per file" and the designer contract said "one row per
   prototype step"; neither said *finish by diffing the two trees*. There was no
   point at which a file the coder never opened could fail anything. Layer: role
   briefs + template. Action: the **Migration completion** slot and the Pass 6
   residual command.

3. **"Apply" was the wrong verb.** `coder-role` said "apply each hunk to `src/`". The
   prototype is not production — the coder re-expresses it with the four-slot header,
   tags, types, error handling and `.js` imports — so `git apply` must be named as
   forbidden, not implied as the method. Layer: coder role. Action: "checklist, not a
   patch".

4. **The destructive step runs before the evidence is read.** The re-sync is
   `cp -r src/. proto/`; it silently deletes anything un-migrated, and nothing before
   it asks for the residual diff. The completion check belongs in the coder's report,
   which is the last artifact before the operator's copy. Layer: process. Action:
   completion clause in the template; the check is now part of the report.

**Git note (the operator's question).** `git diff` with no arguments compares the
working tree to the **index**; `git checkout HEAD -- <path>` sets both, so a bare
`git diff` is silent even when the two trees differ. `git diff src proto` compares
the trees and was never empty here — at `HEAD` the fork is 5 files and +1282/−236
ahead. The copy was never committed: `proto/`'s history is `56b984a` → `5524a14` →
`2c05dc9`, so HEAD still held the fork and the restore was exact.

## 3. Edits

| File | Section | Change |
|---|---|---|
| `decisions.md` | new **D21** | the diff is the checklist; row per file and hunk; residual-diff completion; `git apply` forbidden; the re-sync is the destructive step |
| `coder-role.md` | fork paragraph | "checklist, not a patch"; map rows per file and hunk; a file with no row is incomplete (D21) |
| `coder-role.md` | Pass 6 | run `git diff --no-index src proto`, paste the residual, justify every remaining hunk before the report |
| `designer-role.md` | POC-derived task | the published diff is the checklist, with a per-file/hunk map and a completion clause |
| `designer-role.md` | scope paragraph | name the other POCs as deferred; 219 as the case |
| `task-template.md` | **Migration analysis** | file/hunk table with a status column; new **Migration completion** slot |
| `packages/bot-client/README.md` | loop step 6 | re-express, never apply; finish with the residual diff; parity, then re-sync |

## 4. Task proposals

**The un-migrated fork work is a ready coder task.** POC row 32 (team goto-at,
213/214/228/230) is `proven`; its diff is committed in `5524a14` and still not in
`src/`. The designer should draft it now with D21's shape:

- **Rapid prototype solution:** `git diff --no-index packages/bot-client/src
  packages/bot-client/proto` at `d192821`, file `logs/<task>-proto.diff`.
- **Migration analysis:** one row per file and hunk for `brain.ts`, `combat.ts`,
  `commands.ts`, `connection.ts` (and `world.ts` only if the 219 `TrapProbe` stays
  deferred).
- **Migration completion:** the residual diff is empty except the `TrapProbe`
  instrumentation in `proto/world.ts` and any hunk the task names deferred.
- **Out of scope:** `probe/`, the drivers, the fork.

## 5. Open loops

- **No mechanical gate.** The residual check is a report artifact, not CI: the fork
  legitimately differs from `src/` between POCs, so a repo-wide lint cannot decide
  what "should" be migrated. A per-task check is the most that fits; it stays manual.
- **agent-alley mirror** still pending (its three template edits are dirty and the
  profile pass owns them): the D21 paragraph, the coder Pass 6 block, the designer
  bullet and the template's **Migration completion** slot.
- `packages/bot-client/README.md` is now committed and updated, so it is the package's
  own account of the loop; the arena `agents/` copies remain the source of truth.

## 6. `modev` status

`npm --prefix packages/modev run verify` → check + self-check (4 fixtures) + 11
tests, green. `node packages/modev/cli.mjs drift` → "no drift". No codemap
regeneration needed (no `src/` edit).
