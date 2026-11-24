# GOAP planner fit — the repo planner vs other GOAP implementations

| | |
|---|---|
| **Question** | How well does the current GOAP code (the shared planner plus `packages/bot-client/proto/brain.ts`'s use of it) fit the shape of other GOAP planners, and where does it diverge? |
| **Decision it informs** | Whether to keep the planner and fix the usage (grounding, executor binding, budget), or replace the planner core. |
| **Timebox** | 60 min (spent ~55). |
| **Window** | 2026-11-24 14:19 → 15:20 America/New_York. |
| **Read** | `src/shared/bots/goap.ts` (131 lines), `actions.ts`, `goals.ts`, `state.ts`, `proto/brain.ts` (1,666 lines), `src/brain.ts` (1,560), `test/goap*.test.ts`; measured with `loadArena()` + the real scene graph. |

## Executive summary

The planner core is a **competent classical forward A\*** — deterministic tie-break, duplicate-state g-map, admissible
`unmet × minCost` heuristic with an optional stronger one, expansion/evaluation/deadline budgets — and in structure it
matches ReGoap's planner and the F.E.A.R.-style A* skeleton. The **fit problem is the seam around it**, and it is
measurable: grounding is **goal-shaped** (49–96 actions, 48.8 ms) and a `stand` goal that needs a key it does not name
**fails to plan and burns the full 5 s deadline**; the route-accurate heuristic makes a 4-step plan **203 ms warm**
(versus **1,307 ms and a worse 8-step plan** with the default heuristic); the warm replan budget is **250 ms**, so the
safety replan routinely falls to the 4 s cold path; and the executor consumes the plan as **strings** (`id.startsWith`)
rather than action objects, so planner and executor are edited in two places. `chooseGoal` exists but the proto passes
**one goal** (`chooseGoal(state, [goal], …)`), so this is a single-goal path planner today, not a goal-arbitrating agent.
Verdict: **keep the core, fix the seams** — ground once per map, bind execution to typed action ids, default to the route
heuristic, pass the goal ladder, and raise or pre-warm the budget.

## 1. What the planner actually is (measured)

| Property | Value | Evidence |
|---|---|---|
| Search | forward A*, open list as an array with a **linear min** (deterministic `f`, then `seq`) | `goap.ts:55-103` |
| State key | all facts sorted into a string, `best` g-map, re-expansion on a better g | `goap.ts:31, 100` |
| Goals | `want` compared by equality; an absent fact is false | `goap.ts:24-28` |
| Heuristic | `max(unmet × minCost, opts.heuristic)` | `goap.ts:66-72` |
| Budgets | default `maxExpand` **2,000**, optional `maxEvaluations`, deadline checked every 64 evaluations | `goap.ts:63-96` |
| Costs | seconds; a function of `(state, ctx)` | `actions.ts` `estimateSeconds`, `routeCost` |
| Arbitration | `chooseGoal` by priority, ties by array order | `goap.ts:114-131` |
| Usage | **one goal per call** in the proto: `chooseGoal(state, [goal], …)` | `proto/brain.ts:1237, 1242` |
| Execution | hand-written state machine keyed on action ids (`goTo`, `pickup:`, `unlock:`, `standAt:`) | `proto/brain.ts:637+` |
| Replan triggers | doors change, pickups change, 5 s safety, plan exhausted | `proto/brain.ts:1206-1215` |

## 2. Measured cost (real arena, 174 places, 321 portals, 27 doors)

Command: `loadArena()` + `parseSceneGraph(web/game/scene-graph.json, view.doors)` + `createBotContext` +
`groundActions` + `chooseGoal`, from `outside` to
`brutalist-building-1-cbake-0.floor-1.hall`, key available, all doors as authored (20 locked).

| Step | Result |
|---|---|
| `createBotContext` | **1.2 ms** |
| `groundActions` for a `reach` goal | **48.8 ms**, **51 actions** |
| Plan, **default** heuristic (`unmet × minCost`) | **1,307 ms**, **99 expansions**, **8 steps** |
| Plan, **route** heuristic (`estimateSeconds`) | **203 ms**, **5 expansions**, **4 steps** |
| `retrieve:key@outside` (1 step) | 84 ms, 2 expansions |
| `stand` goal in the same hall, key not named by the goal | **96 actions, no plan, 5,002 ms** (deadline) |

Two numbers matter immediately: the **route heuristic is 6.4× faster and yields a shorter plan** (5 vs 99 expansions), and
the plan cost straddles the warm budget (`PLAN_BUDGET_MS = 250`, `proto/brain.ts:46`): **203 ms warm is under it, 528 ms on
a cold route cache is over it** — and the first plan after join is cold. The proto's "retry once at the cold budget"
(`:1242-1246`) is masking exactly this.

## 3. Fit against other GOAP implementations

| Axis | This repo | ReGoap (C#, Unity/Godot) | crashkonijn GOAP (Unity) | F.E.A.R.-style sketch |
|---|---|---|---|---|
| Planner core | forward A*, deterministic, budgeted | A* core, engine-agnostic | A*, job-system, multi-threaded | A* over action space |
| State | flat `Record<string, boolean\|number\|string>`, **equality only** | key/value facts, conditions incl. numeric comparisons (`>=`) | typed generic world states, `Comparer` conditions | flat facts, equality |
| Actions | grounded per **goal** (49–96 actions, 48.8 ms), plan-time descriptor only | static action objects with `Run` | ScriptableObject/code actions with conditions/effects | static action catalog |
| Execution | strings parsed by a hand-written state machine | action objects execute themselves | agent tick + action resolver | action objects |
| Goals | `chooseGoal` exists; **used with one goal** | goal list, deterministic or weighted-random pick | goal list with priorities, planner per agent | goal stack + priority |
| Replanning | door/pickup change, 5 s safety, exhausted → full replan; **no plan repair** | on world change, re-evaluate | on interval/timeout/callback | re-plan on state change |
| Heuristic | route-accurate `estimateSeconds` (good plans, expensive) | optional, usually cheap | optimized for many agents | simple unmet-count |
| Concurrency | single-threaded, synchronous | main thread | job system (threads) | single-threaded |
| Multi-agent | claims live **outside** the planner (host) | per-agent memory | per-agent | per-agent coordinator |
| Determinism | explicit `seq` tie-break | deterministic or weighted-random | scheduler-dependent | deterministic |
| Dependencies | none | C# lib | Unity packages | — |

**Fit verdict.** The core is **closer to ReGoap's planner than to a full agent framework**: same A*, same goal/action
shapes, same "planner returns a plan, runtime executes it". It diverges in three places:

1. **Grounding is not static.** ReGoap/crashkonijn ground a fixed action set; this repo grounds per goal and only closes
   over the pickups the goal names (plus locked-door keys for reach-shaped goals). That is why `reach` planned
   `pickup:key → goToDoor → unlock → goTo` in 4 steps, and `stand` in the same hall could not plan at all.
2. **The executor is not the action.** Other planners bind `Run` to the action; here the plan is a list of **id strings**
   and the executor matches prefixes (`goTo`, `pickup:`, `unlock:`, `standAt:`, `goToDoor:`, `ride`). Adding an action
   means editing `actions.ts`, `goals.ts` and the executor's switch — the seam the GOAP-combat migration will trip on.
3. **No arbitration in use.** `chooseGoal` is implemented but the proto passes `[goal]`; so the planner is a path
   planner. The combat ladder (`survive`, `defend`, `assault`) has nowhere to win.

The **strengths** are real and should not be traded away: route-accurate costs (a 4-step plan instead of 8), explicit
determinism, a hard expansion/deadline budget, no dependencies, and the host-side claim table — none of the other three
have claims or deadline-bounded search at this granularity.

## 4. Findings

**F1 — the core is sound.** No change to `goap.ts` is indicated by this review; it is a correct A* with the features a
game planner needs (budget, determinism, duplicate handling).

**F2 — grounding is the bottleneck and the bug.** 48.8 ms per grounding, and a goal whose route needs a key it does not
name gets no plan at all (measured: 5 s deadline, 96 actions). Fix: ground once per map/session (or close grounding over
all locked-door keys for every goal shape), then let the planner choose.

**F3 — the heuristic choice is backwards.** The default `unmet × minCost` is cheap per state but searches 99 expansions
and 1.3 s to find an 8-step plan; `estimateSeconds` finds 4 steps in 5 expansions and 203 ms. The route heuristic should
be the default, with the cheap one as the cold fallback.

**F4 — the warm budget is straddled.** A 4-step plan costs 203 ms warm and 528 ms cold; the 250 ms hot budget passes warm
and fails cold, so the first `safety` replan after join falls to the 4 s cold path (the retry exists for exactly this).
Fix either by raising `PLAN_BUDGET_MS` to ~600 ms or by pre-warming `createRoadCache` at boot (the 80 ms baseline).

**F5 — the executor is a string switch, not an action runtime.** Fine for six action families; it will not carry
`seekHealth`, `takeCover`, `returnFire`, `retreat` without a typed map. The GOAP-combat task should land
`Map<actionPrefix, executor>` in the same change.

**F6 — arbitration exists but the production path does not use it.** `chooseGoal` is tested with two goals once
(`test/goap.test.ts:208`, `armUp` vs `idle`) and returns the higher-priority plan; every other test and the proto pass a
single-element array (`proto/brain.ts:1237`). The ladder primitive works; the ladder is not wired.

**F7 — equality-only conditions force bands.** `hp >= 70` must be a `hpHigh` fact. That is consistent with the design
(and with F.E.A.R.), but it means every numeric goal needs a state-builder band, not a planner feature. Accept.

**F8 — no plan cache.** Every replan re-grounds (49 ms) and re-costs routes; the 5 s safety replan and the door/pickup
triggers repeat the same work. A cache keyed by `(goalId, stateKey)` would remove both the 49 ms and most route lookups.

## 5. Recommendation slate

1. **Keep `goap.ts`; fix the seams** (recommended): ground once per session; route heuristic by default; warm budget
   600 ms or boot-prewarmed routes; typed executor map; pass the goal ladder. Expected: plan under 250 ms warm, no 5 s
   failure, arbitration exercised.
2. **Static action set + goal-parameterised actions** (ReGoap-like): ground all places/doors/pickups once, let `usable`
   filter; costs rise with the action count (currently 49–96; all-place grounding would be ~174 places + 321 portals) —
   measure before committing.
3. **Replace the core** (crashkonijn-style, threaded): unnecessary at 16 agents; would trade determinism and claims for
   throughput the prototype does not need.

## 6. Tasks implied

| Task | Owner | Scope |
|---|---|---|
| ground-once + route heuristic + budget | coder | `actions.ts` (`groundActions`/`estimateSeconds`), `proto`/`brain` plan options; tests: `stand` in a locked hall now plans; plan ms logged |
| typed executor map | coder | `proto/brain.ts` step dispatch (or `src/shared/bots/exec.ts` if extracted) |
| goal-ladder test | coder | `test/goap.test.ts`: `survive` outranks `assault`, ties by order |
| boot route pre-warm | bot-developer/coder | measure `createRoadCache` compile at join |

## 7. Open questions

1. **Is `estimateSeconds` admissible?** It is used as `max(unmet×minCost, estimate)`; if `estimate` overestimates on some
   state, A* is no longer optimal (it still finds *a* plan). The 4-step vs 8-step result suggests it is reasonable, not
   that it is proven.
2. **Ground-all cost**: how many actions would a static set produce, and what does grounding it cost? Not measured; the
   all-place path is 174 `goTo` + doors + pickups.
3. **Plan repair vs full replan**: the current replan is cheap enough (49 ms + 203 ms) that repair is not urgent.
4. **Concurrency**: 16 agents × a 203 ms plan on one event loop is 3.2 s of planning per replan wave — the commander's
   2 Hz loop cannot replan every soldier every tick; stagger plans (as the proto already does with `REPLAN_MS`) or use
   the plan cache.

## 8. Confidence

`measured locally` — every number in §2 (commands in the appendix below), `groundActions` counts, plan steps.
`verified locally` — every line reference and the executor's string dispatch. `documented externally` — ReGoap README
(planner/agent/memory/sensors, A*, goal pick), crashkonijn README (multi-threaded, job system, visualizer), F.E.A.R.
skeleton from the GOAP chapter. `inferred` — the plan-cache and static-grounding costs (not measured).

### Appendix — the benchmark

```sh
node --import ./scripts/ts-ext-register.mjs -e '
  const {loadArena} = await import("./src/server/world-loader.ts");
  const {createBotContext, groundActions, estimateSeconds} = await import("./src/shared/bots/actions.ts");
  const {reach} = await import("./src/shared/bots/goals.ts");
  const {chooseGoal} = await import("./src/shared/bots/goap.ts");
  const {buildWorldState} = await import("./src/shared/bots/state.ts");
  const {parseSceneGraph} = await import("./src/shared/scene-graph.ts");
  const fs = await import("node:fs");
  const a = loadArena();
  const graph = parseSceneGraph(JSON.parse(fs.readFileSync("web/game/scene-graph.json","utf8")), a.view.doors).graph;
  const pickups = [{id:"key",kind:"key",model:"key.glb",amount:1,minX:-7,maxX:-6.6,minY:0.8,maxY:1.2,minZ:2.1,maxZ:2.5}];
  const doors = a.view.doors.map(d => ({id:d.id, open:false, locked:d.locked === true}));
  const start = buildWorldState({at:"outside", pickups:["key"], doors});
  const goal = reach("brutalist-building-1-cbake-0.floor-1.hall");
  const ctx = createBotContext(graph, pickups);
  const acts = groundActions(graph, pickups, [goal]);
  for (const [n,o] of [["default",{}],["route",{heuristic:estimateSeconds(goal,ctx,pickups,undefined)}]]) {
    const t = performance.now();
    const p = chooseGoal(start,[goal],acts,ctx,{deadlineMs:Date.now()+8000,now:()=>Date.now(),...o});
    console.log(n, (performance.now()-t).toFixed(1)+"ms", p?.expanded, p?.steps.length);
  }'
```
