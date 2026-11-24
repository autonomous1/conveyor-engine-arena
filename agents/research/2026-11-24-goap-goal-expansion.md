# GOAP goal expansion — the feasible set, and the designer prompt

| | |
|---|---|
| **Question** | Which self-preservation / sustainment goals can the current source tree actually support, and what should the bot-developer implement first? |
| **Decision it informs** | The goal list in the next bot-developer task, and which goals are explicitly deferred with a reason. |
| **Timebox** | 45 min (spent ~35). |
| **Window** | 2026-11-24 16:34 → 17:15 America/New_York. |
| **Read** | `state.ts`, `actions.ts`, `goals.ts`, `goap.ts`, `cover.ts`, `grenade.ts`, `pickups.ts`, `health.ts`, `world.ts` (`grenades()`, `ammo()`, `healthOf()`), proto/brain.ts; prior reports `2026-11-23-goap-combat-migration.md`, `2026-11-23-goal-set-review.md`. |

## Executive summary

Eight goals are feasible **today**, in the bot lane, with executors that already exist: `heal`, `rearm`, `survive`,
`dodgeHazard`, `defend`, `assault`, `regroup`, and the existing `patrol`/`idle` fallback. One more is feasible but needs
a small ingestion step first (`investigate` ← the laser frame, which is broadcast and unread), and four are **deferred**
because the tree lacks the system they assume: `search`/`ambush` (no perception/fog), `suppress` (no suppression
status), `manageWeapon`'s sidearm (one weapon slot), `holdChokepoint` (no tactical-node vocabulary). One honesty check on
`dodgeHazard`: the client receives a grenade's **position and `stop` flag but not its velocity or fuse age**
(`GrenadePose` has no `v`/`age`), so dodging is proximity/stop-based, not predictive — feasible, with a caveat the task
must measure.

## 1. The selected set (feasible now)

| # | Goal | `want` | Priority | Facts needed | Actions | Evidence it works |
|---|---|---|---|---|---|---|
| 1 | `heal` | `hpHigh` (≥70) | 80 | `hpWounded`, `canHeal`, `avail:<crate>` | `seekHealth:crate` (pickup/retrieve) | `healCycle` (`commands.ts:508-535`) already loops health crates; `retrieve` is a GOAP goal |
| 2 | `rearm` | `ammoHigh` (≥30) | 55 | `ammoLow` (<10), `avail:<ammo>` | `reload:crate` (pickup) | `AMMO_PICKUP = 30` (`pickups.ts:17`), `addAmmo`, `pickup` action sets `HAS_AMMO` |
| 3 | `survive` | `hpHigh` or `safe` | 90 | `hpCritical` (<25), `threatNear` | `retreat:place` (reach), then `seekHealth` | `retreatFrom` + `RETREAT_HP` (`brain.ts:313, 405-433`) |
| 4 | `dodgeHazard` | `safe` | 95 | `hazardNear` (grenade within `GRENADE_BLAST_RADIUS = 10 m`), `hazardStopped` (`stop === true`) | `walk`/`path` to a point outside the ring | `world.grenades()` + `grenadeBlastDamage(distance)`; **no velocity/age** in `GrenadePose` (`grenade.ts:175-184`) |
| 5 | `defend` | `inCover` or `threatDown` | 70 | `underFire`, `threatVisible`, `coverKnown` | `takeCover` (`nearestCover` + `standAt`), `returnFire` (`runAttack`) | `nearestCover` (`cover.ts:140`), `runAttack` (`proto/brain.ts:316`) |
| 6 | `assault:<target>` | `threatDown` | 60 | `threatVisible`, `hasWeapon`, `hasAmmo` | `returnFire:target` (`runAttack`) | `runAttack` is the proven attack loop |
| 7 | `regroup` | `at:<anchor>` | 45 | `squadAnchor` (a place id or point) | `reach(anchor)` | `reach` goal exists; anchor must come from squad status (commander is unseated) |
| 8 | `patrol` / `idle` | route done | 10 | — | `reach` loop / none | exists (`goals.ts`, `missions.ts`) |

## 2. Feasible with one small addition

| Goal | Missing piece | Size |
|---|---|---|
| `investigate:<point>` | the **laser frame** is broadcast (`fire.ts:112-115`, `{shooter, from, to, until}`) and the bot lane drops it; add `world.applyLaser` → `heardShotAt` (point + time) | **S** (bot lane only) |

## 3. Deferred, with the reason

| Goal | Why not now |
|---|---|
| `search` / `ambush` | snapshots are omniscient (every pawn, 192 m radius); the perception/contact table does not exist — the goal would be theatre |
| `suppress` | no suppression status in the game; it is a `fireAt` action, not a goal |
| `manageWeapon`'s sidearm | one weapon slot per pawn (`createPawnKit`); reload is the only option |
| `holdChokepoint` / `overwatch` | cover points can be queried; chokepoint/overwatch nodes cannot — needs a derived node list |
| `killTarget` as a separate goal | absorbed by `assault:<target>` |

## 4. The designer prompt

Paste the block below into the designer session. It asks for **one bot-developer task** in the bot-client prototype
lane (`packages/bot-client/proto/`), extending the earlier combat-vocabulary prompt's list with `dodgeHazard`, `rearm`
(ammo band), `regroup`, and the explicit deferrals.

---

### Prompt (copy from here)

You are the designer. Draft **one** task for the **bot-developer** that expands the GOAP goal set to the feasible list
below, in the bot-client prototype lane. Cite `agents/research/2026-11-24-goap-goal-expansion.md` (this report) and
`agents/research/2026-11-23-goap-combat-migration.md` (facts/actions detail). Use `agents/bot-task-template.md`, put the
file in `plan/dsh-tasks/proposed/`, and hand it to the operator for routing to the bot-developer.

**Placement.** The vocabulary lives in the bot-client, not `src/shared`:

- `packages/bot-client/proto/combat.ts` (new): `combatFacts(session)`, `combatActions(session, ctx)`, `combatGoals(state)`.
- `packages/bot-client/proto/brain.ts`: merge the action arrays; call `chooseGoal(state, combatGoals(state), actions, ctx, planOpts)`
  instead of `chooseGoal(state, [goal], …)` (`:1305`, `:1310`); extend `ensureGround()` (`:720-745`) so the cache key
  covers the ladder's wants and the grounding union includes each combat target's place.
- **Do not edit `src/`, `test/`, or the kernel.**

**Goal list (implement exactly these, in this priority ladder).**

| Priority | Goal | `want` | Actions |
|---:|---|---|---|
| 95 | `dodgeHazard` | `safe` | `walk`/`path` outside a 10 m grenade ring |
| 90 | `survive` | `hpHigh` | `retreat:place`, `seekHealth:crate` |
| 80 | `heal` | `hpHigh` (≥70) | `seekHealth:crate` |
| 70 | `defend` | `inCover` or `threatDown` | `takeCover`, `returnFire` |
| 60 | `assault:<target>` | `threatDown` | `returnFire:target`, `takeCover` |
| 55 | `rearm` | `ammoHigh` (≥30) | `reload:crate` |
| 45 | `regroup` | `at:<anchor>` | `reach(anchor)` |
| 10 | `idle` / `patrol` | — | fallback |

**Facts (booleans; the state builder sets bands, the planner compares equality).** `hpHigh` ≥70, `hpWounded` <50,
`hpCritical` <25, `underFire` (hp drop within 1.5 s; the clock stays in the caller), `threatVisible`, `threatNear`,
`inCover`, `canHeal`, `ammoLow` <10, `hasAmmo`, `hasWeapon`, `hazardNear` (a grenade pose within 10 m), `hazardStopped`
(`stop === true` within the ring).

**Costs (the design knob).** Cover ×0.6 and fire ×2 when `hpWounded`; heal is free at `hpCritical` (it must win);
dodge cost is the walk metres / 4.

**Executors that already exist — wrap, do not rewrite.** `seekHealth`/`reload` → `pickup`/`retrieve`; `takeCover` →
`nearestCover` + `standAt`; `returnFire` → `runAttack`; `retreat`/`regroup` → `reach`; dodge → `path`/`walk` to a point
computed from the grenade's position and the 10 m radius.

**Known caveat to record, not hide.** `GrenadePose` has **no velocity and no fuse age** (`grenade.ts:175-184`), so
`dodgeHazard` is proximity/`stop`-based, not predictive. Measure how often it leaves the ring before the blast in the
live run; if it fails, the next task is a host-side grenade age/velocity field, not a client hack.

**Measurement and gates.**

- Offline matrices (no host): hp 30 + crate → `seekHealth` plan; hp 100 + no threat + ammo 0 → `rearm`; hp 100 +
  `underFire` → `takeCover`; hp 100 + visible enemy + armed → `returnFire`; hp 100 + grenade `stop` at 5 m →
  `dodgeHazard`; critical + assault order → `survive` wins; no crate + hp high → no plan (caller falls back).
- Ladder precedence: `dodgeHazard` > `survive` > `heal` > `defend` > `assault` > `rearm` > `regroup` > `idle`.
- Plan cost: p50/p95 ms and expansions per goal against the seam baseline (203 ms / 5 expansions); no deadline hits.
- Live parity (one seat; `runAttack` as control): heal at ≤50, cover at <50, ammo pickup when ≤10, dodge within the
  ring, no death regression, no seat leak, clean `close()`, never target the operator.

**Report and ledger.** `plan/dsh-tasks/reports/live-<date>-goal-expansion.md` with the matrices, the plan-cost table,
the dodge success rate and its caveat, and the POCS row. The driver stays tracked under `packages/bot-client/tests/`.

**Out of scope (explicit deferrals to state in the task).** Perception/contact table (`search`, `ambush`), suppression
status, the sidearm, chokepoint nodes, arena-2, the commander's order vocabulary.

---

## 5. Open questions

1. **`rearm` threshold** — 10 rounds is a guess; the arena's weapon holds 30 per pickup (`AMMO_PICKUP`). Measure.
2. **`heal` stop** — the prototypes disagree (70 vs 100). Default `hpHigh` ≥70.
3. **`regroup` anchor** — the commander is unseated and has no position; the anchor must be a place it names (or the
   squad's modal place). Decide in the task.
4. **`dodgeHazard` radius** — 10 m is the blast radius; the dodge point needs `radius + 1 m` margin, and the walk may
   need more than the fuse allows. The live run is the measurement.
5. **`investigate`** — if the designer wants it now, the task grows by the laser ingestion (one small bot-lane change);
   the goals above do not depend on it.

## 6. Confidence

`verified locally` — every executor, fact source, constant (`AMMO_PICKUP`, `GRENADE_BLAST_RADIUS`, `MAX_HP`), and line
reference. `inferred` — thresholds (`ammoLow`, `underFire` window) and the priority weights. `documented externally` —
none; the goal shapes reuse the F.E.A.R. ladder from `2026-11-23-goal-set-review.md`.
