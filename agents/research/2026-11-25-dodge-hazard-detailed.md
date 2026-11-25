# `dodgeHazard` — implementation-level description

| | |
|---|---|
| **For** | the designer, to turn into a bot-developer task; `heal` is already implemented in `packages/bot-client/proto/combat.ts`, and this follows that pattern exactly. |
| **Why this exists** | the one-line goal ("move out of the blast") is too coarse to draft from; the engine's grenade data is narrow (throw pose + stop pose, no velocity, no fuse), and the behaviour is a reaction race, not a plan. |
| **Read** | `packages/bot-client/proto/combat.ts` (the implemented heal/defend pattern), `src/shared/grenade.ts`, `src/server/grenade.ts`, `packages/bot-client/src/world.ts`, `proto/brain.ts`. |

## 1. What the bot actually knows about a grenade

| Data | Available | Detail |
|---|---|---|
| throw pose | **yes** | `GrenadePose{t:"grenade", id, x, y, z, yaw}` — the thrower's eye, no pitch/velocity. Broadcast to clients that see the owner (`server/grenade.ts:136`). |
| flight path | **no** | only the throw and the stop are broadcast; no per-tick poses |
| stop pose | **yes** | `{…, stop: true, n}` at the landing point (`server/grenade.ts:187-188`) |
| blast point | **stop pose** | the host blasts at the stop point with a **3D** distance (`server/grenade.ts:96-111`) |
| fuse / age | **no** | `GRENADE_LIFE_S = 4` from the throw; the client cannot know how much is left |
| damage | **yes, computable** | `grenadeBlastDamage(d, radius = GRENADE_BLAST_RADIUS = 10)`: percent = `round(100·(1−d/10)²)` clamped to [1, 100], damage = `MAX_HP·percent/100` |

Damage curve (100 hp max): **d 0 → 100 hp, 2 m → 64, 5 m → 25, 7 m → 9, 9 m → 1, 10 m → 0.** The whole value of a
dodge is inside 7 m; outside 9 m it is noise. Because the distance is 3D, a grenade one floor up/down still matters.

**Consequence for the goal:** there is no "incoming" prediction. The bot learns the blast point when the stop pose
arrives, and the fuse may be nearly spent. `dodgeHazard` is therefore **"minimise expected damage once the blast point is
known"**, not "escape before it lands". The task must say this, and the live run must measure it as such.

## 2. Facts (added to `combatFacts` in `proto/combat.ts`)

| Fact | Rule | Why |
|---|---|---|
| `hazardStopped` | any pose with `stop === true` whose 3D distance to the bot is **< 11.5 m** | blast known, inside the ring + margin |
| `hazardHigh` | the same, with `grenadeBlastDamage(d) >= 15` hp | do not dodge a 1 hp tick |
| `hazardNear` | any pose **without** `stop` whose origin is within 11.5 m | the throw pose is a weak prior (the landing is unknown; use it only to pre-position, not to commit) |

`hazardHigh` is the trigger; `hazardStopped` is the release condition; `hazardNear` may be logged only in the first
version.

## 3. Goal and action (same shape as `heal`)

```ts
// in combatGoals(): ranked above survive (90)
{ id: "dodge", want: { safe: true }, priority: (s) => (s.hazardHigh ? 95 : 0) }

// in combatActions(): one action per candidate exit point
{ id: `dodge:${x.toFixed(1)},${z.toFixed(1)}`,
  pre: { hazardHigh: true },
  eff: { safe: true },
  usable: (s, c) => Number.isFinite(metresTo(s, c, place)),
  cost: (s, c) => Math.max(MIN_M, metresTo(s, c, place)) / WALK_MPS }
```

`combatHeuristic` already handles a goal with no place (`HP-high`-style): it will use the cheapest `dodge` cost as the
floor if the action list is non-empty. No heuristic change is needed.

## 4. Safe-point selection (the algorithm to implement)

Inputs: the live `GrenadePose[]` (`world.grenades()`), the bot's feet, `world.placeOf`, `world.sceneGraph()`, the nav
`grid`/`nearestFreeCell` helpers already in `proto/brain.ts`.

1. Let `risky` = all **stopped** grenades with `grenadeBlastDamage(d) > 0` (d in 3D). If none, no action, no goal.
2. For each risky grenade `g`, sample points on a ring around `g`: 16 angles × radii `[11, 12, 13]` m, `y = g.y`.
3. Keep a sample when: `placeOf(point)` exists (walkable place), `grenadeBlastDamage(d3(point, g)) === 0` for **every**
   risky grenade (not just `g`), and `routeCost(self.place, pointPlace)` is finite.
4. If none survive step 3, retry the same ring at radii `[10.4, 10.8]` m and choose the point **minimising the sum of
   `grenadeBlastDamage` over every risky grenade** (a partial dodge is still a dodge). Log `dodge: partial`.
5. If still none, use `awayPoint(session, g)` (the existing retreat helper, 8 m away) and log `dodge: fallback`.
6. Rank survivors by **path metres from the bot** (cheapest first); ground one action per survivor (cap 4 actions; the
   planner only needs the cheapest, but the alternates let it route around a bad cell).
7. Compute the facts and actions **once per plan build** and freeze them (`usable` must not re-test a moving pawn — the
   `184 live` lesson in `combat.ts`).

Do **not** implement predictive dodging from the throw pose: without velocity/pitch the landing is unknowable, and the
stop pose is the only truth. A "pre-position when `hazardNear`" behaviour is a later, measured tweak.

## 5. Wiring: the interrupt is the hard part

The current plan loop replans only on doors/pickups/5 s (`proto/brain.ts:1206-1215`). A grenade's fuse is 4 s and the
stop pose may arrive with less than 1 s left, so a 5 s safety replan is too slow.

- **Trigger:** when `applyGrenade` stores a pose with `stop === true` inside 11.5 m, set `plan = undefined` and a
  `reason = "hazard"`; the loop's next pass replans with the ladder (`chooseCombatGoal`), where `dodge` is 95.
- **Commitment:** once a `dodge:` step starts, hold it for **300 ms** minimum; re-evaluate the safe point every 250 ms
  while the hazard persists (a new stop pose can invalidate the old point).
- **Release:** the goal is satisfied when no stopped grenade is inside 10 m (`hazardStopped` false); then resume the
  mission goal (the loop's `goal` is unchanged; the ladder simply stops choosing `dodge`).
- **Abort on death:** `health.dead` ends the loop as today.
- **Do not** let `dodge` claim a goal id (it is self-preservation; same rule as `survive`/`heal`).

## 6. Edge cases the task must pin

| Case | Behaviour |
|---|---|
| grenade at 0–2 m, stopped | 64–100 hp expected: run; if no exit, choose the point minimising damage and log `dodge: partial` (a 25 hp hit beats a 100 hp one) |
| two stopped grenades | avoid both: step 3 tests every risky grenade; rank by min-max damage |
| no walkable exit (corner, shut door) | no plan for `dodge`; the ladder falls through to `defend`/`heal`; log `dodge: trapped` with the grenade id and distance |
| grenade on another floor | 3D distance decides; do not walk vertically; the ring sample is at `g.y` and `placeOf` filters the floor |
| own grenade | `GrenadePose` has no owner; dodge it too (self-damage is real: 2 self-kills in the 5-min projectile run) |
| a grenade that explodes in flight (never stops) | no stop pose reaches the client; nothing to dodge from the data — log the pose-id disappearance as `dodge: unlanded` and treat it as out of scope for v1 |
| dodge point becomes invalid mid-walk | the 250 ms re-check replans; the commitment window prevents thrash |
| teleport/elevator during the dodge | cancel and re-evaluate (the robot is elsewhere) |

## 7. Acceptance and measurement

**Offline (no host, synthetic poses):**

- stopped grenade 5 m away → `dodge` is the chosen goal and the plan has a `dodge:` step with a point ≥ 10 m from it;
- stopped grenade 12 m away → no `dodge` goal (no `hazardHigh`);
- stopped grenade 5 m away with 1 hp expected (i.e. 9.9 m) → no `dodge` (gate 15 hp);
- two stopped grenades 6 m apart around the bot → the chosen point is ≥ 10 m from both (or the min-damage partial is logged);
- cornered (no walkable ring point) → no `dodge` plan, `dodge: trapped` logged;
- `dodge` outranks `heal`/`survive`/`defend` in `chooseCombatGoal` when `hazardHigh`.

**Live (one bot, one host; a scripted throw at the bot):**

- per hazard event log one NDJSON row: `{t, grenadeId, d0, expected0, chosen, d1, routeM, committedMs, hpBefore,
  hpAfter, outcome: "cleared"|"partial"|"trapped"|"unlanded"}`;
- **dodge success rate** = cleared (hp unchanged) / events; **damage avoided** = control (no dodge) vs dodge, same throw
  geometry; **false positives** = dodges with no blast; **time-to-clear** p50/p95;
- gate for the task: success rate measured (not a target number yet — the point of the run is the number), 0 deaths from
  a dodge that walked into a second grenade, no seat leak, clean `close()`.

## 8. Open questions for the designer

1. **Fuse visibility** — the client has no age; the task should state that the reaction window is measured, and that a
   later host field (`ageMs` in the pose) is the fix if the success rate is poor.
2. **Damage gate** — 15 hp is a guess; the run measures 5/15/25 as a sweep if cheap.
3. **Commitment window** — 300 ms; tune from the trace.
4. **Pre-position on throw** — explicitly out of v1.
5. **Should `dodge` also break line of sight (hide behind a wall) rather than only distance?** The blast is 3D and walls
   do not block damage in this model (the host blasts through geometry: `blast()` queries every living pawn in range) —
   so distance is the only recourse; say so.
