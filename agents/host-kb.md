# Host knowledge base

The runtime flow of the arena host: the 20 Hz tick, ownership, collision,
doors, elevators, hitscan, bots, health, and the snapshot path.
This is the layer above `agents/codemap.md`: the map, not the index.
Every claim carries `file:line`. Generated code is not described here —
follow the symbol into the codemap.

Scale on the reviewed tree (`984e20a`, 2026-11-14): **1,618** live collision
AABBs, **98** doors, **4** elevator cabs, **156** pickups, **16** wander agents.
The arena loader is `src/server/world-loader.ts:48`; the numbers come from
`world.listObstacles()`, `view.doors`, `view.elevators`, `view.pickups`, and
`agents` after `loadArena()`.

## 1. Boot and composition

**Owns:** assembling one authoritative arena from the manifest and socket
server; nothing here runs per tick.

`startArenaServer` (`src/server/main.ts:277`) loads the arena, then calls
`createArenaHost` (`src/server/main.ts:285` → `src/server/arena-host.ts:98`).
Inside `createArenaHost` the order is deliberate: fire, bot sense, bot brain,
then elevators/doors, then `startWanderLoop`. Fire is built before the brain
because FightBack needs `fireAsBot` and `forgetBot`
(`src/server/arena-host.ts:326-349`); doors and elevators are built before the
loop because the first tick already steps cabs and blockers
(`src/server/arena-host.ts:373`). Reordering this wiring silently disables bot
shooting or leaves the first tick without door collision.

The session object is the only surface (`ArenaSession` in the codemap). `attach`
(`src/server/arena-host.ts:429`) owns per-connection inbound frames and the two
deny-log throttles; `stop()` (`:554`) clears snapshot jobs, both deny logs, and
the loop.

## 2. The 20 Hz tick

**Owns:** everything that changes authoritative state without a client frame.

`startWanderLoop` (`src/server/game.ts:880`) is the only `setInterval` on the
path, 50 ms (`TICK_MS`). One tick, in order:

1. Drain gateway timeouts; `clearInput` + `held.drop` (`game.ts:907-909`).
2. Build the owned-entity set from connected clients (`:912-914`); drop held
   inputs that are no longer owned (`:916-918`).
3. `noteArenaInterest(server)` sets every session's interest radius
   (`game.ts:87`, called at `:920`).
4. `elevators.step(MOVE_DT)` returns riders (`game.ts:921`).
5. Per agent: riders skip input (`:924`); dead agents latch fall/idle
   (`:925-936`); unowned players are skipped (`:938`); owned agents take held
   input through `enqueueOwnedMove` (`:939-955`); unowned bots run
   `steerUnownedWander` then `stepUnownedWander` (`:956-973`).
6. Respawn timers (`:974-976`).
7. `commitShielded` for riders/noclip, else `world.commit` (`:977-980`).
8. `onTick` (`:981-985`): pickup grant + obstacle release, grenade tick, bot
   sense, bot brain, bot labels — in that order (`arena-host.ts:374-395`).
9. Publish replication envelopes and send one snapshot per client
   (`game.ts:983-991`), then health frames and audit (`:992-993`).

The order is a contract: pickups run before `grenades.tick`, so a grenade swept
on this tick sees the post-pickup obstacle array; bot sense runs after the
pickup/commit so it reads the tick's final world. A reorder makes pickup and
grenade interactions depend on tick parity.

## 3. Ownership, input, and seq gates

**Owns:** which client may move which pawn, and which frames are fresh.

`HeldInputs` (`src/shared/movements.ts` `createHeldInputs`) stores the latest
command per entity; `HeldInputs.entities()` (`game.ts:80`) is what the loop
drops for unowned entities. Ownership is `server.replicator.get(clientId)` →
`ownedEntity` (`game.ts:913`). `clearInput` is enqueued on death so the clip
leaves the process (`game.ts:928-935`).

Seq gates are per session: `admitFire` (`src/shared/hitscan.ts:127`) and
`admitGrenade` (`src/shared/grenade.ts:94`) reject repeats and too-fast
sequences, and the session id is part of the row key (`fire.ts:60-66`,
`grenade.ts:129-137`). A gate row outliving its session is the failure mode;
both recreate on a sessionId change.

## 4. Collision and the floor index

**Owns:** the 1,618-box obstacle array and the grid that makes floor and
hitscan queries sub-linear.

`floorIndexFor(boxes)` (`src/shared/movements.ts:245`) is a `WeakMap` keyed by
the live array; it rebuilds only when length, last element identity, or the
global `dynamicEpoch` changes (`:247`). `buildFloorIndex` (`:264`) builds a CSR
grid over XZ with `FLOOR_INDEX_CELL` cells and `FLOOR_INDEX_PAD` query room;
boxes whose Y band is missing or whose XZ span is too large go into `always`.
Y is deliberately not indexed: floor height is read live (`floorHeightIndexed`),
so a Y-only move needs no rebuild.

Rebuild triggers: a pickup splice changes length (`src/server/pickups.ts:39-45`);
`markDynamicObstacle` bumps the epoch once per box (`movements.ts:238-242`).
Door leaves are marked dynamic and then rewritten in XZ every `sync`
(`src/server/doors.ts:78-83`); dynamic boxes live in `always`, so the grid does
not have to rebuild when a leaf moves. A new XZ writer that is neither marked
dynamic nor changes length/last is the one way to serve a stale index.

## 5. Doors

**Owns:** 98 runtime leaves, their blockers, use presses, and key state.

`createArenaDoors` (`src/server/doors.ts:121`) seeds state and syncs every
blocker once (`:148`). `createDoorBlockers` (`:62`) keeps one live kernel box
per door: an unknown door allocates an id with a full `reduce` over the live
obstacle array (`:67`) then `addObstacle`; `sync` finds that box
(`listObstacles().find`, `:64`) and rewrites it in place, parking it at
`-1e6` while open (`:78-83`). Nothing is spliced out.

`ride.offset(id, dy)` (`:153`) moves a cab-room door in Y and re-syncs its
blocker; elevators call it per room door on every moving tick
(`src/server/elevators.ts:189`). `press` (`:175`) copies `state.values()` per
press, sorts to a snapshot only for `snapshot()` (`:201`), and `tryUseDoor`
keeps the key held (`src/shared/doors.ts`). The use-seq gate is per client
(`drop`, `:207`).

## 6. Elevators

**Owns:** 4 cabs, their motion, riders, and the room/cab collision they carry.

`elevators.step(dt)` (`src/server/elevators.ts:172`) advances each cab, captures
riders on departure (`:179-183`), offsets the room rider and every room door
while moving (`:186-190`), and moves riders. Returned riders are skipped by
input and shielded through commit (`game.ts:921,924,973`). `createRoomRider`
(`elevators.ts:213`) rewrites only minY/maxY (`:236-240`), which is why the
floor grid is not rebuilt for cab motion. The room-door list is built from door
ids prefixed by the room (`:93`); on this tree each cab has one room door.

## 7. Hitscan and grenades

**Owns:** the three trace implementations and the grenade sweep.

- `traceIndexed` (`src/shared/hitscan.ts:170`) walks the CSR grid, checks
  dynamic/oversized boxes from `always`, and reads Y live. Hitscan shots and
  line of sight use it (`fire.ts:80`, `arena-host.ts:347` → `hasLineOfSight`
  `hitscan.ts:231`).
- `traceHitscan` (`hitscan.ts:143`) is the linear reference; the server does not
  call it on a hot path.
- `sweepSegment` (`hitscan.ts:566`) is linear over every AABB and capsule; the
  grenade uses it (`grenade.ts:148` inside `stepGrenade`).

`grenades.tick` (`grenade.ts:143`) fetches `listObstacles()` once, then for each
body calls `stepGrenade(... pawnCapsules(opts.world) ...)`. Capsules are rebuilt
per body, not per tick (`:148`); `bodies` has no cap (`throwAs` pushes at `:82`).
Gate rate is 1/s and grenade life is 4 s, so one client can keep ~4 bodies
alive; 16 clients can keep ~64.

## 8. Bots and nav

**Owns:** the per-bot decision work the loop triggers, and the caches that make
it affordable.

The loop calls `steerUnownedWander` then `stepUnownedWander` per unowned agent
(`game.ts:956-973`). `steerUnownedWander` (`game.ts:238`) builds
`doorFlags` (`game.ts:683`) every tick per agent, which asks
`nav.liveDoors()` (`arena-host.ts:324` → `doorHost.snapshot()`, `doors.ts:201`)
and allocates a fresh sorted 98-row array. It also allocates `followOthers`
(`game.ts:867`) per agent per tick. Route work is cached by
`createRoadCache` (`src/shared/nav/route.ts:90`), region overlays by
`overlayShutDoors` (`src/shared/nav/regions.ts:120`), nav grids by `navBoxes`
(`src/shared/nav/grid.ts:156`). The arbiter is latched per mind
(`src/shared/bots/arbiter.ts:193`); its latches survive a calm reading until
outside.

## 9. Health, audit, pickups

**Owns:** hp/respawn timers, per-session sent state, and the 156 pickup
placements.

`createPawnHealth` (`src/server/health.ts`) owns hp; the tick applies respawns
and sends only changed rows (`deliverHealthFrames`, `health.ts:45`). Sent state
is per server and per session (`sentFor`, `:19`); it prunes stale clients only
when the cache is larger than the connected set (`:28-33`). Audit uses the same
helper (`src/server/audit.ts:11`). `pickupHost.take` runs in `onTick`
(`arena-host.ts:376`); a grant calls `releasePickupObstacle`
(`src/server/pickups.ts:31`), which finds the placement obstacle then
`splice`s the live array (`:39-45`). The changed length is what tells
`floorIndexFor` to rebuild on the next floor query.

## 10. Snapshot path and backpressure

**Owns:** turning one committed world into per-client snapshot frames.

After commit, `server.replicator.publish(world, snap)` (`game.ts:983`) returns
one envelope per client; each is dispatched through `hostSnapPath`
(`src/server/host-path.ts:34`) to `server.sendSnapshot` (`game.ts:900`). The
host has no outbound queue of its own: `dispatchHostFrame` (`host-path.ts:43`)
awaits `DirectNetPath.send` and only logs a rejection. Whether a slow socket
buffers or drops is kernel behaviour (`conveyor-engine-transport-ws`) and is not
inspectable from this tree; the host does not add a per-client byte budget.
Health and audit frames go directly through `session.socket.send`
(`health.ts:62`, `audit.ts:21`).

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
| `doorHost.snapshot` | 98 | 27.8 | 16 (one per unowned agent) | 0.89% | allocation + sort |
| `buildFloorIndex` | 1,618 | 890 | per pickup event | 1.78% / event | linear rebuild |
| boot `DoorBlockers` seed | 98 doors | 14,200 total | boot | 0.03% one tick | linear boot |

Allocations per tick (Appendix C sweep): `new Set` for timeouts and owned
(`game.ts:907,912`), `noclipIds` (`:922`), `[...noclipIds, ...riders]` (`:973`),
`followOthers` array + one object per other agent per bot (`:867`), 98-row
snapshots from `liveDoors()` per unowned agent (16 × 98 objects), `health.frames`
and `audit.frame` arrays, `snapped` array. `riders.includes` (`:924`) is over
≤4 ids and is noise.

## 12. Invariant index

Existing `@invariant`s that protect this layer (from the codemap):

- `DoorBlockers` — one live obstacle per door; opening parks it
  (`src/server/doors.ts:39`).
- `SnapshotStore` — `byRequester` and `byId` hold the same jobs
  (`src/server/snapshot-store.ts:18`).
- `RateLimitedLog` — one log per client per window (`src/server/rate-limited-log.ts:16`).
- `sceneGraphHash` — set once in `sceneGraphReady`, stable afterwards
  (`src/server/arena-host.ts:107`, still a deferral).
- `judge` — Escape latched until outside
  (`src/shared/bots/arbiter.ts:193`).
- `buildWorldState` — a held key sets both `hasKey` and `holding`; absent facts
  are omitted (`src/shared/bots/state.ts:70`).
- `createRoadCache` — one net per gate signature
  (`src/shared/nav/route.ts:90`).

Missing, found by this review (report findings, not tags): the grenade body
count has no invariant/limit; `releasePickupObstacle` relies on the length
change to invalidate the floor index; `doorHost.snapshot()` is allocation-shaped
but not documented as a per-tick call. See
`plan/dsh-tasks/reports/19-host-review.md`.
