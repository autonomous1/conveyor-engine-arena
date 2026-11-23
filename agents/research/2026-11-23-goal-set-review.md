# Review of the sample goal set — what fits, what the engine cannot support yet, and the expansion

| | |
|---|---|
| **Question** | Does the operator's sample goal set (7 commander goals, 6 soldier goals) fit this tree, and what should be added, merged, deferred or rejected? |
| **Decision it informs** | The final goal vocabulary the coder implements and the bot-developer prototypes — before the commander's "last known position" logic is built on an input the engine does not provide. |
| **Timebox** | 45 min (spent ~35). |
| **Window** | 2026-11-23 12:05 → 12:50 America/New_York. |
| **Read** | the sample goals; `goap.ts`/`state.ts`/`actions.ts`/`goals.ts`; `cover.ts`/`aim.ts`; `brain.ts` `runAttack`; `commands.ts`; `hitscan.ts` `LaserFrame`; `health.ts` `HealthFrame`; `fire.ts` delivery; `bot-client/world.ts`. |

## Executive summary

The set is tactically coherent — it maps almost one-to-one onto F.E.A.R.'s squad-coordinator roles
(FLANKER / SUPPRESSOR / ATTACKER / HOLD) and onto mission command's "intent, not orders" — and its **priority principle
is exactly right**: survival goals must outrank commander orders, or the flank walks into a grenade. But it assumes
three systems this tree does not have, and one of them changes the value of four goals:

1. **No teams.** `rg team src/server src/shared` returns nothing; there is no squad or team field on a pawn. Squads
   are a client-side roster. Friendly fire is therefore possible and `KillTarget` must target by roster, not by "enemy".
2. **No perception limit.** Snapshots carry **every pawn in the interest radius** — and the radius (192 m) covers the
   whole 85 m map. Every bot sees every enemy's exact position every tick. So "last known position", `SearchArea`,
   `InvestigateDisturbance` and `Ambush` describe uncertainty the simulation does not have. They only become meaningful
   with a **client-side perception layer** (FOV + LOS + a TTL contact table). That is the review's main addition.
3. **No tactical-node vocabulary.** Cover *points* can be found (`nearestCover`, `findCoverPoints`), but there is no
   chokepoint, overwatch or vantage node list; `SuppressTarget`/`HoldChokepoint` need either a hand-authored node list
   or a derived "place + cover + LOS" query.

Two goals assume mechanics that do not exist — suppression has **no status effect**, and there is **no sidearm**
(one weapon slot per pawn). One cue is already on the wire and unread: the **laser frame**
(`{t, shooter, from, to, until}`, `hitscan.ts:107-113`) is broadcast to every client that sees the shooter
(`fire.ts:112-115`), and the bot lane drops it — that is the gunfire source for `InvestigateDisturbance` and for
"aimed at me". Recommendation: adopt the ladder with six changes, add the perception/contact layer and the roster, and
defer suppression-as-status and the sidearm.

## 1. Every input the sample assumes, against the tree

| Input the sample names | Available? | Source |
|---|---|---|
| Squad membership / teams | **No** | client roster only; `loadArena` has 13 npc + 3 player, no `team` |
| Last known player position | **No** (current pose only) | `others()` gives exact poses every snapshot |
| Line-of-sight status | **Yes** | `hasLineOfSight`, `hasLineOfSightDag`, `evaluateCover` |
| Squad headcount | **Yes** | `healthOf`/`others()` + roster |
| Cover availability | **Yes (points, not nodes)** | `nearestCover`, `findCoverPoints`, `evaluateCover` |
| Gunfire cue | **On the wire, unread** | `LaserFrame` broadcast; bot lane has no `laser` case |
| Grenade / hazard | **Yes** | `GrenadePose` frames + `stepGrenade` prediction |
| Ammo / weapon | **Yes** | `world.ammo()`, `world.weapon()` |
| Doors / keys / places | **Yes** | `doorBody`, `keys()`, `placeOf`, scene-graph places |

## 2. Verdict on each sample goal

| Sample goal | Verdict | Why / what changes |
|---|---|---|
| **AdvanceToThreat / CloseDistance** | **adopt** as `assault:<target>` | `runAttack` already closes; the target comes from the roster |
| **SuppressTarget** | **adopt with change** | no suppression status exists: it is "fire at the contact point"; the pinning effect is emergent from the enemy's own `TakeCover` goal |
| **FlankTarget** | **adopt with change** | "outside the view cone" needs the enemy's yaw (snapshots carry rotation) + a cover/stand point; feasible with `standAt`/`path` |
| **SearchArea** | **adopt only after perception** | with omniscient snapshots there is nothing to search; needs contact memory + a stale-contact TTL |
| **HoldChokepoint / Overwatch** | **adopt with change** | no node list: use a place + `standAt` + a LOS/cover query, or author 5–10 nodes |
| **Regroup / FallBack** | **adopt** | `reach` to the squad anchor; already expressible |
| **InvestigateDisturbance** | **adopt with change** | audio is not replicated; the laser frame is the wired cue. Footsteps/physics impacts are not available |
| **DodgeHazard** | **adopt, highest priority** | feasible now: `GrenadePose` + blast radius + `walk`; a one-step plan at ~95 priority |
| **TakeCover** | **adopt** | the `defend` goal from the previous report; `nearestCover` + `standAt` |
| **KillTarget** | **adopt** | `returnFire` action wrapping `runAttack`; "lost" is a perception fact, not a distance timeout |
| **ManageWeapon** | **adopt for reload; defer the sidearm** | one weapon slot (`createPawnKit` has one weapon + ammo); reload/ammo exists |
| **Ambush / WaitForTarget** | **adopt only after perception** | omniscience means the bot already knows; ambush is the *absence* of a fact (enemy approaching a door it cannot see) |
| **Patrol / Idle** | **adopt** | exists (`idle`, `patrol`) |

## 3. The expansion (the goal set to implement)

### Soldier ladder (autonomous, per 2 Hz plan selection)

| Priority | Goal | `want` | Actions |
|---:|---|---|---|
| 95 | `dodgeHazard` | `safe` | `walk`/`path` out of the blast ring (one step) |
| 90 | `survive` (critical) | `hpHigh` | `seekHealth:crate`, `retreat:place` |
| 80 | `heal` | `hpHigh` | `seekHealth:crate` (stop at 70; see open questions) |
| 70 | `defend` | `inCover` or `threatDown` | `takeCover`, `returnFire` (cost decides) |
| 60 | `assault:<target>` | `threatDown` | `returnFire`, `takeCover` |
| 55 | `manageWeapon` | `hasAmmo` | `reload:crate` |
| 30 | `ambush:<point>` | `enemyAt:<place>` (perception) | `standAt` + wait |
| 10 | `patrol` / `idle` | route done | `reach` loop |

### Commander roles (orders, priority 40–55 so the ladder can pre-empt)

| Order | Goal it sets on the soldier | F.E.A.R. role |
|---|---|---|
| `advance` | `assault:<contact>` | ATTACKER |
| `suppress` | `fireAt:<contactPoint>` (no status) | SUPPRESSOR |
| `flank` | `takeCover:<flankPoint>` then `assault:<contact>` | FLANKER |
| `hold` | `standAt:<node>` | HOLD |
| `search` | `patrol:<places>` around a stale contact | — |
| `regroup` | `reach:<anchor>` | — |
| `investigate` | `reach:<cuePoint>` | — |

**Priority rule:** a commander order is a goal at 40–55; `dodgeHazard` (95) and `survive`/`heal` (80–90) pre-empt it.
That is the operator's principle implemented as `chooseGoal`'s priority function, not as a branch.

### The three additions the sample is missing

1. **Perception layer (client-side).** A `ContactTable` per squad: `{enemyId, x, z, place, at, by}`, updated when an
   enemy is inside FOV (say 120°) + LOS and within range (say 40 m), expiring after a TTL (say 5 s). Without it,
   `search`, `investigate`, `ambush` and "last known position" are fiction on top of exact data. With it, they are plans
   over facts. No host change: every client already has the poses.
2. **Roster/team table.** `{botNumber, squad, pawnId, role}` — the commander's roster (already planned) becomes the
   authoritative "who is mine". `KillTarget` targets = pawns not in my squad; friendly fire is prevented by the
   commander's target selection, not by the host.
3. **Node vocabulary.** `cover` points exist as a query; `chokepoint`/`overwatch`/`vantage` do not. Cheapest: derive
   `hold` nodes as (place, cover point with LOS to the approach) and cache 5–10 per map; do not build a node editor.

## 4. What the engine would need for the sample to be literally true

| Sample assumes | Cheapest honest fix | Cost |
|---|---|---|
| Enemies are only known when seen | client-side perception + TTL contact table | **S** (bot lane only) |
| Squads exist | client roster (no host change) | **S** |
| Suppression pins the enemy | make it emergent: enemy's `defend` goal reacts to fire | **S** (already the enemy's plan) |
| Tactical nodes | derived hold/flank nodes from cover queries | **S–M** |
| Audio footsteps/physics | the laser frame only; footsteps are not replicated | **M/L** (new host sound events) |
| Sidearm | single weapon slot | **M** (loadout model change) |

## 5. Feasibility

| Option | Verdict | Why |
|---|---|---|
| **A. Adopt the ladder + perception + roster, defer suppression-status and sidearm** | **recommended** | everything in the sample that matters becomes a plan over facts; two goals are restated honestly |
| B. Adopt the goals without perception | **cheap but hollow** | `search`/`investigate`/`ambush` would be theatre; the commander would know everything |
| C. Host-side fog of war / team field | **large, authority change** | a kernel-adjacent change to replication; not needed for the prototype |
| D. Implement suppression as a status effect and a sidearm | **large, wrong order** | mechanics the arena does not model; the enemy's goals give the behaviour for free |

## 6. Tasks

1. **Bot-developer (prototype, now):** `packages/bot-client/tests/perception-probe.ts` — build the FOV+LOS contact table
   from live snapshots, log `seen/lost` transitions for two pawns, and measure the TTL that matches a 20 Hz game.
2. **Coder (vocabulary):** the facts/actions/goals from `2026-11-23-goap-combat-migration.md` plus `dodgeHazard`,
   `manageWeapon`, `ambush`; the `ContactTable` module; `test/goap-combat.test.ts`.
3. **Coder (commander):** the role assignment over the roster and `ContactTable`, emitting the orders in §3.
4. **Deferred:** suppression status, sidearm, footsteps/audio events, host-side fog.

## 7. Open questions

1. **FOV angle and range for the perception layer** — 120°/40 m is a guess; the prototype measures what makes the hall
   fight legible.
2. **Heal stop** — 70 (`threat-response`) or 100 (`attack-run`, `hunt`)? The ladder says `hpHigh` (≥ 70) with the
   executor continuing while hp falls.
3. **May the commander use exact poses at all?** If the perception layer is the honest view, the commander should be
   blind the same way; if not, it is an oracle with a squad. Default: commander uses the same `ContactTable`.
4. **Suppression as an order** — if it has no status, is it worth an order, or is it just `assault` with a fire-only
   action? Default: keep it as `fireAt` for the cost table, not a role.
5. **Node count** — how many derived hold nodes per squad (5? 10?) before the plan search blows up: the action set grows
   with nodes, so costs must stay ordered.

## 8. Confidence

`verified locally` — every input table row, the laser broadcast, the single weapon slot, the absence of team/contact
state. `documented externally` — F.E.A.R.'s roles and goal-stack supervisor, mission command intent
(*Game AI: Patterns, Not Engines* ch. 11; Wikipedia *Mission command*), the blackboard's squad-shared scope with
timestamps (ch. 9). `inferred` — the FOV/range/TTL numbers and the priority weights.
