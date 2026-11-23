# Arena layout for the two squads, and the bot-developer-as-commander plan

| | |
|---|---|
| **Question** | What exactly must the new layout change, so two squads spawn inside a locked hall with weapons/ammo/keys, and what does the plan look like once the operator runs the layout and P0, then the bot-developer prototypes the commander with the operator before any coder joins? |
| **Decision it informs** | The layout task's file list and acceptance, and the phase order after it (P0 → bot-developer commander prototype → coder finalize). |
| **Timebox** | 45 min (spent ~40). |
| **Window** | 2026-11-22 14:39 → 15:25 America/New_York. |
| **Lane** | research only — no `web/`, `src/`, or `packages/` edit. |

## Executive summary

The hall already exists. `brutalist-building-1-cbake-0.floor-1.hall` is a **28 × 21 m** room (x −50.2…−22.3,
z −39.1…−18.1) with 15 nav regions and a **locked door to outside keyed `key`** (`doors.placements.json`, the
`…door-1-1-9-22` entry). So the layout is mostly **data, not geometry**: add **13 squad spawns** to
`player-spawns.json` inside the hall (two bays of 6 and 7), **delete the 13 `spawn-points.json` wander spawns**, and
move the weapon/ammo/key props into the hall (today the weapon and key sit at y = 3.75 on a roof, ~30 m away). The
seat count is already **data-driven** — `world-loader.ts:82-88` makes a `role: "player"` agent from every
`playerSpawns` entry — so **13 client bots need no seat-model code change**; only `respawnPawn`'s pad list needs a
later refinement. With the layout in place, P0 can run, and the bot-developer + operator can prototype the commander on
the real hall with the 13 seats before the coder touches `src/`.

## 1. Question, decisions, timebox

Restated: (a) what the layout must contain and which files encode it; (b) the phase order given the operator's working
model — operator and bot-developer pair-prototype the commander's tasks and brain live, then the coder ports the
proven shape. Operator's answers recorded: **unseated commander, regroup first, squads contend, 2 Hz commander tick,
`plan/dsh-tasks/live/squad-<n>/` journal**. Moot if the 13 squad bots simply reuse the 3 pads and 13 NPCs — they cannot;
the hall placement is what makes the scenario legible.

## 2. What the layout must contain (the spec)

| Element | Requirement | Data |
|---|---|---|
| Hall | one room, ≥ 20 × 15 m of floor, inside bounds, reachable from outside through one door | `buildings.placements.json` (baked) + `regions.json` |
| Two bays | 6 spawns in bay A, 7 in bay B, ≥ 3 m apart, both inside the hall | `player-spawns.json` |
| Locked exit | the hall door is `locked: true, key: "key"`; the key is inside | `doors.placements.json` + `scene-graph.json` portal |
| Weapons | at least one weapon prop inside the hall | `props.placements.json` (`type: "weapon"`) |
| Ammo | enough ammo crates inside the hall for 13 bots (the arena has 78 ammo props; place ≥ 6 inside) | `props.placements.json` (`kind: "ammo"`) |
| Key | one key prop inside the hall, reachable before the exit | `props.placements.json` (`kind: "key"`) |
| Operator pad | the 3 pads stay outside the hall, so the operator (and any human) spawns in the open | `player-spawns.json` |
| No wander NPCs | the 13 `spawn-points.json` entries are removed, so the arena is 13 seats + 3 pads = 16 agents | `spawn-points.json` |
| Nav | the hall's 15 regions cover both bays and the props | `regions.json` (already there) |
| Bounds | hall inside x −70.9…72.6, z −45.5…47.2 | `bounds.json` (already true) |

## 3. Measured authoring path

**The hall is an existing place.** `regions.json` has `brutalist-building-1-cbake-0.floor-1.hall` with 15 regions
covering x −50.2…−22.3, z −39.1…−18.1; `doors.placements.json` has 27 doors and the hall's door is
`{"locked": true, "key": "key"}`; `scene-graph.json` carries the matching portal `hall ↔ outside` with `locked: true`.
The scene graph has 174 places and 321 portals, already baked — **no new geometry is required** if the hall's footprint
is accepted.

**Seat count is data.** `scene.spawnPoints` and `scene.playerSpawnPoints` point at `spawn-points.json` (13) and
`player-spawns.json` (3). `world-loader.ts:79-88` builds one `WanderAgent` per spawn point (role undefined) and one per
player spawn (`role: "player"`). `arena-host.ts:235` seats clients on the `role === "player"` agents. Therefore:
adding 13 entries to `player-spawns.json` **creates 13 seats**, and deleting `spawn-points.json` **removes the 13 wander
NPCs** — no coder change. This supersedes the "P1 seat model (coder)" phase in the previous report.

**Props are placements.** `props.placements.json` holds 265 props (ammo 78, health 76, crate 108, weapon 1, key 1,
building 1); the weapon `alien-weapon-1` is at `[-23.9, 3.75, 16.4]` and the key `key` at `[-7.2, 3.75, 32.7]` — both
at y = 3.75, far from the hall (z positive vs the hall's z −39…−18). Moving them into the hall is a placement edit; if
new prop ids are added, keep them unique (pickups and the DAG reference ids).

**Pickup gate correction.** The manifest sets `player.clientPlayer.pickupProps: true` and
`player.npcPlayer.pickupProps: false`, so the **wander NPCs are already barred from props**; converted **seats** use the
client gate and *can* pick up weapons/ammo — which is what the scenario wants (squad bots arm inside the hall). The
"wander bots steal the weapon" risk in the previous report is a *seat* risk now, not an NPC one; the operators' own
weapon is protected by not dropping it in the hall.

**Respawn gap remains, smaller.** `respawnPawn` (`game.ts:1138`) sends every `role: "player"` agent to `playerSpawns`
and `claimClearSpawn` picks a free pad. With 16 pads that works (no stacking), but a bay-A bot can respawn in bay B.
Acceptable for the prototype; a per-agent spawn is the coder refinement (call it L1b, not P1).

**Bake boundary.** Geometry comes from `scripts/bake.sh` (blueprint-scene on
`dev/scenes/arena-1/designs/arena-1.svg` + floorplans) and `bake-scene-graph.sh` (placements → `scene-graph.json`).
If the hall footprint or its door position must change, that is a scene-bake task and it opens the sibling repo; if the
hall is accepted, the layout is JSON only.

## 4. Layout task (files and acceptance)

| File | Change |
|---|---|
| `web/game/player-spawns.json` | add 13 spawns inside the hall: bay A (6) near x −46…−40, bay B (7) near x −30…−24, z −34…−22, y 0, yaw facing the hall centre |
| `web/game/spawn-points.json` | remove the 13 NPC spawns (the wander bots) |
| `web/game/props.placements.json` | move `alien-weapon-1` and `key` into the hall; add ≥ 6 ammo props inside; keep ids unique |
| `web/game/doors.placements.json` + `scene-graph.json` | unchanged if the existing hall door is used (already locked/keyed); otherwise re-bake |
| `web/game/regions.json`, `bounds.json` | unchanged if the hall is reused |
| `web/game/arena.game.json` | no change (the paths already point at the files above) |

**Acceptance (measurable without running the client).** `node --import ./scripts/ts-ext-register.mjs` +
`loadArena()` must report: `agents.length === 16` with **13 `role: "player"`** and 3 player pads; all 13 seats inside the
hall bounding box; the weapon/key/ammo props inside the same box; the hall door still `locked` with `key: "key"`; a
route from the hall to `outside` exists after the key (`nav` regions for both). A one-shot script is enough; then the
operator restarts the host and runs the observer to see the hall.

## 5. Revised phase plan (bot-developer as commander)

| Phase | Owner | What | Gate |
|---|---|---|---|
| **L0** | operator (+ designer if a scene bake is needed) | the layout above; restart the host | the `loadArena()` acceptance |
| **P0** | bot-developer | 4 sessions on the new layout (2 squad bots + 2 unseated) for 60 s: host tick ms, bytes/session/s, seat handshake errors | tick stays inside budget, else option B (one process per squad) |
| **B1** | bot-developer + operator | commander prototype driver: 1 unseated commander + up to 13 squad bots on the 13 seats; in-process queue; rule-based `assignRoles`; **regroup first**; 2 Hz | a squad regroups and moves as one, twice in a row, without a seat leak |
| **B2** | bot-developer + operator | extend the order vocabulary the commander actually used (`attack <target>` first, then flank/hold positions), still in the driver | every order is accepted and reported by the squad |
| **C1** | designer → coder | port the proven prototype: `squad/queue.ts`, `squad/commander.ts`, `attack` in `commands.ts`, claim modes, tests | coder task cites the B1/B2 report and the driver |
| **C2** | coder | per-seat respawn (L1b) and any command that survived B2 | `npm run typecheck` + scoped tests |
| **L1** | bot-developer | two-squad live run, commanders contending, report + POCS | target concentration and order completion measured |

**Pair-programming protocol (B1/B2).** The bot-developer owns one tracked driver under
`packages/bot-client/tests/` (say `commander-proto.ts`) and the report
`plan/dsh-tasks/reports/live-<date>-commander-proto.md`; the operator owns the host, the restart, the observer view, and
the judgment. Each iteration is: hypothesis → driver edit → run → log under `plan/dsh-tasks/logs/` → one row in the
report → next. The commander is unseated, so it never takes a seat or a claim; the squad bots take the 13 new seats;
the operator never plays a seat that a bot needs. Nothing is promoted to `src/` until the behaviour is settled — the
coder receives the driver and the report, not the live session.

**What the commander's brain is, at B1.** A 2 Hz rule-based coordinator (not a `goap.ts` planner): read the 13 members'
place/hp/ammo/weapon, the enemies outside, and the pickup state; emit one order per member; hold it until a terminal
event. Ladder: `rearm` (no ammo) → `regroup` (isolated) → `assault` (focus target) → `flank` (one member) → `hold`.
Roles FLANKER / ATTACKER / SUPPRESSOR / HOLD map to existing commands (`stand`, `goto`, `attack`, `walk`), which is why
B2 only needs `attack`.

**Claims under "squads contend".** Between squads, claims stay the arbiter (D10). Within a squad, a mass attack on
one target must **not** claim `attack:<id>` — the second bot would wait. B2 uses a per-bot claim key
(`attack:<target>#<selfId>`) or no claim for squad-assigned attacks; the coder's C1 formalises it as
`opts.claim: "shared" | "self" | "none"` with the default unchanged.

## 6. Risks and gates

- **Hall footprint.** If the existing hall is too tight for 13 spawns + props, L0 becomes a scene-bake task; check the
  acceptance before P0.
- **Seat leak.** 13 long-lived sessions plus the operator must close cleanly; a leftover seat is the known
  `SERVER_FULL` cause. P0 and B1 must log the seat count before and after.
- **Bandwidth.** 13 seats + 2 unseated ≈ 148 KB/s each (measured full-snapshot figure; deltas lower) — P0 measures the
  real number on the new layout.
- **Prop ids.** Moving props keeps the id; adding ammo needs new unique ids, or the DAG/scene-graph re-bake.
- **Operator visibility.** The observer follows any pawn by id; with 13 bots inside a hall, bot labels (Options) are
  the practical way to tell squads apart.

## 7. Open questions

1. **Two bays or one hall?** The operator's words allow either; two bays inside one locked hall is assumed (6 + 7
   spawns, one door). If the bays need a wall between them, that is a scene-bake change.
2. **Is the key inside the hall or with the weapon?** Assumed inside, near the weapon, so a squad must find both before
   it can leave.
3. **How many ammo props?** Assumed ≥ 6 (78 exist globally); the number decides whether a squad can rearm after a
   fight without leaving the hall.
4. **Do the 3 pads stay outside?** Assumed yes — the operator needs an open spawn and the squads must come to them.
5. **Does the layout replace arena-1 or become arena-2?** `arena.game.json` names one scene; a second scene means a
   second manifest and a host flag. Assumed: edit arena-1 in place for the prototype; a new arena id later.

## 8. Confidence legend

`measured locally` — hall extents, prop positions, spawn counts, seat derivation (`world-loader.ts:79-88`),
`respawnPawn` (`game.ts:1138`), pickup defaults (`arena.game.json` `player.clientPlayer.pickupProps`). `inferred` —
the bandwidth on the new layout (P0 measures it), and the 2-bay split. `documented externally` — none in this report;
the methods live in `2026-11-22-squad-commander.md`.
