# Designer prompt — GOAP-combat vocabulary, bot-client placement, bot-developer task

Paste the block below into the designer session. It asks for **one bot-developer task** that builds the combat
vocabulary in the bot-client prototype lane (`packages/bot-client/proto/`), using the shared planner unchanged; the
coder's later job is to **move** the proven module, not rewrite it.

---

## Prompt (copy from here)

You are the designer. Draft **one** task for the **bot-developer** that adds the soldier's combat vocabulary to GOAP —
health-at-50, cover-or-return-fire, the survival/defend/assault ladder — from these reports:

- `agents/research/2026-11-23-goap-combat-migration.md` — the fact/action/goal design and the four duplicate heal loops.
- `agents/research/2026-11-23-goal-set-review.md` — the expanded ladder and the per-goal verdicts (the perception
  layer is out of scope here; combat goals must work with exact poses for now).
- `agents/research/2026-11-24-goap-planner-fit.md` §2/§4 — the measured seam costs the new vocabulary must fit under.

Use `agents/bot-task-template.md` (spike-shaped prototype), put the file in `plan/dsh-tasks/proposed/`, and hand it to
the operator for routing to the bot-developer.

**Placement decision (state it in the task).** The vocabulary lives in the **bot-client**, not `src/shared`:

- New module `packages/bot-client/proto/combat.ts`: `combatFacts(session)` (a `WorldState` fragment), `combatActions(session, ctx)`
  (`Action<BotCtx>[]`), `combatGoals(state)` (`Goal[]` with the priority ladder).
- Wire it in `packages/bot-client/proto/brain.ts`: merge the action arrays and call
  `chooseGoal(state, combatGoals(state), actions, ctx, planOpts)` instead of the current `chooseGoal(state, [goal], …)`
  (`:1305`, `:1310`).
- Rationale: this is the soldier brain's decision vocabulary, not engine/nav; the shared planner is used unchanged, and
  the coder later **moves** the module into `src/shared/bots/` if it is promoted. A single home avoids proto/src drift.
- **Do not edit `src/`, `test/`, or the kernel** in this task.

**Files.**

| File | Use |
|---|---|
| `packages/bot-client/proto/combat.ts` (new) | facts, actions, goals, the ladder, cost multipliers |
| `packages/bot-client/proto/brain.ts` | merge actions; pass the ladder to `chooseGoal`; extend `ensureGround` |
| `packages/bot-client/tests/combat-goap.ts` (new, tracked) | offline plan matrices + live parity driver |
| read-only | `src/shared/bots/{goap,actions,goals,state,cover,aim}.ts`, `commands.ts:508-535` (`healCycle`), `brain.ts:405-433` (cover/retreat) |

**Vocabulary (from the migration report, restate it in the task).**

- Facts: `hpHigh` (≥ 70), `hpWounded` (< 50), `hpCritical` (< 25), `underFire` (hp dropped within 1.5 s; the clock stays
  in the caller), `threatVisible`, `inCover`, `canHeal`, `hasAmmo`, `hasWeapon`.
- Actions, each wrapping an executor that exists: `seekHealth:<crate>` (`pickup`/`retrieve`), `takeCover:<point>`
  (`nearestCover` + `standAt`), `returnFire:<target>` (`runAttack`), `retreat:<place>` (`reach`), `reload:<crate>`
  (`pickup`).
- Cost multipliers: cover × 0.6 and fire × 2 when `hpWounded` (the cost table is the design knob, not an `if`).
- Goals and priorities: `survive` 90 (critical) / 80 (wounded) → `defend` 70 → `assault:<target>` 60 →
  `rearm` 55 → `idle` 10. A critical soldier must be able to refuse an assault order.
- `chooseGoal` returns the highest-priority goal with a plan; tie by array order.

**Integration detail the task must specify.** `ensureGround()` (`proto/brain.ts:720-745`) caches grounded actions by
`(graph hash, goal.want, stand key)`. With a ladder the cache key must include **the whole ladder's wants** (or the
combat action set), and the grounding union must include the place of each combat target (health/ammo crate, cover
point), or the key closure is missing and the plan fails. This is the same class of bug as the `stand`-in-a-locked-hall
case in the planner-fit report; the task should assert it is fixed for combat goals.

**Behaviour to preserve (the imperative rules, with their line refs).**

- hp ≤ 50 → fetch health crates (the prototype stops at 100, `threat-response` at 70; pick one and say why; the default
  in the migration report is `hpHigh` ≥ 70 with the executor continuing while hp falls).
- hp < 50 → take cover; hp < 25 or ≥ 3 threats → retreat (`brain.ts:405-433`).
- Return fire when armed, with ammo and a visible threat.

**Measurements and gates.**

- Offline plan matrices (no host): hp 30 + crate available → plan `[…] seekHealth`; hp 80 + `underFire` → `takeCover`;
  hp 100 + `threatVisible` + armed → `returnFire`; hp 100, no threat → `idle`; critical + assault order → `survive`
  wins; no crate + hp high → no plan (caller falls back).
- Plan cost: p50/p95 plan ms and expansions for the combat goals, against the seam report's 203 ms / 5 expansions
  baseline; no plan may hit the deadline.
- Live parity (one seat, `runAttack(target)` as control): heal initiated at ≤ 50, cover chosen at hp < 50, shots landed
  no worse, no death regression, plan log shows the cover-vs-fire choice flipping when hp crosses 50.
- No seat leak; one bot per trial; clean `close()`; never target the operator.

**Report and ledger.** `plan/dsh-tasks/reports/live-<date>-combat-goap.md` with the plan matrices, the cost table and
why, the parity table, and the POCS row. The driver stays tracked under `packages/bot-client/tests/`.

**Out of scope.** `src/` edits (the coder moves `proto/combat.ts` after the prototype proves it), the perception/contact
table, the commander's orders, suppression status, the sidearm, arena-2.

---

## Notes for the operator

- Why not a coder task: the vocabulary is still being tuned (thresholds, cost multipliers, priorities), and the live
  parity loop is the bot-developer's. A coder task now would lock in numbers the prototype has not validated. The
  designer should note in the task that the coder's follow-up is a **move + tests**, citing the prototype report.
- The one thing that leaks into `src/` eventually: if the commander also needs the combat facts (it does, for the
  ladder), the module should move rather than be copied. The task says so.
- The seam-fix task and this one both touch `proto/brain.ts`; run the seam fix first, or the combat vocabulary will be
  measured against a 250 ms budget that already fails on a 528 ms cold plan.
