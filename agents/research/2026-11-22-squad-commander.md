# Squad commander for client bots — gap analysis and implementation plan

| | |
|---|---|
| **Question** | What is the gap between the current tree and 13 client bots in two squads, each with a commander that issues orders through an in-memory mailbox and runs its own (squad-level) GOAP tasks? |
| **Decision it informs** | The phase plan the designer turns into tasks, and the three design choices that must be settled before any code: the seat model, the claim policy for focus fire, and one process vs two. |
| **Timebox** | 75 min (spent ~70). |
| **Window** | 2026-11-22 14:20 → 15:35 America/New_York. |
| **Lane** | research only — no `src/` or `packages/` edit. |

## Executive summary

The command layer a commander needs already exists: `createCommandHost` + `parseCommand` with ten typed commands
(`packages/bot-client/src/commands.ts`), a mailbox abstraction (`mailbox.ts`), a per-bot brain (`runBrain`/`runAttack`),
and an unseated spectator connection (`connectBot({spectate:true})`). Three gaps block the design, and one of them is a
genuine conflict rather than missing code: **`runBrain` claims `goal.id` before executing**, so two squad bots ordered
onto the same target serialise on the claim `attack:<id>` — exactly the focus fire the commander exists to produce.
The others: the arena has **3 seats** (13 wander agents are role-less NPCs and a client cannot own them, `arena-host.ts:235`),
and 13 converted seats would respawn on the same 3 pads (`game.ts:1138`). The capacity cost is real: a full snapshot is
**7,596 bytes for 16 pawns** (measured), so **15 client sessions ≈ 148 KB/s each ≈ 2.2 MB/s** of host egress at 20 Hz.
The industry template is F.E.A.R.'s decomposition: **per-agent planner + a separate rule-based squad coordinator that
assigns roles + a presentation layer** — and its documented folklore error is worth repeating: GOAP did not coordinate
the squad; the coordinator did. Recommendation: five phases, starting with a four-bot capacity spike and the seat-model
change, with the claim policy settled in phase 2.

## 1. Question, decision, timebox

Restated: 16 agents today = 13 wander NPCs + 3 player pads. Swap the 13 for client bots, split into squads of 6 and 7,
add one commander per squad, give the commander an in-memory mailbox to its squad and its own squad-level task set.
The decisions: (a) how a client owns a wander agent (seat model), (b) whether squad orders bypass claims (focus fire),
(c) where the in-memory mailbox lives (one process or one per squad). Timebox 75 min; a plan is due before any task
file.

## 2. Sources

| Source | Version / date | What it gives |
|---|---|---|
| [GOAP — *Game AI: Patterns, Not Engines*, ch. 11](https://www.socratopia.app/library/game-ai-patterns-en/chapter-11) | book chapter, retrieved 2026-11-22 | the F.E.A.R. decomposition: per-soldier GOAP, **separate rule-based squad coordinator** assigning FLANKER/SUPPRESSOR/ATTACKER/HOLD, barks; the folklore correction ("GOAP made them flank" is false) |
| [Mission command](https://en.wikipedia.org/wiki/Mission_command) | rev. 2026-09-21 | centralized intent + decentralized execution; orders give effect and reason, subordinates choose how; principles list |
| [Lanchester's laws](https://en.wikipedia.org/wiki/Lanchester%27s_laws) | rev. 2026-07 | the square law: concentrating force dominates; the quantitative case for focus fire |
| [FIPA Contract Net, SC00029H](https://web.archive.org/web/20120223164111/http://www.fipa.org:80/specs/fipa00029/SC00029H.html) | Standard 2002-12-03 | allocation when two squads contend for one task (cfp → propose → accept); the claim table is the accept half |
| [Blackboards, ch. 9](https://www.socratopia.app/library/game-ai-patterns-en/chapter-9) | book chapter | squad-shared blackboard scopes; timestamps vs single-writer vs CAS for assignments |
| Local: `world-loader.ts`, `arena-host.ts`, `game.ts`, `pickups.ts`, `brain.ts`, `commands.ts`, `mailbox.ts`, `missions.ts`, `connection.ts` | HEAD 2026-11-22 | everything measured below |

## 3. Current state (measured)

**Agents and seats.** `loadArena()` gives **16 agents: 13 with `role: undefined` (wander NPCs) + 3 with `role: "player"`**.
They are built in `world-loader.ts:79-88` from `game.definition.spawnPoints` (13) and `playerSpawns` (3). The host seats a
client only on a `role === "player"` agent (`arena-host.ts:235`); beyond 3 seats it answers `SERVER_FULL`. So the arena has
**3 seats and 13 unownable NPCs** — the opposite of the goal.

**The wander loop already treats unowned player-role agents as idle.** `game.ts:1047`:
`if (agent.role === "player" && !owned.has(agent.id)) continue;` — a converted seat does nothing until a client owns it,
and owned seats take input instead of the wander steering. That is the exact behaviour the squad wants.

**Respawn would stack them.** `game.ts:1138`: `const pads = agent?.role === "player" ? playerSpawns : world.listSpawnPoints();`
— a converted seat respawns on one of the **3** player pads, not its own spawn point. 13 seats need per-agent respawn
spawns; `claimClearSpawn` picks a free pad, so 13 simultaneous respawns would fail or stack.

**Pickups follow the role set.** `arena-host.ts:462` gates pickups by `npcIds` vs `padIds` under
`npcPickupProps`/`clientPickupProps`; converting the 13 flips them from the NPC gate to the client gate. The operator's
"wander bots pick up props" problem returns unless `clientPickupProps` is off for squad seats.

**Commands and mailbox exist.** `commands.ts` exports `CommandName` (10: `arm, goto, stand, walk, reload, hunt, patrol,
retrieve, getkey, projectile`), `parseCommand`, `createCommandHost`; `mailbox.ts` exports `openMailbox` (file) and
`sendCommand`. `mailbox.poll()` returns raw strings. There is no in-memory implementation and no `attack {target}` command,
although `parseMission("attack:<id>")` exists (`missions.ts:17,24`) and `runAttack` is exported (`brain.ts:262`).

**Focus fire is blocked by the claim.** `runBrain` (`brain.ts:508-519`) claims `goal.id` before running; for an
`attack:<id>` goal the key is the target's id, so **the second bot ordered onto the same target waits for the first to
finish or times out**. Claims were designed for contention (D10); a commander ordering a mass attack needs the opposite.

**A full snapshot is 7,596 bytes** (measured: `loadArena()` + `world.commit(0n)`, 16 entities, BigInt normalised).
At 20 Hz that is **148 KB/s per client** for full snapshots; the replicator sends deltas after the handshake, so the
steady figure is lower but unmeasured. Fifteen client sessions therefore put an upper bound of about **2.2 MB/s
(~18 Mbit/s)** on host egress before health/door/elevator/claims frames.

**Commanders can watch without a seat.** `connectBot` takes `spectate?: boolean` (`connection.ts:56`) and the host's
`spectateHello` leaves the client unseated (`arena-host.ts:222-224`); the interest radius (192 m) already exceeds the map's
radius (85.5 m), so a commander sees every pawn. It has no `selfId`, which is fine for a coordinator and wrong for a
command host.

**The commander's brain is not GOAP-shaped yet.** `src/shared/bots/goap.ts` is frozen, and the existing goals are per-pawn
facts (`at:door`, `hasKey`). Squad-level tasks (assault, flank, hold, regroup, rearm) are a *coordinator* decision over
the squad's positions, not a STRIPS search over one pawn's facts. F.E.A.R. made the same split.

## 4. Gap table

| Component | Today | Needed for 2 squads + 2 commanders | Size |
|---|---|---|---|
| Seats | 3 (`role: "player"`), 13 unownable NPCs | 15+ seats, one per squad bot, operator keeps one | **M** (loader + respawn + pickup gates + tests) |
| Squad membership | none — every bot is independent | a squad registry: member ids, role, order state | **S–M** (new module) |
| Commander | none | an unseated client with a squad-level tick and a rule-based coordinator | **M** |
| Command transport | file mailbox | in-memory queue with the same row shape, plus a per-bot runner | **S** |
| Command vocabulary | 10 commands; `hunt` auto-targets nearest | add `attack {target}` so a commander can mass fire | **S** |
| Claim policy | every mission claims `goal.id` | per-order claim policy (`shared` / `self` / `none`) so mass fire is possible | **S but load-bearing** |
| Focus fire | impossible (claims serialise) | N bots on one target, coordinated by the commander, not by claims | **S** after the policy |
| Spawn/respawn | 3 pads | per-seat respawn spawn (the agent's spawn point) | **S** |
| Telemetry | per-bot file mailbox + transcript | squad journal: orders, acks, target assignment, kill/assist | **S** |
| Capacity | 13 NPCs cost the host nothing | ~148 KB/s/client, ~2.2 MB/s host egress at 15 sessions | **risk**, measure first |
| GOAP | frozen, per-pawn | unchanged for squad bots; commander uses orders, not `goap.ts` | **0** |

## 5. Other methods of coordinated attack

| Method | How it coordinates | Fit here | Verdict |
|---|---|---|---|
| **F.E.A.R. decomposition** — per-agent GOAP + rule-based squad coordinator + barks | coordinator reads full squad knowledge, assigns FLANKER/SUPPRESSOR/ATTACKER/HOLD; each soldier's planner composes toward the role | exact match: squad bots keep `runBrain`; commander becomes the coordinator; "barks" = the visual/audio labels the arena already has | **adopt** |
| **Mission command** (intent, not orders) | commander states the effect and the reason; subordinates choose the route | fits `patrol`/`goto`/`attack` orders with a role; keeps per-bot autonomy and replanning | **adopt as the order language** |
| **Contract Net** (cfp → propose → accept) | allocation among peers when a task is scarce | the claim table is already the accept half; with 2 squads contending for one key, claims still work; focus fire needs the exception, not a new protocol | **keep claims for contention, bypass for mass fire** |
| **Blackboard** (squad-shared state) | one typed store; coordinator single-writer for roles, timestamp/CAS for contacts | the in-memory squad registry *is* the blackboard; no wire frames needed | **adopt (in-process)** |
| **Lanchester / focus fire** | concentrate fire on one target | the reason a commander is worth building; math favours massing | **adopt as the first tactical priority** |
| **Swarm/boids, flocking** | local steering rules produce group motion | movement only, not task allocation; the host's `steerUnownedWander` already does the per-pawn version | **defer** |
| **FIPA ACL / A2A** | performatives, agent cards, remote agents | overkill in one process; already assessed in `2026-11-21-bot-messaging-framework.md` | **reject** |

## 6. Design

**Squads.** 6 + 7 bots. Each bot is one `connectBot` session on a converted seat. Commanders are **unseated** spectate
sessions (no pawn, no claim, no seat) — they watch and order. That keeps 13 seats for squad bots and leaves the operator's
pad free.

**One process, in-memory queues.** A `swarm.ts` runner owns 15 sessions and two commander loops. A commander's order is a
`CommandRequest` pushed into that squad's per-bot queue; the bot's session loop pops one, `parseCommand`s it, and
`host.dispatch`es it (one at a time — the host's busy rule). No file I/O on the hot path; the per-bot file mailbox stays
available for the bot-developer's manual runs and for recording.

**Commander tick (2–5 Hz, rule-based).** Reads the squad's `BotWorld` view: members' position/place/hp/ammo/weapon,
enemies outside, the pickup state. Emits at most one order per member per tick and holds it until a terminal event.
Priority ladder (v1): `rearm` (no ammo) → `regroup` (member isolated) → `assault` (focus target) → `flank` (one member
on a stand point) → `hold`. Roles: FLANKER, ATTACKER, SUPPRESSOR(pre-v1: another ATTACKER), HOLD — the F.E.A.R. set,
because each maps to an existing command: flank/hold → `stand {x,z}` or `goto {place}`, assault → `attack {target}`,
rearm → `reload`/`getkey`, regroup → `goto`.

**Order shape.** `{ squad: 1, member: 7, order: "assault", target: 12, id: "s1-o17" }` → serialised as
`{ name: "attack", args: { target: 12 }, id: "s1-o17" }`.

**Claim policy.** `attack` dispatches with `claim: "none"` (squad-assigned target) and a per-bot mission key
`attack:<target>#<selfId>` when the claim is wanted for telemetry. Contention orders (`retrieve`, `arm`, `getkey`) keep
`claim: "shared"`. This is the one change to `runBrain`'s contract: an `opts.claimKey`/`opts.claim` parameter, default
unchanged.

**No GOAP change.** `goap.ts` stays frozen; squad-level tasks are the coordinator's ladder, not a planner. If a later task
wants STRIPS over squad facts, it gets its own module and its own decision entry.

## 7. Feasibility matrix

| Option | Verdict | Cost | Risk | What would change it |
|---|---|---|---|---|
| A. 15 sessions in one process, unseated commanders, in-memory queues | **small-medium, recommended** | runner + queue + commander + seat change | event-loop starvation if 15 sessions × snapshots exceed one tick; 2.2 MB/s egress | a measured tick slip in P0 → split by squad (B) |
| B. One process per squad (commander + 6/7 bots), in-memory within a squad | **medium** | process supervisor + cross-squad claims via the host | two processes, two logs; the same in-memory property per squad | if P0 shows single-process jitter |
| C. Commander as a seated bot with a pawn | **conflicts** with the intent | — | the commander consumes a seat, is killable, and must dodge; a "commander" that fights is not a commander | if the operator wants a visible commander avatar |
| D. Commander as a host NPC (arbiter/bot-brain) | **large, wrong lane** | host brain + squad state in `src/server` | host-side squad AI is a bigger authority change; the client bots still need orders over the wire | if the commander must keep working with clients disconnected |
| E. File mailbox for orders | **works, slow** | 0 new code | 250 ms poll cadence, filesystem churn, no per-order ack | a demo where latency is irrelevant |
| F. New ACL or GOAP for the commander | **large, over-engineered** | protocol + planner | duplicates claims; frozen `goap.ts` | if a third party (non-bot) must command |

## 8. Implementation plan

**P0 — capacity spike (bot-developer, 1 run).** Four client bots join (2 seats + 2 unseated), 60 s of straight-line input,
measure: host tick ms (host `TickMetrics`), bytes per session per second, seat handshake failures. Guard rails: one seat
per bot, clean `close()`, no operator targeting. Artifact: `plan/dsh-tasks/reports/live-<date>-swarm-capacity.md`.
*Gate:* if 4 sessions already push the tick past budget, stop and take option B or C.

**P1 — seat model (coder).** Loader: mark the 13 spawn-point agents as seats (a `squadSeat: true` flag on the agent, or
`role: "player"` plus a `seatKind`), keeping the 3 pads. `respawnPawn`: per-agent spawn (the spawn point it was built
from), not `playerSpawns`. Pickups: squad seats use `npcPickupProps` (no prop stealing) unless the operator says otherwise.
Tests: 16 seats, unowned seat idles, respawn lands on its own spawn, seat count in `SERVER_FULL` terms.

**P2 — in-memory squads and orders (coder).** `packages/bot-client/src/squad/queue.ts` (`createCommandQueue`: push,
shift, pending, close), `squad/runner.ts` (sessions + per-bot dispatch loop, one order at a time), `CommandName` gains
`attack {target}` (dispatch to `runAttack`), and `runBrain`/`runMission` gain `opts.claim: "shared" | "self" | "none"`
(default `"shared"`, no behaviour change). Tests: queue FIFO and per-bot isolation, `attack` parse, claim modes.

**P3 — commander (coder).** `squad/commander.ts`: `createCommander({squad, members, queue, now})` with a pure
`assignRoles(snapshot)` (given member and enemy positions, return roles + target) and a `tick` that emits orders. Tests:
role assignment table-driven (2 enemies, 3 members; wounded member → HOLD; no ammo → REARM), order emission, and the
ladder priority.

**P4 — live two-squad run (bot-developer).** 13 squad bots + 2 commanders on the converted map; a scripted engagement:
commander 1 assaults a player pawn, commander 2 holds the key room; measure orders issued, orders completed, target
concentration (distinct targets per tick), time-to-first-shot per squad, tick ms, seat errors. Report + POCS row.

**P5 — model and ledger (model-developer + designer).** `bot-kb` rows for the squad registry/order queue; a decision entry
for "squad orders bypass claims" (the one rule that changes existing behaviour); POCS rows for the swarm.

**Risks and mitigations.** Bandwidth (P0 gate, then deltas/interest tuning). Event loop (one process first, split later).
Respawn stacking (P1 per-agent spawn). Prop stealing (P1 pickup gate). Claim serialisation (P2 claim modes). Seat
starvation (`SERVER_FULL` if the operator's pad is taken — the runner must never seat on the pad the operator uses).
Log volume (15 sessions × per-tick lines — the runner writes one merged NDJSON journal, not 15 files).

## 9. Open questions

1. **Does the operator want a visible commander?** Unseated is simpler and safer; a seated commander is a target and a
   spectacle. Default: unseated.
2. **6 + 7 or 7 + 6?** The split decides the flanker budget (one flanker per squad needs ≥3 members). Default: 6 + 7.
3. **Is focus fire the first tactic, or is regroup?** Lanchester favours massing, but a squad that dies alone is worse.
   Default ladder: rearm → regroup → assault/flank.
4. **Do the two squads contend or cooperate?** Claims handle contention; a "one squad holds the key room, the other
   assaults" script needs the commander to know the other squad's intent — an operator-level order, not a squad one.
5. **Should the commander tick at 2 Hz or 5 Hz?** Orders are coarse; 2 Hz leaves the bot brain to replan. Default 2 Hz.
6. **Where does the squad journal live?** `plan/dsh-tasks/live/squad-<n>/` (gitignored) matches the bot lane; a tracked
   driver under `packages/bot-client/tests/` is the runner, per the rules.

## 10. Confidence legend

`measured locally` — snapshot bytes from `loadArena()` + `world.commit(0n)`; seat/agent counts from `loadArena()`;
`verified locally` — every line reference. `inferred` — the 15-session bandwidth extrapolation from the measured
full-snapshot size (steady state uses deltas, unmeasured). `documented externally` — the method table, none of it
measured here.
