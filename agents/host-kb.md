# Host knowledge base

The runtime flow of the arena host: the 20 Hz tick, ownership, collision,
doors, elevators, hitscan, bots, health, and the snapshot path.
This is the layer above `agents/codemap.md`: the map, not the index.
Every claim names the file and symbol; the codemap owns `:line`. Generated code is not described here —
follow the symbol into the codemap.
The host's state — containers, keys, writers, lifetimes — is §13.

Scale on the reviewed tree (`984e20a`, 2026-11-14): **1,618** live collision
AABBs, **98** doors, **4** elevator cabs, **156** pickups, **16** wander agents.
The arena loader is `src/server/world-loader.ts`; the numbers come from
`world.listObstacles()`, `view.doors`, `view.elevators`, `view.pickups`, and
`agents` after `loadArena()`.

## 1. Boot and composition

**Owns:** assembling one authoritative arena from the manifest and socket
server; nothing here runs per tick.

`startArenaServer` (`src/server/main.ts`) loads the arena, then calls
`createArenaHost` (`src/server/main.ts` → `src/server/arena-host.ts`).
Inside `createArenaHost` the order is deliberate: fire, bot sense, bot brain,
then elevators/doors, then `startWanderLoop`. Fire is built before the brain
because FightBack needs `fireAsBot` and `forgetBot`
(`src/server/arena-host.ts`); doors and elevators are built before the
loop because the first tick already steps cabs and blockers
(`src/server/arena-host.ts`). Reordering this wiring silently disables bot
shooting or leaves the first tick without door collision.

The session object is the only surface (`ArenaSession` in the codemap). `attach`
(`src/server/arena-host.ts`) owns per-connection inbound frames and the two
deny-log throttles; `stop` clears snapshot jobs, both deny logs, and
the loop. The containers this boot creates, with their keys and lifetimes, are §13.

## 2. The 20 Hz tick

**Owns:** everything that changes authoritative state without a client frame.

`startWanderLoop` (`src/server/game.ts`) is the only `setInterval` on the
path, 50 ms (`TICK_MS`). One tick, in order:

1. Drain gateway timeouts; `clearInput` + `held.drop` (`game.ts`).
2. Build the owned-entity set from connected clients; drop held
 inputs that are no longer owned.
3. `noteArenaInterest(server)` sets every session's interest radius
 (`game.ts`, called).
4. `elevators.step(MOVE_DT)` returns riders (`game.ts`).
5. Per agent: riders skip input; dead agents latch fall/idle; unowned players are skipped; owned agents take held
 input through `enqueueOwnedMove`; unowned bots run
 `steerUnownedWander` then `stepUnownedWander`.
6. Respawn timers.
7. `commitShielded` for riders/noclip, else `world.commit`.
8. `onTick`: pickup grant + obstacle release, grenade tick, bot
 sense, bot brain, bot labels — in that order (`arena-host.ts`).
9. Publish replication envelopes and send one snapshot per client
 (`game.ts`), then health frames and audit.

The order is a contract: pickups run before `grenades.tick`, so a grenade swept
on this tick sees the post-pickup obstacle array; bot sense runs after the
pickup/commit so it reads the tick's final world. A reorder makes pickup and
grenade interactions depend on tick parity.

## 3. Ownership, input, and seq gates

**Owns:** which client may move which pawn, and which frames are fresh.

`HeldInputs` (`src/shared/movements.ts` `createHeldInputs`) stores the latest
command per entity; `HeldInputs.entities()` (`game.ts`) is what the loop
drops for unowned entities. Ownership is `server.replicator.get(clientId)` →
`ownedEntity` (`game.ts`). `clearInput` is enqueued on death so the clip
leaves the process (`game.ts`).

Seq gates are per session: `admitFire` (`src/shared/hitscan.ts`) and
`admitGrenade` (`src/shared/grenade.ts`) reject repeats and too-fast
sequences, and the session id is part of the row key (`fire.ts`,
`grenade.ts`). A gate row outliving its session is the failure mode;
both recreate on a sessionId change.

## 4. Collision and the floor index

**Owns:** the 1,618-box obstacle array and the grid that makes floor and
hitscan queries sub-linear.

`floorIndexFor(boxes)` (`src/shared/movements.ts`) is a `WeakMap` keyed by
the live array; it rebuilds only when length, last element identity, or the
global `dynamicEpoch` changes. `buildFloorIndex` builds a CSR
grid over XZ with `FLOOR_INDEX_CELL` cells and `FLOOR_INDEX_PAD` query room;
boxes whose Y band is missing or whose XZ span is too large go into `always`.
Y is deliberately not indexed: floor height is read live (`floorHeightIndexed`),
so a Y-only move needs no rebuild.

Rebuild triggers: a pickup splice changes length (`src/server/pickups.ts`);
`markDynamicObstacle` bumps the epoch once per box (`movements.ts`).
Door leaves are marked dynamic and then rewritten in XZ every `sync`
(`src/server/doors.ts`); dynamic boxes live in `always`, so the grid does
not have to rebuild when a leaf moves. A new XZ writer that is neither marked
dynamic nor changes length/last is the one way to serve a stale index.

## 5. Doors

**Owns:** 98 runtime leaves, their blockers, use presses, and key state.

`createArenaDoors` (`src/server/doors.ts`) seeds state and syncs every
blocker once. `createDoorBlockers` keeps one live kernel box
per door: an unknown door allocates an id with a full `reduce` over the live
obstacle array then `addObstacle`; `sync` finds that box
(`listObstacles().find`) and rewrites it in place, parking it at
`-1e6` while open. Nothing is spliced out.

`ride.offset(id, dy)` moves a cab-room door in Y and re-syncs its
blocker; elevators call it per room door on every moving tick
(`src/server/elevators.ts`). `press` copies `state.values()` per
press, sorts to a snapshot only for `snapshot`, and `tryUseDoor`
keeps the key held (`src/shared/doors.ts`). The use-seq gate is per client
(`drop`).

## 6. Elevators

**Owns:** 4 cabs, their motion, riders, and the room/cab collision they carry.

`elevators.step(dt)` (`src/server/elevators.ts`) advances each cab, captures
riders on departure, offsets the room rider and every room door
while moving, and moves riders. Returned riders are skipped by
input and shielded through commit (`game.ts`). `createRoomRider`
(`elevators.ts`) rewrites only minY/maxY, which is why the
floor grid is not rebuilt for cab motion. The room-door list is built from door
ids prefixed by the room; on this tree each cab has one room door.

## 7. Hitscan and grenades

**Owns:** the three trace implementations and the grenade sweep.

- `traceIndexed` (`src/shared/hitscan.ts`) walks the CSR grid, checks
 dynamic/oversized boxes from `always`, and reads Y live. Hitscan shots and
 line of sight use it (`fire.ts`, `arena-host.ts` → `hasLineOfSight`
 `hitscan.ts`).
- `traceHitscan` (`hitscan.ts`) is the linear reference; the server does not
 call it on a hot path.
- `sweepSegment` (`hitscan.ts`) is linear over every AABB and capsule; the
 grenade uses it (`grenade.ts` inside `stepGrenade`).

`grenades.tick` (`grenade.ts`) fetches `listObstacles()` once, then for each
body calls `stepGrenade(... pawnCapsules(opts.world)...)`. Capsules are rebuilt
per body, not per tick; `bodies` has no cap (`throwAs` pushes).
Gate rate is 1/s and grenade life is 4 s, so one client can keep ~4 bodies
alive; 16 clients can keep ~64.

## 8. Bots and nav

**Owns:** the per-bot decision work the loop triggers, and the caches that make
it affordable.

The loop calls `steerUnownedWander` then `stepUnownedWander` per unowned agent
(`game.ts`). `steerUnownedWander` (`game.ts`) builds
`doorFlags` (`game.ts`) every tick per agent, which asks
`nav.liveDoors()` (`arena-host.ts` → `doorHost.snapshot()`, `doors.ts`)
and allocates a fresh sorted 98-row array. It also allocates `followOthers`
(`game.ts`) per agent per tick. Route work is cached by
`createRoadCache` (`src/shared/nav/route.ts`), region overlays by
`overlayShutDoors` (`src/shared/nav/regions.ts`), nav grids by `navBoxes`
(`src/shared/nav/grid.ts`). The arbiter is latched per mind
(`src/shared/bots/arbiter.ts`); its latches survive a calm reading until
outside.

## 9. Health, audit, pickups

**Owns:** hp/respawn timers, per-session sent state, and the 156 pickup
placements.

`createPawnHealth` (`src/server/health.ts`) owns hp; the tick applies respawns
and sends only changed rows (`deliverHealthFrames`, `health.ts`). Sent state
is per server and per session (`sentFor`); it prunes stale clients only
when the cache is larger than the connected set. Audit uses the same
helper (`src/server/audit.ts`). `pickupHost.take` runs in `onTick`
(`arena-host.ts`); a grant calls `releasePickupObstacle`
(`src/server/pickups.ts`), which finds the placement obstacle then
`splice`s the live array. The changed length is what tells
`floorIndexFor` to rebuild on the next floor query.

## 10. Snapshot path and backpressure

**Owns:** turning one committed world into per-client snapshot frames.

After commit, `server.replicator.publish(world, snap)` (`game.ts`) returns
one envelope per client; each is dispatched through `hostSnapPath`
(`src/server/host-path.ts`) to `server.sendSnapshot` (`game.ts`). The
host has no outbound queue of its own: `dispatchHostFrame` (`host-path.ts`)
awaits `DirectNetPath.send` and only logs a rejection. Whether a slow socket
buffers or drops is kernel behaviour (`conveyor-engine-transport-ws`) and is not
inspectable from this tree; the host does not add a per-client byte budget.
Health and audit frames go directly through `session.socket.send`
(`health.ts`, `audit.ts`).

## 11. Hot-path table

Measured on `984e20a`, Node v24.0.2, single process, median of three runs;
calibration values in the wave-3 review are ~1.7–3× lower on the author's
machine, so percentages are the portable number.

| Operation | N | µs/call | Calls/tick | % of 50 ms | Verdict |
|---|---:|---:|---:|---:|---|
| `listObstacles().find` | 1,618 | 27.3 | 4 (elevator door sync) | 0.22% | linear |
| `DoorBlockers.sync` | 1,618 | 33.3 | 4 | 0.27% | linear find |
| `sweepSegment` (grenade) | 1,618 | 753.0 | 1–64 bodies | 1.5–96% | linear, uncapped |
| `traceIndexed` (hitscan) | 1,618 | 9.4 | per shot | <0.05% | grid-indexed |
| `traceHitscan` (reference) | 1,618 | 398.8 | not hot | 0.80% | linear |
| `hasLineOfSight` | 1,618 | 3.8 | per LOS query | <0.01% | grid-indexed |
| `doorHost.snapshot()` | 98 | 27.8 | 16 (one per unowned agent) | 0.89% | allocation + sort |
| `buildFloorIndex` | 1,618 | 890 | per pickup event | 1.78% / event | linear rebuild |
| boot `DoorBlockers` seed | 98 doors | 14,200 total | boot | 0.03% one tick | linear boot |

Allocations per tick (Appendix C sweep): `new Set` for timeouts and owned
(`game.ts`), `noclipIds`, `[...noclipIds,...riders]`,
`followOthers` array + one object per other agent per bot, 98-row
snapshots from `liveDoors()` per unowned agent (16 × 98 objects), `health.frames`
and `audit.frame` arrays, `snapped` array. `riders.includes` is over
≤4 ids and is noise.

## 12. Invariant index

Existing `@invariant`s that protect this layer (from the codemap):

- `DoorBlockers` — one live obstacle per door; opening parks it
 (`src/server/doors.ts`).
- `SnapshotStore` — `byRequester` and `byId` hold the same jobs
 (`src/server/snapshot-store.ts`).
- `RateLimitedLog` — one log per client per window (`src/server/rate-limited-log.ts`).
- `sceneGraphHash` — set once in `sceneGraphReady`, stable afterwards
 (`src/server/arena-host.ts`, still a deferral).
- `judge` — Escape latched until outside
 (`src/shared/bots/arbiter.ts`).
- `buildWorldState` — a held key sets both `hasKey` and `holding`; absent facts
 are omitted (`src/shared/bots/state.ts`).
- `createRoadCache` — one net per gate signature
 (`src/shared/nav/route.ts`).

Missing, found by this review (report findings, not tags): the grenade body
count has no invariant/limit; `releasePickupObstacle` relies on the length
change to invalidate the floor index; `doorHost.snapshot()` is allocation-shaped
but not documented as a per-tick call. See
`plan/dsh-tasks/reports/19-host-review.md`.

## 13. Host state model

**Owns:** the map of the host's state — which container holds which record, its key,
who writes it, and how long it lives. The flows are §1–§10; the sub-host internals
stay in the sections linked below and in the codemap. `S`/`B`/`X`: see
`agents/AGENTS.md` "KB row classifications".

### 13.1 Read-only inputs (boot-only)

| tag | state | container | element type | key → value | written by | lifetime |
|---|---|---|---|---|---|---|
| S | arena data | `loaded` | `LoadedArena` (`world-loader.ts`) | world, agents, view, playerSpawns, sceneGraph?, regions?, spatialDag? | `loadArena()` before the host | boot-only |
| S | canonical privileged JSON | `sceneGraphJson`, `regionsJson` (`arena-host.ts`) | strings | — | host construction | boot-only |
| S | page view | `arenaJson`, `propClips` (`arena-host.ts`) | strings | — | `startPropAnimation` | boot-only |
| B | content hashes | `sceneGraphHash`, `regionsHash` (`arena-host.ts`) | `let` string | — | `sha256Hex` in `sceneGraphReady` | one-shot; stable after |
| B | privileged arrivals before the hash | `privilegedWaiters` | `HostConn[]` | — | `pushPrivileged` | until `sceneGraphReady` splices |
| S | nav view handed to the loop and brain | `wanderNav` | object | sceneGraph, regions, aabbs, doors, pawnRadius, pawnHeight, liveDoors | host construction | boot-only |

### 13.2 Sub-hosts (constructed here, internals linked)

| tag | state | container | element type | key → value | written by | lifetime |
|---|---|---|---|---|---|---|
| X | kernel server | `engine` | `EngineWsServer` | clientId → gateway/replicator/session | kernel + `onHello` | per session |
| S | door leaves + blockers | `doorHost` | §5, `doors.ts` `state` Map | door id → `DoorRuntime` | `sync`/`press` | boot-only; leaves mutate per press |
| B | goal claims | `claimHost` | `claims.ts` `table` | goal key → `{owner, expires}` | `onFrame`, `tick` | TTL 5–120 s, default 30 (`claims.ts`) |
| S | cabs + riders | `elevatorHost` | §6, `elevators.ts` cabs | cab id → `Cab` (`riders`) | `step` | boot-only; riders per tick |
| B | fire seq gates | `fire` | `fire.ts` `gates`, `botGates` | clientId / bot id → gate | `onFrame` | per session |
| B | grenade bodies + gates | `grenades` | `grenade.ts` | gates per client; `bodies` array | `throwAs`, `tick` | body ≤ `GRENADE_LIFE_S` 4 s (`grenade.ts`); gates per session |
| S | bot sense/decisions/labels | `botSense`, `botBrain`, `botLabels` | §8, `bot-sense.ts`, `bot-brain.ts`, `bot-label.ts` | bot id → row / `Slot` / label | `update` | per tick |
| S | hp, loadout, inventory, audit | `health`, `kit`, `pickupHost`, `audit` | §9, `health.ts`, `pickups.ts`, `audit.ts` | pawn id → vital / ammo+weapon / keys | tick + frames | per session |
| S | snapshot jobs | `snapStore` | §10, `snapshot-store.ts` | requesterId/id → `SnapJob` | `begin`/`take` | TTL 3 s (`arena-host.ts`) or `take` |

### 13.3 Per-client

| tag | state | container | element type | key → value | written by | lifetime |
|---|---|---|---|---|---|---|
| X | connected clients | `engine.connected` | Set | — | kernel | per session |
| X | seat record | `engine.gateway`/`replicator` | kernel record | clientId → `connected`, `ownedEntity`, `sessionId`, `interestRadius` | kernel + `onHello` | per session |
| B | refused hellos | `refused` | Set<number> | clientId | `onHello` | until the welcome passes |
| B | snapshot id counter | `snapSeq` | `let` number | — | `nextSnapId` | monotonic |
| B | roster signature | `lastRoster` | `let` string | — | tick callback | replaced on change |
| B | deny throttles | `teleportDenyLog`, `qaSnapshotDenyLog` | `RateLimitedLog` (`rate-limited-log.ts`) | clientId → last ms | `shouldLog` | 60 s window; cleared on stop |
| B | per-connection handlers | `socketFromConn` | arrays + `self` | — | `attach` | per connection |

### 13.4 Per-pawn/entity

| tag | state | container | element type | key → value | written by | lifetime |
|---|---|---|---|---|---|---|
| X | kernel entities | `loaded.world` store | kernel | entity id → pose/radius/scale/render | `placePawn`, frame commit | until restart |
| B | health rows | `health.rows` (`health.ts`) | Map | pawn id → `Vital` | `take`, respawn, `note` | per session; `forget` on close |
| B | loadout | `kit` (`pickups.ts`) | two Maps | pawn id → ammo, weapon | `take` | per session; `forget` on reuse and close |
| B | inventory | `pickupHost` (`pickups.ts`) | Set + Map + bags | placement id → placement; pawn → key set | `take`, `consumeKey` | until taken; `forget` on reuse |
| B | latest input | `held` | Map (`game.ts`) | pawn id → `HeldInput` | `admit` | per tick; dropped on death/teleport/reuse/close |
| S | agent records | `agents` (`world-loader.ts`) | `WanderAgent[]` | id → role, gait, goal, path, override, heading, nextTurn | loop + brain | boot-created; fields per tick |
| B | wander walks | `wanderWalks` (`game.ts`) | WeakMap | agent → walk | `steerUnownedWander` | per walk; `clearWalk` |
| S | player/NPC groups | `npcIds`, `padIds` | Sets | — | host construction | boot-only |
| B | bot-debug ids | `botIds` | array | — | boot when `botDebug` | boot-only |
| B | pads reserved since the last commit | `reservedPads` | Map | pawn id → `SpawnPick` | hello | cleared every tick |
| S | seat render handles | `seatRender` | Map | player pad id → kernel render | host construction | boot-only; `role === "player"` only |

### 13.5 Tick-owned and lifetime rules

- Per tick the host mutates: `claimHost.tick(Date.now())` (`arena-host.ts`),
 `reservedPads.clear()`, the pickup `take`, and
 `grenades.tick()` / `botSense.update()` / `botBrain.update()` / `botLabels.update()`. The tick's order is §2. `held` is replaced by `admit` per input frame
 and dropped for unowned entities by the loop (`game.ts`).
- On close (`arena-host.ts`): `despawnSeat`, `held.drop`, `fire.forgetBot`,
 `claimHost.drop`, `health.forget`, `kit.forget`, `grenades.drop`,
 `reservedPads.delete`; `doorHost.drop(clientId)`.
- On seat reuse in hello: `held.drop`, `kit.forget`, `pickupHost.forget`,
 `fire.forgetBot`. On teleport: `held.drop`.
- On `stop`: the snapshot jobs and their timers, both deny
 logs, then `stopLoop()`.
- TTLs: snapshot job 3 s, claim row 5–120 s (`claims.ts`), deny log
 60 s (`rate-limited-log.ts`), grenade body 4 s (`grenade.ts`).
- A restart loses every container here; only `loaded` is rebuilt (`world-loader.ts`).

### Ownership graph

```text
clientId ──engine.gateway/replicator──▶ ownedEntity (pawn id)
 │ ├─ health.rows[id] hp
 │ ├─ kit{ammo,weapon}[id] loadout
 │ ├─ pickupHost.heldKeys[id] keys
 │ ├─ held[id] latest input
 │ └─ claimHost.table[*].owner claims
 ├─ snapStore.byRequester[clientId] one job
 ├─ snapSeq / lastRoster / refused per-client scalars
 └─ socketFromConn(messages, closes, self) per-connection handlers

pawn id (role === "player") ──▶ seatRender[id] ──▶ agent record
npc id (role !== "player") ──▶ npcIds ──▶ botSense.rowById / botBrain.byId / botLabels
reservedPads[pawn id] ──▶ the next hello's claimClearSpawn `pending`
SnapJob: requesterId → byRequester; id → byId
```

### Trust boundary

Inbound frames are untrusted and enter through the `attach` handler
(`arena-host.ts`); the state above is the authority, and client predictions
are never stored here. Scopes gate the privileged paths: `teleport`, `qa`
snapshots, `scene-graph` delivery. The `X` rows mark the
containers shared with the kernel (`engine.*`, the world store), the client
(`propClips`, the frames built from `view`), or the shared contract — their
contracts live in `agents/shared-kb.md` or the model repo, not here.

### Candidate invariants

Checkable from the model; none is in §12 yet. One moves to §12 only when a test or
`@invariant` confirms it.

- `sceneGraphHash` / `regionsHash` are written once inside `sceneGraphReady` and never again — `arena-host.ts`.
- `reservedPads` is emptied on every tick, so a pad reserved by a hello reads as occupied only until the next tick's commit — `arena-host.ts`.
- `npcIds` / `padIds` are fixed at boot from `loaded.agents` — `arena-host.ts`.
- `seatRender` holds `role === "player"` ids only — `arena-host.ts`.
- `refused` loses a client exactly when its welcome passes — `arena-host.ts`.
- A snapshot job leaves the store by `take` or the 3 s timer, and both maps are cleared together — `snapshot-store.ts`, `arena-host.ts`.
- `claimHost.table` rows are expired by `tick` and dropped for a disconnected owner — `claims.ts`, `arena-host.ts`.


## 14. Known quirks / open gaps

Dated 2026-11-19, "as of the current fixes". The live runs rediscovered these the
hard way; see `plan/dsh-tasks/reports/53-attack-fix-list.md`. A run that hits one
records it as evidence, not a new discovery.

Read `plan/dsh-tasks/reports/53-attack-fix-list.md` before a fresh session; the
recent runs rediscovered these the hard way:

- **Spawn collision on a fresh join** — a pawn can come back boxed; step off/away
  and re-plan.
- **Kit/pose reuse on a fresh join** — a new client can inherit the previous pawn's
  weapon/pose; the operator once joined holding the alien weapon. Check
  `weapon`/`ammo` and the pose at the start, not only at the end.
- **Despawn does not release the seat** (task 49 fixed the close path; a stale
  tab/old bot can still hold a seat) — check the seat count.
- **Door-replan livelock** — the same `goTo` re-begun ~600 times with no pose
  change; the macro fix is 53 #5; until then, step off and re-plan.
- **Weapon consumed on session close** — the alien weapon does not survive the
  session; a run needs a fresh map or an armed bot, and the arm-up is two
  pickups (weapon + an outside ammo crate).
- **Ammo accounting** — the 30-round pickup + 154+ shots; `ammo` may not be the
  budget the controller assumes; check before trusting the gate.
- **The kit survives death** — a respawn keeps the weapon/rounds; 53 #9 decided
  later.
- **Door handling:** check `door.locked`/`doorBody(id).key` before pressing; a
  locked door needs its key (the operator may hold it) — log
  `door <id> is LOCKED (key=…)` and skip the target. Press `use` **once**, then
  wait for the door frame; spamming `use` toggles the leaf open/closed. An
  already-open door needs no press.
- **Elevator room door is a prop** — `…elevator-1-1.door-1-1-9-22` is in
  `world.doors` but not a scene-graph `door` portal, so `goTo:e1@0` never
  presses `use` and wedges on the room's north-east corner; the west landing is
  `(-34.914772, 0, 26.86411)`. Task 81 is the product fix. The only working
  approach is `packages/bot-client/tests/elevator-ride.ts` (north
  `(-32.20, 28.80)` → west `(-35.30, 28.80)` → south `(-35.30, 26.60)`, press
  the door, then the landing `(-33.564772, 26.86411)`); it is the spec, not a
  workaround to paste into `dag-live.ts`.
- **Seats before and after:** check the seat count before the run and, after
  `close`, confirm the seat is free; a stale session is what produces the next
  run's `SERVER_FULL`.

These are known; when a run hits one, record it as evidence, not a new
discovery.

- **Alien weapon / `no_ammo` (host environment).** A long-running host has usually
  lost the alien weapon and key to wander-bot pickups; the operator restarts the
  host to protect them. A bot that joins a long-running host logs
  `alien-weapon-1 present=false` and the attack mission exits `no_ammo`; ask for a
  fresh map, do not chase it. A restart closes the bot with `session abort`; wait
  for the operator's ready.

## 15. Layer map and single sources

Replicated from `agents/shared-kb.md` §1/§9; the test pins are shared §11.

| Group | Files | Host consumer | Client consumer | Cadence |
|---|---|---|---|---|
| wire/protocol | `wire.ts`, `bot-protocol.ts`, `fire-debug.ts`, `spawn-frame.ts` | frames out | frames in | per snapshot/frame |
| data model | `arena-view.ts`, `scene-graph.ts`, `pickups.ts`, `health.ts`, `audit.ts` | boot + tick | boot + snapshot | boot, tick, event |
| geometry | `doors.ts`, `elevators.ts`, `building-profile.ts`, `svg-bounds.ts`, `map-frame.ts` | doors/elevators | scene build, use prompt | tick, frame, boot |
| movement/collision | `movements.ts`, `hitscan.ts`, `look.ts`, `gamepad-map.ts` | owned step, fire, LOS | predicted step, shot, input | tick/frame |
| nav | `nav/grid.ts`, `funnel.ts`, `regions.ts`, `legs.ts`, `route.ts`, `follow.ts` | bot replan | not used | per replan |
| bots | `bots/*` | brain/sense/arbiter | not used | per tick |

The host is the authority for movement, doors, health, and pickups; the client
predicts only the camera and its own visual step; the bot-client and the host's bots import the frozen planner `goap.ts`
(`src/shared/bots/goap.ts`, kernel-independent).

| Convention | Shared | Consumer copy |
|---|---|---|
| Door yaw quarter-turn | `doors.ts doorYawRadians` | **Yes**: `client/arena-scene.ts yawToRadians` (identical body) |
| Door use volume | `doors.ts doorUseVolume` | No copy; host `server/doors.ts` and `pickDoorForUse` use it |
| Capsule overlap | `pickups.ts capsuleOverlapsAabb` | No copy; host `server/game.ts`, pickups use it |
| Movement intent | `look.ts moveIntent` | No copy; client `boot.ts`, host `game.ts` |
| Eye height | `look.ts EYE_HEIGHT` | No copy; client/server/bot import it |
| Pickup id encoding | `pickups.ts pickupBoxSource` | No copy; host `server/pickups.ts` |
| Snapshot revival | `wire.ts revive` | No copy; client `net.ts` |
| Door leaf box | `doors.ts doorLeafBox` | No copy; host `DoorBlockers` uses it |

The one real duplicate is door yaw; the two bodies are byte-identical today, and nothing fails if one drifts. The test pins for these pairs are in §11; the `X` rows in §13 carry the boundary contracts these single sources feed.
