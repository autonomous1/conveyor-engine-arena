# Host knowledge base — flow (§1–§10)

The runtime flow of the arena host: the 20 Hz tick, ownership, collision,
doors, elevators, hitscan, bots, health, and the snapshot path. This is the
layer above `agents/codemap.md`: the map, not the index. Every claim names the
file and symbol; the codemap owns `:line`. Generated code is not described here —
follow the symbol into the codemap.
The host's state — containers, keys, writers, lifetimes — is §13, in
`agents/host-model.md`. A task's **Knowledge base** slot names the half it
needs; `agents/host-kb.md` is the index.

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

Auth is its own subtree: `src/server/auth/` mints and verifies tokens
(`tokens.ts`, `resolvedScopes`), gates the privileged paths (`gate.ts`), and
keeps the revocation list — host state, §13.2.

## 2. The 20 Hz tick

**Owns:** everything that changes authoritative state without a client frame.

`startWanderLoop` (`src/server/game.ts`) is the only `setInterval` on the
path, 50 ms (`TICK_MS`). One tick, in order:

1. Drain gateway timeouts; `clearInput` + `held.drop` (`game.ts`).
2. Build the owned-entity set from connected clients; drop held
 inputs that are no longer owned.
3. `noteArenaInterest(server)` sets every session's interest radius
 (`game.ts`, called each tick after the owned set).
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

`HeldInputs` (`src/server/game.ts` `createHeldInputs`) stores the latest
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

`createPawnHealth` (`src/shared/health.ts`) owns hp; the tick applies respawns
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

