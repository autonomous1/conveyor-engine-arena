# Designer prompt — seam-fix prototype, assigned to the bot-developer

Paste the block below into the designer session. It asks for **one** bot task (not a coder task), confined to the
prototype lane; the shared-code changes it proves are deferred to a later coder task. The report it cites is
`agents/research/2026-11-24-goap-planner-fit.md` §2–§6.

---

## Prompt (copy from here)

You are the designer. Draft **one** task for the **bot-developer** from the GOAP planner-fit review
`agents/research/2026-11-24-goap-planner-fit.md` (§2 measurements, §4 findings, §6 tasks). Use
`agents/bot-task-template.md` (this is a spike-shaped prototype run, not a coder task), put the file in
`plan/dsh-tasks/proposed/`, and hand it to the operator for routing to the bot-developer.

**Why the bot-developer and not the coder.** The measured failures are in the prototype brain
(`packages/bot-client/proto/brain.ts`) and its use of the shared planner. The bot-developer proves the fix live in the
prototype lane; the coder later ports the proven seam changes into `src/shared/bots/`. The task must say this explicitly
so the bot-developer does not edit `src/`.

**Scope (Files table).**

- `packages/bot-client/proto/brain.ts` — the prototype brain: action grounding/caching, plan options, step dispatch.
- `packages/bot-client/tests/plan-probe.ts` (new, tracked) — the driver that runs the measurements and a short command
  matrix.
- Read-only: `src/shared/bots/{goap,actions,goals,state}.ts`, `packages/bot-client/tests/command-parity.ts`.
- **Do not edit `src/`, `test/`, or the kernel.**

**The experiment — five measurements, each with a before/after.**

1. **Grounding cost and closure.** Instrument `groundActions` in the proto: `ms`, action count, and the goal shape it
   was called for. Then (a) cache the grounded set per `(goal want, stand key)` for the session, and (b) call it with a
   union of the session's goals (so a `stand` goal inherits the key pickups the `reach` shape grounds). Prove the case the
   review measured: a `stand` goal in `brutalist-building-1-cbake-0.floor-1.hall` with the key available **plans**
   instead of hitting the 5 s deadline.
2. **Heuristic default.** Compare the default `unmet × minCost` heuristic against `estimateSeconds` on the same goal:
   plan ms, expansions, step count. The review measured 1,307 ms / 99 / 8 vs 203 ms / 5 / 4; reproduce it in the proto
   and make `estimateSeconds` the default for warm replans.
3. **Budget.** Raise the warm plan budget locally (`PLAN_BUDGET_MS` in the proto, currently 250) to 600 and count
   `plan done … ms` rows, cold retries, and any 5 s deadline failures. Pre-warm `createBotContext`/the route cache at
   join if that removes the cold 528 ms.
4. **Executor binding.** Replace the id-kind parse that turns a plan step into an executor (`begin`, kind = id before `:`, `proto/brain.ts:778`; plus the `pickup:` `startsWith` at `:1198`) with a typed `Map<string, (step, session) => Promise<StepResult>>` in the proto. Prove parity on
   the 11-command matrix (`command-parity.ts` names them) and on the five action families above.
5. **Ladder.** Call `chooseGoal` with the soldier ladder (`survive`, `defend`, `assault:<target>`, `idle`) instead of
   `[goal]`, and log the chosen goal. Offline matrix (no host needed): hp 30 + no threat → `survive`; hp 80 + under fire
   → `defend`; hp 100 + visible enemy → `assault`; nothing → `idle`. Include the tie/priority assertion.

**Instrumentation (the JSON row per event).**

`{ t, event: "ground"|"plan"|"dispatch"|"ladder", goal, groundMs, actions, planMs, expanded, steps, reason,
coldRetry, chosen, alternatives }` — one NDJSON file under `plan/dsh-tasks/logs/`, plus the existing `record` lines.
The driver prints a summary table at exit: per goal, p50/p95 plan ms, expansion count, cold retries, deadline misses.

**Gates (all must be measured, not asserted).**

- The `stand`-in-locked-hall case plans within 600 ms (was: no plan, 5,002 ms).
- Warm plan p95 ≤ 250 ms after the first plan; cold plan ≤ 600 ms.
- No `no plan` caused by a missing key pickup on a route with a locked door.
- Command matrix parity: the same 11 commands return the same codes/`why` as the pre-change run; the executor map
  handles all five action families.
- Ladder matrix: all four cases choose the expected goal.
- No seat leak; one bot per trial; clean `close()`; never target the operator.

**Report and ledger.** `plan/dsh-tasks/reports/live-<date>-plan-seams.md` — the measurements table, the before/after
numbers from the review, what the coder should port into `src/shared/bots/` (the grounding closure and the executor map
are the two shared changes), and the POCS row (`packages/bot-client/tests/POCS.md`). Keep the driver tracked; `plan/`
is gitignored so the driver is the only reviewable artifact.

**Out of scope.** Anything in `src/` (the grounding closure in `actions.ts` and the executor in `brain.ts`/`proto` are
*proven* here, ported later by a coder task the designer writes from this report); new combat goals; the commander's
orders; the observer.

**Questions the designer should answer in the task, not leave open.** Which seat the probe uses (1), whether the probe
runs offline (plan-only) or live (one host session), and the exact summary table columns. The review's numbers are the
baseline: reproduce them or explain the difference.

---

## Notes for the operator

- The two changes that **cannot** be proven without `src/` are the `groundActions` closure and the `src`-side executor;
  the bot-developer's prototype should mirror them in `proto/` and leave the shared fix as a coder task. That is the
  split the pipeline expects: prototype first, port second.
- If the designer prefers one task with the coder as the executor, the same measurements apply — but the review's
  evidence (48.8 ms grounding, 5 s stand failure) was produced from the prototype brain, and the bot-developer's live
  run is the faster loop.
- The report to cite: `agents/research/2026-11-24-goap-planner-fit.md` (§2 numbers, §4 F2–F5, §6 task table).
