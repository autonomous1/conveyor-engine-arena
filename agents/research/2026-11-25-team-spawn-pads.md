# Team attribute on spawn pads — review and change plan

| | |
|---|---|
| **Question** | Can a spawn pad carry a `team`, so every pawn spawned from it is on that team, and respawn places a dead pawn on a free pad of its own team? |
| **Decision it informs** | Where the team lives (pad → seat → host state, never the kernel entity), which task opens the change, and what the two-squad prototype can use today. |
| **Timebox** | 45 min (spent ~40). |
| **Window** | 2026-11-25 14:01 → 14:45 America/New_York. |
| **Read** | `web/game/player-spawns.json`, `world-loader.ts`, `game.ts` (`respawnPawn`, `claimClearSpawn`), kernel `conveyor-engine-world` entity record, `arena-view.ts`, `bot-protocol.ts`, sibling `blueprint-scene/src/{types,bake}.ts`. |

## Executive summary

The proposal is the right shape, with one boundary to draw: **the team belongs to the pad and the seat, not to the
kernel entity.** `EntityRecord` has `id, alive, spawnTick, lifecycle, owner, flags, category, …` and no team field
(`conveyor-engine-world/src/types.ts:91-105`); adding one is a kernel change and is not needed. The host already builds
one `WanderAgent` per player pad with `role: "player"` (`world-loader.ts:72-88`), and `respawnPawn` already chooses
between `playerSpawns` and the NPC spawn points (`game.ts:1129-1140`) — so a `team` on `SpawnPick`/`WanderAgent` plus a
filtered pad list in `respawnPawn` is a ~20-line arena change. The durable authoring path is the pad attribute:
`data-team` on the `player-spawns` SVG layer → `SpawnPoint.team` (`blueprint-scene/src/types.ts:178-184`) →
`spawnFile` writes it → `player-spawns.json`. The fast path for arena-2, which is being designed now, is a post-bake
team table or pad-id naming; both unblock the two-squad prototype without touching the sibling repo.

## 1. What exists (measured)

| Piece | Today | Line |
|---|---|---|
| Pad file | `web/game/player-spawns.json`, currently **4 pads** (`player-pad-5…`), `{id,x,y,z,yaw}` | — |
| Pad type (respawn) | `SpawnPick = { x, y, z, yaw }` — no id, no team | `health.ts:235` |
| Pad record (loader) | `LoadedArena.playerSpawns` entries `{id, x, y, z, yaw}` | `game.ts:53` |
| Pad type (bake) | `SpawnPoint = { id, x, y, z, yaw }` (sibling) | `blueprint-scene/src/types.ts:178-184` |
| Agent build | one `WanderAgent` per pad, `role: "player"`; NPCs from `spawnPoints` | `world-loader.ts:72-88` |
| Agent type | `WanderAgent` has `role?: "player"`; no team | `world-loader.ts:19-40` |
| Respawn | `pads = role === "player" ? playerSpawns : world.listSpawnPoints()`; `claimClearSpawn(world, id, pads) ?? pads[0]` | `game.ts:1139` |
| Clear-pad pick | `claimClearSpawn(world, id, spawns, pending)` takes any pad list | `game.ts:1156` |
| Kernel entity | `owner`, `flags`, `category` — **no team** | `conveyor-engine-world/src/types.ts:91-105` |
| Client view | `ArenaView.playerSpawns` carries pads to the browser | `arena-view.ts:245` |
| Bot frames | `players: { ids }` — ids only, no team | `bot-protocol.ts:114` |

## 2. Design

**Layering.** Pad → seat → spawner. The team is authored on the pad, read into the pad record, copied to the
`WanderAgent` when the seat is built, used by `respawnPawn` to filter pads. It never enters the world entity; a client
that needs it gets it from a frame, not from the snapshot.

**2.1 Pad attribute (durable).** The SVG `player-spawns` layer elements get `data-team="a"` / `"b"`. The bake change is
three edits in the sibling: the element parse copies `data-team` into the mark, `SpawnPoint` gains `team?: string`, and
`spawnFile` writes it when present. `web/game/player-spawns.json` then reads
`{"id":"team-a-1","x":…,"z":…,"yaw":0,"team":"a"}`.

**2.2 Host (arena).**

- `SpawnPick` (`health.ts:235`) gains `team?: string`; `LoadedArena.playerSpawns` (`game.ts:53`) and the
  `world-loader.ts:72` mapping carry it through.
- `WanderAgent` gains `team?: string`; set from the pad at `spawnAgent`.
- `respawnPawn`:
  ```ts
  const pads = agent?.role === "player" ? playerSpawns : world.listSpawnPoints();
  const own = agent?.team ? pads.filter((pad) => pad.team === agent.team) : [];
  const spawn = claimClearSpawn(world, id, own.length > 0 ? own : pads) ?? pads[0];
  ```
  Log a cross-team fallback (`respawn cross-team id=… team=… pad=…`) so a full team pad zone is visible in the run.
  Do **not** leave the pawn dead waiting for a pad: `pads[0]` is the existing last resort.
- NPC spawn points stay teamless; `world.listSpawnPoints()` is unchanged.

**2.3 Client (optional for v1).** The bot-developer's driver knows its squad by construction, so the combat `SquadView`
can be injected (`--squad a`, roster ids) with no host frame. The durable discovery is a host frame:

`{ t: "teams", rows: [{ id: number; team: string }] }`, sent on welcome and whenever a seat spawns/respawns — the same
host-authoritative shape as `claims` and `players`. It needs `parseTeams`, a `WanderAgent`→frame handler, and a
`world.teams()` in the bot model. That is a small protocol task, not a prerequisite for the prototype.

**2.4 Human seats and observers.** The operator takes a free player seat, so their team is the pad's team — "join as a
squad member" works without a new field. A spectate session is unseated and has no team (fine). Arena-2's 8 + 8 pads
decide which hall a human lands in.

## 3. Feasibility

| Option | Verdict | Cost | Risk | What would change it |
|---|---|---|---|---|
| **A. Bake `data-team` → JSON → host → same-team respawn** | **recommended, durable** | 3 sibling edits + 4 arena edits + 1 test | low; the attribute survives re-bake | if the operator keeps designing pads in JSON, skip the sibling change |
| B. Post-bake overlay `web/game/teams.json` (`padId → team`) read by the loader | **fast, no sibling** | 1 arena file + loader map | the overlay is lost on re-bake if the bake overwrites pads? no — it is a separate file, safe | if the bake starts writing pads and the overlay drifts |
| C. Pad-id convention (`team-a-*`) parsed by the loader | **prototype-only** | ~5 lines | naming is the schema; a typo yields a teamless pad | if pads are renamed |
| D. Team on the kernel entity | **reject** | kernel change | forbidden boundary, snapshot/protocol churn, no consumer in the world | if replication ever needs team-based interest |

**Staging.** For the arena-2 design in progress, C (or B) unblocks the two-squad prototype this week; A lands with the
next bake so the design remains the source of truth. The host and respawn code (2.2) is the same for all three.

## 4. Task plan

| # | Task | Owner | Scope |
|---|---|---|---|
| 1 | Pad team through the loader + same-team respawn + fallback log | coder | `src/server/{game,world-loader}.ts`, `web/game/player-spawns.json` (team field), `test/spawn-team.test.ts` (server scope `^spawn-`) |
| 2 | `data-team` in the bake (3 sibling edits) | coder (task names `../blueprint-scene`) | `blueprint-scene/src/{types,bake}.ts` + the element parse; re-bake arena-2 |
| 3 | `teams` frame + bot `world.teams()` (client discovery) | coder | `src/shared/bot-protocol.ts`, host spawn/respawn handlers, `packages/bot-client/src/world.ts`, `test/bot-protocol.test.ts` |
| 4 | Two-squad prototype consumes the team (SquadView + respawn check) | bot-developer | driver only; no src |

**Tests (task 1).** A `loadArena()`-level test: two pads (team a, team b) → two agents with the matching `team`; kill
pawn on team a → respawn lands on a team-a pad; fill all team-a pads → fallback to a free pad **and** log the cross-team
line; a pad without `team` behaves exactly as today.

**Acceptance (task 1).** `npm run typecheck`; `npm run test:scope server`; the `loadArena()` check; `goap.ts` untouched;
the respawn path keeps `pads[0]` as the last resort.

## 5. Open questions

1. **Attribute name and values** — `data-team="a"|"b"` (strings) or `1|2`? Strings are readable in the JSON and the logs;
   prefer `a`/`b`.
2. **Fallback policy** — cross-team respawn with a log (default) vs delay until a team pad frees. A delay risks a dead
   bot for the rest of a run; the log is enough for a prototype.
3. **Does the operator's human seat have to pick a team**, or does any free pad do? Any free pad = the pad's team.
4. **Observer** — unseated, no team; if the observer later needs one, the `teams` frame gives it nothing.
5. **NPC wander spawns** — stay teamless and never respawn on player pads (today's rule).
6. **Does the two-squad prototype need the `teams` frame**, or is the driver's roster enough for now? Default: roster.

## 6. Confidence

`verified locally` — every line reference, the pad file, the kernel record, the bake types. `inferred` — the bake
parse edit's exact location (the `scene.playerSpawns` builder in `plan.ts`/`bake.ts`; the reader confirmed
`spawnFile`/`SpawnPoint` but not the parse function by line). `documented externally` — none.
