# Shared knowledge base

`src/shared/` is the contract both halves run: the host's tick and the
client's frame execute the same movement, doors, hitscan, and scene-graph
code, and the bot runs the same planner. This is the layer map above
`agents/codemap.md`: who owns each behaviour, what is duplicated, and what a
call costs at the consumer. Every claim carries `file:line`.

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
predicts only the camera and its own visual step; the bot is a host-side
consumer of `goap.ts` copied verbatim.

## 2. Wire and protocol

**Owns:** the bytes both sides accept and the trust boundary between them.

Client→host frames (`bot-protocol.ts` parsers) are **untrusted** and mostly
finite-checked; host→client snapshots are **trusted but not validated** — the
client's only gate is `asSnapshot` (`wire.ts:19`). `revive` (`wire.ts:7`)
rebuilds `$i` BigInts and allocates a fresh tree; `asSnapshot` then converts the
tick with `BigInt(Number(tick))`. A non-finite tick throws `RangeError` from the
snapshot path (report S2); the client's catch is `net.ts:498`, which reports the
fault and resyncs but loses the frame. `NaN` seq passes through.

Parser shape: each arena frame is JSON-parsed once, then a per-`t` parser
(`parseArenaFrame`, `bot-protocol.ts:120`). The finite checks are not uniform
(see the report's parser matrix): health hp, QA `waitFrames`, snapshot
vectors/follow numbers, and scene/regions hashes are checked; `welcome.ammo`
silently coerces `1e999` to 0 (`parseWelcomeExtras`, `:272`). Unknown `t`,
kernel messages, and bad JSON return `undefined`.

## 3. Data model

**Owns:** the manifest view, the scene graph, pickup ids, health, and audit.

`arena-view.ts` is the manifest projection the client renders and the host
uses; its validation lives in `server/game-manifest.ts` (out of this layer).
`parseSceneGraph` (`scene-graph.ts:235`) is the data-model validator: it
requires an object, `formatVersion: 1`, `units: "meters"`, exactly one
`outside` place, arrays of places/portals, known door ids, increasing elevator
stops, matching landings/joins, a room for each shaft, and known stair joins.
A door-lock/key disagreement is **not** an error: it is a warning and the
portal is rewritten from the compiled door row (`:285-293`) — the graph's locks
are advisory (task 19 F10). Unknown extra fields are ignored.

Pickup ids are strings; `pickupBoxSource` (`pickups.ts:68`) is the one encoding
the host uses for the AABB source. `createPawnHealth` (`health.ts:111`) takes an
injected `now`; `audit.ts` is a pure counter set.

## 4. Geometry

**Owns:** the door quarter-turn, the use volume, leaf boxes, elevator
stops/landings, building profiles, SVG bounds, and the map frame.

`doorYawRadians` (`doors.ts:68`) wraps degrees to quarter turns; the client
re-implements the same body as `yawToRadians` (`client/arena-scene.ts:556`) —
see §9. `doorUseVolume` (`doors.ts:84`) builds the overlap box from the leaf
frame; the host adds it to the obstacle list never, only the use test
(`@why` in source). `doorLeafBox` is the shut blocker the host adds.
`elevators.ts` models stops/landings and the cab ride; the client renders the
same rows (`client/elevator-room.ts`). Building profiles and SVG bounds are
boot/bake-only; `map-frame` is the shared XZ↔panel mapping.

## 5. Movement and collision

**Owns:** the floor index, the three trace implementations, capsule overlap,
input intent, and the pad maps.

`movements.ts` owns the CSR floor grid: `floorIndexFor` (`:245`) caches by
array identity + length + last + `dynamicEpoch`; `buildFloorIndex` (`:264`) is
the rebuild; `floorAlongMoveIndexed` (`:453`) is the client/server step query.
Task 19 owns its rebuild cost (F5) and the indexed-vs-linear traces:
`traceIndexed` (`hitscan.ts:170`) is the hot path, `traceHitscan` (`:143`) is
the reference, `sweepSegment` (`:566`) is grenade-only and linear (F1).
`capsuleOverlapsAabb` (`pickups.ts:134`) is the one overlap test; `moveIntent`
(`look.ts:58`) and `EYE_HEIGHT` (`:23`) are the shared frame conventions.
`gamepad-map.ts` is input-only.

## 6. Nav

**Owns:** the occupancy grid, region graphs, route nets, and the follower.

`navBoxes` (`nav/grid.ts:156`) flattens the view AABBs + door leaves into
floor boxes; `buildGrid` (`:180`-ish) makes the occupancy grid.
`overlayShutDoors` (`nav/regions.ts:120`) drops portals a shut leaf covers;
`createRoadCache` (`nav/route.ts:90`) keeps one compiled net per gate
signature; `planRoute`/`planLegs` consume it. `nav/legs.ts:89` memoizes
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
(`:785`, and again on the door path `:826`). `sense.ts` owns the exit index and
per-bot rows; `flee.ts` scores region centres; `aim.ts` is the pure RNG-driven
shot solve. All take the RNG/clock from the caller.

## 8. Determinism and injection

**Owns:** where time and randomness enter shared code.

No algorithm reads `Math.random`; no algorithm reads the wall clock except the
two injected defaults: `createPawnHealth(now = Date.now)` (`health.ts:111`) and
`losGate(clock = Date.now)` (`hitscan.ts:252`). `bot-brain`/`sense` inject a
clock and `splitMix` RNG for bots; `goap.ts` and `aim.ts` state their
determinism in their headers. A new hidden clock in shared would break bot
replays and both hashes; the defaults are the only boundary.

## 9. Single-source table

| Convention | Shared | Consumer copy | Test pins the pair |
|---|---|---|---|
| Door yaw quarter-turn | `doors.ts:68 doorYawRadians` | **Yes**: `client/arena-scene.ts:556 yawToRadians` (identical body) | **No** — `interior-door-use.test.ts` tests only the shared one; the client copy is private |
| Door use volume | `doors.ts:84 doorUseVolume` | No copy; host `server/doors.ts:257` and `pickDoorForUse` use it | Yes — door tests (`door-block`, `interior-door-use`, `door-lock`, `nav-follow`) |
| Capsule overlap | `pickups.ts:134 capsuleOverlapsAabb` | No copy; host `server/game.ts:1128`, pickups use it | Yes — `pickup.test.ts`, `nav-follow.test.ts` |
| Movement intent | `look.ts:58 moveIntent` | No copy; client `boot.ts:811`, host `game.ts:148` | Yes — `look.test.ts`, `gamepad-profile.test.ts`, bot tests |
| Eye height | `look.ts:23 EYE_HEIGHT` | No copy; client/server/bot import it | Yes — `look.test.ts`, `pawn-feet.test.ts` |
| Pickup id encoding | `pickups.ts:68 pickupBoxSource` | No copy; host `server/pickups.ts:36` | **No behavior test** (only the coverage manifest names it) |
| Snapshot revival | `wire.ts:7 revive` | No copy; client `net.ts:364` | **No** — no `revive` test |
| Door leaf box | `doors.ts doorLeafBox` | No copy; host `DoorBlockers` uses it | Yes — `door-block.test.ts` |

The one real duplicate is door yaw; the two bodies are byte-identical today,
and nothing fails if one drifts.

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
| `navBoxes` | per replan (`nav/legs.ts:89` memo) | **460** (cal. 1,218) | per plan | — | per plan, not tick |
| `revive` (16 entities) | client, per snapshot | **55** | 20 | 1.10 ms/s | 0.11% of the second |
| `parseArenaFrame` | both, per frame | **0.9** (cal. 9.96) | 20–60 | ~0.05 ms/s | negligible |
| `canonicalJson` (full graph) | host boot hash | **3,415** | once | 3.4 ms boot | boot-only |
| `asSnapshot` hostile tick | client snapshot | **throws** | — | frame lost | robustness |

## 11. Invariant index

Existing `@invariant`s in shared and the consumer that relies on each:

- `buildWorldState` — a held key sets both `hasKey` and `holding`; absent facts
  are omitted (`bots/state.ts:70`).
- `judge` — Escape latched until outside; Evade latched the same way
  (`bots/arbiter.ts:193`).
- `createRoadCache` — one net per gate signature (`nav/route.ts:90`).
- `PawnHealth` — hp in range; dead pawn unchanged by wound/heal
  (`health.ts:73`).
- `pickDoorForUse` — equal distance keeps the smaller id (`doors.ts:142`).
- `canonicalJson` — keys sorted, arrays kept, undefined omitted
  (`scene-graph.ts:129`).
- `DoorBlockers` — one obstacle per door (`server/doors.ts:39`).

Missing, found here (report findings, not tags): door yaw has no cross-test
between shared and client; `parseWelcomeExtras.ammo` has no finite rejection;
`asSnapshot` has no non-finite tick guard.
