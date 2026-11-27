# Model review — the coder's bot-package `src/` surface (2026-11-27)

## 1. Scope

Read: the arena's `git status`/`git log`; `plan/dsh-tasks/reports/212-room-exit-doors.md`;
`proposed/{213-door-side,214-room-exit-proto,215-seat-team}.md`;
`reports/live-2026-11-27-goap-tasks-6.md`; the working `proto/brain.ts` diff; and
`agents/{decisions,designer-role,coder-role,bot-developer-role,task-template}.md`.

Not read: `src/` beyond the diffs, the kernel, sibling repos.

Changed: `agents/decisions.md`, `agents/coder-role.md`, `agents/designer-role.md`,
`agents/task-template.md`, `agents/bot-developer-role.md`. No `src/`, `test/` or
`proto/` edit. `agents/host-model.md` was already dirty with the 206 team row and is
untouched here.

## 2. Findings

1. **The coder's bot-package surface said "`src/` only" and nothing more.**
   `212-room-exit-doors.md` names `packages/bot-client/src/brain.ts` in its Changed
   table next to the shared-planner change; the coder implemented both and the
   operator rejected the set (`215-seat-team.md`, Base tree). The rule it followed is
   true — the coder modifies `src/` only — and insufficient: it reads as a licence to
   *design* in `src/`, not only to *migrate into* it. The bot lane meanwhile is
   building the same door walk in the fork: `proto/brain.ts` is +234/−27 in the
   working tree for `214`. That is the two-copy divergence D18 exists to prevent —
   the next `src → proto` copy deletes the fork work, and the next migration
   overwrites the src work. Layer: decision + role briefs + task template. Action:
   D20 and the edits in §3.

2. **Three documents still retire the fork.** `bot-developer-role.md` said "then
   delete `proto/` (or re-copy…)" and "the fork is deleted in the commit that lands
   the port"; D18's publish paragraph said "`proto/` is deleted". All contradict
   D18's "The fork is **permanent**: only the operator copies … Nothing is retired".
   A bot-developer reading its brief would delete the lane's workspace. Layer: role
   brief + decision. Action: corrected — the operator re-copies `src/` over `proto/`;
   nothing deletes it.

3. **The rejected 212 had a legitimate half.** `src/shared/nav/{legs,path}.ts` is the
   shared contract, coder lane, and `214` itself says "If the POC shows the planner
   must expose the doors to make the walk work, stop and report — that is a coder
   decision." The shared half is a real task waiting on 214's POC; the rerun must not
   bundle the brain wiring with it (D20). Layer: task proposal. Action: §4.

Positive check: the in-flight `215` (team seating) edits `src/server/arena-host.ts`
and `test/` — the right lane for a main-tree defect, which is what the new rule asks
for.

## 3. Edits

| File | Section | Change |
|---|---|---|
| `decisions.md` | new **D20** | `packages/bot-client/src` is migration output; the coder HALTs without a published proto diff; the shared-half split; 212 evidence; no lint yet |
| `decisions.md` | D18, publish paragraph | "`proto/` is deleted" → re-copied, never deleted (corrected 2026-11-26) |
| `coder-role.md` | fork paragraph | outside a migration `packages/bot-client/src/` is not a coder surface; HALT (D20) |
| `coder-role.md` | HALT list | new bullet: bot-package `src/**` path with no **Rapid prototype solution** line |
| `designer-role.md` | after "migrates and stops" | a coder task never designs bot behaviour in `src/`; split the shared half |
| `task-template.md` | **Files to touch** | bot-package `src/**` only with a **Rapid prototype solution** line |
| `bot-developer-role.md` | steps 5–6 and the fork note | the fork is permanent; the operator re-syncs; never deleted |

## 4. Task proposals

**Conditional — the shared-nav door list (only if 214's POC proves it).** Wait for
`214`'s report. If it says the point route cannot name the shut-unlocked doors
without a planner change, draft a coder task:

- **Files to touch:** `src/shared/nav/legs.ts`, `src/shared/nav/path.ts`,
  `test/nav-path.test.ts`, and the one KB section that owns the nav contract. No
  `packages/bot-client/**`.
- **Architecture note:** D20 plus the 214 report. A successful plan carries `doors`
  in route order, only shut-unlocked portals; a locked door still refuses.
- **Acceptance:** the nav suite green plus the closed-door repro (no-portal before,
  ok + doors after). The brain wiring is a **separate bot task in `proto/`** and a
  later migration; this task does not touch it.
- **Out of scope:** `brain.ts`, `proto/`, the bot brain, the live parity run.

If 214 reports the walk works without a planner change, close the loop with no task.

## 5. Open loops

- **agent-alley mirror.** `~/dev/agent-alley/agents/templates/{coder-role,designer-role,task-template}.md`
  are mid-edit (uncommitted, already diverged). Mirror D20's paragraph, the coder
  HALT bullet and the Files-slot rule during the profile pass; do not hand-sync from
  here while that tree is dirty.
- **No mechanical gate yet.** The check reads a task file under gitignored `plan/`,
  which `modev:check` cannot see, so it stays a dispatch/intake read. A tracked
  marker (a task registry, or a lint over a committed task index) would be needed
  before a lint is possible — undefined, not promised.
- **`agents/host-model.md` is dirty** with the 206 team row (`agents` record gains
  `team`) from the prior session; untouched here.

## 6. `modev` status

`npm --prefix packages/modev run verify` → `check` + `self-check` (4 fixtures, one
finding per failure mode) + 11 tests, **all green, exit 0**. `node packages/modev/cli.mjs
drift` → "no drift". No codemap regeneration needed: no `src/` edit, and
`agents/codemap.md` is gitignored and built from `src/`.
