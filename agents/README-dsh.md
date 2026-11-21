# Tasks

Task files for the conveyor-engine-arena. Each file is a self-contained spec
consumed by one executor session. The designer drafts into `proposed/`. The user
moves a task to `invoked/` once it has run or is in progress; `invoked/` is the
record of invoked tasks, not a next queue. Done is recorded in `reports/` and
commits. Executor reports land in `reports/`.

Read `agents/decisions.md` before drafting or executing a task.
The coder's task template lives in `agents/task-template.md` (tracked). The bot-developer's live/run template lives in `agents/bot-task-template.md`. Do not duplicate either here.

Logs, fail-first output, scoped test output, and codemap diffs land in `logs/`; reports in
`reports/`; live traces in `live/`. Never write them to the repo root. The task template's
`**Artifacts:**` slot names the exact paths for each task.

---

## State

Tasks 10–14 are the codemap/tag work that produced this file; tasks 15–108 live in
`plan/dsh-tasks/` (`proposed/`, `invoked/`, `reports/`). This table is history, not
the current queue.

| Task | Title | Status | Notes |
|------|-------|--------|-------|
| 10 | Codemap generator extracts JSDoc tags | done | deviated from ts-morph to a `typescript` AST walker; justified |
| 11 | Tag on touch: GOAP bots + arena host | done | 14 tag lines / 8 symbols; 6 acceptance symbols couldn't appear (function-locals). Rule is **module-scoped** in AGENTS.md (header + new/changed exports only). |
| 12 | Enforce `@invariant` → test pairing | done | fail-first demonstrated; gate green |
| 13 | Extract `SnapshotStore` | done | pure bookkeeping; fail-first via `ERR_MODULE_NOT_FOUND` |
| 14 | Extract `RateLimitedLog` | **done** | D9 superseded; module exists |
| — | Four-slot headers across tree | deferred | tag-on-touch carries it |
| — | `sceneGraphHash` test harness | deferred | last remaining `(test lands …)` deferral |

---

## Open loops

- **Stale local tag in `arena-host.ts` — fixed (task 14).** The
  `snapByRequester`/`snapById` tag was removed with the extraction; the type
  carries it (D2).
- **Template corrections from tasks 10–13.** Five accumulated edits, all now
  reflected in `agents/task-template.md`:
  - Contradictions across sections are spec bugs (task 10's `@internal`).
  - Acceptance names only symbols the generator can see (task 11).
  - Line-number churn is expected; the rule is "no signature text changes"
    not "no `:line` changes" (task 11).
  - Codemap "remove" entries only for symbols that had entries (task 13).
  - Task-provided scaffold may have bugs; the executor fixes and notes
    rather than working around (task 12).
- **Test flake under concurrent load.** Task 11 reported one timing-sensitive
  failure in a clean rerun. One occurrence is noise; two-in-a-row across tasks
  is its own task.
- **Gate limitation.** The gate enforces pairing, not accuracy (D6). Worth a
  one-line note in `test/contract-grep.test.ts`'s header.

---

## Test scope

The coder runs a scope, not the full suite, for each task. The manifest is
`test/scopes.json`; the runner is `scripts/test-scope.mjs`.

- `npm run test:scope nav,bot` — the named scopes plus the six `always` gates.
- `npm run test:related -- <changed files>` — scopes from the path map plus
  tests that directly import a changed file, plus the gates. Defaults to the
  working-tree diff.
- Seven scopes: `nav`, `doors`, `bot`, `server`, `client`, `shared`, `meta`.

## Model queries

Symbols and KB sections are queried, not read: `node packages/modev/cli.mjs
query symbol|file|section|entity`, `find`, `drift`, `stats`. `npm run
modev:check` is the gate; `packages/modev/README.md` is the reference. The
read order in `AGENTS.md` is the enforcement point — a session that reads
`agents/codemap.md` as a document is off the contract.

## Logs and artifacts

- `plan/dsh-tasks/logs/` — fail-first runs, scoped test output, codemap diffs (`<task>-<what>.log`, `<task>-codemap.diff`).
- `plan/dsh-tasks/reports/` — the human report; links the logs.
- `plan/dsh-tasks/live/` — live traces, captures, and journals.

Never write any of these to the repo root. The template's `**Artifacts:**` slot carries the
exact paths for each task; a coder that writes a root `.log` or `.diff` has skipped the slot.
  A test may match more than one; the coverage gate (`test/scopes.test.ts`)
  fails a test that matches none, so a new test file needs a scope pattern.
- Full `npm test` is the merge gate and the 2-hour CI run; the scoped command is
  the development loop. Do not weaken the full suite.

---

## What a good task looks like vs. what goes wrong

**Good:** cites a specific `@invariant` or ARCHITECTURE paragraph; the Files
table is bounded and every symbol is verified against current source; the
fail-first is a specific failure against `HEAD`; the acceptance gate is
mechanically checkable and names what *not* to do as precisely as what to do;
the **Test scope** names the scoped command and the tests it selects.

**Common failures** (all seen in tasks 10–13):

- An acceptance clause that names a symbol the generator cannot emit
  (function-locals, `//`-comment headers).
- A design step that contradicts a test step; the executor follows the test,
  which is correct, but the contradiction should not exist.
- A line-number assertion without a pre-flight `rg`, which drifts on the
  next task.
- A local tag that duplicates a type's tag; the copy goes stale.
- "No `:line` changes" as an acceptance clause; inserted comments always
  shift lines below them.

---

## Role split (summary; full rationale in D8)

- **Researcher session:** reads `src/`, `test/`, `packages/`, `agents/` and the
  public web; writes `agents/research/` only; returns a feasibility report that
  ends in a task proposal, a spike, or no action.

- **Designer session:** read-only on `src/`; writes `tasks/proposed/`; verifies
  every symbol and line number with `rg` before writing it into a task.
- **Executor session:** one task file per run; writes `src/`, `test/`,
  `tasks/reports/<task>.md`; regenerates `agents/codemap.md`.
- **User:** promotes `tasks/proposed/` → `tasks/`; resolves open questions;
  updates `agents/decisions.md`.

The filesystem is the only channel. Reports flow one way (executor → user →
designer), tasks flow the other (designer → user → executor).