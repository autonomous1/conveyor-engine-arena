# Goal details — `survive`, `defend`, `assault`, `regroup`, `patrol`

| | |
|---|---|
| **For** | the designer, to write one bot-developer task per goal (or one task with five sections). `heal` and `rearm` are already prototyped in `packages/bot-client/proto/combat.ts`; these five are not, or are only half-wired. |
| **Why details are needed** | each goal's one-liner hides a live-fact problem: the planner satisfies goals against the **current world state**, and three of these goals currently want facts that state never produces (`defended`, a sticky `threatDown`, a non-existent `safe`), so the ladder re-plans in a loop instead of finishing. |
| **Read** | `packages/bot-client/proto/combat.ts` (379 lines), `proto/brain.ts` (loop `:1390-1470`, `firedDown` `:718/:818/:1299`, `ladderWants` `:728`, `missionTarget` `:747`), `proto/missions.ts` (patrol `:15`, `:72`), `src/shared/bots/{goap,actions,goals,state}.ts`, `src/shared/bots/cover.ts`. |

## 0. Shared rules every one of these goals must obey

**R1 — a goal's `want` must be satisfiable from the live state.** `runBrainInner` returns 0 only when
`satisfies(worldState(), goal.want)`; if a want fact exists only as an action *effect*, the plan executes once and the
ladder re-plans the same goal forever. `defend` currently wants `defended`, which no fact builder sets — that is the
first fix in §2.

**R2 — effect-only facts are fine inside a plan, not as a release test.** `safe`, `defended`, `threatDown` may be
effects, but each needs a live derivation (a fact builder rule) or a per-target check.

**R3 — `threatDown` is sticky today.** `firedDown` is set when a `returnFire` step returns 0 (`brain.ts:1299`) and is
never reset (`:718`, `:818`); after one kill, `threatDown` is true for the session and later assault/defend goals skip.
Derive it per target instead: `healthOf(target)?.dead === true || !others().some(p => p.id === target)`.

**R4 — team identity is client-side and currently wrong for arena-2.** `hostiles()` treats **players as friendly and
NPCs as enemy** (`combat.ts:68-84`). In arena-2 every squad bot is a `player`-role seat, so no enemy is ever hostile.
Introduce a `SquadView` — `{ members: Set<number>; enemies: Set<number> }` — supplied by the driver/commander (v1:
`--squad`/`--enemies` ids; later the roster) and used by `hostiles()`.

**R5 — the grounding union must cover the ladder.** `ladderWants` (`brain.ts:728`) lists only `hpHigh`, `inCover`,
`threatDown`. Add `safe`, `defended`, `at:<anchor>` when those goals exist, or a `regroup`/`survive` plan loses the key
closure for a locked-door anchor.

**R6 — no claims on self-preservation goals.** `survive`/`heal`/`defend`/`dodge` must not claim a goal id (mass fire and
squad movement would serialise); `assault` keeps the mission's claim until the commander task changes it.

## 1. `survive` — critical hp: break contact, then heal

**Intent.** At hp < 25 (or hp ≤ 50 against 2+ threats) the soldier stops trading, leaves the threat's line, and heals.
The imperative rule is `RETREAT_HP = 25`, `RETREAT_THREATS = 2` (`brain.ts:355-356`), checked at `:537`.

**Current state.** `combatGoals` has `survive` want `{hpHigh}`, priority 90 on `hpCritical` (`combat.ts:284`). Its
actions: `retreat:<point>` (pre `hpCritical`, eff `safe`, `awayPoint`), `seekHealth:<crate>` (pre `hpWounded`, eff
`hpHigh`, cost 0.01 at critical). **Because the want is only `hpHigh`, the plan is `seekHealth` — the soldier heals
under fire and the retreat action is unreachable.** `safe` is never wanted by a goal.

**Fix (the detail).**

- Add a live fact `safe`: no hostile (`SquadView.enemies`) within **12 m** with LOS to the eye, and `underFire` false,
  and no `hazardHigh` (dodge). Add it to `combatFacts`.
- Change `survive` want to `{ hpHigh: true, safe: true }`. The plan then chains `retreat` (→ safe) → `seekHealth`
  (→ hpHigh) when a threat is near, and plans `seekHealth` alone when already safe.
- Keep `retreat`'s target from `awayPoint` (8 m away from the threat, same floor); if no point, no retreat step and the
  plan is `seekHealth` only (a documented partial).
- Priority 90; `heal` 80 keeps the wounded band (`hpWounded && !hpCritical`).

**Trigger / release.** Trigger `hpCritical` (or `hp ≤ 50 && threats ≥ 2`, folded into a `hpPressured` fact).
Release when `hpHigh` (≥ 70) **and** `safe` — so a critical soldier under fire does not stop at 70 in the open.

**Edge cases.** No crate available → plan is `retreat` only; log `survive: no crate` and fall through to `defend` after
the retreat. No safe point (cornered) → `seekHealth` only, log `survive: no exit`. Dead → the mission ends; respawn is
outside this goal. Critical while a grenade is stopped nearby → `dodge` 95 pre-empts.

**Acceptance.** Offline: hp 20 + threat 8 m + crate → plan `retreat → seekHealth`; hp 20 + no threat + crate →
`seekHealth`; hp 20 + no crate → `retreat` only; hp 60 → no `survive` (heal 80); critical + assault order → `survive`
wins. Live: in a scripted fight, every critical event produces a retreat step before the heal, and no death occurs while
"healing under fire".

## 2. `defend` — under fire: cover or return fire

**Intent.** When taking fire, either break the line (cover) or suppress/kill the shooter; the cost decides, and a
wounded soldier prefers cover (`COVER_WOUNDED_MUL = 0.6`, `FIRE_WOUNDED_MUL = 2`).

**Current state.** `defend` want `{defended}`, priority 70 when `underFire && !hpCritical` (`combat.ts:289`). Actions:
`takeCover:<x>,<z>` (pre `underFire + threatVisible`, eff `inCover + defended`, cost route × 0.6 when wounded) and
`returnFire:<id>` (pre `hasWeapon + hasAmmo + threatVisible`, eff `threatDown + defended`, cost 8 s × 2 when wounded).
`combatFacts` sets `underFire` (hp drop ≤ 1.5 s), `threatVisible` (nearest hostile ≤ 30 m with LOS), `inCover` (LOS
blocked).

**The live-fact bug.** `defended` is never set by `combatFacts`, so the goal is never satisfied; after a cover step the
ladder re-plans `defend` and walks to cover again (the takeCover pre is still true while `underFire`). Fix: derive
`defended` live:

```
defended = inCover || threatDown(target) || threatGone(target)
```

where `target` is the visible threat (or the mission target). Add it to `combatFacts`.

**Fix (the detail).**

- `defended` live as above; keep both actions effecting `defended` (one goal, two actions, cost decides — the existing
  design note at `:286-288`).
- Trigger: `underFire && !hpCritical` (as today). Cover only when `threatVisible`; if the threat is gone but `underFire`
  is still hot, the goal is already satisfied (defended via `threatGone`).
- Cover point: `nearestCoverPoint` (16 angles × 2–10 m, LOS broken, same floor, ≤ 12 m). Cache the point for the cover
  step; re-evaluate when the threat moves > 2 m (add a replan reason `threat`).
- Firing: `returnFire` is the existing `runAttack` step; `usable` frozen at build (the `184 live` lesson).
- Replan triggers: add `threat` (visible-threat id or pose moved > 2 m) to the loop's reasons alongside
  doors/pickups/5 s (`brain.ts:1406-1410`).

**Trigger / release.** Trigger as above; release when `defended` true (in cover or threat down/gone) or `hpCritical`
(survive pre-empts). Commitment: hold a cover step ≥ 300 ms; do not flap between cover and fire on a 250 ms replan.

**Edge cases.** No cover point (open ground) → fire if armed; if unarmed, `rearm`/`survive`. No ammo → `rearm` (extend
`rearm`'s scope from assault-only to `defend` too, `combat.ts:290`). Threat is a squadmate → `SquadView` (R4). A cover
point behind a locked door → `usable` false, no plan (log). Grenade in the ring → `dodge` 95.

**Acceptance.** Offline: `underFire + threatVisible + cover point` → `takeCover` plan; no cover + armed → `returnFire`;
wounded → cover plan (cost flip); no ammo → `rearm`; in cover (LOS blocked) → no `defend` plan. Live: under a scripted
shot, the bot breaks LOS or fires within one step and does not oscillate (count cover-walk starts per event; expect 1).

## 3. `assault` — kill the named target

**Intent.** The commander's `attack:<id>` order becomes `assault:<id>`; the soldier pursues and fires until the target
is dead, while `survive`/`defend`/`dodge` can pre-empt.

**Current state.** `assaultGoal(target)` → `{ id: assault:<id>, want: { threatDown }, priority: 60 }`
(`combat.ts:313-315`); `combatGoals` appends the mission at 60 (`:292-295`); `returnFire:<id>` runs `runAttack(target)`
as its step body (`brain.ts:1272-1310`); `missionTarget()` parses `assault:<id>` (`:747`). `threatDown` comes from the
sticky `firedDown` (R3).

**Fix (the detail).**

- Derive `threatDown` per target live: `healthOf(target)?.dead === true` or the target is absent from `others()`.
  Remove `firedDown` from the state, or reset it whenever the mission target changes.
- Keep `returnFire:<id>`; `runAttack` already handles pursuit, reacquisition, retreat-at-25 hp, cover at < 50, and ammo
  gates — the goal only selects it. Cost 8 s × 2 when wounded keeps `defend` winning at low hp.
- Replan triggers: target moved > 2 m (add `target` reason), target gone (killed → goal satisfied), ammo 0 (`rearm` 55
  fires only for an assault mission, `combat.ts:290-291`).
- Claim: `runBrain` claims `goal.id` (`assault:<id>`) — two soldiers on one target serialise. For now keep the claim
  for a single soldier; the commander's mass fire needs the per-bot claim key (`attack:<id>#<selfId>`) in the squad
  task. State this in the task so it is not a surprise.

**Trigger / release.** Trigger: the mission is `assault:<id>` (or the commander's order). Release: `threatDown` (target
dead/gone); the mission returns 0. Pre-emption: `dodge` 95, `survive` 90, `heal` 80, `defend` 70 — all above 60.

**Edge cases.** Target dead before the mission starts → satisfied immediately (return 0, do not claim). Target
unreachable → `runAttack` returns 2/3; the mission reports it (the driver logs). Target is a squadmate → `SquadView`
prevents the order. No ammo → `rearm`; unarmed → `arm`/`getkey` (a separate order). Dead → mission ends.

**Acceptance.** Offline: visible armed target → `returnFire` action; dead target → no plan, mission satisfied; no ammo →
`rearm` plan; hp 20 + threat → `survive` wins. Live: kill a named pawn; count steps and confirm the mission returns 0
once, no re-plan after the kill (the sticky-flag bug).

## 4. `regroup` — converge on an anchor

**Intent.** The commander orders a rally point (or the soldier is isolated and falls back); the soldier walks to it and
resumes its previous duty. It is a movement goal, not a combat one.

**Current state.** Nothing. The commander is unseated (no pawn, no position), so the anchor cannot be "the commander's
pose". `reach(place)` and `standAt(point)` exist.

**Design (the detail).**

- Anchor source: the **order** names a place (`regroup:<place>`) or a point (`regroup:<x>,<z>`); v1 driver takes
  `--anchor <place>`; later the commander picks the squad's modal place or a cover-backed rally point.
- Goal: `regroup` want `{ at: <anchor> }`, priority **45**; action `reach(anchor)` (place) or `standAt(point)`.
  `at` is live (`AT` from `buildWorldState`), so the goal releases naturally.
- Add a live `isolated` fact (no squadmate within 20 m for 5 s) and allow `regroup` to fire on it *only if* the
  operator enables it (v1 default: order only).
- Priority 45 sits below `rearm` 55 and above `idle` 10; combat (70+) and survival (80+) pre-empt, and the mission loop
  resumes the anchor after the fight.

**Trigger / release.** Trigger: the order / `isolated`. Release: `at == anchor` (within 2 m) or within 8 m of ≥ 2
squadmates. Pre-emption: the ladder rules above.

**Edge cases.** Anchor behind a locked door → the plan needs the key; `ladderWants` (R5) must include `at:<anchor>` and
the grounding union must include the anchor's place, or the key closure is dropped and the plan fails. Anchor on another
floor → elevator ride (the `ride` actions); measure. Anchor not in the graph → no plan, log `regroup: bad-anchor` and
keep the previous mission. Anchor unreachable (sealed) → no plan, log, stop after one retry.

**Acceptance.** Offline: reachable anchor → `reach` plan; locked-door anchor with a key → key → unlock → reach;
unreachable → no plan; `underFire` → `defend` wins. Live: order a regroup from 30 m, measure time-to-converge and
confirm the previous mission resumes.

## 5. `patrol` — the fallback loop

**Intent.** With nothing else to do, walk a loop of places; combat pre-empts each leg and the loop resumes.

**Current state.** `missions.ts:15,72`: `patrol:<places>` is a mission kind, and `runMission` loops `reach(place)` per
leg — **there is no patrol goal in the planner** (the comment at `missions.ts:2` says so). The ladder therefore already
pre-empts each leg (each `runBrain` call re-plans with `combatGoals`), which is the behaviour wanted.

**Design (the detail).**

- Keep the mission loop as the executor (do not invent a `patrol` goal); make the *leg* a first-class part of the
  contract: `reach(<leg>)` with priority 10; `goal.id = reach:<leg>`; the mission's `place` is the leg, so
  `ladderWants`/grounding include it (R5).
- Leg completion: `placeOf(self).id === leg` **and** within 1.0 m (else a `standAt` tolerance), or the plan returns 0.
- Dwell: 0 s in v1 (a `dwellMs` option later); then next leg, wrapping.
- No plan on a leg → retry once, then skip to the next leg; stop after 2 consecutive no-plan legs or the mission
  timeout (the existing `runMission` loop already returns on a non-zero code — the task should make skip explicit).
- Resume after combat: the loop re-enters the same leg (the leg index is in `runMission`, not lost).
- Patrol is a **fallback**: priority 10, below `idle`? No — patrol above idle; idle only when there is no route.

**Trigger / release.** Trigger: the commander's `patrol` order (or the CLI scenario). Release: the mission timeout or
the commander's next order.

**Edge cases.** Leg unreachable (locked, no key) → skip, log. Leg on another floor → elevator action (measure). A patrol
leg interrupted by a kill → the ladder resumes the leg (move far from the corpse; no corpse model). The mission's `at`
token is the leg's place (R1: live `AT`).

**Acceptance.** Offline: 3 places → 3 `reach` legs; leg 2 no plan → leg 3; `underFire` mid-leg → `defend` step then
resume leg 2. Live: two full loops, no stuck-forever leg, and a combat interruption that resumes the current leg.

## 6. Priority ladder after the five goals land

| Priority | Goal | Live release fact |
|---:|---|---|
| 95 | `dodge` | no stopped grenade in the ring |
| 90 | `survive` | `hpHigh && safe` |
| 80 | `heal` | `hpHigh` |
| 70 | `defend` | `defended` (in cover or threat down/gone) |
| 60 | `assault:<id>` | `threatDown(target)` (live) |
| 55 | `rearm` | `hasAmmo` |
| 45 | `regroup` | `at == anchor` |
| 10 | `patrol` leg / `idle` | leg reached / route done |

## 7. Open questions for the designer

1. **One task or five?** The five share R1–R5 (the live-fact fixes) and one loop; I would draft **one task** for
   `survive`/`defend` because they share `safe`/`defended`, and a second for `assault`/`regroup`/`patrol` (orders and
   anchors). D4 (one extraction per task) does not apply — no extraction.
2. **`safe` definition** — 12 m + LOS + not under fire; if the operator wants a tighter "out of sight" rule, the cover
   scan already answers it.
3. **`regroup` isolation rule** — order-only in v1; enable the 20 m/5 s rule only if the run shows lost soldiers.
4. **`patrol` skip vs stop** — skip a bad leg twice, then stop; confirm.
5. **Team identity** — the `SquadView` source for the prototype (`--squad` ids vs the commander's roster) decides
   whether `defend`/`assault` can be tested in arena-2 at all.
