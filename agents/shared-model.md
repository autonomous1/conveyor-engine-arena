# Shared knowledge base — model (§11–§13)

The shared invariants and test pins (§11), the layer-map pointer (§12), and the
shared state model plus the cross-layer contract (§13). The flow (§1–§10) is in
`agents/shared-flow.md`; the section numbers are the pre-split ones, so a task
that names `shared-kb` §13 still means this §13.
`agents/shared-kb.md` is the index.

## 11. Invariant index

Existing `@invariant`s and the consumer that relies on each:

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
- `SpatialNode` — static-only: a node has no door/pawn kind (`spatial-dag.ts`).
- `unlock` — the key stays held; one key opens every leaf that names it
 (`bots/actions.ts`).
- `hasLineOfSightDag` — the DAG holds no door or pawn triangles; a shut door
 must be in `dynamic` to block (`hitscan.ts`).
- `sweepIndexed` — the same closest hit as `sweepSegment`
 (`hitscan.ts`).


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
§11; the layer state itself is `agents/host-model.md` §13 and `agents/client-kb.md` §13,
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
| Pawn | `createPawnHealth`, `createPawnKit`, `createPickupHost`, `HeldInputs` | `health.rows` (hp), `kit` (ammo/weapon), `pickupHost` bags (keys), `held` (input) — host §13.4; `claimHost.table` (claim) — host §13.2 | `pawnVital`, the pawn layer, the owned prediction — client §13.2 | `health.test.ts`, `pickup.test.ts`, `bot-client.test.ts` |
| Door | `doorLeafBox`, `doorUseVolume` (`doors.ts`) | `doorHost`'s state Map + the live blockers — host §13.2 | `doorOpen` + the leaf swing — client §13.2 | `door-block.test.ts`, `door-lock.test.ts`, `door-swing.test.ts` |
| Cab | `ElevatorRuntime`, `stopForKey` (`elevators.ts`) | cabs + `riders` — host §13.2 | `cabState`/`cabPick` + the cab render — client §13.2 | `bot-elevator.test.ts`, `elevator-exit.test.ts` |
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
`agents/host-model.md` §13 / `agents/client-kb.md` §13 for the layer containers — this
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
