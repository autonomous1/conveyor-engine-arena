# Proto folder heuristics audit — the full decision surface for the brain JSON

| | |
|---|---|
| **Question** | Beyond `brain.ts` and `combat.ts`, where else in `packages/bot-client/proto/` are bot-decision heuristics embedded (weights, thresholds, timers, selection rules), excluding infrastructure such as the WebSocket link? |
| **Decision it informs** | The scope of the brain JSON: which files/values the loader must own, and which stay code. |
| **Timebox** | 45 min (spent ~40). |
| **Window** | 2026-11-28 11:45 → 12:35 America/New_York. |
| **Role** | the per-value appendix for the consolidated transition report `2026-11-28-brain-json-transition.md`; that report is the one the designer should read first. |

## Executive summary

The proto folder is **6,630 lines across 12 files**. Only **four** files carry bot-decision heuristics: `brain.ts`
(2,426), `commands.ts` (1,901), `combat.ts` (518), and `predict.ts` (99). `missions.ts` is a grammar (no heuristics),
`world.ts` is the state model (two data caps), and the rest — `connection.ts`, `input.ts`, `cli.ts`, `mailbox.ts`,
`socket.ts`, `node-socket.ts` — is plumbing. The previous brain-JSON audit counted **only top-level constants** and
therefore missed two large layers: (1) `brain.ts`'s **function-local attack constants** (12, `:456-472`) and ~14 inline
tolerances, and (2) **`commands.ts`'s doctrine layer** — the `defend` posture (radius 30, drift 2 m, 30 s hold), `arm`
(8 attempts, 60 s), `reload` (6 attempts, 90 s, crate ranking), `stand`/`walk`/`patrol`/`hunt` timeouts, projectile
band/offset tables. That doctrine is not the planner's policy, but it *is* behaviour the operator wants to tune without
code. Recommendation: the brain file gets **two tiers** — `policy` (facts/goals/priorities/actions, the current schema)
and `doctrine` (executor parameters read by `commands.ts`/`brain.ts`), with one loader and one parity test.

## 1. File classification

| File | Lines | Class | Why |
|---|---:|---|---|
| `brain.ts` | 2,426 | **decision core** | plan loop, attack loop, pursuit, latches, walkers, door/elevator executors |
| `commands.ts` | 1,901 | **doctrine + executors** | handler params (hunt/defend/arm/reload/patrol/stand/walk/projectile) and the selectors |
| `combat.ts` | 518 | **decision core** | facts, actions, goal ladder, priorities, costs |
| `predict.ts` | 99 | **decision-adjacent** | motion predictor blend/snap (aiming quality) |
| `missions.ts` | 82 | model | mission grammar; no heuristics |
| `world.ts` | 561 | model | state; `LANDED_CAP 16`, `MSG_RING 64` are data caps |
| `input.ts` | 117 | plumbing | frame cadence; excluded |
| `connection.ts` | 494 | plumbing (WS) | reconnect/handshake timers; excluded per the question |
| `cli.ts` | 248 | plumbing | arg defaults; excluded |
| `mailbox.ts` | 154 | plumbing | recorder; excluded |
| `socket.ts` / `node-socket.ts` | 21 / 9 | plumbing | transport; excluded |

## 2. Inventory (method: `rg` for top-level and function-local `UPPER_CASE` consts + inline numeric comparisons)

### 2.1 `brain.ts` — 23 top-level params + 12 attack locals + ~14 inline

| Group | Values (line) | Drives |
|---|---|---|
| loop cadence | `STEP_MS`, `REPLAN_MS 5000`, `PLAN_BUDGET_MS 600`, `THREAT_PLAN_BUDGET_MS 1500`, `COLD_PLAN_BUDGET_MS 4000` (`:42-78`) | when to re-plan, how long a plan may take |
| pursuit | `PURSUE_REPLAN_MS 200`, `PURSUE_DRIFT_M 1`, `PURSUE_WINDOW_MS 400`, `PURSUE_LEAD_M 6`, `PURSUE_SPEED` (`:80-87`) | aim lead, re-aim cadence |
| ride/elevator | `RIDE_SUMMON_MS 30k`, `RIDE_WAIT_MS 60k`, `RIDE_NEAR_M 0.6` (`:43-45`) | summon patience, arrival tolerance |
| waiters | `GRAPH_WAIT_MS 1500`, `USE_WAIT_MS 1000`, `PICKUP_WAIT_MS 2000` (`:88-97`) | executor patience |
| geometry | `STAND_TOLERANCE 0.35`, `STAND_GOAL_Y 0.6`, `DOOR_REACH 1.5`, `RAISED_EPS 0.05` (`:48-91`) | "arrived", "at door", floor match |
| team | `TEAM_SPREAD_R 1.2`, `TEAM_SPREAD_A 0`, `TEAM_QUEUE_M 2` (`:93-96`) | queue/stand spacing |
| attack locals | `FIRE_MIN_M 12`, `FIRE_MAX_M 18`, `FACE_SETTLE_MS 150`, `FACE_RAD 0.05`, `COVER_REACH_M 0.6`, `RETREAT_HP 25`, `RETREAT_THREATS 2`, `RETREAT_THREAT_M 8`, `RETREAT_ESCAPE_M 18`, `RETREAT_MAX_MS 6000`, `STANDOFF_LOG_MS 500` (`:456-472`) | engagement band, retreat, cover hold |
| inline | claim renew 10 s / TTL 30 s (`:278`), player-on-segment radius +0.05 (`:310`), use timeout 8 s (`:1452`), threat replan 1000 ms (`:1895`), takeCover commit 300 ms (`:1899`), `failStreak 2` (`:2008`), `stuckCount 2` (`:2041`), cab offset 2 m (`:2284`), point dedupe 1e-3/1e-6 (`:2380`) | stalls, commit windows, elevator cab |

### 2.2 `commands.ts` — 5 top-level + handler doctrine (~18 values)

| Handler | Values | Drives |
|---|---|---|
| `arm` | re-scan `8` attempts (`:482`), `60_000` mission (`:493`) | arming patience |
| `reload` | `RELOAD_TIMEOUT_MS 90_000`, `RELOAD_ATTEMPTS 6` (`:630/637`), crate ranking (same place → same floor → XZ, `:453`) | ammo runs |
| `hunt` | minutes default 2, range 0.5–10 (`:193-194`), per-target mission `60_000` (`:735`) | hunt length |
| `defend` | minutes default 2, `radius` default 30 clamp 4–60 (`:1749`), hold drift `> 2 m` → re-stand (`:1796`), hold re-stand `≤ 30_000` | posture |
| `patrol` | minutes default 3, 0.5–10 (`:206-207`), ≥ 2 places | loop length |
| `stand` / `walk` | `90_000` stand (`:555`), `60_000` per leg (`:919`), arrival `0.6 m` (`:384/:1110`), stuck `> 6` / `> 4` (`:393/:1119`) | movement patience |
| `projectile` | throws 1–8 (`:225/:1663`), offset table `[0,±25,±50,±90,±135,180]` (`:1240`), sampler 50 ms (`:943`) | aim sweep |
| task span | `TASK_TIMEOUT_MS 180_000`, `MAX_TEXT 256` (`:26/:28`) | caps |

### 2.3 `combat.ts` — 9 params + 4 priorities + 2 multipliers + scan

`UNDER_FIRE_MS 1500`, `THREAT_M 30`, `WOUNDED_HP 50`, `CRITICAL_HP 25`, `FIRE_S 8`, `COVER_WOUNDED_MUL 0.6`,
`FIRE_WOUNDED_MUL 2`, `WALK_MPS 4`, `MIN_M 0.5` (`:32-45`); priorities survive 90 / heal 80 / defend 70 / mission 60 /
rearm 55 / idle 10 (`:410-418`); cover scan 16 angles × 2–10 m, cap 12 m (`nearestCoverPoint`); `hpPressured` bands.

### 2.4 `predict.ts` — `SNAP_M 1`, `BLEND 0.2`

The motion model snap/blend. Not a plan decision, but it sets how much the bot trusts its own prediction while aiming —
tunable doctrine.

## 3. What this changes for the brain JSON

The previous schema had one tier. The audit says **two**:

```jsonc
{
  "policy":   { "params": {...}, "facts": {...}, "actions": [...], "goals": [...] },
  "doctrine": {
    "plan":     { "replanMs": 5000, "planBudgetMs": 600, "threatPlanBudgetMs": 1500 },
    "pursuit":  { "replanMs": 200, "driftM": 1, "windowMs": 400, "leadM": 6 },
    "attack":   { "fireMinM": 12, "fireMaxM": 18, "coverReachM": 0.6,
                  "retreatHp": 25, "retreatThreats": 2, "retreatThreatM": 8,
                  "retreatEscapeM": 18, "retreatMaxMs": 6000 },
    "movement": { "standToleranceM": 0.35, "standGoalY": 0.6, "doorReachM": 1.5,
                  "rideNearM": 0.6, "arrivalM": 0.6 },
    "executors": {
      "arm":    { "attempts": 8, "missionMs": 60000 },
      "reload": { "attempts": 6, "missionMs": 90000 },
      "hunt":   { "minutes": 2, "perTargetMs": 60000 },
      "defend": { "minutes": 2, "radiusM": 30, "holdDriftM": 2, "reStandMaxMs": 30000 },
      "patrol": { "minutes": 3 },
      "stand":  { "missionMs": 90000 },
      "walk":   { "legMs": 60000 },
      "projectile": { "throwsMax": 8, "offsetsDeg": [0,25,-25,50,-50,90,-90,135,-135,180] }
    },
    "predict": { "snapM": 1, "blend": 0.2 }
  }
}
```

- **Policy** is the planner's input (facts/goals/actions/priorities) — the prior report's schema, unchanged.
- **Doctrine** is read by the executors (`brain.ts` walkers/attack, `commands.ts` handlers) through a typed params object.
  It is the layer the operator wants for "risk taking" (retreat hp, fire band, cover discipline) without touching the
  planner.
- **Mechanism** stays code: point dedupe epsilons, `1e-6` length guards, the step binders, the state builders.

## 4. Counts (from the greps in §2)

| File | Heuristic items | Policy | Doctrine | Excluded (mechanism/plumbing) |
|---|---:|---:|---:|---:|
| `brain.ts` | ~48 | 0 (executor) | 40 | 9 |
| `commands.ts` | ~25 | 0 | 23 | 2 |
| `combat.ts` | ~15 | 15 | 0 | 0 |
| `predict.ts` | 2 | 0 | 2 | 0 |
| `world.ts` | 2 | 0 | 0 | 2 (caps) |
| others | ~8 | 0 | 0 | 8 (infra) |
| **total** | **≈100** | **15** | **65** | **21** |

The earlier brain-JSON report surfaced 32 (23 + 9); the full audit finds **≈100**, with **65 doctrine values** that are
not in the planner at all. That is the answer to the question: the decision surface is roughly **three times** what the
brain-only audit saw.

## 5. Recommendation

1. **Scope the JSON to policy + doctrine, not mechanism.** The two-tier schema above; one `brain.json` per role/risk,
   the doctrine values read by the executors via a params object.
2. **Land doctrine first (P0).** It is the larger, lower-risk half: wire the ~65 values into `brain.ts`/`commands.ts`
   behind a `BrainDoctrine` type with defaults equal to today's constants. Zero behaviour change; a JSON edit then tunes
   timers/attempts/ranges without code.
3. **Then policy (P1).** Facts/actions/goals with the expression layer from the prior report; parity against `combat.ts`.
4. **Exclude `connection.ts`, `input.ts`, `cli.ts`, `mailbox.ts`, `socket*`** from both tiers, as the operator asked.
5. **Keep `missions.ts` as the mission grammar** for now; a JSON mission list is a later, separate change (it is a data
   format, not a heuristic).
6. **Ownership.** P0–P3 are **bot-developer** prototypes in `proto/` (plus tracked drivers and a `live-*.md` report); a
   **coder** productionizes each proven phase from the designer's handoff task (see the transition report §9).

## 6. Open questions

**Resolved 2026-11-28** (see the transition report §10): one file with `policy` + `doctrine` sections; handler
defaults live in `doctrine.executors` and CLI orders override them; `TEAM_SPREAD_*`/`TEAM_QUEUE_M` are doctrine;
`predict.blend` is doctrine (not a gene, revisit at P3). Remaining: **`world.ts` caps** (`LANDED_CAP`, `MSG_RING`) are
data-structure sizes, not decisions — keep code.

## 7. Confidence

`verified locally` — every file/line/value in §2 and the counts in §4 (greps in §2; counts are instances, not unique
concepts). `inferred` — the policy/doctrine split line for a few borderline values (`TEAM_SPREAD_*`, handler defaults).
`documented externally` — none in this audit; the schema/expression/GA precedents are in
`2026-11-28-brain-json-transition.md`.
