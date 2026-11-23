# GOAP combat migration — heal-at-50 and return-fire as goals

| | |
|---|---|
| **Question** | How do the soldier's prototype rules — seek health crates at hp ≤ 50, and answer incoming fire with cover or return fire — become GOAP goals/actions, and what must change so the bot lane plans with GOAP instead of TypeScript branches? |
| **Decision it informs** | The vocabulary task for the coder (facts/actions/goals) and the bot-developer's prototype that proves the plans before the commander relies on them. |
| **Timebox** | 50 min (spent ~45). |
| **Window** | 2026-11-23 11:53 → 12:45 America/New_York. |
| **Tree** | HEAD `c9dd5ce` + dirty tree (the `path`, 152 and parity changes). |

## Executive summary

The planner is not the problem: `src/shared/bots/goap.ts` is a **131-line** deterministic A* over flat facts with
`Action{id, pre, eff, cost, usable}` and `Goal{id, want, priority}`. The problem is the **vocabulary**: `state.ts` builds
facts for movement, doors and pickups (seven builders, `:47-95`, plus the `at`/`hasWeapon`/`hasAmmo`
constants), `actions.ts` grounds eight actions (movement, doors, elevators, pickups) plus the aggregate, and `goals.ts` has five goals (`retrieve`, `reach`, `standAt`, `armUp`, `idle`) — **no hp, under-fire, threat,
cover or heal fact, action or goal exists**. The two rules the operator names are imperative and duplicated: the 50 %
heal lives in `commands.ts:508` (`healCycle`, called by `hunt` at `:581`) and in three driver copies
(`attack-run.ts:455`, `threat-response.ts:181`, `dag-cover.ts:189`); the "wounded → cover, critical → retreat" rule is
`brain.ts:405-433`; and `runMission` routes **`attack` to `runAttack` (`brain.ts:120`), the one mission kind that escapes
GOAP**. The migration is therefore **vocabulary + one routing line**, not a new planner: reuse the existing executors as
action bodies (`pickup` for a health crate, `standAt` for cover, `runAttack` for return fire), express the choice between
cover and fire as **cost**, and keep `goap.ts` byte-identical.

## 1. Question, decision, timebox

Restated: the soldier should *plan* "I am hurt, a crate is near, go heal" and "I am under fire, cover or shoot" from
facts and costs, not from `if (hp < 50)`. The decisions: the fact vocabulary, the action set (and which existing executor
each wraps), the goal priority ladder, and whether `goap.ts` changes (it should not). Moot only if combat stays a
bespoke loop — which is what the operator is asking to retire.

## 2. The substrate (measured)

| Piece | What exists | Line |
|---|---|---|
| Planner | `plan(start, goal, actions, ctx, opts)`, `chooseGoal`, `Fact = boolean\|number\|string`, equality `pre`, absent fact = false, stable tie-break, injected `now` | `goap.ts:1-131` |
| Facts | `at`, `avail:<pickup>`, `hasKey:<id>`, `holding:<id>`, `doorOpen:<id>`, `doorLocked:<id>`, `hasWeapon`, `hasAmmo` | `state.ts:119-136` |
| Actions | `groundActions`, `standAt`, `goTo`, `goToDoor`, `rideTo`, `ride`, `unlock`, `pickup`, `estimateSeconds` | `actions.ts:98-456` |
| Goals | `retrieve`, `reach`, `standAt`, `armUp`, `idle` (priorities 5, 3, …, `idle` lowest) | `goals.ts:16-83` |
| Routing | `runMission`: `goal`→`runBrain`, `stand`→`runBrain(standAt)`, **`attack`→`runAttack`**, `patrol`→`reach` loop | `brain.ts:110-131` |
| Cover/aim | `evaluateCover`, `findCoverPoints`, `nearestCover`, `shutDoorBoxes`; `sampleAim`, `aimSigma`, `turnToward`, `burstScheduler` | `cover.ts`, `aim.ts` |

The planner already supports everything the two rules need: a goal's `want` is a fact set, an action's `usable` can test
reachability, and `cost` can be a function of the state — so **"cover or fire" is a cost comparison** (the F.E.A.R.
chapter's "cost is the design knob"), not a branch.

## 3. The two rules today

| Rule | Where | Shape |
|---|---|---|
| hp ≤ 50 → health crates to 100 | `commands.ts:508-535` `healCycle`, called by `hunt` (`:581`) | imperative loop, 120 s deadline, 8 attempts, outside-first sort, per-crate failure blacklist |
| the same rule, three more times | `tests/attack-run.ts:455-495`, `tests/threat-response.ts:181-199`, `tests/dag-cover.ts:189` | copied loops, each with its own threshold (100, 70, 100) |
| hp < 50 → cover hold; hp < 25 or ≥3 threats → retreat | `brain.ts:405-433` (`RETREAT_HP`, `threatsNear`, `retreatFrom`, `nearestCover`) | imperative branch inside `runAttack`'s loop |
| return fire | `brain.ts` attack loop's fire block | aim + burst scheduling, no GOAP |

So the heal rule exists **four times**, with **two different stop thresholds** (70 and 100), and only the `hunt` copy is
in `src/`. That duplication is the strongest argument for the migration: one goal replaces four loops.

## 4. The gap

1. **No hp facts.** `buildWorldState` takes no `hp` and produces no band; the planner cannot see "wounded".
2. **No under-fire fact.** The client sees hp *drops* (health frames) and poses, not a damage-source event; no fact
   carries "I was hit in the last N ms".
3. **No threat/cover facts.** `cover.ts` can *find* a point, but nothing tells the planner one exists or that we are in
   it.
4. **No combat actions.** There is no `seekHealth`, `takeCover`, `returnFire`, `retreat`, `reload` action.
5. **No combat goals.** `survive`, `defend`, `assault` do not exist; `attack` is routed around the planner entirely.
6. **No priority ladder** for "I am nearly dead" over "the commander said assault".

## 5. Design

### 5.1 Facts (`state.ts`)

| Fact | Meaning | Source | Lifetime |
|---|---|---|---|
| `hpHigh` | hp ≥ 70 | `world.health()` | per snapshot |
| `hpWounded` | hp < 50 | same | per snapshot |
| `hpCritical` | hp < 25 | same | per snapshot |
| `underFire` | hp dropped within 1.5 s | caller tracks the clock; passed in | derived, per plan |
| `threatVisible` | a hostile is inside 30 m with LOS | `others()` + `hasLineOfSight` | per plan |
| `threatNear` | nearest hostile < 12 m | same | per plan |
| `inCover` | LOS to `threatVisible`'s pawn is blocked from the current point | `evaluateCover` | per plan |
| `canHeal` | an available `kind: "health"` crate exists | `pickupPlacements` + `pickups()` | per plan |

Booleans, not numbers: the planner compares `pre` by equality and treats an absent fact as false, so bands are the
cheapest representation and `goap.ts` needs no numeric comparison. The clock (for `underFire`) stays with the caller —
`buildWorldState` stays pure (D3).

### 5.2 Actions (`actions.ts`) — each wraps an executor that already exists

| Action id | `pre` | `eff` | `cost` | Executor |
|---|---|---|---|---|
| `seekHealth:<crate>` | `hpWounded`, `avail:<crate>`, `at:<place>` | `hpHigh`, `avail:<crate>: false` | route m / 4 | `pickup` + `runMission(retrieve)` (already grounded) |
| `takeCover:<point>` | `underFire`, `threatVisible` | `inCover` | route m / 4, **× 0.6 when `hpWounded`** | `nearestCover` + `runMission(standAt)` |
| `returnFire:<target>` | `hasWeapon`, `hasAmmo`, `threatVisible` | `threatDown` | 8 s flat, **× 2 when `hpWounded`** | `runAttack(target)` (kept as the step body) |
| `retreat:<place>` | `hpCritical` | `safe` | route m / 4 | `runMission(reach)` |
| `reload:<crate>` | `hasAmmo: false`, `avail:<crate>` | `hasAmmo` | route m / 4 | `pickup` |

Cost is where the design lives: a wounded soldier's cover is cheap and firing is expensive; a healthy one's fire is
cheap and cover is not. That reproduces the prototype's behaviour without an `if`.

### 5.3 Goals (`goals.ts`) and the priority ladder

| Goal | `want` | Priority |
|---|---|---|
| `survive` | `hpHigh` (or `safe` when critical) | 90 when `hpCritical`, 70 when `hpWounded`, else 0 |
| `defend` | `inCover` **or** `threatDown` | 60 when `underFire` |
| `assault:<target>` | `threatDown` | 50 (the commander's default order) |
| `rearm` | `hasAmmo` | 40 |
| existing `retrieve`/`reach`/`armUp` | unchanged | 5 / 3 / — |

`chooseGoal` picks the highest priority goal that has a plan; if none plans, the next. The F.E.A.R. reference is exact:
**per-soldier planning is a module; the goal ladder is the supervisor** — the commander's order sets `assault`, but
`survive` outranks it when the soldier is critical, which is the "disobey to keep the mission" behaviour mission command
allows.

### 5.4 Routing

`runMission`'s `attack` case becomes `runBrain(session, assault(target))`; `runAttack` survives as the **step executor**
inside `returnFire`, so the prototype's aim/burst code is not thrown away. `hunt` drops its `healCycle` in favour of
`chooseGoal` + the `survive` plan (the same loop, now declarative).

## 6. Feasibility

| Option | Verdict | Cost | Risk | What would change it |
|---|---|---|---|---|
| **A. Add facts/actions/goals, route `attack` through the planner, keep `runAttack` as a step body** | **small-medium, recommended** | 3 files (~150 lines) + 1 test file; `goap.ts` untouched | low: the executors already exist; behaviour parity testable against `runAttack` | if parity fails on aim/burst timing, keep `runAttack` as the whole step and only add the goal above it |
| B. A separate combat planner module | **large, rejected** | new planner + state | duplicates `goap.ts`, splits the vocabulary | only if combat needs a different search shape (it does not) |
| C. Wrap the existing `if` rules as goals with one action each | **conflicts** with the ask | small | the planner becomes a label on a branch; no cost trade-off, no plan search | if the operator only wanted the rules moved, not replanned |
| D. Extend `goap.ts` with numeric comparisons | **unnecessary** | — | touches the frozen file | if hp bands ever need continuous trade-offs (then a fact function, not the planner) |

## 7. Tasks

### 7.1 Coder — the vocabulary

**Files:** `src/shared/bots/state.ts` (facts, `hp` in `WorldSnapshot`), `actions.ts` (`seekHealth`, `takeCover`,
`returnFire`, `retreat`, `reload`), `goals.ts` (`survive`, `defend`, `assault`), `test/goap-combat.test.ts` (matches the
`bot` scope via `^goap`). `goap.ts` is **not edited**; acceptance asserts `git diff src/shared/bots/goap.ts` empty.

**Tests (pure, no session):** `hp_bands_set_the_facts`; `survive_plans_a_health_crate` (wounded + crate available →
plan `['goTo', 'seekHealth']`); `defend_prefers_cover_when_wounded_and_fire_when_healthy` (the same state, two hp bands,
two plans — the cost knob); `critical_survive_outranks_assault` (`chooseGoal`); `no_plan_when_no_crate_and_hp_high`
(returns undefined, caller falls back); `return_fire_requires_weapon_ammo_and_threat`.

**Fail-first:** import fail-first for the new exports (`ERR_MODULE_NOT_FOUND`-style is not available for named exports;
the honest fail-first is the import of `assault`/`survive` from `goals.ts` failing). State it as weaker.

### 7.2 Bot-developer — the prototype before the coder

`packages/bot-client/tests/combat-goap.ts`: build the world state from the live `BotWorld` (hp, ammo, weapon, pickups,
threats, cover), call `chooseGoal`/`plan`, log the plan, and execute the steps with the existing `runMission`/
`runAttack`. Run the same scenario twice: **control** (imperative `runAttack`) and **planned** (the goal ladder). Gate:
same cover decision at hp < 50, heal initiated at ≤ 50, no regression in shots landed, and the plan log shows the
cost choice (cover vs fire) flipping when hp crosses 50.

## 8. Open questions

1. **Heal stop threshold: 70 or 100?** The drivers disagree (`threat-response` 70, `attack-run`/`hunt` 100). Default in
   the design: plan to `hpHigh` (≥ 70) and let the executor continue if hp is still falling.
2. **Under-fire source:** hp delta is primary; should `threatVisible` (a hostile whose yaw points at us within LOS) also
   set `underFire`? It catches the "aimed at but not yet hit" case at the cost of false positives.
3. **Does `runAttack` get deleted or demoted?** Design keeps it as the `returnFire` body; deleting it is a later task
   once parity is proven.
4. **Commander order vocabulary:** do the squad orders become goals directly (`defend`, `survive`) or stay commands
   (`attack`, `hold`) that the soldier maps to goals? The command layer already exists; mapping in the soldier's brain is
   cheaper.
5. **Claim semantics for `defend`/`survive`:** these are self-preservation goals — they must not claim a squad target
   (`goal.id` claims would serialise them). Same bypass as mass fire.

## 9. Confidence

`verified locally` — every line reference, the fact/action/goal inventories, the four heal copies, the routing line.
`documented externally` — the F.E.A.R. decomposition and "cost is the design knob" (*Game AI: Patterns, Not Engines*,
ch. 11, read 2026-11-22). `inferred` — the cost multipliers and priorities (to be tuned by the prototype).
