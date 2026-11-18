# Task NN — <one-line title, imperative: "Extract X", "Add Y", "Fix Z">

Read `agents/AGENTS.md` first. Then this file. Then `agents/codemap.md` only for symbols in the Files table.

**Do not read memory or skills.** `AGENTS.md` is already injected. Do not re-read `~/.dsh/AGENTS.md` or the project `AGENTS.md`. Do not open `SKILL.md` bodies under `~/.dsh/skills/` or `<repo>/.dsh/skills/` unless this task names the skill. If a memory plugin is installed, do not call `mem_search` / `mem_pack` / `memory_*` and do not read `~/.dsh/memory*`.
**Do not open** `~/dev/conveyor-engine-packages` or `../blueprint-scene` unless the Files table names a path there.
**Codemap:** at most one exact-symbol search from the Files table, then open that source file. Do not scroll or re-open `codemap.md`.

**Repos:** all paths in `./conveyor-engine-arena`. Do not change the kernel. Do not read memory or skill bodies (see above).
**Node:** start shell commands with `cd ~/dev/conveyor-engine-arena && export PATH=~/.nvm/versions/node/v24.0.2/bin:$PATH &&`.
**Artifacts:** logs, fail-first output, scoped test output, and codemap diffs go under `plan/dsh-tasks/logs/` (name `<task>-<what>.log` / `<task>-codemap.diff`); the report goes under `plan/dsh-tasks/reports/`; live traces under `plan/dsh-tasks/live/`. Never write these to the repo root.

**Context to Inject:** <the exact files the user pastes into the coder's fresh context window, together with this task file. One path per line, each with a one-line reason; repo-relative, or absolute for `~/dev/blueprint-scene`. List only the files the coder must read in full: the source under edit, its test file, and the specific report/log/evidence. Do not list `agents/codemap.md` (symbol lookup only, regenerated), generated files (`dist/`, codemap), or the kernel; `agents/AGENTS.md` is injected by the runner, do not list it. Every source/test path here must also appear in the Files table. If the task reproduces an existing failure, list the reproduction script and its log here too.>

> **Changed in vX.Y:** <one sentence: what this task assumes from prior tasks, what it closes, what it defers. Delete the whole line for a clean task with no dependency.>

**Architecture note:** <cite the specific `ARCHITECTURE` paragraph, `@invariant`, or decision entry this task implements. If it can't cite one, the task is speculative — stop and reconsider.>

**Files to touch:** <paths with a one-line purpose each. This bounds the executor's codemap scope; nothing outside this list is in scope.>

**Codemap delta:** <entries to add, move, or remove. "Remove" only for symbols that had entries in the prior codemap — verify with `rg` before writing. Line-number shifts are expected when comments are inserted; the rule is "no signature text changes, no reordering, no removed symbols," not "no `:line` changes.">
**Headers and tags:** for every touched module that exports more than one symbol, update or create its four-slot header (`ARCHITECTURE` / `Wiring` / `Order` / `Invariants`); tag every new or changed export (`@invariant` with `(test: <name>)` or a deferred `(test lands …)`, plus `@pre` / `@post` / `@why` / `@when` / `@see` / `@internal`). See `agents/AGENTS.md` "Comment as contract".

**Test-must-fail-first:** <for a new invariant, the test that fails on current `HEAD`, with the expected failure to paste in the report. For extractions, the import-error fail-first (`ERR_MODULE_NOT_FOUND`) is honest and sufficient — state in the report that it is weaker than an assertion fail-first.>
**Test scope:** <the `npm run test:scope <scopes>` and/or `npm run test:related -- <files>` command; which new/edited test files belong to which scope; the expected `selected N/<total>`. If a new test matches no `test/scopes.json` scope, add the pattern to the manifest as a step. The scoped run is the task loop; the full `npm test` is the merge gate (CI on push/PR and every two hours), not a per-task requirement.>
**Artifacts:** <exact paths under `plan/dsh-tasks/logs/`, e.g. `49-fail-first.log`, `49-tests.log`, `49-codemap.diff`; never the repo root. The report links them.>

### Problem
<What is wrong today, or what does not exist yet. Two to four paragraphs. Name the specific symbols and behaviors involved. If this is a refactor, say what the current shape is and why it does not support what is next.>

### Design

<Numbered steps. Each step names files and symbols. Add an implementation-note subsection only when the shape of the code is not obvious from the prose.>

1. <step>
2. <step>
3. <step>

### Implementation note

<Concrete code the executor can paste and adjust. Full module if new; exact diff blocks if editing. If the scaffold has a bug, the executor fixes it and notes the fix — the scaffold is a starting point, not a spec.>

### Tests

<- **`test/<name>.test.ts`** — new or edited. Real objects where possible, no mocks unless unavoidable.>
<- **Existing tests unchanged** — state which, or "all"; a dropped test is a real bug.>
<- **Test count** — before → after. State the expected delta; a mismatch is investigable.>

### Acceptance (hard gate)

<- `npm run typecheck` passes; the **scoped** run from Test scope passes; **N scoped tests, 0 fail**. The scoped runner builds `dist` only when a selected test imports it; do not run the full `npm test` — it is the merge gate (CI on push/PR and every two hours), not the per-task loop.>
<- Standalone scoped run of the new/edited test file passes; both test names appear in the report.>
<- **Fail-first is demonstrated** — report includes the failing run before the fix and the passing run after, both verbatim.>
<- `npm run codemap:check` passes.>
<- Codemap delta captured via `mkdir -p plan/dsh-tasks/logs && cp agents/codemap.md /tmp/codemap-prev.md && npm run codemap && git diff --no-index /tmp/codemap-prev.md agents/codemap.md > plan/dsh-tasks/logs/<task>-codemap.diff` contains only the expected added lines (and their `:line` shifts). Paste the summary and the log path; the full diff stays in `logs/`.>
<- Every touched module that exports more than one symbol has its four-slot header (new or updated), and every new/changed export carries its JSDoc tags; `test/module-headers.test.ts` and `test/contract-grep.test.ts` pass in the scoped run; the codemap diff shows the header/tag lines and no unexplained comment churn.>
<- `src/shared/bots/goap.ts` unchanged: `git diff src/shared/bots/goap.ts` empty.>
<- No new `Math.random` / `Date.now` in the touched source; existing ones are noted but not removed.>
<- <Any file whose behavior must not change — list specifically.>

### Out of scope

<- Deferred to a named future task, with a one-line reason.>
<- Adjacent refactors that would be tempting.>
<- Behavior changes that would sneak in through the acceptance gate.>

### Open questions

<- Design choices where the default is stated but could reasonably differ. Each entry: question, default, when to reopen.>

### Files (read only these)

| File | Repo | Use |
|---|---|---|
| <path> | conveyor-engine-arena | Edit / Read-only reference / New |
| `agents/codemap.md` | conveyor-engine-arena | Regenerate; symbol lookup only. Do not edit by hand. |
| `src/shared/bots/goap.ts` | conveyor-engine-arena | Read-only reference to confirm it is **not** edited. |

### Appendix: <pre-flight cross-check | fixture | exact diffs>

<If the task edits a file with n scattered references to a symbol, put an `rg` here so the executor verifies the reference set before editing. This is the check that caught task 13's clean extraction — without it, an unexpected extra reference site makes the extraction silently wrong.>

<If the task uses a fixture, put the full fixture here so the executor doesn't have to search for one.>

<If the task replaces specific comment text, put the exact current → new diff here, so the executor doesn't paraphrase.>
