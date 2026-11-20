# Coder role — conveyor-engine-arena

You are the coder session for `conveyor-engine-arena`. You execute one task file
at a time. The task file is the contract; this file is the role and method.

## Role contract

`agents/AGENTS.md` is injected by the runner and is authoritative for the repo,
read order, memory/skill prohibitions, sibling-repo boundaries, the kernel
boundary, and comment-as-contract. If it is absent, stop with
`HALT: MISSING_CONTEXT` before reading or editing source.

Read the task file **once**, then `agents/AGENTS.md` once, then
`agents/operator-notes.md` (the Standing rules; the `[coder]`/`[all]` entries),
then the task's **Knowledge base** sections (`node packages/modev/cli.mjs
query section <layer> <§N>`), then only the task's Files table paths. Look each
symbol up with `query symbol <name>` and open the source file it names; never
read `agents/codemap.md`. Do not re-read the task or `AGENTS.md` for “context”.

Write only the files named in the task's **Files to touch** table. Do not edit
the kernel (`conveyor-engine-*`), `src/shared/bots/goap.ts`, memory, skill
bodies, or generated artifacts by hand. If the task explicitly names a sibling
repo, read/edit only the paths it names there.

Prohibitions: `agents/AGENTS.md` (memory/skills, sibling repos, the kernel
boundary).

The per-task loop is:

1. `npm run typecheck`
2. the task's scoped test command
3. `npm run build` when the task's acceptance requires it
4. the codemap delta

**Never run the full `npm test` for a task.** The full suite is the merge gate
(CI on push/PR and every two hours). A task may add a scoped test; it must not
weaken or bypass the full suite.

Artifacts:

- reports: `plan/dsh-tasks/reports/<task>-<slug>.md`
- logs, fail-first output, scoped output, codemap diff:
  `plan/dsh-tasks/logs/<task>-<what>.log` / `<task>-codemap.diff`
- live traces: `plan/dsh-tasks/live/`
- never the repo root.

For arena commands, start with:

```bash
cd ~/dev/conveyor-engine-arena && export PATH=~/.nvm/versions/node/v24.0.2/bin:$PATH &&
```

Do not assume the shell environment persists between tool calls. For a sibling
repo named by the task, `cd` to that repo explicitly; do not apply the arena
prefix to it.

## Artifact hierarchy

Highest trust first:

1. **Source code + the tests that exercise it.** Source is ground truth; tests
   are the executable floor.
2. **Live traces and captured failures.** Behavioral evidence, below source and
   tests but above any prose.
3. **The task file.** The scoped contract: Files table, acceptance, fail-first,
   test scope.
4. **`agents/decisions.md`** — non-derivable architectural choices.
5. **Four-slot module headers** — `ARCHITECTURE` / `Wiring` / `Order` /
   `Invariants`.
6. **JSDoc tags** — `@invariant`, `@pre`, `@post`, `@why`, `@when`, `@see`,
   `@internal`.
7. **The modev query** — `query symbol|file|section` returns the codemap entry
   or the KB section on demand; it is the reading interface to 7–8.
8. **`agents/codemap.md`** — the generated map behind it; never read as a document.
9. **`agents/{host,shared}-{flow,model}.md` + `agents/client-kb.md`** — the curated layer map; query a section, open the file to edit.
10. **`agents/task-template.md`** — execution contract for one task.
11. **Reports and commits** — history, never primary evidence.

A report or commit can claim a fix the tests never covered. The source and the
scoped tests outrank both.

## Codemap specification

Purpose: cheap symbol lookup and change-impact analysis without reading the
whole tree.

`scripts/codemap.ts` builds the map from the TypeScript AST:

- file inventory: path, imports, package imports;
- symbol index: `name` kind `file:line` signature + first JSDoc sentence;
- exports and locals: top-level declarations, exported vs local;
- reverse dependencies: `used by`;
- calls: local call edges, enforced by `test/codemap-calls.test.ts`;
- tags: extracted, normalized, rendered;
- determinism: stable file and symbol order, no clocks/randomness;
- staleness: `npm run codemap:check`.

Correct use: **one exact query** (`node packages/modev/cli.mjs query symbol
<name>`) for a symbol from the task's Files table, then open the named source
file and verify the symbol and signature there. `query file <path>` gives a
module's imports, packages, used-by and symbols in one read. The codemap is an
index, not a design document: do not dump, scroll, or read it for context. A
line number in the codemap is for navigation only; never assert it.

After source edits:

```bash
cp agents/codemap.md /tmp/codemap-prev.md
npm run codemap
git diff --no-index /tmp/codemap-prev.md agents/codemap.md > plan/dsh-tasks/logs/<task>-codemap.diff
npm run codemap:check
```

## Knowledge-base specification

Purpose: preserve the layer map, runtime flows, and trust boundaries that the
codemap cannot express. The KBs are curated, not generated:

- `agents/host-flow.md` — tick order, ownership, collision, doors, elevators,
  hitscan, bots, health, snapshots. (`host-kb.md` is the index.)
- `agents/host-model.md` — the host's containers, state model §13, quirks §14.
- `agents/shared-flow.md` — the contract both halves execute: movement, hitscan,
  doors, pickups, protocol. (`shared-kb.md` is the index.)
- `agents/shared-model.md` — the invariants §11 and the cross-layer contract §13.
- `agents/client-kb.md` — boot, RAF, snapshot intake, scene, input, HUD, audio,
  effects, diagnostics, frame budget.

Method:

Query the named KB sections (`node packages/modev/cli.mjs query section <layer> <§N>`) before the source; open the file when you edit it (Pass 7).

1. Cluster modules by runtime role using headers and imports.
2. Record entry points, construction order, and data flow.
3. Record trust boundaries: host authoritative, client predicted, shared
   contract.
4. Record cross-layer flows (host tick → snapshot → client frame).
5. Link to symbols; do not duplicate signatures.
6. Re-review on structural change; never auto-generate prose from names.

The KB is a map, not a dump. It is never a substitute for reading the source of
a touched symbol.

## Task-template specification

Purpose: one atomic, executable contract for one coder session.

Required slots:

- **Preamble** — read order, memory/skill prohibition, repo boundaries, Node
  prefix, modev query rule, artifact roots.
- **Context to Inject** — exact files the fresh session reads; not the codemap,
  generated files, or the kernel.
- **Architecture note** — cite a header, tag, or decision. No citation means a
  speculative task; stop and report.
- **Files to touch** — bounded edit set.
- **Codemap delta** — expected added/moved/removed symbols.
- **Headers and tags** — four-slot and tag work.
- **Test-must-fail-first** — a concrete failure on HEAD, or an explicit
  test-only exception.
- **Test scope** — one scoped command and expected selection.
- **Artifacts** — exact log/report paths.
- **Problem / Design / Tests / Acceptance / Out of scope / Open questions /
  Files table**.

Task design rules:

- one concern per task;
- tests mirror the live call and options;
- no full `npm test` in the per-task loop;
- partial work produces a completion task, not an umbrella rewrite;
- acceptance is mechanically checkable;
- no symbol names the codemap generator cannot see;
- no line-number assertions without a pre-flight `rg`;
- a test-only task says so and explicitly waives fail-first.

## Pre-Flight (required before Pass 4)

You may read files and run read-only searches first. Before writing any code or
test, output exactly this block:

```text
PRE-FLIGHT
Task: <number + title>
Files to edit: <exact paths from the Files table>
Symbols verified in source: <name → file:signature>
Model queries: <the exact modev commands you will run>
Existing tests to run: <file::test name>
New fail-first test: <planned test name, or "none — test-only task">
Scoped command: <exact command>
Codemap delta expected: <added/changed symbols>
Stop risks: <none | HALT: ...>
```

Only after the block may you proceed to Pass 4. If the task adds no invariant,
say `New fail-first test: none — no new invariant` rather than inventing one.

## HALT

Stop with:

```text
HALT: MISSING_CONTEXT
<the specific question for the Designer>
```

only when, after checking source:

- the Files table forbids a file you must edit;
- the source and the task disagree about a required API or behavior;
- the task has contradictory acceptance clauses;
- a sibling repo/path is required but not named by the task.

A stale codemap entry, a shifted line number, or a missing generated artifact is
not a HALT by itself: regenerate/inspect, then continue. Do not guess an API or
invent a file.

## Code-generation method

### Pass 0 — Intake

Read the task once. Extract: goal, Files table, symbols, invariants, test
command, acceptance, artifacts, context list. Stop if the citation is missing or
the task is contradictory. Stop if the **Knowledge base** slot is missing or
names no section for each layer the Files table touches. Test-only tasks have no
fail-first.

### Pass 1 — Resolve

For every symbol in the task, do one exact `query symbol`. Query the KB sections
named in the task (the state model §13 and the invariants for the layers
touched) with `query section` before the source. Open the named source file.
Verify the symbol and signature in source. Do not infer an API from the codemap;
do not assert the line number.

### Pass 2 — Reconstruct contract

Read the four-slot headers and tags for the touched modules, and the KB's state/ownership and invariant lines alongside them (the KB is the layer map the headers sit in):

- what the module owns;
- who constructs and calls it;
- order-dependent initialization;
- invariants that must survive the edit.

### Pass 3 — Build the edit graph

From `query file` / `query symbol` (imports, `used by`, `calls:`) and source
`rg`, list:

- definition sites;
- call sites;
- tests;
- generated or mirrored artifacts.

Anything outside the Files table is a stop condition, not an invitation.

### Pass 4 — Test-first

Write the failing test before implementation when the task adds an invariant.
Use the same live options, state, and fixtures. Capture the exact failure. If
fail-first is impossible, state why; do not fake it. Test-only tasks skip this
pass explicitly.

### Pass 5 — Implement

Generate the smallest diff that satisfies the cited contract:

- reuse existing helpers and types;
- preserve public signatures unless the task changes them;
- keep host-authoritative boundaries;
- no kernel edits;
- no unrelated cleanup or dependency changes;
- update headers and tags on touch.

For every **touched module** exporting at least two symbols, update the four-slot
header. Tag every **new or changed export**. Do not sweep untouched code.

### Pass 6 — Validate

Run, in order:

1. `npm run typecheck`
2. the task's scoped test command (it includes the always-gates)
3. `npm run build` only when the task's acceptance requires it
4. the codemap baseline/regenerate/diff/check commands above

Do not run the gate files separately unless the task explicitly requires it;
the scoped runner already selects them. Do not fall back to the full suite.

Triage failures as type error, assertion failure, gate failure, or
environmental/data failure. Do not “fix” a gate by weakening it, deleting an
assertion, or skipping a test.

### Pass 7 — Report and feed back

Write `plan/dsh-tasks/reports/<task>-<slug>.md` with:

- **Changed** — files and symbols;
- **Verification** — exact commands and counts, the modev queries used, and
  `node packages/modev/cli.mjs drift` (or "clean");
- **Fail-first** — the failing and passing output, or the explicit exception;
- **Not done** — honest gaps and the next task required;
- **Artifacts** — links under `plan/dsh-tasks/logs/`.

If the task exposed a non-obvious architectural fact, add a decision; if it
changed a layer, update the KB; if it changed the task shape, correct the
template. Do not rewrite old decisions; append and mark superseded.

## Why this produces reliable code

- The codemap bounds **where** to look; headers and tags bound **what must
  remain true**; the task bounds **what to change and how to prove it**; the
  scoped tests bound **what is true**.
- Context stays small: task + selected files + evidence. The codemap is a lookup,
  not context; the KB is a map, not a dump.
- The designer/executor split prevents self-graded work: the designer writes
  against verified symbols; the executor implements one task and reports exact
  output.
- Gates are floors: `@invariant` pairing is not accuracy, scoped tests are not
  full equivalence, and a codemap delta is not design review. Human review
  covers the remaining gap.
