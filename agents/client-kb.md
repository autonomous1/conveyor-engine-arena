# Client knowledge base

The browser frame of the arena client: boot, the RAF loop, snapshot intake,
scene construction, input, HUD, audio, effect pools, diagnostics, and the
frame budget. This is the layer above `agents/codemap.md`: the map, not the
index. Every claim names the file and symbol; the codemap owns `:line`. Kernel-owned work is named, not
described.
The client's state — containers, keys, writers, lifetimes — is §13.

Baseline (`984e20a`, 2026-11-14): 1,618 boxes, 98 doors, 4 cabs, 156 pickups,
16 agents (`loadArena()`); 630 tests. Target frame is 16.7 ms at 60 Hz.

## 1. Boot and composition

**Owns:** page entry, manifest fetch, scene load, socket, and the one RAF loop.

`src/client/main.ts` fetches `/arena.json`, resolves the ws URL, and calls
`boot` (`src/client/boot.ts`); `solo-main.ts` does the same through
`startSolo` (`src/client/solo.ts`). `boot` fetches the game files, builds the
renderer/scene (`createArenaScene`), loads visuals (`loadArenaVisuals`), then
constructs input, HUD, scene map, audio, the net link, and the frame closure.
Construction order matters: HUD and audio must exist before the first snapshot
can call `onStatus`/`play`; the scene must exist before `renderSnapshot()` sizes
the pawn layer. The entry points run once per page; there is no re-boot path. The containers
this boot creates, with their keys and lifetimes, are §13.

## 2. The frame loop

**Owns:** the 60 Hz presentation loop and its fault path.

`frame(now)` (`boot.ts`) calls `drawFrame`, then `hitMarker.tick`, the 98-rig door-swing pass, the info probe, and
schedules the next RAF. A throw anywhere in `drawFrame` enters the
catch: it reports the fault, writes the console hint, clears every
effect pool and both echo dedupes, stops audio, renders once, and continues the
RAF. There is no backoff; the next frame runs the same body.

`drawFrame(now)`: dt clamp to 50 ms; prop mixers unless frozen; input
menu gate + `input.update` + `sample`; `client.renderSnapshot()`
(kernel); owned-pawn lookup; fire/grenade clocks and sends; use/cab
input; predicted trace and camera presentation; laser/grenade queue drain;
effect pool updates; listener update; character FX; pawn layer apply; bot
labels; input send at `INPUT_HZ`; elevator-room tick; HUD status/profile/pad;
scene map; `renderer.render`; stats overlay when visible. The order is a
contract: input is sampled before clocks, clocks before sends, snapshot render
before all per-frame consumers.

## 3. Snapshot intake and resync

**Owns:** applying host snapshots without stalling the frame.

`net.ts` handles a `snapshot` message by `applySnapshot` (kernel), acking the
seq, then calling `client.renderSnapshot()` **again** (`net.ts`) to count
entities for the status line; a delta that renders zero entities requests a
resync. Seq gaps request a resync. Status is delivered to
`onStatus`, which is `hud.setStatus` via `boot` (`boot.ts`). The two
`renderSnapshot()` calls per snapshot+frame are kernel-owned (`EngineClient`,
`conveyor-engine-client`).

## 4. Interpolation and presentation

**Owns:** turning 20 Hz snapshots into a 60 Hz picture.

`renderSnapshot()` returns the interpolated entity list; `presentation.ts`
(`PawnLayer`) owns cloned/billboard characters and applies the list each frame
(`boot.ts`); `pawn-feet.ts` adjusts root/foot offsets; `viewmodel.ts` keeps
the weapon on the camera. `presentShot` (`shot-view.ts`) positions the camera
at the owned eye and draws an optional segment. Snapshots are the truth;
nothing here integrates gameplay state except the camera and predicted laser.

## 5. Scene construction

**Owns:** what the renderer draws and what it clones.

`loadArenaVisuals` (`arena-scene.ts`) loads GLBs and builds the `doors` rig
map (98), placements, and lights. Static meshes go through
`placeStaticInstances`: one `InstancedMesh` per non-skinned mesh.
Door frames are instanced by `placeStaticDoorFrames`; the moving **leaf** is a
clone per opening (`placeDoorModel`), because each hinges independently.
Pawns are cloned per agent by `PawnLayer` (`presentation.ts`); a missing asset
falls back to a capsule. `tickDoorSwing` eases the hinge by
`group.getObjectByName("hinge")` each frame. `placeRoomLights` adds
point/rect lights; lights have no draw call.

## 6. Input

**Owns:** keyboard, mouse, pointer lock, and the one gamepad.

`createInput` installs 9 window/document listeners once (`input.ts`);
`update(dt)` polls the pad and `sample` returns the frame's
`PlaySample`. Menu-open and pointer-lock gates live in `sample`; fire/use/
grenade bits are consumed by `boot`'s clocks. Listeners are page-lifetime; the
options dialog adds its own 8 (`options.ts`), HUD 5 (`hud.ts`), scene map 2
(`scene-map.ts`), arena resize 1 (`arena-scene.ts`), audio unlock 3
(`boot.ts`, removed on unlock), auth landing 4, net visibility 1
(`net.ts`, removed on close).

## 7. HUD, overlay, scene map

**Owns:** the DOM the player reads, and its write gates.

`createHud` builds status/profile/pad/stats/info (`hud.ts`). `setStatus`
 writes `textContent`; `setPad` rewrites a label and colour;
`paintInfo` rewrites `textContent` **and the whole `cssText`**;
`setStats` is gated by `statsVisible`. `drawFrame` calls
`setStatus`/`setProfile`/`setPad` every frame (`boot.ts`) and
`probe.refresh` → `paint("")` every frame via the info probe. The scene map
repaints only when `selfMoved`/dirty (`scene-map.ts`).

## 8. Audio

**Owns:** one `AudioContext`, decoded samples, positional voices, and dedupe.

`createSfx` fetches and decodes once; `unlock` runs on the first gesture
(`boot.ts`). Each effect has `maxVoices`; `pickVoice` (`audio.ts`)
reuses a free/ended slot, then allocates up to the cap, then evicts the oldest.
`stopVoice` calls `stop` and `disconnect`; `stopAll` walks every
effect. `EchoDedupe` gates the local play/host echo pair (three uses in
`boot`). No per-shot node leak found.

## 9. Effect pools

**Owns:** explosions, surface blasts, lasers, grenades, hit marker, character
FX, and beam overlays.

Each pool is bounded and cleared on a frame fault (`boot.ts`):
`explosions.clear()`, `laserImpacts.clear()`, `surfaceExplosions.clear()`,
`pickupSounds.clear()`, `doorSounds.clear()`, `elevatorSounds.clear()`,
`characterFx.clear()`, both beam `fx.clear()`, plus `lasers.drop()` and
`grenades.drop()`. Per-frame drains reuse arrays (`laserQueue`,
`grenadeQueue`) and call `expire`/`update` with the clamped dt. Pool objects
expose `dispose` (`explosion.ts`, `presentation.ts`,
`aabb-debug.ts`) but no caller runs them at page scale.

## 10. Diagnostics and QA

**Owns:** fault capture and the `qa=1` hooks.

`createClientDiag` (`diag.ts`) keys faults and suppresses repeats, emitting
a summary every `SUMMARY_EVERY`; `reportFrameFault` bounds labels and
never prints raw credentials. `boot`'s catch reports the frame fault, writes
`presentFaultHud`, and clears pools. QA installs only for `qa=1`
(`qa.ts`, `boot.ts`); `takeHashToken` moves the fragment token into
session storage once.

## 11. Frame budget table

| Operation | Per frame | Basis | % of 16.7 ms | Verdict |
|---|---|---:|---:|---|
| Door-swing search (`getObjectByName` × 98) | **50.2 µs** | measured, median of 3 | 0.30% | cache the hinge |
| Door-swing cached hinge | **24.2 µs** | measured, median of 3 | 0.15% | the fix's floor |
| `renderSnapshot()` (frame) | not measured | kernel-owned | — | static |
| `renderSnapshot()` (snapshot path) | 20/s extra | counted | — | kernel-owned |
| `cameraAim` | 0.76 µs | measured | <0.01% | gated by `wantInfo` |
| Info `paint`/`paintInfo` | 1 DOM+`cssText` write | static count | — | runs even when hidden |
| HUD status/profile/pad writes | 3 DOM writes + strings | static count | — | gate on change |
| `probeCabs` | 4 objects + array | static count | — | called unconditionally |
| `render.entities.find` | O(16) | counted | <0.01% | trivial |
| Info raycast (`refresh`) | 0 (guard) | source | 0% | refuted |
| Audio voice churn | amortised | source | — | capped/disconnected |
| Scene-map repaint | gated | source | — | only when moved |
| `formatOverlay` | only when stats visible | source | — | gated |

## 12. Invariant index

Existing `@invariant`s touching this layer:

- `EchoDedupe` — one waiting local play covers exactly one echo inside the
 window (`src/client/audio.ts`).
- `RateWindow` — no snapshot in a window leaves `tickPerSec` unset
 (`src/client/rates.ts`).
- `floorLabel` — floor 1 is the lowest stop; away from a lift it falls back to
 `y <m>m` (`src/client/map-marker.ts`).

Missing, found by this review (report findings, not tags): the door rig has no
hinge cache; the info probe paints even when nothing is shown; HUD writes are
not gated on text change; the frame fault path has no backoff; no scene
teardown is called on the page path.

## 13. Client state model

**Owns:** the map of the client's state — which container holds which record, its
key, who writes it, and how long it lives. The frame flow is §1–§10; the sub-system
internals are the linked sections and the codemap. `S`/`B`/`X`: see
`agents/AGENTS.md` "KB row classifications".

### 13.1 Boot-time and read-only

| tag | state | container | element type | key → value | written by | lifetime |
|---|---|---|---|---|---|---|
| S | page inputs | `view`, `opts` (`boot.ts`) | `ArenaView`, opts | — | main/solo | boot-only |
| S | DOM layers and overlays | `hud`, `hitMarker`, `sceneMap`, `options` | §7 factories | — | boot | page-lifetime |
| S | renderer, scene, debug overlays | `arena`, `collisionDebug`, `cabDebug` | three scene + aabb/cab groups | cab id → debug mesh | boot, `options` | page-lifetime |
| S | loaded visuals | `visuals` | placements/doors/templates/mixers | placement id → model, door id → rig | boot | boot-only; visibility mutates |
| S | page subsystems | `viewmodel`, `pawns`, `input`, `probe` | §5–§7 | — | boot | page-lifetime |
| S | effect pools | `lasers`, `grenades`, `explosions`, `laserImpacts`, `surfaceExplosions`, `beamSheets`, `characterFx` | §9 pools, bounded | slot/pose → active effect | `drawFrame` plays | bounded; cleared on fault |
| S | sound system | `sfx`, `pickupSounds`, `doorSounds`, `elevatorSounds` | §8 | effect name → voices | boot, host frames | page-lifetime; unlock listeners removed |
| S | elevator rooms | `elevatorRooms` | `createElevatorRooms` | cab id → room | `applyCab` | page-lifetime |
| X | kernel client | `client` | `EngineClient` | entity id → interpolated pose; owned id | `link` | per session, kernel-owned (§3–§4) |
| S | diagnostics and debug hooks | `diag`, `fireDebug`, `botLabels`, `pushModel` | §10 | — | boot | page-lifetime |
| S | QA surface | `installQaApi` | `QaApi` | — | boot when `qa` | only with `qa` |

### 13.2 Per-entity containers

| tag | state | container | element type | key → value | written by | lifetime |
|---|---|---|---|---|---|---|
| S | players seen | `playerIds` | Set<number> | entity id | `onPlayers` | replaced per `players` frame |
| S | door open state | `doorOpen` | Map | door id → open | welcome, `swingDoor` | per session; last host frame wins |
| B | cab state and local pick | `cabState`, `cabPick` | Maps | cab id → `ElevatorState` / stop | `applyCab`, ship input, open/closed | per session |
| B | pickups remaining | `pickupIds` + `visuals.placements` | Set + placement visibility | placement id | `onPickupSet`/`onPickup` | until taken |
| B | predicted-shot boxes | `shotBoxes` | ray list (`createRayBoxList`) | — | rebuilt per shot | per shot |
| X | pawn vitals | `pawnVital` | Map | entity id → `{hp, dead}` | health frames | per session |
| S | pawn renders | `pawns` | `PawnLayer` map (`presentation.ts`) | entity id → clone | `apply` | per entity lifetime |
| B | scene-map markers | `sceneMap` (`scene-map.ts`) | layer → samples map, `selfLabel`, `dirty` | layer → samples | `setSelf`/`setPlayers` | repaint when dirty |
| B | echo dedupes | `ownLaserEcho`, `ownGrenadeEcho` | `EchoDedupe` (`audio.ts`) | one waiting local play | `noteLocal`/`echo` | window; cleared on fault |

### 13.3 Per-frame and per-input

| tag | state | container | element type | key → value | written by | lifetime |
|---|---|---|---|---|---|---|
| B | aimed owned id | `aimedPawn` | `let` number | — | `drawFrame` | replaced when the owned id changes |
| B | send sequences | `fireSeq`, `grenadeSeq`, `useSeq` | `let` number | — | sends | monotonic per page |
| B | send clocks | `nextFireAt`, `nextGrenadeAt` | `let` ms | — | `advance*Clock` | per fire/grenade |
| B | fire-debug trace | `pendingFireLog`, `awaitFireReply`, `loggedFireSnap` | `let`s | — | send/reply | per shot; cleared in `frame` |
| B | inbound queues | `laserQueue`, `grenadeQueue` | arrays | push per frame | `onLaser`/`onGrenade` | drains per frame; cleared on fault |
| B | QA capture reply | `snapshotSend` | `{ current }` | — | `link` wiring | per page; used by `answerQaCapture` |
| B | first snapshot | `sawSnap`, `resolveSnap`, `firstSnapshot` | `let` + Promise | — | `onApplied` | one-shot |
| B | QA freeze/follow | `frozen`, `followId`, `followBack`, `followUp` | `let`s | — | QA API | until cleared |
| B | frame clock and input accumulator | `last`, `sendAcc`, `sendDt` | `let` / const | — | `drawFrame` | per frame |
| B | counters and rate window | `seenSnaps`, `resyncs`, `rates` | numbers + `RateWindow` (`rates.ts`) | — | frame + `onStatus` | per session / rolling window |
| B | door-swing clock | `lastDoorTick` | `let` ms | — | `frame` | per frame |
| B | info-probe inputs | `wantInfo`, `probeOwn`, `probeOwnedId`, `probePawns` | `let`s | — | `drawFrame`, reset | per frame |
| B | status and hint | `statusText`, `consoleHint` | `let`s | — | `onStatus`/faults | replaced; hint latches |
| B | fire-debug watch | `debugPawn`, `debugPawnWatch`, `sawFiniteCamera` | `let`s | — | sends, frame | per shot / per frame |
| B | effect clock | `fxNow` | `let` ms | — | `drawFrame` | per frame |
| S | input state | `input` (`input.ts`) | `keys` Set + yaw/pitch/locked/fire | key → down | listeners, `update` (§6) | per page |
| S | HUD state | `hud` (`hud.ts`) | strings + flags | — | `setStatus`/`setStats` (§7) | page-lifetime |
| S | net intake state | `net.ts` | `lastSeq`, `lastSnapAt`, `recovering`, `inputSeq`, `resyncs`, `closed` | — | frames (§3) | per session |
| S | subsystem containers | `diag.seen` (`diag.ts`), `characterFx.states` (`character-fx.ts`), `grenades.props` (`grenade.ts`), `viewmodel.ticket` (`viewmodel.ts`) | maps / counters | id → row/prop | per effect (§9–§10) | per session |

### Ownership graph

```text
page ──▶ boot closure (everything below)
snapshot ──▶ client.renderSnapshot ──▶ pawns / pawnVital / status / scene map
local input ──▶ fireSeq/grenadeSeq/useSeq ──▶ link.send* ──▶ prediction (owned pawn only)
local play ──▶ EchoDedupe.noteLocal ──▶ host echo ──▶ EchoDedupe.echo (drop the duplicate)
QA capture ──▶ answerQaCapture ──▶ snapshotSend ──▶ link.sendQaSnapshotData
scene ──▶ HUD text / scene-map markers / info probe
host frames ──▶ doorOpen / cabState / pickupIds / playerIds ──▶ per-frame consumers
```

### Trust boundary

Host snapshots are authoritative: `pawnVital`, `doorOpen`, `cabState`,
`pickupIds`, and the rendered entities all come from host frames, and
`client.renderSnapshot()` is the kernel's interpolation of them (`boot.ts`,
§3–§4). The client predicts only the owned pawn (`predictOwned`,
`EngineClient` ); its local fire/grenade play is deduped against the host
echo. The QA/diag paths are gated by `qa`.
The `X` rows name the boundary only — the contract lives in
`agents/shared-model.md` or the model repo.

### Candidate invariants

Checkable from the model; none is in §12 yet. One moves to §12 only when a test or
`@invariant` confirms it.

- `firstSnapshot` resolves exactly once, on the first applied snapshot — `boot.ts`.
- The frame fault clears every effect pool, both queues, and both echo dedupes — `boot.ts`.
- `fireSeq` / `grenadeSeq` / `useSeq` only advance on a successful send and never decrease in a page — `boot.ts`.
- The owned-pawn prediction never overwrites authoritative state (kernel contract, not written here) — the client only calls `renderSnapshot()`/`authoritative`, `boot.ts`.
- The QA capture and probe paths run only with `qa` — `boot.ts`.
- `laserQueue` / `grenadeQueue` are emptied every frame, including after a fault — `boot.ts`.
- `wantInfo` is reset at the top of every frame and set from the frame's input sample — `boot.ts`.
- The audio unlock listeners are removed on the first running resume — `boot.ts`.


## 14. Layer map and single sources

Replicated from `agents/shared-flow.md` §1/§9; the test pins are `agents/shared-model.md` §11.

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
(`src/shared/bots/goap.ts`, kernel-independent; both sides import the one file).

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
