# Brain-as-JSON — the full transition scope (policy + doctrine)

| | |
|---|---|
| **Question** | What exactly moves out of `packages/bot-client/proto/` into a JSON brain — weights, thresholds, small logical expressions, no TS code — so brains can be edited, versioned, selected by role/risk and later evolved? |
| **Decision it informs** | The transition plan the designer turns into tasks: which values move, in what order, and what stays code. |
| **Timebox** | 70 min consolidated (transition 60 + audit 40). |
| **Window** | 2026-11-28 11:10 → 12:35 America/New_York. |
| **Consolidates** | `2026-11-28-proto-heuristics-audit.md` (the per-value appendix), `2026-11-24-goap-planner-fit.md` (the seam costs), `2026-11-25-goal-details-five.md` (the goal semantics). |

## Executive summary

The decision surface is **≈100 heuristic items across four files** — `brain.ts` (~48), `commands.ts` (~25),
`combat.ts` (~15), `predict.ts` (2); the rest of the folder is model or plumbing. Of those, **15 are planner policy**
(facts, goals, priorities, costs), **65 are executor doctrine** (timers, attempts, ranges, retreat rules, hold
discipline), and **21 are mechanism or excluded** (point-dedupe epsilons, data caps, the WebSocket/CLI layer). The
brain-only audit that came first saw 32 and missed two layers: `brain.ts`'s function-local attack constants (`:456-472`)
and `commands.ts`'s handler doctrine (`defend` posture, `arm`/`reload` attempts, `hunt`/`patrol` minutes, `walk`/`stand`
timeouts, `projectile` band sweep). The JSON brain therefore needs **two tiers** — `policy` (what to plan) and
`doctrine` (how long/how far/how patient) — with code keeping observation, navigation, the 12 step binders and the plan
loop. Recommendation: **doctrine first** (65 values, zero behaviour change, JSON-tunable risk), then policy (parity
against `combat.ts`), then role selection, then the GA — which is already viable because `memoryPair()` gives an
in-process host and the host's RNG is seeded. **Ownership: the bot-developer owns P0–P3 as rapid prototypes** (in
`packages/bot-client/proto/` and tracked drivers); each proven phase is then handed to the **coder** to productionize
(placement, headers/tags, codemap, tests) and retire the prototype path.

## 1. The full decision surface (measured)

| File | Lines | Class | Heuristic items |
|---|---:|---|---:|
| `brain.ts` | 2,426 | decision core + executors | ~48 |
| `commands.ts` | 1,901 | doctrine + executors | ~25 |
| `combat.ts` | 518 | decision core (policy) | ~15 |
| `predict.ts` | 99 | decision-adjacent | 2 |
| `missions.ts` | 82 | grammar | 0 |
| `world.ts` | 561 | model | 2 caps (excluded) |
| `connection.ts`, `input.ts`, `cli.ts`, `mailbox.ts`, `socket.ts`, `node-socket.ts` | 893 | plumbing | excluded |

### 1.1 `brain.ts` — 23 top-level params, 12 attack locals, ~14 inline

| Group | Values (line) | Drives |
|---|---|---|
| loop cadence | `STEP_MS`, `REPLAN_MS 5000`, `PLAN_BUDGET_MS 600`, `THREAT_PLAN_BUDGET_MS 1500`, `COLD_PLAN_BUDGET_MS 4000` (`:42-78`) | replan cadence, plan budget |
| pursuit | `PURSUE_REPLAN_MS 200`, `PURSUE_DRIFT_M 1`, `PURSUE_WINDOW_MS 400`, `PURSUE_LEAD_M 6`, `PURSUE_SPEED` (`:80-87`) | aim lead and re-aim cadence |
| ride | `RIDE_SUMMON_MS 30k`, `RIDE_WAIT_MS 60k`, `RIDE_NEAR_M 0.6` (`:43-45`) | summon patience, arrival |
| waiters | `GRAPH_WAIT_MS 1500`, `USE_WAIT_MS 1000`, `PICKUP_WAIT_MS 2000` (`:88-97`) | executor patience |
| geometry | `STAND_TOLERANCE 0.35`, `STAND_GOAL_Y 0.6`, `DOOR_REACH 1.5`, `RAISED_EPS 0.05` (`:48-91`) | arrived / at-door / floor match |
| team | `TEAM_SPREAD_R 1.2`, `TEAM_SPREAD_A 0`, `TEAM_QUEUE_M 2` (`:93-96`) | queue and stand spacing |
| **attack locals** | `FIRE_MIN_M 12`, `FIRE_MAX_M 18`, `FACE_SETTLE_MS 150`, `FACE_RAD 0.05`, `COVER_REACH_M 0.6`, `RETREAT_HP 25`, `RETREAT_THREATS 2`, `RETREAT_THREAT_M 8`, `RETREAT_ESCAPE_M 18`, `RETREAT_MAX_MS 6000`, `STANDOFF_LOG_MS 500` (`:456-472`) | engagement band, retreat, cover hold |
| inline | claim renew 10 s / TTL 30 s (`:278`), segment radius +0.05 (`:310`), use timeout 8 s (`:1452`), threat replan 1000 ms (`:1895`), takeCover commit 300 ms (`:1899`), `failStreak 2` (`:2008`), `stuckCount 2` (`:2041`), cab offset 2 m (`:2284`), dedupe 1e-3/1e-6 (`:2380`) | stalls, commit windows, elevator |

### 1.2 `commands.ts` — 4 top-level params + ≈21 handler doctrine values

| Handler | Values | Drives |
|---|---|---|
| `arm` | re-scan 8 attempts (`:482`), 60 s mission (`:493`) | arming patience |
| `reload` | `RELOAD_TIMEOUT_MS 90_000`, `RELOAD_ATTEMPTS 6` (`:630/637`), crate ranking same-place → floor → XZ (`:453`) | ammo runs |
| `hunt` | minutes default 2, range 0.5–10 (`:193-194`), per-target 60 s (`:735`) | hunt length |
| `defend` posture | minutes default 2, `radius` default 30 clamp 4–60 (`:1749`), re-stand when drift > 2 m (`:1796`), hold ≤ 30 s | posture |
| `patrol` | minutes default 3, 0.5–10 (`:206-207`), ≥ 2 places | loop length |
| `stand` / `walk` | 90 s (`:555`), 60 s/leg (`:919`), arrival 0.6 m (`:384/:1110`), stuck > 6 / > 4 (`:393/:1119`) | movement patience |
| `projectile` | throws 1–8 (`:225/:1663`), offsets `[0,±25,±50,±90,±135,180]` (`:1240`), sampler 50 ms (`:943`) | aim sweep |
| caps | `TASK_TIMEOUT_MS 180_000`, `MAX_TEXT 256` (`:26/:28`) | service limits |

### 1.3 `combat.ts` — the planner policy

`UNDER_FIRE_MS 1500`, `THREAT_M 30`, `WOUNDED_HP 50`, `CRITICAL_HP 25`, `FIRE_S 8`, `COVER_WOUNDED_MUL 0.6`,
`FIRE_WOUNDED_MUL 2`, `WALK_MPS 4`, `MIN_M 0.5` (`:32-45`); priorities survive 90 / heal 80 / defend 70 / mission 60 /
rearm 55 / idle 10 (`:410-418`); cover scan 16 angles × 2–10 m, cap 12 m (`nearestCoverPoint`); `hpPressured` bands.

### 1.4 `predict.ts` — `SNAP_M 1`, `BLEND 0.2`

Snap/blend of the motion model — aiming quality, tunable doctrine.

## 2. The boundary: policy / doctrine / mechanism

| Tier | What it is | Examples | Where it lives |
|---|---|---|---|
| **Policy** | what to plan: facts, action templates, goals, priorities, costs | `hpHigh 70`, `survive 90`, `FIRE_S 8`, cover/fire multipliers | JSON `policy` |
| **Doctrine** | how long / how far / how patient the executors are | `REPLAN_MS`, `RETREAT_HP`, `arm 8`, `defend radius 30`, `hunt minutes 2`, `SNAP_M` | JSON `doctrine` |
| **Mechanism** | contracts a value would break | 1e-3 point dedupe, 1e-6 length guard, `STEP_BINDERS`, plan loop order, observation (LOS, cover scan, hp clock), navigation | code |

**Rule for expressions:** a JSON expression may read facts and params, compare, branch and do arithmetic. It may not
call a function, loop, mutate or name a TS symbol. The loader validates; the evaluator is a small interpreter.

## 3. Precedents (external)

- **PDDL** — a domain file: predicates, `:action` with `:parameters`/`:precondition`/`:effect`, axioms (derived facts),
  numeric fluents from 2.1. Our planner is a STRIPS subset with numeric facts; the JSON mirrors this shape.
  <https://planning.wiki/ref/pddl/domain>
- **JSON Logic** — `{"op":[…]}`, data only, "no setters, no loops, no functions or gotos", "we never `eval()`", storable
  and shippable. **Decided: an in-house subset shaped like JSON Logic** (no dependency in the bot lane); the whitelist in
  §5 is the contract, and the format stays compatible with a future JSON Logic export. <https://jsonlogic.com/>
- **NEAT / GA** — for the eventual evolution over brain configs; a parameter GA (or CMA-ES) is the right first step, with
  rtNEAT as the game precedent. <https://en.wikipedia.org/wiki/Neuroevolution_of_augmenting_topologies>

## 4. Schema — two tiers, one file per brain (decided)

```
brains/
  soldier-default.json     role: soldier, risk: medium
  soldier-cautious.json    role: soldier, risk: low
  commander-flank.json     role: commander, risk: high
```

```jsonc
{
  "v": 1, "id": "soldier-default", "role": "soldier", "risk": "medium",
  "policy": {
    "params": { "hpHigh": 70, "hpWounded": 50, "hpCritical": 25,
                "underFireMs": 1500, "threatM": 30, "fireS": 8,
                "coverWoundedMul": 0.6, "fireWoundedMul": 2,
                "priorities": { "dodge": 95, "survive": 90, "heal": 80, "defend": 70,
                                "assault": 60, "rearm": 55, "regroup": 45, "idle": 10 } },
    "facts": {
      "hpHigh":     { ">=": [ { "var": "hp" }, { "var": "p.hpHigh" } ] },
      "hpWounded":  { "<=": [ { "var": "hp" }, { "var": "p.hpWounded" } ] },
      "underFire":  { "<=": [ { "var": "sinceHitMs" }, { "var": "p.underFireMs" } ] }
    },
    "actions": [
      { "id": "seekHealth", "exec": "pickup", "bind": "healthCrate",
        "pre": { "hpWounded": true, "avail": "$crate", "at": "$place" },
        "eff": { "hpHigh": true, "avail": "$crate": false },
        "cost": { "/": [ { "max": [ { "var": "p.minM" }, { "var": "routeM" } ] }, { "var": "p.walkMps" } ] } },
      { "id": "returnFire", "exec": "returnFire", "bind": "threat",
        "pre": { "hasWeapon": true, "hasAmmo": true, "threatVisible": true },
        "eff": { "threatDown": true },
        "cost": { "*": [ { "var": "p.fireS" },
                         { "if": [ { "var": "hpWounded" }, { "var": "p.fireWoundedMul" }, 1 ] } ] } }
    ],
    "goals": [
      { "id": "dodge",   "want": { "safe": true },       "priority": { "if": [ { "var": "hazardHigh" }, { "var": "p.priorities.dodge" }, 0 ] } },
      { "id": "survive", "want": { "hpHigh": true, "safe": true }, "priority": { "if": [ { "var": "hpPressured" }, { "var": "p.priorities.survive" }, 0 ] } },
      { "id": "defend",  "want": { "defended": true },   "priority": { "if": [ { "var": "underFire" }, { "var": "p.priorities.defend" }, 0 ] } },
      { "id": "assault", "want": { "threatDown": true }, "priority": { "if": [ { "var": "threatVisible" }, { "var": "p.priorities.assault" }, 0 ] } },
      { "id": "idle",    "want": {},                     "priority": { "var": "p.priorities.idle" } }
    ]
  },
  "doctrine": {
    "plan":     { "replanMs": 5000, "planBudgetMs": 600, "threatPlanBudgetMs": 1500, "coldPlanBudgetMs": 4000 },
    "pursuit":  { "replanMs": 200, "driftM": 1, "windowMs": 400, "leadM": 6 },
    "attack":   { "fireMinM": 12, "fireMaxM": 18, "coverReachM": 0.6,
                  "retreatHp": 25, "retreatThreats": 2, "retreatThreatM": 8,
                  "retreatEscapeM": 18, "retreatMaxMs": 6000 },
    "movement": { "standToleranceM": 0.35, "standGoalY": 0.6, "doorReachM": 1.5,
                  "rideNearM": 0.6, "arrivalM": 0.6, "teamSpreadM": 1.2, "teamQueueM": 2 },
    "executors": {
      "arm":        { "attempts": 8, "missionMs": 60000 },
      "reload":     { "attempts": 6, "missionMs": 90000 },
      "hunt":       { "minutes": 2, "perTargetMs": 60000 },
      "defend":     { "minutes": 2, "radiusM": 30, "holdDriftM": 2, "reStandMaxMs": 30000 },
      "patrol":     { "minutes": 3 },
      "stand":      { "missionMs": 90000 },
      "walk":       { "legMs": 60000 },
      "projectile": { "throwsMax": 8, "offsetsDeg": [0,25,-25,50,-50,90,-90,135,-135,180] }
    },
    "predict": { "snapM": 1, "blend": 0.2 }
  }
}
```

`$crate`/`$place`/`$threat` are **binding slots**: code enumerates the live entities and expands each template into a
grounded action (the current `combatActions` work). JSON never iterates the world.

## 5. Expression language

- **Whitelist (the in-house contract):** `var`, `==`, `!=`, `<`, `<=`, `>`, `>=`, `and`, `or`, `!`, `if`, `+`, `-`, `*`,
  `/`, `min`, `max`. No `map`/`filter`, no functions, no strings beyond names. The evaluator is ~100 lines, validated at
  load time, and never calls `eval`.
- **Namespaces:** `p.<param>`, facts (bare or `f.`), observation values passed as `var` (`hp`, `routeM`, `sinceHitMs`,
  `threatsNear`).
- **Validation:** depth ≤ 8, ≤ 64 nodes per expression, finite literals; every fact referenced by a goal must be
  produced by observation/derived facts/an effect; unknown `exec` is a load error.
- **Cost:** compile each expression once per brain load; the priority/cost expressions run inside the planner's
  heuristic (hundreds of times per plan), so memoise if the seam-style measurements show it.
- **Determinism:** expressions are pure; clocks arrive as observation values.

## 6. Loader and integration

1. `loadBrain(json) → { policy, doctrine }` — schema + expression validation with JSON paths in errors.
2. `observe(session)` — unchanged code: LOS, cover scan, threat pick, hp clock, ammo/weapon, roster.
3. `groundPolicy(policy, facts, session) → { actions, goals }` — binding expansion + derived facts; same
   `Action<BotCtx>[]`/`Goal[]` shapes the proto uses.
4. **Doctrine is read by the executors**: `brain.ts` walkers/attack/pursuit and `commands.ts` handlers take a
   `Doctrine` object; defaults equal today's constants, so P0 is behaviour-neutral.
5. `STEP_BINDERS` — unchanged (12 keys: `goTo`, `standAt`, `ride`, `rideTo`, `goToDoor`, `unlock`, `pickup`, `seekHealth`,
   `reload`, `takeCover`, `retreat`, `returnFire`); `exec` must name one.
6. Selection: `--brain <file>` on the driver (the file is the selection unit and the GA genome); later a role
   map (`soldier → soldier-default`).
7. Parity: P0 diffs the doctrine defaults against today's constants; P1 runs the offline matrices against `combat.ts` and
   deletes it after green. Both parity checks run **in the prototype first** — the coder's handoff re-runs them as
   production tests (§9).

## 7. Multiple brains and the GA

- **Selection** is a policy file `role → brain`; risk is a doctrine+policy bundle (`retreatHp` 25 → 35, `fireS` 8 → 6,
  `priorities.assault` 60 → 70). Two soldiers can run different brains in one squad — a live A/B.
- **Genes:** numbers addressed by JSON path (`policy.params.hpWounded`, `policy.params.priorities.defend`,
  `doctrine.attack.retreatHp`, `doctrine.executors.defend.radiusM`). Not expression shapes in v1.
- **Fitness:** from a scripted match on a fixed map and host seed; e.g. `kills − deaths/2 + objective − time·ε`, or
  lexicographic (objective, kills, time). The fixed scenario/seed is mandatory or the noise swamps the signal.
- **Harness:** `memoryPair()` gives an in-process host↔client socket (`src/app.ts:130`); the host seeds wander
  (`splitMix(20260917)`, `game.ts:995`); no bot path calls `Math.random`. Caveat: the brain reads `Date.now()` for
  deadlines and timers, so a run is reproducible only if the schedule is stable — inject a clock or accept timing noise.
- **Algorithm:** 3–5 hand-authored brains + a grid/coordinate search first; then a simple GA (population 8–32,
  20–50 generations); NEAT/CMA-ES only if it plateaus (the topology is the JSON schema, so a parameter GA is the fit).
- **Risks:** overfitting to arena-1 and the scripted scenario; fitness gaming; evaluation cost; a host RNG change
  invalidating stored scores.

## 8. Feasibility

| Option | Verdict | Cost | Risk | What would change it |
|---|---|---|---|---|
| **A. Doctrine-only JSON** (65 values, executors read params; policy stays `combat.ts`) | **small, first step** | loader + `Doctrine` type + defaults; one file | low; behaviour-neutral | if the operator needs new goals without code (then B) |
| **B. Policy + doctrine JSON** (the full two-tier schema) | **medium, end state** | loader, validator, evaluator, `groundPolicy`, parity | medium; schema/expression drift, planner cost | if expression evaluation shows in plan ms |
| C. Full templates with arbitrary binding logic | **large** | binding language | becomes code in JSON | if the action set stops changing |
| D. Generate TS from JSON | **reject** | — | code again; no editor/GA value | never |

## 9. Plan

**Ownership rule.** The **bot-developer owns P0–P3** and works as the rapid prototyper: everything lands in
`packages/bot-client/proto/` plus tracked drivers under `packages/bot-client/tests/`, and the live evidence is a
`live-*.md` report. When a phase's prototype is proven, the designer writes a **coder handoff task** citing that
report; the coder converts it to production-ready code (correct placement, four-slot headers and `@` tags, codemap,
tests, no dead prototype path) and the prototype is retired. A prototype never drifts into `src/` without that step.

| # | Bot-developer prototype (rapid) | Coder handoff (production) | Gate on the prototype |
|---|---|---|---|
| **P0 — doctrine** | `Doctrine` type + defaults (= today's constants) wired into `proto/brain.ts`, `proto/commands.ts`, `proto/predict.ts`; one soldier `brain.json` with the `doctrine` section; a JSON-edit prove-out (e.g. `retreatHp`, `defend.radiusM`, `hunt.minutes`) | move the type + loader to its production home (`packages/bot-client/src/` or `src/shared/bots/`), add tests, codemap, headers/tags | zero behaviour change; defaults parity; typecheck + scoped tests |
| **P1 — policy** | `policy` section + expression evaluator + `groundPolicy` in the proto; parity vs `combat.ts`; then `combat.ts` deleted in the prototype | port the evaluator/loader to production, production tests from the matrices, delete the dead code | offline matrices identical; one live run unchanged |
| **P2 — commander + selection** | commander `brain.json`, `--brain`/role map, two brains in one squad (A/B) | production selection path, docs, tests | two roles run their own brain; A/B measured live |
| **P3 — GA** | `memoryPair` harness, fixed seed, fitness, genome map, 5-gene sweep | move the harness to its production home (scripts or the test lane), docs | one match measured; a 20-genome sweep bounded in time |

## 10. Decisions (resolved 2026-11-28)

| # | Decision | Consequence in this plan |
|---|---|---|
| 1 | **One file per brain, with `policy` and `doctrine` sections** (not `brain.json` + `doctrine.json`) | §4 layout stays; a GA genome covers both tiers; `loadBrain` returns one object |
| 2 | **Doctrine carries the handler defaults** (`hunt.minutes`, `defend.radiusM`, …); CLI orders override them | §1.2 and the schema `doctrine.executors` block are the defaults layer; the drivers keep `--minutes`/`--radius` as overrides |
| 3 | **Team geometry is doctrine** (`teamSpreadM`, `teamQueueM`) | already in `doctrine.movement`; not commander policy |
| 4 | **In-house expression subset shaped like JSON Logic** | §5 whitelist + validator; no dependency in the bot lane |
| 5 | **Parity definition accepted** — same plan steps on the offline matrices first, then same live outcomes | P0 and P1 gates unchanged; the coder re-runs them as production tests |
| 6 | **Handoff per phase** — one coder task per proven prototype | §9: one handoff row per P0–P3; matches D4 |

No open questions remain in this report. The one residual choice is `predict.blend` (doctrine by default, not a GA gene);
it only matters when the GA runs, so P3 can revisit it without touching the schema.

## 11. Confidence

`verified locally` — every file, line, value and count in §1 (greps in the audit appendix), the 12 binders, the seeded
host, the deterministic bot plan/aim paths, `memoryPair`. `documented externally` — PDDL, JSON Logic, NEAT.
`inferred` — expression cost in the planner heuristic and GA runtime (need P0/P3 measurements).

### Appendix

- Per-value tables and the audit method: `agents/research/2026-11-28-proto-heuristics-audit.md`.
- Goal semantics the policy must reproduce: `agents/research/2026-11-25-goal-details-five.md`.
- Planner seam costs: `agents/research/2026-11-24-goap-planner-fit.md`.
