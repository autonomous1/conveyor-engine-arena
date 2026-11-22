# Model review — current-state reconciliation (2026-11-20)

## 1. Scope

**Read** (this session): `agents/AGENTS.md`, `agents/model-developer-role.md`,
`agents/operator-notes.md`, `agents/decisions.md` (all), `agents/README-dsh.md`,
the three KBs in full (`host-kb`, `shared-kb`, `client-kb`), `agents/task-template.md`,
`test/kb-symbols.test.ts`, `agents/designer-role.md` (the slot and gate
sentences via `rg`), `test/scopes.json` (all), `.github/workflows/ci.yml`,
`plan/dsh-tasks/reports/104-…`, `105-…`, and `plan/dsh-tasks/handoff.md`.
Source opened only to verify a KB claim: `src/server/game.ts`
(`noteArenaInterest` and its call site in the tick), `src/shared/bots/goap.ts`
(header, imports), `packages/bot-client/src/brain.ts` (the import lines), and
`ls test/<name>.test.ts` for the nine tests named in `shared-kb` §13.6.

**Changed** (`agents/` only): `host-kb.md`, `shared-kb.md`, `client-kb.md`,
`README-dsh.md`, `decisions.md`, `model-developer-role.md`. No `src/`, `test/`,
`packages/`, or `agents/codemap.md` edit.

**Tree:** `c7669eb` plus the operator's uncommitted `AGENTS.md`/`decisions.md`
D11 lines (not mine). Node `v24.0.2` for every command.

**Baseline measurement (the 78% rule).**

| KB | lines | bytes | §13 starts at | §11 starts at |
|---|---:|---:|---:|---:|
| `host-kb.md` | 444 | 25,973 | 244 (55%) | 195 (44%) |
| `shared-kb.md` | 340 | 22,359 | 207 (61%) | 167 (49%) |
| `client-kb.md` | 306 | 19,029 | 179 (58%) | 163 (53%) |

A full `read` of each returned the whole file; the 2,000-line default is not
reached (444 = 22%). The brief's claim "host and shared pass, client does not"
is exactly consistent with a read window of **W ∈ [392, 436) lines**
(`0.78W < 444`, `0.78W < 340`, `0.78W ≥ 306`). No window definition exists in
the repo. That number is the open question in §5, F1.

## 2. Findings

**F1 — The split premise is unverified; the cost side is large.**
(a) *Claim:* "`host-kb.md` and `shared-kb.md` both pass the window; their §13 is
in the tail. Split into `-flow`/`-model`."
(b) *Evidence:* the table above. No truncation at the measured 2,000-line read
default; §13 starts at 55–61% of each file, and under a ~400-line window host
§13 would run from 61% to 90% of it — the tail the brief means. A split moves
≈250 filename occurrences (84 in `agents/`, 168 under `plan/dsh-tasks/`),
including the `invoked/` task records that AGENTS' "KB missing → stop" rule
would then reject.
(c) *Layer:* KB structure.
(d) *Action:* recorded as the open decision in the role brief's Current state,
with the W ∈ [392, 436) inference. **No edit until the operator states the
window.** This is the one finding this session cannot close on evidence.

**F2 — Always-gate count.** (a) *Claim:* designer says six, `README-dsh.md` says
five. (b) *Evidence:* `test/scopes.json` `always` = contract-grep,
module-headers, codemap-tags, codemap-calls, manifest-data, jsdoc-exports (6);
`designer-role.md` rule 2 lists the same six; `README-dsh.md:59` said "five".
(c) *Layer:* role/README. (d) *Action:* README corrected to six.

**F3 — Trailing fragments.** (a) *Claim:* `host-kb §2` `(called)`, plus "the
local sketch" in host §15 / client §14. (b) *Evidence:* `rg` found three:
`host-kb:47` `(game.ts, called)`; `client-kb:293` `kernel-independent;)`;
`shared-kb:27` `kernel-independent; the local sketch`. The brief mislocated the
sketch phrase — host §15 was clean. (c) *Layer:* KB prose. (d) *Action:* all
three edited; the host fragment now carries the verified timing ("called each
tick after the owned set", `game.ts` tick at `noteArenaInterest(server)`).

**F4 — `goap.ts` import vs copy.** (a) *Claim:* the brief reports that shared §1
says the bot "copies verbatim" while host §15/client §14 say "import", and
asserts "copied verbatim" is the truth. (b) *Evidence:* `packages/bot-client/src/brain.ts` has
`import { chooseGoal } from "../../../src/shared/bots/goap.js"` and a type-only
import from the same file; no copy exists under `packages/`. `goap.ts` has no
imports and its header calls itself a "planner sketch". (c) *Layer:* KB cross-
layer claim. (d) *Action:* the KB's "import" was right and the brief was wrong;
all three files now read "(`src/shared/bots/goap.ts`, kernel-independent; both
sides import the one file)". No §9 row and no drift test — there is one file.

**F5 — Entity table present, three cells mis-pointed.** (a) *Claim:* the table
is missing; `§13` is per-container. (b) *Evidence:* `shared-kb` §13.6 already had
Pawn/Door/Cab/Pickup/Claim with the requested columns; but the Door and Cab
"client copy" cells said §13.3 (per-frame state) while `doorOpen` and
`cabState`/`cabPick` are §13.2; the Pawn cell put `claimHost.table` under host
§13.4 while `claimHost` is host §13.2. (c) *Layer:* KB. (d) *Action:* three
cells corrected; all nine named tests exist (`ls test/<name>.test.ts`).

**F6 — `shared-kb §12.3` heading.** (a) *Claim:* reads "Authority values" and
lists host-owned containers. (b) *Evidence:* there is no §12.3; §13.3 reads
"Authority containers (host-owned; shared factories)". (c) *Layer:* KB.
(d) *Action:* none needed — the tree is ahead of the brief; role brief updated.

**F7 — Alignment.** (a) *Claim:* `AGENTS.md` says "§13 in all three KBs"; verify
`shared-kb` moved §12 → §13. (b) *Evidence:* `AGENTS.md` "KB row
classifications" names `host-kb`/`client-kb`/`shared-kb` §13; `shared-kb` §13 is
"Shared state model" and §12 is the layer-map pointer. (c) *Layer:* pointer.
(d) *Action:* verified true; no edit.

**F8 — Pointer mismatch.** (a) *Claim:* host §15 and client §14 point at "test
pins are shared §11"; the pins were in §9. (b) *Evidence:* `shared-kb` §9 is the
3-column single-source table; §11 carries "Single-source test pins (from §9)";
`host-kb` §15 and `client-kb` §14 both say §11. (c) *Layer:* pointer.
(d) *Action:* verified true; no edit.

**F9 — D7 template slot count.** (a) *Claim:* the template has five slots.
(b) *Evidence:* `task-template.md` carries nine plus the preamble (Context to
Inject, Architecture note, Knowledge base, Files to touch, Codemap delta,
Headers and tags, Test-must-fail-first, Test scope, Artifacts);
`designer-role.md` rule 3 lists the same nine. (c) *Layer:* decision.
(d) *Action:* superseding entry appended to `decisions.md`; D7 itself untouched,
per its own "do not edit entries" rule.

**F10 — `packages/modev` does not exist.** (a) *Claim:* modev lints are wired
into `modev:check` and CI; `promote/` proposes edits. (b) *Evidence:* `ls
packages` → `bot-client` only; no `modev` script in `package.json`;
`ci.yml` runs typecheck/build/codemap/cmp/`npm test` only. (c) *Layer:* tooling.
(d) *Action:* recorded in the role brief's Current state as an operator
decision. The live model lints are `node:test` gates — `test/kb-symbols.test.ts`
(no `path:line`), `contract-grep`, `codemap-*` — which run through `npm test`,
i.e. the 2-hour CI the scope discipline asks for, but not through `modev:check`.

**F11 — The brief carried four dangling section refs.** (a) *Claim:* four
references to `shared-kb §12.3` in the brief. (b) *Evidence:* a scanner over
`agents/*.md` attributing every `§N` to its KB reported 4 dangling refs, all in
`model-developer-role.md:102,106`; after the rewrite, 0. (c) *Layer:* role
brief. (d) *Action:* the brief's "Current state" now names §13.3 / §13.6 and
carries the verified status of every item.

## 3. Edits

| File | Section | Change |
|---|---|---|
| `agents/host-kb.md` | §2 step 3 | `(game.ts, called)` → `(game.ts, called each tick after the owned set)` |
| `agents/host-kb.md` | §15 | goap sentence tail → `kernel-independent; both sides import the one file` |
| `agents/client-kb.md` | §14 | `kernel-independent;)` → the same sentence (fragment repaired) |
| `agents/shared-kb.md` | §1 | `... ; the local sketch` → `... ; both sides import the one file` |
| `agents/shared-kb.md` | §13.6 | Pawn claim pointer host §13.4 → §13.2; Door client copy → `doorOpen` … client §13.2; Cab client copy → `cabState`/`cabPick` … client §13.2 |
| `agents/README-dsh.md` | Test scope | "five `always` gates" → six |
| `agents/decisions.md` | appended | "Superseding entry — D7 slot count (2026-11-20)" |
| `agents/model-developer-role.md` | "Current state" | stale issue list replaced with the verified list (11 items); the attachment copy is untouched |

## 4. Task proposals

No finding in the first pass needs a `src/` or `test/` change. The one
code-shaped item is the lint set that would keep F1–F3, F9 and F11 closed; it is
drafted here so the operator can route it to `packages/modev` (the brief's
design) or `test/` (the repo's current practice) without re-deriving it. The
second pass below routes it to `packages/modev` and adds the one test-only
proposal.

**Draft — three lints, one failure mode each** (the scope discipline's rule).

- `kb-length` — fails when a KB's line count exceeds the stated window
  threshold; threshold is a constant in the test header, not an env var.
- `kb-section-refs` — fails when a `host|client|shared-kb §N` reference names a
  section the target KB does not have. (Scanner already written and run this
  session; 0 after the edits, 4 before.)
- `kb-count-claims` — fails when a prose "<N> `always` gates" disagrees with
  `test/scopes.json`.

- **Knowledge base:** `agents/AGENTS.md` "KB row classifications"; `shared-kb`
  §11 (the invariant index the lints protect).
- **Files:** `packages/modev/{kb-length,kb-section-refs,kb-count-claims}.mjs`
  + a `modev:check` script, **or** `test/kb-{length,section-refs,count-claims}.test.ts`
  with scope `meta` (the `^kb-` pattern already exists in `scopes.json`).
- **Codemap delta:** none — no `src/` exports.
- **Fail-first (captured on the pre-edit tree, verbatim):**
  `model-developer-role.md:102 shared-kb §12.3 MISSING` (×2) and
  `agents/README-dsh.md:59 ... the five always gates`. These are now green, so a
  live red run needs the offending line reintroduced in a scratch copy; the
  captured output is the honest demonstration.
- **Test scope:** `npm run test:scope meta` (after adding the three test files;
  they match the existing `^kb-` pattern).
- **Acceptance:** `npm run test:scope meta` green; `npm run codemap:check` up to
  date; one assertion per file.

## 5. Open loops

> Items 1–2 were decided and closed in the second pass below; the loops after it
> are the surviving ones.

1. **KB split (F1).** Needs the operator to state the read window. If
   W ≈ 400 lines, split `host` and `shared` as the brief says; if W = the
   2,000-line default, drop the rule and replace it with the `kb-length` lint at
   a stated threshold. A split should keep `*-kb.md` as a stub index so the
   ≈250 existing occurrences (including `invoked/`) still resolve.
2. **modev vs `test/` (F10).** The brief's scope discipline describes a tool
   that does not exist. Pick one home for model lints; either way the
   `promote/` advisory tool is unbuilt and unneeded until a lint proposes edits.
3. **Invariant→test registry.** Report 105's residual: the KBs list invariants
   and the source tags name tests, but no generated `invariant → test → file`
   table exists. Still the largest mechanical gap in the model.
4. **`kb-symbols` is a no-line lint, not a resolution check.** It catches
   `path:line` but not a symbol that moved or was renamed. A real resolver would
   need the codemap; report 105 carried this forward.
5. **Flow cadence on the §13 graphs** (50 ms tick / 16.7 ms frame) — 105
   residual, still absent.
6. **§14 quirks.** No live failure was reported this session, so nothing was
   appended. The section is dated 2026-11-19; a bot-developer report with a new
   quirk is what re-opens it.

## 6. `modev` status

`packages/modev` **does not exist** (only `packages/bot-client`); there is no
`modev:check` script, so `npm --prefix packages/modev run check` cannot run.
Nothing landed in `packages/modev`; nothing is pending there. The gate results
that stand in for it:

```text
$ npm run codemap:check
codemap: agents/codemap.md is up to date

$ npm run test:scope meta
ℹ tests 26   ℹ pass 26   ℹ fail 0   ℹ skipped 0
```

Both run on Node `v24.0.2`. A red check would be a finding; neither is red.

## 7. Second pass (2026-11-20) — the operator's two decisions

The operator chose: (1) split host and shared, keeping `*-kb.md` as a stub
index; (2) bootstrap `packages/modev` now. Both are done.

### 7.1 The split

| Before | After | Lines |
|---|---|---:|
| `host-kb.md` 444 | `host-flow.md` (§1–§10) | 196 |
| | `host-model.md` (§11–§15) | 258 |
| | `host-kb.md` (index) | 18 |
| `shared-kb.md` 340 | `shared-flow.md` (§1–§10) | 170 |
| | `shared-model.md` (§11–§13) | 182 |
| | `shared-kb.md` (index) | 18 |
| `client-kb.md` 306 | unchanged — the next candidate | 306 |

Section numbers are preserved, so `host-kb §13` (an older task, report, or
`invoked/` file) resolves through the index in one hop. Each body is
byte-identical to the pre-split text:

```text
$ diff <(sed -n '10,194p' <pre-split host-kb>) <(tail -n +12 agents/host-flow.md)
$ diff <(sed -n '195,444p' <pre-split host-kb>) <(tail -n +9 agents/host-model.md)
$ diff <(sed -n '9,166p'  <pre-split shared-kb>) <(tail -n +13 agents/shared-flow.md)
$ diff <(sed -n '167,340p' <pre-split shared-kb>) <(tail -n +9 agents/shared-model.md)
(no output above = identical)
```

Every half is now under 312 lines (78% of the 400-line window):

| file | lines |
|---|---:|
| `client-kb.md` | 306 |
| `host-model.md` | 258 |
| `host-flow.md` | 196 |
| `shared-model.md` | 182 |
| `shared-flow.md` | 170 |

### 7.2 Pointer surfaces updated

| File | Change |
|---|---|
| `agents/AGENTS.md` | row-classification table names `host-model`/`client-kb`/`shared-model`; the `X` contract points at `shared-model` |
| `agents/coder-role.md` | KB specification lists the five content files, indexes noted |
| `agents/designer-role.md` | resources list names the five content files |
| `agents/bot-developer-role.md` | read order names the halves; the §14 quirks pointer is `host-model` |
| `agents/task-template.md` | the Knowledge-base example names one half per section; the Files row is `<layer>-{flow,model}` |
| `agents/bot-task-template.md` | the read line, Knowledge-base slot and Files row name the halves |
| `agents/client-kb.md` | its two cross-layer pointers now name `shared-model`/`shared-flow` |
| `agents/host-model.md`, `agents/shared-model.md` | in-content cross-KB pointers name the new files |
| `agents/model-developer-role.md` | read order, §14 pointer, 78% note, and the Current-state entries |

`plan/` was not touched: its ~168 KB mentions resolve through the indexes, and a
task file is a record of what was given, not a live pointer.

### 7.3 `packages/modev`

```text
packages/modev/
  package.json            (private, no deps, scripts: check, self-check)
  check.mjs               imports lints/*.mjs, prints file:line, exits 1
  self-check.mjs          four fixtures, one violation each
  lints/kb-length.mjs     READ_WINDOW_LINES = 400; 78% ceiling
  lints/kb-section-refs.mjs   a § reference must resolve by layer
  lints/kb-count-claims.mjs   "N `always` gates" vs test/scopes.json
  README.md
```

```text
$ npm --prefix packages/modev run check
modev: kb-count-claims — ok
modev: kb-length — ok
modev: kb-section-refs — ok

modev:check passed

$ node packages/modev/self-check.mjs
modev: self-check passed — 4 fixtures, one finding per failure mode
```

Fail-first on the real tree: a temporary `agents/zz-modev-probe.md` (removed
after the run) produced exactly the expected findings and a red exit:

```text
modev: kb-count-claims — FAIL (1)
  agents/zz-modev-probe.md:5  says Five `always` gates; test/scopes.json has 6
modev: kb-section-refs — FAIL (2)
  agents/zz-modev-probe.md:3  §99 is not in the host KB
  agents/zz-modev-probe.md:3  §13.9 is not in the shared KB

modev:check failed — 2 lint(s)
```

The self-check caught one real bug in the lint as first written: a non-range
reference was checked twice (duplicate finding). Fixed with a `Set`.

**Not wired at the time of writing:** the root `"modev:check"` script (added
later, §7.6) and the CI step (still the operator's).

### 7.4 Verification after the split

```text
$ npm run codemap:check
codemap: agents/codemap.md is up to date

$ npm run test:scope meta
ℹ tests 26   ℹ pass 26   ℹ fail 0
```

### 7.5 The no-line gate covers the split halves (applied 2026-11-20)

The operator granted the edit. `KBS` now lists all seven files, so the gate's
scope matches the split (3 → 7 cases).

The gap was proven first: a `path:line` in `host-model.md` passed the old
3-file list (weaker fail-first — the test cannot fail on a file it does not
read). After the edit the same probe is red, and green again when reverted:

```text
$ node --import ./scripts/ts-ext-register.mjs --test test/kb-symbols.test.ts
clean:    7 pass, 0 fail
probe:    6 pass, 1 fail   ✖ host-model.md cites symbols, not lines
reverted: 7 pass, 0 fail
```

### 7.6 `npm run modev:check` (root, applied 2026-11-20)

```text
$ npm run modev:check
modev: kb-count-claims — ok
modev: kb-length — ok
modev: kb-section-refs — ok

modev:check passed
```

`package.json` parses; `test:scope meta` is **30/30** (26 before + 4 new KB
cases); `codemap:check` is up to date. The CI step is added (granted, later
2026-11-20): `.github/workflows/ci.yml` runs `npm run modev:check` before
`npm test`, and the file parses to 11 steps.

### 7.7 Open loops (updated)

Wiring is complete: root script, split-half gate, CI step.

1. **Invariant→test registry** — still the largest mechanical gap (105 residual).
2. **`kb-symbols` is a no-line lint, not a symbol resolver** (105 residual).
3. **Flow cadence on the §13 graphs** (50 ms / 16.7 ms) — still absent.
4. **`client-kb` split** — 306 lines, under the ceiling but the largest file.
5. **`promote/`** — unbuilt and unneeded; it lands when a lint has a mechanical
   fix worth proposing.
6. **§14 quirks** — nothing appended; no live failure was reported this session.

## 8. Readiness check for new role sessions (2026-11-20)

The operator is about to open the designer, coder and bot-developer sessions by
pasting the role briefs. Checked that every brief and template in that set
resolves against the post-split tree.

| Check | Result |
|---|---|
| Role briefs present (`designer` 91, `coder` 311, `bot-developer` 350 lines) | yes |
| Path scan over AGENTS + 4 roles + 2 templates (backticked paths) | no real missing path — 7 hits were prose, URLs, or paths relative to `packages/bot-client/src` |
| `npm run …` referenced by those docs | 9/9 exist (incl. `modev:check`) |
| `layer-kb §N` references | 0 dangling (`modev: kb-section-refs`) |
| KB files over the 312-line ceiling | none (largest 306) |
| `test/kb-symbols` (7 files) / `test:scope meta` | 7/7 · 30/30 |
| `codemap:check` | up to date |
| Bot token `~/.config/ce-arena/qa-token.pem` | present |
| Local host on `127.0.0.1:4173` | **not listening** — the operator starts it (expected) |
| Tasks 80/81 | both in `invoked/`; report 80 exists, no report 81 |

### Fixed this pass

- `designer-role.md` — "(D1–D10)" → D1–D11 + superseding entries. The claim that
  the `agents/` and `plan/dsh-tasks/` copies are "identical today" was false
  (`diff` shows the plan copies at five gates / `docs/decisions.md` / D9
  pending); the line now says the `agents/` copies are current and the `plan/`
  ones are history.
- `coder-role.md` — artifact hierarchy said
  `agents/{host,shared,client}-kb.md`; now the five content files.
- `bot-developer-role.md` — "the handover section (the `dag-live.ts` command
  there)" was a dead cross-reference (no such section); now
  `packages/bot-client/tests/elevator-ride.ts` + `host-model.md` §14.
- `agents/README-dsh.md` — the State table is the task 10–14 record; added the
  scope line so a fresh designer does not read it as the current queue.
- `AGENTS.md` — read-order step 4 now states that a `*-kb.md` index's §N
  resolves to its half, so an older task naming `host-kb §13` is not a missing
  section; the Roles sentence is repaired.
- Both templates and the designer/coder KB lists: "split's index page" wording
  (the codemap remains *the* index).

### Outside my write surface

1. `plan/dsh-tasks/proposed/108-pursuit-implementation.md` — the only proposed
   task — names `agents/host-kb.md` §8/§13 and `agents/shared-kb.md`
   §6/§7/§9/§13. It resolves through the indexes (AGENTS now says so), but the
   slot should name `host-flow` §8, `host-model` §13, `shared-flow` §6/§7/§9,
   `shared-model` §13.
2. `plan/dsh-tasks/README-dsh.md` and `plan/dsh-tasks/decisions.md` are older
   copies (five gates, `docs/decisions.md`, D9 pending). The designer role now
   warns; keep them as history or delete them.
3. Task 81 is `invoked/` with no report; the bot role's "ask whether 81 has
   landed" is answered by the operator, not by a file.

**Verdict:** the three sessions are ready. The only blocker-shaped item is the
host not running for the bot-developer — the operator's start — and 108's KB
slot is cosmetic (it resolves).

## 9. modev gains the query CLI (2026-11-20, operator-approved)

The model is now queryable without reading it: `node packages/modev/cli.mjs`
returns one symbol, one KB section, one entity row, or the drift report.

### Why, in bytes

| The agent reads today | Size | ~tokens |
|---|---:|---:|
| `agents/codemap.md` (grep-then-read, or read) | 385 KB / 5,278 lines | ~96k |
| `host-model` §13 (a state question) | 118 lines | ~2,200 |
| `shared-model` §13.6 (one entity) | 11 lines | ~300 |
| **`query symbol createArenaHost`** | **376 B** | **~95** |

JSON is the CLI's internal shape; the agent-facing output is compact text. The
saving is the query, not the format.

### What landed

| File | Role |
|---|---|
| `packages/modev/cli.mjs` | the command line: `query symbol|section|entity`, `find`, `drift`, `stats`; `--root`, `--json`; exit 0 found, 1 miss/findings, 2 usage |
| `lib/parse-codemap.mjs` | module sections → files (imports, used-by, doc) and symbols (kind, local flag, line, signature, doc, tags, calls) |
| `lib/parse-kb.mjs` | numbered sections (bounded), tables, §13.6 entities |
| `lib/index.mjs` | the query layer + the drift report |
| `lib/refs.mjs` | the `layer-kb §N` scanner, moved out of the lint so the gate and `drift` share one implementation |
| `test/cli.test.mjs` + `test/fixtures/` | 8 tests: exactness, locality, section boundaries, entity row, drift (one finding per defect), CLI exit codes |

Two rules worth recording:

- **Exact lookup only.** `query symbol` takes one name; a miss is exit 1 with no
  guess. `find` is the only substring entry point.
- **Section boundaries.** A numbered subsection stops at the next heading of any
  kind (`### 13.6` stops at `### Ownership…`), while a chapter keeps its
  unnumbered subsections (`## 13` includes the ownership graph). The first
  attempt only saw numbered headings and inflated §13.6 from 11 to 60 lines.

`drift` is advisory and mechanical — three defect kinds: a `§` ref that does not
resolve, a KB `src/…` path that is gone or absent from the codemap, a §13.6 test
pin with no test file. It reports no symbol-level prose accuracy (D6).

### Wiring

- `npm --prefix packages/modev run verify` = the three lints + the 8 CLI tests.
- Root `modev:check` now runs `verify`; CI already runs it before `npm test`.
- The query log lands in `packages/modev/.cache/queries.jsonl` (gitignored);
  `modev stats` reads it. That is the evidence for tuning the KBs later.

### Not done

- **Role adoption.** The read order still says "one codemap lookup"; pointing
  AGENTS/roles at `modev query` is the next change, after a before/after count.
- **`scripts/codemap.ts --json`** (a coder task, outside my surface); the CLI
  parses the markdown until then.
- **Symbol-level drift** (a KB name that no longer resolves) — deferred as noisy
  until the §13 table rows are the only input.
- **`promote/`** — still unbuilt; `drift` is the advisory report that would feed it.
- **blueprint-scene root** — it has a codemap but no KBs; `--root` already takes
  any repo, but its agents set has no KBs to query.

## 10. Wiring the CLI into the agent instructions (2026-11-20, operator-approved)

The query surface is now the instructed way to read the model. The rule changed
from "one exact `rg` in the codemap" to "ask modev, then open the source".

| File | Change |
|---|---|
| `AGENTS.md` | read order steps 4 and 6 name the commands; "Codemap is an index, not a document" is replaced by **"Query the model — never read the map"**; Find-code-fast and Commands updated |
| `coder-role.md` | read order; artifact hierarchy (the modev query is the reading interface, the codemap file is never read); KB spec; Pass 1; Pass 3; the codemap spec's "correct use"; Pre-Flight now carries **`Model queries:`**; the report's Verification carries the queries and `modev drift` |
| `designer-role.md` | resources; rule 1 (query the symbol, `rg` the line); Pass 1 (`query file` per module); Pass 5 (`query section` / `query entity`) |
| `bot-developer-role.md` | read order step 4 queries the sections |
| `model-developer-role.md` | the 78% fallback is the section query; the read order distinguishes *query for a reader* from *read the file to edit* |
| `task-template.md` | preamble, **Context to Inject** (KB files are the fallback), **Knowledge base** slot names the query |
| `bot-task-template.md` | preamble and Knowledge base slot |
| `agents/README-dsh.md` | a **Model queries** section |

Design points kept from the review:

- **`rg` is not banned.** It stays for what the codemap does not index:
  function-locals, call sites inside a function, and the text of a file about to
  be edited. The instruction says exactly that, so the coder does not stop
  grepping the source.
- **A fallback exists.** If the CLI is unavailable: one exact `rg` in
  `codemap.md`, open the source it names, and say so in the report. No silent
  return to reading the map.
- **Query to read, open to edit.** The model developer and coder read a section
  by query and open the file only when editing it.

Verification (the path a coder now walks):

```text
$ node packages/modev/cli.mjs query section host-model 13.2     # 13 lines, not the 258-line file
$ node packages/modev/cli.mjs query symbol noteArenaInterest     # entry + file + used-by
$ node packages/modev/cli.mjs query file src/server/game.ts      # module header + imports + symbol list
```

Gates: `modev:check` 9 tests + 3 lints + self-check, `test:scope meta` 30/30,
`drift` clean. `modev stats` now records the queries, which is how the operator
sees whether a session used the CLI or went back to grep.

**Still open:** the generated codemap header itself says "Find a symbol: grep the
Symbol index" (`scripts/codemap.ts`). That line now contradicts AGENTS; it is a
coder task (outside my surface) — the header should name `modev query symbol`.

## 11. The designer did not query — a wording and placement failure (2026-11-20)

The operator reported the designer's search:

```text
grep -rn "GRENADE_DAMAGE\|wound(" --include='*.ts' src test packages | head -40
```

and "the agent did not run `modev query symbol GRENADE_DAMAGE`". My first read of
the query log contradicted that; the operator then confirmed the entries at
12:09–12:12 were **their own manual tests**. The designer session has no query
entries: it grepped. The false correction was recorded here and is retracted.

Two causes, both real:

1. **The wording licensed it.** The first Discovery bullet said "`rg` is expected
   for call sites, and for `test/` and `packages/`". That describes the captured
   command exactly — a repo-wide `--include` sweep over those trees. An
   "expected rg" clause is permission, and a session can rationalize any sweep
   under it.
2. **Placement.** In the designer role the rule sat in rule 1 and the Resources
   list, both about *verifying symbols while drafting*. A pre-task exploration
   has no task file and no Files table, so nothing said what the first move was.

Fixes:

- **AGENTS Discovery:** the first search is `find` (unknown name) or
  `query symbol` (known); `rg` follows, scoped to the file or directory the query
  returned; a repo-wide `rg --include` sweep is the last resort and must say what
  the query missed.
- **Designer role:** **"Model first"** is now the first line of the role; rule 1
  says `rg` is scoped to the query's file/directory; **Pass 0.5 — Discover** gives
  the exploration workflow the method was missing.
- **Task template Appendix:** records the `query symbol|file|section` commands
  used; a cited symbol with no query in the appendix was not verified.
- **Tool:** session attribution (`DSH_SESSION_ID`, previous section) makes a
  zero-query session visible instead of invisible.

Lesson: a log without attribution is not evidence, and "rg is expected here" is
permission — write the *order* (query, then scoped rg), not a list of allowed
trees.

## 12. Coder finding: `used by` is module-level (2026-11-20)

The coder flagged that `query symbol GRENADE_DAMAGE` listed
`used by: src/client/boot.ts, src/client/net.ts, src/shared/bot-protocol.ts`
as if those files imported the symbol. The data is right and the label was
wrong:

- `src/client/boot.ts` imports `advanceGrenadeClock`, `src/client/net.ts` and
  `src/shared/bot-protocol.ts` import `parseGrenadePose`/`grenadeFrame`,
  `src/server/grenade.ts` imports the block that includes `GRENADE_DAMAGE`.
- The codemap records importers **per module** (`used by` in the file record),
  never per symbol; there is no per-symbol reverse index to print.

Fixed: the symbol output now says **`module used by:`**; the `query file` output
keeps `used by:` (it is the module record, so it is unambiguous). The README
states the limitation. The coder's move — verify the model's claim with `rg`
before trusting it — is the artifact hierarchy working (source outranks the map).
Adding per-symbol importers would mean parsing `import { … }` names into the
generator's file records; not worth it while `rg` answers the question exactly.

**The coder's second wording is imprecise, and part of it is now moot.** The
list was never stale at the time it was printed: `boot.ts`, `net.ts` and
`bot-protocol.ts` all reference the *module* (three different export names), and
at `HEAD` `src/server/grenade.ts` imported `GRENADE_DAMAGE`. But the coder's
task **replaces that symbol**: `git diff src/shared/grenade.ts` shows
`GRENADE_DAMAGE` removed for `GRENADE_BLAST_RADIUS` / `GRENADE_BLAST_MIN_PERCENT`
/ `grenadeBlastDamage`. So mid-task every model claim about `GRENADE_DAMAGE` is
stale by design — the codemap describes the last regeneration, not the working
tree. That is now stated in AGENTS ("Freshness"): source outranks the map while
editing; regenerate and re-query before reporting.

## 13. Auto-regenerating the codemap? No — stat and warn (2026-11-20)

The operator asked whether `modev` should regenerate the codemap whenever the
coder creates or changes a symbol, since the map is stale during a task.

Measured on the working tree (Node 24.0.2):

| Operation | Measured |
|---|---|
| full regeneration (`node scripts/codemap.ts`) | **4.48 s** — 121 files, 1,885 symbols, 5,285 lines |
| staleness stat (src file vs `agents/codemap.md`) | ~0 ms (one stat); whole-tree walk 0.00 s |

Feasible, but not advisable, for three reasons:

1. **Cost.** 4.5 s is a full AST parse; a task changes symbols many times. The
   coder would pay seconds per edit for information it already has in context.
2. **D5's review surface.** The codemap is regenerated once at the end so the
   pre-regeneration delta is the review artifact. Auto-updating mid-task destroys
   the baseline: the reviewer can no longer see what the task changed.
3. **Write surface.** `modev` is read-only; a query that writes `agents/` turns a
   read into a mutation and makes the answer depend on when it ran.

What landed instead: **per-result freshness.** A symbol/file result stats its
source file against the map and prints
`stale: <file> changed after agents/codemap.md — run npm run codemap`; a miss on a
stale tree carries the same hint. Two stats, targeted at the file the result is
about, so unrelated queries stay quiet. The CLI never regenerates.

Incident, disclosed: measuring the regeneration ran the generator against the
coder's mid-task tree and overwrote the pre-edit map. Restored from `HEAD` via a
temporary `git worktree` (the map is gitignored, so `git checkout` cannot), with
the mtime backdated to `HEAD` so the new warning reports correctly. `codemap:check`
is now legitimately red until the coder regenerates at the end of the task.

## 14. First full pipeline run: adoption and one found gap (2026-11-20)

The first designer → coder → bot-developer → designer run is done. The query log
(76 queries, session-tagged) shows:

| session | queries | role (inferred from the commands) |
|---|---:|---|
| `b6a4f47d` | 13 | designer: `section host 9/13.4/13.5`, then a symbol sweep |
| `60a9f09e` | 7 | coder: sections + `GRENADE_DAMAGE` + the new blast names |
| `d2046747` | 5 | second task session |
| unknown | 16 | before session tagging (operator tests) |

The coder is the main volume user, as expected: it reads one task's sections and
symbols, while the designer drafts from the KB and the bot reads §14. The useful
signal is not the count, it is the **miss rate**: one session ran
`self`, `others`, `healthOf`, `landed`, `playerIds`, `health` — six misses in a
row — and `find "laser damage"` returned 0.

Cause: those are **methods on `BotWorld`**, declared in
`packages/bot-client/src/world.ts`. `query symbol` only knows top-level symbols,
and the codemap's roots are `src/` — `packages/` is not indexed at all
(`query file packages/bot-client/src/world.ts` misses). The session was asking a
legitimate question the model cannot answer.

Fixed in the model, not in the tool:

- `find` on zero hits now says what it matches (names and section titles) and
  points at `rg` for source text, member names and `packages/`.
- AGENTS: **"A member is not a symbol"** — query the owner's file and read the
  declaration.
- Designer and bot roles name `packages/bot-client/src/world.ts` as the `BotWorld`
  surface, outside the codemap.

### Task proposal — extend the codemap roots (coder)

- **Architecture note:** the codemap is the index of what agents may query; the
  bot lane is half the pipeline and is currently invisible.
- **Files:** `scripts/codemap.ts` (default roots), `package.json` (`codemap`),
  the codemap gates if they assume `src/` only.
- **Change:** add `packages/bot-client/src` to the default roots (9 files,
  2,791 lines). Do not add `tests/`.
- **Fail-first:** `node packages/modev/cli.mjs query file
  packages/bot-client/src/world.ts` exits 1 today; after, it lists `BotWorld`.
- **Acceptance:** `npm run codemap` includes the 9 files; `query symbol BotWorld`
  hits; `codemap:check` green; `test:scope meta` green.
- **Risk:** cross-root `used by` edges (bot-client imports `../../../src/…`) and
  a larger map; both are visible in the regenerated diff.

Adoption verdict so far: the loop works, the misses are the model's fault when
they happen, and the fix is either a pointer (member/packages) or a day of
generator work (scope) — not a change in the agents.

## 15. The scoped test loop is the wall clock (2026-11-20)

The operator: coding takes <5 minutes, then the test phase dominates. Profile,
per test file, Node 24, 4 cores (numbers taken while a cancelled suite may still
have been draining — treat them as upper bounds):

| test | s | note |
|---|---:|---|
| `manifest-data` | 21.8 | **always gate**, calls `loadInstalledGame` three times |
| `ray-broadphase` | 12.5 | |
| `grenade` | 12.3 | |
| `scene-graph` | 11.5 | imports `../dist/` |
| `grenade-dag` | 11.0 | |
| `placements-file` | 10.1 | |
| `example` | 9.7 | imports `../dist/` |
| `codemap-tags` | 7.5 | always gate |
| `module-headers` | 5.3 | always gate |
| `codemap-calls` | 4.8 | always gate |
| `jsdoc-exports` | 4.2 | always gate |
| `tag-coverage` | 3.8 | |

For a grenade change the related run selects **25/137** tests and `build yes`;
`npm run build:server` alone is **14.6 s**. The six always-gates are ~25–45 s on
every run. The full related run exceeded six minutes twice (killed); the per-file
sum is ~4 minutes, so the parallel default is not buying what it should — that
gap is a suspicion, not a measurement.

Three causes, three candidate tasks (one concern each, for the designer):

1. **`manifest-data` reloads the game three times** (once uncached by design, to
   emit warnings; the other two do not need it). Cache one load for the tests
   that do not capture warnings — an always-gate saving on every run.
2. **The `dist` build is unconditional when a selected test imports `dist/`**
   (5 of them). Skip the build when `dist` is newer than every `src/` file, or
   have `scene-graph.test.ts` import `src/` if deploy parity is not the point.
3. **Profile the parallel run** — 25 files taking >6 min against a ~4 min
   sequential sum; measure `--test-concurrency`, then fix the concurrency or the
   test that stalls under load.

Not a gate change: every proposal caches or reuses work; none weakens an
assertion. Interim, landed in the coder role: iterate on the edited test file
alone, run the scoped command once before the report.

## 16. The dispatcher convention: `Next:` only when action is needed (2026-11-20)

The operator reported spending more time reading turn endings to decide whether a
post-task action was needed. Rule added to AGENTS and all four briefs:

- **Normal finish → no line.** Work complete, report written, task file on disk:
  the turn ends there. Silence means nothing to dispatch.
- **Question, blocker, or operator decision → exactly one line:**
  `Next: operator — <the one action>`. If the next actor is another agent, name
  it so the operator routes it (`Next: designer — draft the follow-up task`).
- Never end with both a summary and an unexplained question.

Why this and not `Next: none`: the operator's scan is "is there a Next line?" —
one grep-shaped check per turn, instead of reading the prose. A mandatory line
would restore the reading cost it removes.

Applied in `AGENTS.md` (injected, canonical), `designer-role.md` (rule 8),
`coder-role.md` (Role contract), `bot-developer-role.md` (Interaction protocol),
and `model-developer-role.md` (With the operator). Sessions started before this
change need a restart to see it.

## 17. Bot scripts are tracked; paths are repo-relative (2026-11-20)

The designer sent the bot to `plan/dsh-tasks/live/114-threat-response.ts` — a
gitignored folder, so the script is not reviewable. Rule changed:

- **AGENTS Rules:** a bot task's script lives under `packages/bot-client/tests/`
  and is named in the task's Files table; `plan/` is gitignored. Paths are
  repo-relative — no `/home/tim/…`; the token comes from `CE_TOKEN` or
  `~/.config/ce-arena/qa-token.pem` via `os.homedir()`.
- **bot-developer-role:** lane table, "driver home", journal item 4, permissions,
  and the Node line all say the same.
- **bot-task-template:** the preamble and a new Files row put the script under
  `packages/bot-client/tests/<name>.ts`.
- **designer-role rule 14:** the Files table names a tracked script, never
  `plan/dsh-tasks/live/`.
- `plan/dsh-tasks/live/` remains for raw captures only.

Absolute-path inventory (checked):

| where | count | what |
|---|---:|---|
| `packages/bot-client/tests/*.ts` | 28 | `readFileSync("/home/tim/.config/ce-arena/qa-token.pem")` |
| `scripts/room.sh`, `scripts/room-dev.sh`, `scripts/ws-stick.ts` | 3 | `/home/tim/dev/conveyor-engine-arena/...` |
| `plan/dsh-tasks/live/114-threat-response.ts` | 1 | untracked, same token literal |
| `agents/` | 0 | clean |

Proposed coder task: a `packages/bot-client/tests/token.ts` helper
(`CE_TOKEN` → `join(homedir(), ".config/ce-arena/qa-token.pem")`), the 28 inline
reads replaced, the 3 scripts made repo-relative (`ROOT=$(cd "$(dirname "$0")/.." && pwd)`),
acceptance `rg -n "/home/tim" packages scripts` empty plus typecheck. The drivers
are outside `tsconfig.bot` (src only), so the sweep is `rg`-driven; adding the
drivers to a typecheck is a separate task.

## 18. The bot lane's purpose: prototype → measured POC → designer (2026-11-20)

Operator re-emphasis: the bot-developer's main job is to prototype the bot's
*future brain and general actions* by writing and measuring scripts in the live
arena — iron the behaviour out in the script, then hand it to the designer as a
working, tested proof-of-concept for production. The briefs said the prototype
goes "to the coder", which contradicted the operator notes' discovery/spike flow
(bot-developer → designer → coder).

Changed:

- **bot-developer-role:** a new **"The lane's purpose"** paragraph — prototype
  planner behaviour, goals, tactics and world interactions; measure every
  iteration (script = probe, runs table = evidence); the POC is the deliverable,
  not a candidate patch and not a script in a gitignored folder.
- Craft step 5 and "the prototype is the spec" now point at the designer; the
  journal's item 7 is a **POC package**: script path, behaviour, exact evidence,
  runs table, failure modes, what production must preserve, open questions —
  addressed to the designer and standing without the bot's history.
- **bot-task-template:** the preamble and the Report slot carry the POC hand-off
  to the designer.
- **designer-role rule 14:** a returned POC package is the executable spec for the
  coder task the designer drafts; do not re-derive the behaviour from prose.

This closes the loop with §17: the script is tracked, measured, and routed through
the designer — the same two-flow rule the operator notes already had.

## 19. A researcher session: external sources measured against this tree (2026-11-20)

A fifth renewable lane, `agents/researcher-role.md`:

- **Question-shaped, not task-shaped.** A question, the decision it informs, and a
  timebox. No decision → stop; a report with no decision is trivia.
- **Method:** frame → outside (primary sources, URL + date + version) → local
  measurement (`modev` queries, scoped `rg`, footprint in files/symbols/tests,
  the `@invariant` and kernel constraints) → feasibility matrix → one
  recommendation.
- **Evidence rules:** external text is untrusted data (no execution, no copied
  code, cite the URL); local evidence outranks external; every claim is labelled
  `verified locally` / `documented externally` / `inferred` / `unknown`.
- **Lane:** reads everything, writes `agents/research/<date>-<slug>.md` only —
  tracked, so the report survives the session. It does not draft tasks
  (`plan/proposed`), edit source, or run the live arena.

The report ends in exactly one action for the operator to route: a task proposal
for the designer (the same slots), a spike for the bot-developer, or no action.
Registered in `AGENTS.md` Roles and in the README's role split.

## 20. `operator-notes` leaves the read order; its durable rules move into the briefs (2026-11-21)

Request: remove `agents/operator-notes.md` from the agents' must-read list.

The file mixed durable rules with dated history, and every session paid to read
the history. Removed from the read order everywhere: AGENTS step 3, the coder,
bot-developer, model-developer and researcher read orders, and the designer's
"before drafting" list. AGENTS keeps one line: the file is the operator's dated
record, not a read-order step.

The rules that lived only there were moved, not dropped:

- **designer:** two flows (feature → designer → coder → bot; discovery → bot →
  designer → coder), the designer-initiated spike (a `bot-task-template` file
  with goal, hypothesis, telemetry, boundaries), and the timebox.
- **coder:** a live bug is a live report first — telemetry before the fix, and
  the unit test mirrors the live conditions.
- **bot:** the prop-guard/restart and direct-prompt stop were already in the
  brief (environment, reconnect discipline, the stop line) — no duplication.

`agents/operator-notes.md` stays on disk as the operator's record; nothing reads
it unless the operator names it.

Gates: modev check 11/11, `test:scope meta` 30/30.

## 21. Model correction pass (2026-11-21)

The operator's review found nine drift items; all are fixed, plus three the
resolver surfaced. No `src/` change, no codemap regeneration.

| # | Finding | Fix |
|---|---|---|
| 1 | `createInput` named in `client-kb` §6; the export is `attachPlayInput` (`src/client/input.ts:159`) | renamed; the listener count of 9 was right |
| 2 | No gate checked that a KB symbol exists | `test/kb-symbols.test.ts` now also resolves every backticked identifier against `src/` + `packages/` (14 tests; fail-first: `client-kb:88 createInput`) |
| 3 | `host-model` §15 and `client-kb` §14 were byte-identical (2,290 chars), both copying `shared-flow` §9 | both collapsed to a pointer: group table → shared-flow §1, single sources → §9, pins → shared-model §11. `client-kb` 306 → 285 lines (headroom restored) |
| 4 | Invariant index covered 13/18 tags | 4 rows in shared-model §11 (`SpatialNode`, `unlock`, `hasLineOfSightDag`, `sweepIndexed`) and 1 in host-model §12 (`resolvedScopes`) |
| 5 | `tick-metrics.ts` had no §13 row | §13.2 `metrics` row (rolling window, reset by `beginTick`) |
| 6 | `auth/*` (715 lines) unnamed | §13.2 revocation row + a §1 auth sentence (`tokens.ts`, `gate.ts`) |
| 7 | `shared-model` §11 header said "in shared" | "Existing `@invariant`s and the consumer that relies on each" |
| 8 | AGENTS said "`*-kb.md` is an index" (client-kb is a full KB) | names `host-kb`/`shared-kb` as the two indexes |
| 9 | "630 tests" stale | 748 today (746 pass, 2 skipped), full suite in 691 s |

Three extra drifts found while building the resolver:

- `HeldInputs`/`createHeldInputs` were attributed to `src/shared/movements.ts`;
  they are in `src/server/game.ts`.
- `createPawnHealth` was attributed to `src/server/health.ts`; it is in
  `src/shared/health.ts` (the server file owns the frames).
- `players.ts` and `info-probe.ts` were unnamed: the roster is now noted under
  host §13.3, the probe in client §7.

Not done (deferred): the `client-kb` split (it is 285/312 now, and the section
collapse bought the headroom); the other unnamed modules (auth `gate.ts` and
`token-cli.ts` are named in the §1 sentence, the bots/nav internals remain under
their group rows); a file-attribution gate (the resolver checks existence, not
that the cited file contains the name — that needs the codemap's file map and a
second lint).

The full suite takes **11.5 minutes** (748 tests, 4 cores) — the reason the
scoped loop matters and the per-file iteration rule exists.

## 22. Task 121 model updates: the `msg` frame (2026-11-21)

Source: `plan/dsh-tasks/reports/121-msg-frame.md`. The coder listed four model
items; all landed, plus one section the report did not name.

| Item | Change |
|---|---|
| host §13.2 | `msgHost` row: `messages.ts` `pending` + `seqBySender`; `onFrame`/`tick`/`drop`; drained per tick (≤4 rows/s), queue ≤64, dropped on close |
| host §13.5 | `claimHost.tick(now)` + `msgHost.tick(now)` share one `Date.now()` per tick; `msgHost.drop(pawnId)` on close; the queue noted in the TTL line |
| **host-flow §2** | *not in the report*: the `onTick` order now starts with the claim/msg tick (`arena-host.ts:453`) — the flow half had the old order |
| shared §13.1 | `bot signals in` (untrusted, `chat` scope, text 1–256, `from` host-stamped) and `bot signals out` (one batch/tick, ≤4 rows/s, `MAX_MSG_ROWS` 64, 64-row client ring) rows; welcome extras gains `messages` |
| shared-flow §2 | one sentence: the `msg` frame is fire-and-forget, counted not acked |
| decisions | **D12** appended: host-mediated signal frame, the `chat` scope, one batch per tick, not a chat |

One deviation from the report: it suggested the `createArenaMessages`
`@invariant` go in `shared-model` §11, but the module is `src/server/messages.ts`
— a host container. It went to **host §12**, where the other host invariants
live; shared §11 keeps the contract rows.

Test count refreshed twice in a day (748 → 757); if it keeps drifting, the KB
line should carry a date rather than "today". 757 (755 pass, 2 skipped) in 720 s.

Not model work, from the same report: `connection.say` has no unit test, and the
host rejection is silent to the sender (`msgReject` is a follow-up). Those are
designer/coder items.

Gates: modev check green (lints + 11 tests + self-check), `drift` clean,
`test:scope meta` 37/37.

## 23. Task 123: the welcome seeds the owner's vital (2026-11-21)

The command host needed the bot's hp at join; the health frame is change-driven,
so a pawn that never takes damage never receives one. The welcome now carries
`hp`/`dead` (`parseWelcomeExtras` requires both to be present; the world applies
them in `connectBot`).

Model change: the shared §13.1 welcome row lists the new keys and says they seed
the change-driven health frame. Nothing else: the `cmd` surface rides the
existing `msg` row (a JSON `text` payload), so no wire row is added, and
`command-host.ts` is bot-client test tooling, not host state.

## 24. Reports are the handoff; the bot POC ledger (2026-11-21)

Operator: the bot lane's successful missions stay prototypes, no one reads them,
and the coder found a bot report useful — the pipeline is a graph, not a line.

**`packages/bot-client/tests/POCS.md`** is the missing index: one row per
behaviour a run has proven — behaviour, script, evidence, status. Seeded with 11
rows: three `landed` (127 combat policy, 129 info probe, 131 plan unlock) and
eight `proven` (command surface, link/mailbox, interior-door spike, attack loop,
door press, elevator ride, two-bot claims, visibility diagnosis). Status moves
`proven` → `proposed` (a designer task cites it) → `landed` (task/commit).

Wiring, so it is read rather than remembered:

- **AGENTS:** "Reports are the handoff" — a table of each lane's writes and what
  it reads before acting; a task or run cites the report it builds on; a report
  with no consumer is not done.
- **bot-developer:** read order step 3 is the ledger + drivers README; a new rule
  "Build on the ledger" (a `proven` row means extend that script, not restart);
  the POC hand-off now includes a **task proposal** and the ledger row; `POCS.md`
  is in its write set.
- **designer:** reads `POCS.md`, the `live-*.md` reports and `agents/research/`;
  "A proven POC is a task" — cite the script and report, set the row to
  `proposed`, do not re-design what the prototype measured.
- **coder:** if the task cites a prototype or report, read it before the source.
- **task template:** the Architecture note may cite a prototype/report; a Files
  row names it.

Gates: modev check green, `drift` clean. The running sessions need a restart to
pick up the new briefs.

## 25. The bot lane can read the KB (2026-11-22)

Operator: the bot-developer does not understand the source tree it works with —
it needs KB access. It *could* read `agents/` and the task's KB sections, but the
lane table assigned "KBs" to the designer (read as ownership), and nothing said
the slot was a minimum or that querying further was expected.

Changed in the bot brief:

- **Lane table:** the designer "owns" **KB edits**; a line under the table says
  every lane reads the KBs through `modev`, and only the designer and the model
  developer edit them.
- **Read order:** the task's KB slot is the entry point, **not the limit** — query
  any further section the run needs, and query rather than read a whole file.
- **"The source tree":** read `src/` (host + shared) and `packages/bot-client/src/`;
  when an observation does not fit, query the owning section (host tick, doors,
  collision, client frame) and then the symbol's file. The KB is the map; a wrong
  section is a report line, not an edit.
- **Permissions:** reading `agents/` is explicit (KBs, `decisions.md`,
  `README-dsh.md`); editing `agents/` is not the bot's lane.
- **First ten minutes:** a model-query smoke test (`query section host-flow 2`,
  `query symbol runMission`).
- **Bot task template:** the Knowledge base slot is the entry point, not the limit.

Gates: modev check green, `drift` clean.
