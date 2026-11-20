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
