# Shared knowledge base

`src/shared/` is the contract both halves run: the host's tick and the
client's frame execute the same movement, doors, hitscan, and scene-graph
code, and the bot runs the same planner. This is the layer map above
`agents/codemap.md`: who owns each behaviour, what is duplicated, and what a
call costs at the consumer. Every claim names the file and symbol; the codemap owns `:line`.

Baseline (`984e20a`, 2026-11-14): 1,618 boxes, 98 doors, 4 cabs, 156 pickups,
16 agents; 630 tests. Task 19's host numbers (`sweepSegment` 753 µs,
`floorIndexFor` rebuild 0.89 ms, `DoorBlockers.sync` 33 µs, `hasLineOfSight`
3.8 µs, F1–F10/H1–H11) are cited, not re-derived.

## 1. Layer map

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
(`src/shared/bots/goap.ts`, kernel-independent; the local sketch).

## 2. Wire and protocol

**Owns:** the bytes both sides accept and the trust boundary between them.

Client→host frames (`bot-protocol.ts` parsers) are **untrusted** and mostly
finite-checked; host→client snapshots are **trusted but not validated** — the
client's only gate is `asSnapshot` (`wire.ts`). `revive` (`wire.ts`)
rebuilds `$i` BigInts and allocates a fresh tree; `asSnapshot` then converts the
tick with `BigInt(Number(tick))`. A non-finite tick throws `RangeError` from the
snapshot path (report S2); the client's catch is `net.ts`, which reports the
fault and resyncs but loses the frame. `NaN` seq passes through.

Parser shape: each arena frame is JSON-parsed once, then a per-`t` parser
(`parseArenaFrame`, `bot-protocol.ts`). The finite checks are not uniform
(see the report's parser matrix): health hp, QA `waitFrames`, snapshot
vectors/follow numbers, and scene/regions hashes are checked; `welcome.ammo`
silently coerces `1e999` to 0 (`parseWelcomeExtras`). Unknown `t`,
kernel messages, and bad JSON return `undefined`.

## 3. Data model

**Owns:** the manifest view, the scene graph, pickup ids, health, and audit.

`arena-view.ts` is the manifest projection the client renders and the host
uses; its validation lives in `server/game-manifest.ts` (out of this layer).
`parseSceneGraph` (`scene-graph.ts`) is the data-model validator: it
requires an object, `formatVersion: 1`, `units: "meters"`, exactly one
`outside` place, arrays of places/portals, known door ids, increasing elevator
stops, matching landings/joins, a room for each shaft, and known stair joins.
A door-lock/key disagreement is **not** an error: it is a warning and the
portal is rewritten from the compiled door row — the graph's locks
are advisory (task 19 F10). Unknown extra fields are ignored.

Pickup ids are strings; `pickupBoxSource` (`pickups.ts`) is the one encoding
the host uses for the AABB source. `createPawnHealth` (`health.ts`) takes an
injected `now`; `audit.ts` is a pure counter set.
The cross-layer state model — who owns each value and what crosses the boundary —
is §12.

## 4. Geometry

**Owns:** the door quarter-turn, the use volume, leaf boxes, elevator
stops/landings, building profiles, SVG bounds, and the map frame.

`doorYawRadians` (`doors.ts`) wraps degrees to quarter turns; the client
re-implements the same body as `yawToRadians` (`client/arena-scene.ts`) —
see §9. `doorUseVolume` (`doors.ts`) builds the overlap box from the leaf
frame; the host adds it to the obstacle list never, only the use test
(`@why` in source). `doorLeafBox` is the shut blocker the host adds.
`elevators.ts` models stops/landings and the cab ride; the client renders the
same rows (`client/elevator-room.ts`). Building profiles and SVG bounds are
boot/bake-only; `map-frame` is the shared XZ↔panel mapping.

## 5. Movement and collision

**Owns:** the floor index, the three trace implementations, capsule overlap,
input intent, and the pad maps.

`movements.ts` owns the CSR floor grid: `floorIndexFor` caches by
array identity + length + last + `dynamicEpoch`; `buildFloorIndex` is
the rebuild; `floorAlongMoveIndexed` is the client/server step query.
Task 19 owns its rebuild cost (F5) and the indexed-vs-linear traces:
`traceIndexed` (`hitscan.ts`) is the hot path, `traceHitscan` is
the reference, `sweepSegment` is grenade-only and linear (F1).
`capsuleOverlapsAabb` (`pickups.ts`) is the one overlap test; `moveIntent`
(`look.ts`) and `EYE_HEIGHT` are the shared frame conventions.
`gamepad-map.ts` is input-only.

## 6. Nav

**Owns:** the occupancy grid, region graphs, route nets, and the follower.

`navBoxes` (`nav/grid.ts`) flattens the view AABBs + door leaves into
floor boxes; `buildGrid` (-ish) makes the occupancy grid.
`overlayShutDoors` (`nav/regions.ts`) drops portals a shut leaf covers;
`createRoadCache` (`nav/route.ts`) keeps one compiled net per gate
signature; `planRoute`/`planLegs` consume it. `nav/legs.ts` memoizes
`navBoxes` per walk (`boxes ??=`), so the 460 µs build is per replan, not per
tick. `follow.ts` turns a path into an input frame and owns `doorStand`.

## 7. Bots

**Owns:** the planner, the state record, action/goal factories, the arbiter
latches, sensing, flee scoring, and aim.

`goap.ts` is the frozen planner (`@why` string keys, deterministic ties).
`state.ts` builds the flat fact record; a held key sets both `hasKey` and
`holding` (invariant). `actions.ts`/`goals.ts` are the grounded action and
priority factories (task 11 tags). `arbiter.ts` latches Escape until outside
and Evade under fire; `bot-brain.ts` calls `judge` per bot per tick
(and again on the door path ). `sense.ts` owns the exit index and
per-bot rows; `flee.ts` scores region centres; `aim.ts` is the pure RNG-driven
shot solve. All take the RNG/clock from the caller.

## 8. Determinism and injection

**Owns:** where time and randomness enter shared code.

No algorithm reads `Math.random`; no algorithm reads the wall clock except the
two injected defaults: `createPawnHealth(now = Date.now())` (`health.ts`) and
`losGate(clock = Date.now())` (`hitscan.ts`). `bot-brain`/`sense` inject a
clock and `splitMix` RNG for bots; `goap.ts` and `aim.ts` state their
determinism in their headers. A new hidden clock in shared would break bot
replays and both hashes; the defaults are the only boundary.

## 9. Single-source table

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

## 10. Hot-path table

Measured on this tree, Node v24.0.2, median of three runs unless noted. The
task's calibration numbers are in parentheses where they differ by >2×.

| Shared call | Consumer / cadence | µs/call | Calls/s | Cost | Budget share |
|---|---|---:|---:|---|---|
| `pickDoorForUse` over 98 rows | client `overlapsDoor`, per frame | **26.6** (body 21.7 + build 4.9) | 60 | **1.60 ms/s** | 0.16% of 16.7 ms |
| `doorUseVolume` ×98 | inside the pick | **14.7** | 60 | 0.88 ms/s | 68% of the pick |
| `pickDoorForUse` over `view.doors` | host press, per event | **49.0** (cal. 126.4) | event | — | per press |
| `judge` | host brain, 16 bots × 20 Hz | **0.38** (cal. 3.9) | 320 | 0.12 ms/s | 0.012% of 50 ms/tick |
| `placeAt` | host brain/sense, ~2/bot/tick | **1.5** (cal. 5.8) | ~640 | 0.96 ms/s | 0.096% of tick |
| `navBoxes` | per replan (`nav/legs.ts` memo) | **460** (cal. 1,218) | per plan | — | per plan, not tick |
| `revive` (16 entities) | client, per snapshot | **55** | 20 | 1.10 ms/s | 0.11% of the second |
| `parseArenaFrame` | both, per frame | **0.9** (cal. 9.96) | 20–60 | ~0.05 ms/s | negligible |
| `canonicalJson` (full graph) | host boot hash | **3,415** | once | 3.4 ms boot | boot-only |
| `asSnapshot` hostile tick | client snapshot | **throws** | — | frame lost | robustness |

## 11. Invariant index

Existing `@invariant`s in shared and the consumer that relies on each:

- `buildWorldState` — a held key sets both `hasKey` and `holding`; absent facts
 are omitted (`bots/state.ts`).
- `judge` — Escape latched until outside; Evade latched the same way
 (`bots/arbiter.ts`).
- `createRoadCache` — one net per gate signature (`nav/route.ts`).
- `PawnHealth` — hp in range; dead pawn unchanged by wound/heal
 (`health.ts`).
- `pickDoorForUse` — equal distance keeps the smaller id (`doors.ts`).
- `canonicalJson` — keys sorted, arrays kept, undefined omitted
 (`scene-graph.ts`).
- `DoorBlockers` — one obstacle per door (`server/doors.ts`).


Single-source test pins (from §9):

| Convention | Test pins the pair |
|---|---|
| Door yaw quarter-turn | **No** — `interior-door-use.test.ts` tests only the shared one; the client copy is private |
| Door use volume | Yes — door tests (`door-block`, `interior-door-use`, `door-lock`, `nav-follow`) |
| Capsule overlap | Yes — `pickup.test.ts`, `nav-follow.test.ts` |
| Movement intent | Yes — `look.test.ts`, `gamepad-profile.test.ts`, bot tests |
| Eye height | Yes — `look.test.ts`, `pawn-feet.test.ts` |
| Pickup id encoding | **No behavior test** (only the coverage manifest names it) |
| Snapshot revival | **No** — no `revive` test |
| Door leaf box | Yes — `door-block.test.ts` |

Missing, found here (report findings, not tags): door yaw has no cross-test
between shared and client; `parseWelcomeExtras.ammo` has no finite rejection;
`asSnapshot` has no non-finite tick guard.

## 12. Layer map and single sources

The canonical layer map is §1 (the groups and their host/client consumers); the
single-source table is §9; its test pins are §11. The state model follows in
§13, the cross-layer contract the host/client §13 rows link.

## 13. Shared state model

**Owns:** the map of the state that lives in `src/shared/` and the **cross-layer
contract** — which side owns each value, which side predicts, and what crosses the
boundary. The types are §3, the wire is §2, the duplicates are §9, the invariants are
§11; the layer state itself is `agents/host-kb.md` §13 and `agents/client-kb.md` §13,
linked from the `X` rows rather than restated here.

`S`/`B`/`X`: see `agents/AGENTS.md` "KB row classifications".

### 13.1 Wire and protocol

| tag | state | container / owner | element type | key → value | written by | lifetime |
|---|---|---|---|---|---|---|
| X | snapshot envelope | `revive` (`wire.ts`), `asSnapshot`; kernel `IncomingSnapshot` | revived tree → client snapshot | — | client `net.ts` per frame → client §13 | per snapshot; **trusted but unvalidated** |
| X | inbound arena frames | `parseArenaFrame` (`bot-protocol.ts`); `ArenaFrame` union | frames | `t` → frame | client/host per frame → host §13 | **untrusted**; finite checks non-uniform |
| X | welcome extras | `parseWelcomeExtras`; `WelcomeExtras` | object | ammo/keys/scope/claims | host welcome | once per connection |
| X | spawn row | `spawnFrame` (`spawn-frame.ts`), `parseSpawn`; `SpawnFrame` | row | entity id → pose | host frame / client parse | per spawn |
| X | QA result frames | `parseSnapshotResult` (`bot-protocol.ts`), `parseQaCapture` | frames | request id | client reply | per request |
| X | fire / grenade input | `parseFire` (`hitscan.ts`), `parseGrenade` (`grenade.ts`) | frames | seq → shot | client input → host §13 gates | per frame, seq-gated |

### 13.2 Baked and manifest inputs

| tag | state | container / owner | element type | key → value | written by | lifetime |
|---|---|---|---|---|---|---|
| S | manifest view | `ArenaView` (`arena-view.ts`) | type | placements, bounds, spawn points, doors, aabbs, pickups, elevators, sounds | `game-manifest.ts` | boot-only |
| S | scene graph | `SceneGraph` (`scene-graph.ts`), `parseSceneGraph` | places/portals maps | id → place / portal | manifest load | boot-only |
| B | door locks (advisory) | `locksMatch`, `applyDoorLock` | portal fields | door id → `locked`/`key` | `parseSceneGraph`, rewritten from the compiled door | boot-only; **the door wins** |
| S | spatial DAG | `SpatialDAG` (`spatial-dag.ts`), `loadSpatialDAG` | chunks/nodes | node id → bounds | manifest load | boot-only |
| B | canonical hashes | `canonicalJson` (`scene-graph.ts`), `sha256Hex` | strings | — | host boot | one-shot |
| S | place lookups | `indexGraph`, `stopOf`, `placeAt`, `isElevatorShaft` | maps | id → place; point → place | boot + per query | boot maps; queries stateless |

### 13.3 Authority containers (host-owned; shared factories)

| tag | state | container / owner | element type | key → value | written by | lifetime |
|---|---|---|---|---|---|---|
| X | health rows | `PawnHealth` (`health.ts` factory, `PawnHealthState`) | Map | pawn id → hp/dead | host tick | per session → host §13 |
| X | pickup inventory | `createPickupHost` (`pickups.ts`) | Set + Map + bags | placement id → placement; pawn → keys | host tick | per session → host §13 |
| X | loadout | `createPawnKit` | two Maps | pawn id → ammo/weapon | host tick | per session → host §13 |
| X | audit counters | `createAudit` (`audit.ts`), `AuditCounters` | counters | field → count | host tick | per session, monotonic → host §13 |
| X | door rows | `DoorRuntime` (`doors.ts`), `pickDoorForUse` | rows | door id → leaf state | host | per session → host §13 |
| X | elevator rows | `ElevatorRuntime` (`elevators.ts`), `ElevatorState` | rows | cab id → state | host | per session → host §13 |

### 13.4 Nav and bot derived

| tag | state | container / owner | element type | key → value | written by | lifetime |
|---|---|---|---|---|---|---|
| S | floor index | `FloorIndex` (`movements.ts`), `floorIndexFor`, `buildFloorIndex` | CSR grid | cell → boxes | both halves | cached by array identity + length + epoch |
| S | nav boxes | `navBoxes` (`nav/grid.ts`) | `FloorBox[]` | — | `planLegs` (`legs.ts`) | per plan (memo) |
| S | occupancy grid | `buildGrid` (`grid.ts`) | cells | cell → blocked/floor | nav consumer | per plan |
| S | region graphs | `parseBakedRegions` (`regions.ts`), `indexRegions`, `overlayShutDoors` | maps | place id → graph | boot + per plan | boot file; overlay per plan |
| S | route nets | `createRoadCache` (`route.ts`) | cache | gate signature → net | per plan | cached by signature |
| S | plans | `planRoute`, `planLegs` (`legs.ts`), `planPath` (`path.ts`) | results | — | per plan | per plan, stateless |
| S | bot fact record | `buildWorldState` (`state.ts`) | flat record | fact key → value | per sense tick | per tick |
| S | arbiter latches | `judge` (`arbiter.ts`) | `Mind` | — | per bot per tick | per session latch |
| S | sense rows | `SENSE_TICK_HZ` (`sense.ts`), `SensePawn`, `BotSense` | rows | bot id → row | host | per tick → host §13 |
| S | action set and plan | `createBotContext` (`actions.ts`), `groundActions`, `estimateSeconds`, `chooseGoal` (`goap.ts`) | pure | — | per plan | per plan, stateless |
| S | cover / aim solves | `evaluateCover` (`cover.ts`), `nearestCover`, `sampleAim` (`aim.ts`) | pure | — | per bot | per plan |
| S | traces and sweeps | `traceHitscan` (`hitscan.ts`), `traceIndexed`, `sweepSegment`, `sweepIndexed`, `sweepDag` | pure | — | both | stateless; `MIN_HIT_DISTANCE` is shooter-only |
| B | fire / grenade gates | `FireGate`, `GrenadeGate` (`grenade.ts`), `admitFire`/`admitGrenade` | per client | seq → accepted | host `onFrame` | per session |
| B | grenade body | `GrenadeBody` (`grenade.ts`), `stepGrenade` | per body | id → body | host tick | ≤ `GRENADE_LIFE_S` 4 s |
| B | LOS gate | `losGate` (`hitscan.ts`) | closure | — | per bot | injected clock |

### 13.5 Single sources

| tag | state | container / owner | element type | key → value | written by | lifetime |
|---|---|---|---|---|---|---|
| S | door yaw | `doorYawRadians` (`doors.ts`) + client copy `yawToRadians` (`client/arena-scene.ts`) | two bodies | — | — | **no cross test** |
| S | pickup id encoding | `pickupBoxSource` (`pickups.ts`) | one encoding | — | host | **no behavior test** |
| S | snapshot revival | `revive` (`wire.ts`) | one body | — | client | **no `revive` test** |
| S | door use / leaf | `doorUseVolume` (`doors.ts`), `doorLeafBox` | two builders | — | host/client | tested (door suites) |
| S | capsule overlap | `capsuleOverlapsAabb` (`pickups.ts`) | one test | — | host/client | tested (`pickup`, `nav-follow`) |
| S | eye height | `EYE_HEIGHT` (`look.ts`) | one constant | — | all | tested (`look`, `pawn-feet`) |

### 13.6 Domain entities

One row per entity; the containers are the §13.1–§13.5 rows and the layer KBs.

| entity | shared factory / type | host container | client copy | test |
|---|---|---|---|---|
| Pawn | `createPawnHealth`, `createPawnKit`, `createPickupHost`, `HeldInputs` | `health.rows` (hp), `kit` (ammo/weapon), `pickupHost` bags (keys), `held` (input), `claimHost.table` (claim) — host §13.4 | `pawnVital`, the pawn layer, the owned prediction — client §13.2 | `health.test.ts`, `pickup.test.ts`, `bot-client.test.ts` |
| Door | `doorLeafBox`, `doorUseVolume` (`doors.ts`) | `doorHost`'s state Map + the live blockers — host §13.2 | the leaf render/swing — client §13.3 | `door-block.test.ts`, `door-lock.test.ts`, `door-swing.test.ts` |
| Cab | `ElevatorRuntime`, `stopForKey` (`elevators.ts`) | cabs + `riders` — host §13.2 | the cab render — client §13.3 | `bot-elevator.test.ts`, `elevator-exit.test.ts` |
| Pickup | `createPickupHost` (`pickups.ts`) | remaining/byId/bags — host §13.4 | the visual removal on the `pickup` frame — client §13.2 | `pickup.test.ts` |
| Claim | — (host-only) | `claimHost.table` — host §13.2 | none (the welcome/`claims` frame only) | `claims.test.ts` |

### Ownership and authority graph

```text
host tick ──▶ health / pickupHost / kit / audit / door / elevator rows
 └──▶ welcome + frames (ArenaFrame) ──▶ client copies (visual, predicted)
host tick ──▶ snapshot ──▶ revive/asSnapshot ──▶ kernel EngineClient ──▶ client renderSnapshot
client frame ──▶ input/use/fire/grenade frames ──▶ parseArenaFrame ──▶ host gates ──▶ rows
manifest ──▶ ArenaView / SceneGraph (advisory locks) / SpatialDAG ──▶ both halves, boot-only
nav + bots ──▶ per-plan derived (navBoxes, grids, route nets, fact record) ──▶ host only
```

**Authority rule:** the host owns the rows above; the client predicts only its owned
pawn and camera and treats every host frame as truth; the bot is a host-side reader
with no state of its own outside the host §13 containers. The `X` rows point at
`agents/host-kb.md` §13 / `agents/client-kb.md` §13 for the layer containers — this
section owns the contract, the layers own the containers.

### Trust boundary

- **Inbound** (client/bot → host) is untrusted: `parseArenaFrame` (`bot-protocol.ts`)
 rejects unknown `t`, bad JSON, and kernel messages, and finite-checks non-uniformly
 (`parseWelcomeExtras.ammo` coerces rather than rejects).
- **Host → client** snapshots are trusted but **not validated**: `asSnapshot`
 (`wire.ts`) is the only gate; a non-finite tick throws in the client's catch and
 the frame is lost (report S2).
- **Baked inputs** (`ArenaView`, `SceneGraph`, `SpatialDAG`) are trusted because they
 are host-built, with one deliberate exception: scene-graph door locks are advisory
 and rewritten from the compiled doors (`scene-graph.ts`).
- The kernel's `EngineClient`/`EngineWsServer` are named and linked, not modeled
 (open question 3).

### Candidate invariants

Checkable from the model; none is in §11 yet. One moves to §11 only when a test or
`@tag` confirms it.

- The host is authoritative; the client predicts only its owned pawn and camera — `client/boot.ts` (`predictOwned`), (`EngineClient`).
- Snapshots are trusted but unvalidated; `asSnapshot` is the only gate — `wire.ts`.
- Scene-graph door locks are advisory; the compiled door rewrites them — `scene-graph.ts`.
- The door-yaw duplicate has no cross-test — `doors.ts` vs `client/arena-scene.ts`.
- The pickup-id encoding has no behavior test — `pickups.ts`.
- Wall-clock time enters shared code only through the two injected defaults — `health.ts`, `hitscan.ts`.
- Audit counters never decrease — `audit.ts`.
- The inbound parser's finite checks are non-uniform — `bot-protocol.ts`
- `revive` rebuilds `$i` BigInts per snapshot — `wire.ts`.
- A fire/grenade seq is accepted once per gate — `hitscan.ts`, `grenade.ts`.
- `createRoadCache` keeps one net per gate signature — `route.ts`.
- `buildWorldState` sets both held-key facts — `state.ts`.
