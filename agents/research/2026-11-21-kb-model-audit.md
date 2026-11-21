# Audit — is the agent knowledge base fit to drive model-driven development?

| | |
|---|---|
| **Question** | Are `agents/{shared-kb,host-kb,shared-model,host-model,client-kb}.md` an accurate, complete and usable model substrate for session agents? |
| **Decision it informs** | Whether the pipeline keeps this KB architecture as the context carrier, and which corrections must land before more tasks are designed against it. |
| **Timebox** | 45 min (spent ~50). |
| **Window** | 2026-11-21 08:34 → 09:30 America/New_York. |
| **Tree** | HEAD `7d6571e` (2026-11-21 08:27), 70 commits after the KBs' baseline `984e20a` (2026-11-14). |
| **Read** | The five named files in full (782 lines), `shared-flow.md` §9, `host-flow.md` headings, `model-developer-role.md`, the three `packages/modev` lints, `test/kb-symbols.test.ts`. |

## Executive summary

The model is **accurate and usable, and incomplete in one specific way**. Of 395 backticked identifiers in the
five files, 394 resolve in `src/`/`test/`/`packages/`; every `§` reference resolves; `modev:check` and
`modev drift` are clean; the §13 tables' TTLs and the baseline entity counts (1,618 boxes / 98 doors / 4 cabs /
156 pickups / 16 agents) reproduce exactly at HEAD, 70 commits after they were written. The incompleteness is the
**invariant index**: 18 `@invariant` tags exist in `src/`, and the three §11/§12 indexes name 13 of them — five are
missing, two of those already carry a test and therefore qualify by the repo's own rule. Two structural issues
compound it: `host-model` §15 and `client-kb` §14 are **byte-identical** (2,290 chars, similarity 1.000) and both
copy `shared-flow` §9, so one convention change needs three edits; and `client-kb` is 306 lines against a 312-line
gate, so the next 7-line addition turns `modev:check` red. The one stale symbol (`createInput`, line 88 of
`client-kb`) survives because `test/kb-symbols.test.ts` checks path:line citations, not symbol existence.
**Recommended next step: a model-developer correction pass — five KB edits plus one lint — no `src/` change.**

---

## 1. Question, decision, timebox

Restated: does the KB give a session agent enough **true** context about the data model and code structure that it
can be told "read §13 of your layer" and act on it, without the KB quietly lying or omitting the container it
needs? The decision is whether to invest a pass in the model before more tasks are designed against it, and what
that pass contains. Moot if the KB were only a navigation aid that agents always verify against source — it is
not: `AGENTS.md` makes the KB the *first* read for every task, and the coder is told to trust it until source
disagrees.

## 2. Sources

No external sources: this is a local audit, so the tree and the model are the two authorities and the tree wins.
`web_search` was not used — an external claim cannot settle whether a local symbol exists.

## 3. Findings

Each finding: claim → evidence → label.

**F1 — one stale symbol.** `client-kb.md:88` says "`createInput` installs 9 window/document listeners once
(`input.ts`)". No `createInput` exists; the export is `attachPlayInput` (`src/client/input.ts:159`), and the
listener count is right (9 `addEventListener` calls in that file).
*Label: verified locally.* **Severity: low** (the file and count are right; a coder who greps finds it) —
**but it is the only defect of its class and it proves the gate below cannot see that class.**

**F2 — the KB gate checks citations, not symbols.** `test/kb-symbols.test.ts` asserts only that no KB file contains
a `path:line` or bare `:line` citation; it never checks that a named symbol exists. `modev drift` covers § refs,
`src/` paths and §13.6 test pins — not symbols. `modev:check`'s three lints (`kb-length`, `kb-section-refs`,
`kb-count-claims`) do not either. So F1 passes every gate.
*Label: verified locally.* **Severity: medium** — this is the mechanism by which the model rots silently.

**F3 — three copies of the layer map and single-source table.**
`host-model.md` §15 and `client-kb.md` §14 are byte-identical (2,290 chars, `difflib` ratio **1.000**), and both
say "Replicated from `agents/shared-flow.md` §1/§9" — where the same table also lives (`shared-flow.md:138-151`).
Three copies of one convention table; nothing fails if one drifts (the KB itself predicts exactly this: "the two
bodies are byte-identical today, and nothing fails if one drifts").
*Label: verified locally.* **Severity: medium** — it is a drift hazard the model already names, in the model.

**F4 — the invariant index covers 13 of 18 `@invariant` tags.** Tags in `src/`: 18 (`rg -c "@invariant" src`).
Named in a §11/§12 index: 13. Unindexed:

| tag owner | file:line | test? |
|---|---|---|
| `SpatialNode` — static-only, no door/pawn kind | `src/shared/spatial-dag.ts:10` | **yes** — `dag_nodes_are_places_not_dynamic_objects` (`test/spatial-dag.test.ts:39`) |
| `unlock` — the key stays held, one key opens every leaf | `src/shared/bots/actions.ts:297` | **yes** — `unlock_keeps_key` |
| `hasLineOfSightDag` — the DAG holds no door/pawn triangles | `src/shared/hitscan.ts:367` | shared-model §13.2 names the DAG, not the tag |
| `sweepIndexed` — same closest hit as `sweepSegment` | `src/shared/hitscan.ts:747` | named in §13.4, absent from §11 |
| `resolvedScopes` — extras never remove a default scope | `src/server/auth/tokens.ts:94` | no test; no KB file names `auth/` at all |

Two of the five (the first two) carry `(test: …)` references, so under `AGENTS.md`'s own rule ("a candidate
invariant is not an `@invariant` until a test or tag confirms it; then it moves to that layer's §12/§11") they are
eligible now.
*Label: verified locally.* **Severity: high for a coder relying on §11 as the complete invariant set.**

**F5 — 40 of 121 `src/` modules are named in no KB half.** Most are legitimately out of scope (bake/util, bench,
example app, node stubs, `game-files*`). The ones that matter for a data-model KB:

| module | why it matters | modeled? |
|---|---|---|
| `src/server/tick-metrics.ts` | `createTickMetrics` (`game.ts:1000`) holds a rolling window + budget — real runtime state | **no** row in host §13, no mention in any KB |
| `src/server/players.ts` | `playerRoster` (`arena-host.ts:148`) builds the `lastRoster` row §13.3 names | value modeled, builder not named |
| `src/server/auth/{tokens,gate,token-cli}.ts` | 715 lines; scopes/tokens gate `teleport`, `qa`, scene-graph delivery (§13 trust boundary refers to scopes) | **no** — and F4's unindexed tag lives here |
| `src/shared/info-probe.ts`, `src/client/info-probe.ts` | the info probe §7 describes by symbol (`probe`) | concept yes, files no |
| `src/shared/bots/bot-tuning.ts`, `src/shared/nav/stand.ts` | tuning / stand queries the bot lanes use | no |
| `src/shared/shadows.ts`, `src/shared/model-choice.ts` | boot inputs (`view.shadows`, `modelChoices`) that appear in §13 rows as values | values yes, files no |

*Label: verified locally.* **Severity: medium** — the §13 tables are the part agents act on, and `TickMetrics` is a
container an agent editing `game.ts` would not be warned about.

**F6 — the KB set sits on the window gate.** `kb-length` fails above 312 lines (78 % of a 400-line window);
`client-kb` is **306**. `model-developer-role.md` itself says client "is still one file (306 lines, the next
candidate)" — so the split policy is half-applied (host and shared are `flow`+`model`+index; client is a single
file, with no `client-flow.md`/`client-model.md` half to name). A 7-line edit to `client-kb` reds the gate.
*Label: verified locally.* **Severity: medium** — scheduling, not correctness.

**F7 — stale anchors, and one likely-stale count.** Both the client baseline and the host hot-path table are dated
`984e20a` (2026-11-14); HEAD is 70 commits later. The entity counts still hold exactly (measured below), so the
baseline line is fine. The "630 tests" claim (`client-kb.md:11`) is suspect: the suite now has **730** syntactic
`test(`/`test.skip(` sites across 137 files. Executed count was not obtained — the full `npm test` was still
running when I killed it at ~20 minutes — so this is `inferred`, not proven.
*Label: inferred.* **Severity: low** — no task depends on the number.

**F8 — `AGENTS.md` mis-describes `client-kb.md`.** The always-injected file says "`*-kb.md` is an index of the
split; that is not a missing section". True for `host-kb`/`shared-kb` (18 lines each, tables only); false for
`client-kb` (306 lines of content). Harm is contained — `modev query section client 13` resolves — but every
session reads that sentence.
*Label: verified locally.* **Severity: low.**

**F9 — a host-layer tag in the shared index.** `shared-model` §11 opens "Existing `@invariant`s **in shared**" and
then lists `DoorBlockers` (`src/server/doors.ts`), which is also host §12's first entry. Either the header or the
entry is wrong; D2's "one tag on the authoritative declaration" is not violated (the tag is in one place), but the
*index* duplicates it in the wrong layer.
*Label: verified locally.* **Severity: low.**

**F10 — the query surface works.** Sections return bounded slices: `shared §11` 33 lines, `shared §12` 5,
`shared §13` 134, `host §11` 24, `host §12` 23, `host §13` 118, `host §15` 29, `client §11` 17, `client §12` 15,
`client §13` 97, `client §14` 29. `query entity Claim` stitches the §13.6 row correctly. So an agent that follows
`AGENTS.md` really does read ~20–130 lines instead of 782.
*Label: verified locally.* **Severity: — (positive finding; the architecture is sound).**

**F11 — §13 rows reproduce at HEAD.** Spot-checked against source: claim TTL clamp 5 s–120 s, default 30 s
(`claims.ts:12-14`); snapshot job 3 s (`arena-host.ts:718 SNAP_TIMEOUT_MS`); deny log window 60 s
(`rate-limited-log.ts:24`); §13.6 Claim row matches host §13.2. Baseline counts from `loadArena()`: aabbs 1,618,
doors 98, elevators 4, pickups 156, agents 16 — exactly the client-kb baseline line.
*Label: verified locally.* **Severity: — (positive).**

## 4. Local measurement

```bash
wc -l agents/{shared-model,host-model,shared-kb,host-kb,client-kb}.md        # 182/258/18/18/306 = 782
node packages/modev/cli.mjs stats ; node packages/modev/cli.mjs drift        # 171 queries; "no drift"
npm --prefix packages/modev run check                                        # kb-count-claims / kb-length / kb-section-refs ok
node packages/modev/cli.mjs query section {shared,host,client} {11,12,13}    # slice sizes in F10
node packages/modev/cli.mjs query entity Claim                               # stitches §13.6

# identifier audit: every backticked token in the 5 files, tested against src/test/packages
#   395 unique identifiers → 1 unresolved (createInput)
# file-reference audit: 103 `.ts` refs in the five files (124 across the seven KB files)
#   → 0 unresolved once basenames were matched against src/test/packages (31 looked missing before that)
# module coverage: 121 src modules → 81 named in the 7 KB files, 40 not

# invariant coverage: 18 tags in src/ vs 13 named in §11/§12
rg -c "@invariant" src --glob '*.ts'
rg -n "dag_nodes_are_places_not_dynamic_objects" test/*.ts                   # the unindexed tag's test exists

# duplication
python3 -c "…difflib host §15 vs client §14…"                                # ratio 1.000, 2,290 chars each

# baseline counts at HEAD
node --import ./scripts/ts-ext-register.mjs -e "…loadArena()…"                # 1618/98/4/156/16
```

Footprint of the recommended pass: **5 KB files + 1 test file** (a lint extension) + `AGENTS.md`/role line — no
`src/`, no `test/` behaviour change, no codemap regeneration (no exported symbol moves).

## 5. Feasibility matrix

| Option | Verdict | Cost | Risk | What would change it |
|---|---|---|---|---|
| A. Leave as is | — | 0 | the 5 unindexed invariants stay invisible; the 3-copy table drifts | a coder relying on §11 as complete |
| B. Fix F1/F4/F5/F9 (accuracy + index completeness) | **small** | 5 files, ~12 lines | low; §11 gains 5 rows, `TickMetrics` 1 row | — |
| C. De-duplicate the layer map (F3): one copy in `shared-flow` §9, pointers in host §15/client §14 | **small** | 2 files, ~60 lines deleted | low; agents that read host §15 alone lose the inline table (keep pointers + the one-duplicate note) | if a reader is expected to work from one file offline |
| D. Extend the gate: assert every backticked identifier resolves (F2) | **small** | 1 test file + 1 helper | medium: false positives on prose/`packages/` names → needs an allowlist | if `packages/` symbols can't be resolved cheaply |
| E. Split `client-kb` into `client-flow`+`client-model` (F6) | **large** | 1 → 3 files, every `client-kb §N` reference in tasks/roles must still resolve through an index | medium: 4 h of editorial work; a mis-cut section costs a coder a read | a 7-line edit is needed before the split (then it is forced) |
| F. Refresh the "630 tests" and the hot-path anchor date (F7) | **small** | 1 line + 1 header | low | the number is a marketing claim, not a gate |

## 6. Recommendation

**One action: hand the model-developer a correction pass (B + C + D + F), no `src/` change.** The model's structure
is right — bounded sections, §13 tables that reproduce, an entity stitcher that works. The defects are five
missing index rows, one stale symbol, one triplicated table, and a gate that cannot see the class of F1. None of
that needs a coder, and every one of it is cheap now and expensive after another ten tasks are written against the
gaps. The `client-kb` split (E) is the only expensive item; do not do it in this pass, but note that the next
7-line addition to `client-kb` forces it.

Charter for the pass (what the model-developer writes):

| # | Edit | File | Detail |
|---|---|---|---|
| 1 | rename the symbol | `client-kb.md:88` | `createInput` → `attachPlayInput`; keep "9 listeners" |
| 2 | add 5 invariant rows | `shared-model` §11, `host-model` §12 | `SpatialNode` static-only, `unlock` key-hold, `hasLineOfSightDag`, `sweepIndexed`; `resolvedScopes` after `auth/` is modeled |
| 3 | add `TickMetrics` row | `host-model` §13.3 or §13.5 | `createTickMetrics` (`game.ts:1000`) — window/budget, per-tick writer, `now` injected |
| 4 | name the auth layer | `host-model` §13 trust boundary + a §13 row for tokens/scopes | 715 lines, currently zero mentions; F4's fifth tag lands here |
| 5 | collapse the layer map to a pointer | `host-model` §15, `client-kb` §14 | keep "the one real duplicate is door yaw" note, delete the copied table |
| 6 | fix the shared §11 header or move `DoorBlockers` | `shared-model` §11 | header says "in shared"; entry is host |
| 7 | extend the gate | `test/kb-symbols.test.ts` (+ helper) | every backticked identifier resolves in `src/`/`test/`/`packages/`; allowlist prose and kernel names |
| 8 | correct `AGENTS.md` | line in "Query the model" | `client-kb.md` is content, not an index; it has no `-flow`/`-model` split yet |
| 9 | refresh the count | `client-kb.md:11` | replace "630 tests" with the measured number (or drop it) |

**Out of scope for this pass:** splitting `client-kb`; touching `src/`; re-measuring the hot-path table (the
percentages are still the portable number and the anchor date is honest).

## 7. Open questions

1. **Executed test count** — the full `npm test` was killed at ~20 minutes in this session; 730 is the syntactic
   count. Resolve by letting CI finish once and reading the TAP total.
2. **Should §11 list every `@invariant`, or only cross-call ones with a consumer?** D1 says a tag needs a
   consumer; §11 is an index, not a registry. If the intent is "every tag appears in some §11/§12", F4 is a bug;
   if not, the section needs a stated scope line.
3. **Is `src/server/auth/` in the model's scope?** It is host code, not kernel, and it gates `teleport`/`qa` — the
   KB currently models the *effect* (scopes) and not the code.
4. **Does anything read `host §15`/`client §14` for the layer map, or is `shared-flow` §1/§9 the real entry?**
   Determines whether C can delete both copies or must keep one.

## 8. Confidence legend

`verified locally` — reproduced with the commands in §4. `inferred` — reasoned from two measured facts. No
`documented externally` claims appear in this report.
