# arena-2: two 8-member teams, baked from an Inkscape plan

| | |
|---|---|
| **Question** | What exactly is arena-2 — two 8-member teams in two building halls, one key/weapon/ammo per member, all 16 spawn pods authored in Inkscape and baked like arena-1 — and what must change in the command layer for the commander to run it? |
| **Decision it informs** | The L0 authoring task (SVG layers → six baked files → manifest root) and the B1/B2 prototype scope (16-bot roster, 8 per team, 2 Hz loop, arena-2-aware gear commands). |
| **Timebox** | 30 min (revision of the 14:50 report). |
| **Window** | 2026-11-22 14:50 → 15:40 America/New_York. |
| **Supersedes** | this file's own v1 (13+3 pads, hand-edited JSON). |

## Executive summary

arena-2 is **not a data edit — it is a bake**, and the tree already documents exactly how: `blueprint-scene bake`
reads six SVG layers (`buildings`, `bounds`, `props`, `doors`, `spawn-points`, `player-spawns`) and writes six files.
The plan is drawn at **1 mm = 1 m**, yaw snaps to 0/90/180/270, a pad outside `bounds` fails the bake, and a
`player-spawns` object becomes a `{id, x, y:0, z, yaw}` seat. So **16 pods on the `player-spawns` layer — 8 inside one
building's hall, 8 inside another's — are 16 client seats**, with no loader change. Each hall gets 8 weapon stencils, 8
ammo-box stencils and 8 key stencils on the `props` layer, and its exit door is already expressible: the `doors` layer
carries `data-locked="true" data-key="key"`. arena-2 is then baked into its own root and selected with
`ARENA_GAME_ROOT`. The only code work is the arena-1-specific command behaviour (`arm`, `reload`, `hunt`), which the
bot-developer and operator prototype in B2 before the coder ports it.

## 1. Question and answers folded in

- **16 pods, two 8-member teams**, each team inside a building hall.
- **One key per member**, plus one weapon and one ammo per member, inside each hall.
- The **operator may take a seat** as a squad member or observe.
- **The SVG determines the buildings and the spawn points** — authored in Inkscape, baked like arena-1.
- **Only spawn points and prop locations differ** from arena-1.
- Squad movement doctrine stays with the bot-developer + operator (B1/B2), not this report.

## 2. The bake contract (measured from the CLI)

`./node_modules/.bin/blueprint-scene bake --help` states:

- Reads the SVG layers **buildings, bounds, props, spawn-points, player-spawns, doors**.
- Writes **six files** into the `--out` directory: `buildings.placements.json` (the `--out` path) plus `bounds.json`,
  `props.placements.json`, `spawn-points.json`, `player-spawns.json`, `doors.placements.json`.
- **`player-spawns`**: "a text, path, or small rect … is a human pad", written with `{ id, x, y: 0, z, yaw }`; a pad
  **outside the bounds rectangle fails the bake**.
- **Scale**: 1 mm = 1 m; **yaw snapped** to 0/90/180/270; uniform scale only.
- It does **not** write `arena.game.json` or a scene object.

The existing arena-1 SVG confirms the authoring vocabulary: layers labelled `buildings`, `bounds`, `doors`, `props`,
`spawn-points`, `player-spawns`, plus `model:<id>` layers; the doors layer carries `data-locked="true"` and
`data-key="key"`. Props reference their model stencil (`data-model="ammo-box"`, `model:key-1`,
`model:alien-weapon-enh`), which is how a prop becomes a pickup of kind ammo/key/weapon.

## 3. arena-2 plan (what to draw)

| Layer | arena-2 content | Consequence |
|---|---|---|
| `bounds` | the full arena rectangle, containing both buildings and the open middle | nothing outside it bakes |
| `buildings` | two building footprints with halls large enough for 8 pods + 24 props each | each group needs a floor plan |
| `player-spawns` | **8 objects in hall A, 8 in hall B** (text/path/small rect), ≥ 2 m apart, inside the hall, yaw facing the interior | **16 seats** — the two teams |
| `props` | per hall: 8 `alien-weapon-enh`, 8 `ammo-box`, 8 `key-1` stencils on the floor | 16 weapons, 16 ammo, 16 keys; one of each per member |
| `doors` | one exit door per hall with `data-locked="true" data-key="key"`; the other doors shut or locked | the squad must take its key and open its hall |
| `spawn-points` | **empty** | no wander NPCs; the arena is 16 seats + 2 unseated commanders |
| `model:*` | reused from arena-1 (no new GLBs) | `web/assets` stays shared via `dist/web/assets` |

**Team assignment**: pod ids should carry the team (`team-a-1…8`, `team-b-1…8`) — the runner numbers the bots from
these ids and the commander derives "who is mine" from the roster, not from a place predicate.

**Operator seat**: if the operator takes one pod, the roster is 15 bots + the operator; if they observe, 16 bots. Both
are the same code path — the runner must skip a pod it did not connect.

## 4. Bake and select

```sh
# 1. layouts: plan -> six files (writes into the arena-2 root)
./node_modules/.bin/blueprint-scene bake \
  --svg ./dev/scenes/arena-2/designs/arena-2.svg \
  --models ./web/assets/models \
  --floors ./dev/scenes/arena-2/designs/floorplans \
  --rooms ./web/assets/models \
  --game ./dev/scenes/arena-2/designs/arena-2.game.json \
  --collision-dir ./dev/scenes/arena-2/generated \
  --out ./arenas/arena-2/web/game/buildings.placements.json

# 2. scene graph (places, portals, door locks)
./node_modules/.bin/blueprint-scene scene-graph \
  --buildings ./arenas/arena-2/web/game/buildings.placements.json \
  --floors ./dev/scenes/arena-2/designs/floorplans --rooms ./web/assets/models \
  --doors ./arenas/arena-2/web/game/doors.placements.json \
  --props ./arenas/arena-2/web/game/props.placements.json \
  --bounds ./arenas/arena-2/web/game/bounds.json --radius 0.45 --height 1.8 \
  --out ./arenas/arena-2/web/game/scene-graph.json

# 3. spatial DAG (the AI collision)
node ../blueprint-scene/src/cli.ts spatial-dag \
  --placements ./arenas/arena-2/web/game/buildings.placements.json \
  --scene-graph ./arenas/arena-2/web/game/scene-graph.json \
  --bounds ./arenas/arena-2/web/game/bounds.json \
  --out ./arenas/arena-2/web/game/spatial-dag.json

# 4. manifest: copy arena-1's, same relative ./web/game/... names, new gameId/bundleId
cp web/game/arena.game.json arenas/arena-2/web/game/arena.game.json

# 5. run it
ARENA_GAME_ROOT=$PWD/arenas/arena-2 npm start
```

`nodeGameFiles(root)` and `projectRoot()` require `web/game/arena.game.json` **inside** the root (the manifest ref is
root-relative), so the `arenas/arena-2/web/game/` shape above is the contract. Assets need no copy: the build already
puts `web/assets` under `dist/web/assets` and the client fetches `/assets/...` from there.

## 5. Acceptance before P0

`node --import ./scripts/ts-ext-register.mjs` and `loadArena(nodeGameFiles("arenas/arena-2"))` must show:

- **16 `role: "player"` agents**, 8 whose `placeOf` is hall A, 8 in hall B; **0 wander agents**.
- 16 weapon props, 16 ammo props, 16 keys, all inside the two halls.
- each hall's exit door `locked` with `key: "key"`; the other doors shut.
- `regions` cover both halls (8 pods and 24 props inside walkable regions); `spatial-dag` chunks > 0.
- bounds contain every pad (the bake fails otherwise — a good early check).

## 6. Commander loop for 16 bots (B1)

| Step | Input | Cadence | Note |
|---|---|---|---|
| Roster | 16 pod ids (`team-a-*`, `team-b-*`) → numbered bots | once | map pod → pawn id from `world.self()` after welcome; print the roster at start |
| Roles | member pos/place/hp/ammo/weapon; enemy contacts | 2 Hz | 8 per team; FLANKER / ATTACKER / SUPPRESSOR / HOLD; **regroup first** |
| Status | `self/healthOf/weapon/ammo/placeOf/keys` | 2 Hz | same fields `CommandStatus` carries |
| Enemy scan | all pawns not in my roster | 2 Hz | roster-based, not `place === "outside"` |
| Orders | one `CommandRequest` per member, held until terminal | on change | `arm` → ammo+`getkey` → `stand` at the exit → open → `goto`/`walk` outside → `stand` cover → `attack` |

The commander is unseated; the operator's seat, if taken, is one roster entry the commander must not order (flag it).

## 7. The arena-1 command assumptions to fix in B2

1. `arm` hardcodes `alien-weapon-1` and the arena-1 waypoints (`commands.ts:322-331`) — arena-2 needs the nearest
   weapon **in the current place**, or a `target` argument.
2. `reload` only looks at ammo with `placeOf === "outside"` (`commands.ts:409`, `:415`) — arena-2's ammo is in the hall.
3. `hunt` filters targets to `outside` (`:461`, plus `:717`, `:946`, `:1291`) — the commander needs `attack {target}`
   and a roster-based enemy list.

## 8. Plan

| Phase | Owner | Gate |
|---|---|---|
| **L0** | operator (Inkscape + bake) | §5 acceptance |
| **P0** | bot-developer | 4 sessions on arena-2: tick ms, bytes/session/s, seat errors |
| **B1** | bot-developer + operator | 16-bot roster, roles, 2 Hz loop, regroup-first; squad leaves its hall twice |
| **B2** | bot-developer + operator | arena-2-aware `arm`/`reload`, `attack {target}`; full ladder |
| **C1** | designer → coder | port the proven loop (`squad/queue.ts`, `squad/commander.ts`, commands, claim modes) |
| **C2** | coder | per-seat respawn spawning (a bay-A pad for a bay-A bot) |
| **L1** | bot-developer | two-team live run: 8 vs 8, order completion, concentration |

## 9. Open questions

1. **Do the two halls share one building model or two?** Two `model:` layers or two placements of one model both bake;
   the plan determines it.
2. **Is the operator's seat one of the 16 or a 17th pad?** A 17th pad keeps 16 bot seats; 16 total means one bot fewer.
3. **Prop id naming** — the bake derives ids from SVG object ids, so name the stencils `weapon-a-1`… so the roster and
   the command layer can refer to them.
4. **Does arena-2 keep the alien weapon's special ammo economy?** 16 weapon props with the same model/asset is the
   simplest; if the weapon is meant to be scarce, use crates instead.
5. **Do the teams share the arena through the open middle, or does each hall open into its own corridor?** The plan
   decides the first contact location, which B1's regroup test depends on.
