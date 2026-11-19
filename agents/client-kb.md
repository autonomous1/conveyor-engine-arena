# Client knowledge base

The browser frame of the arena client: boot, the RAF loop, snapshot intake,
scene construction, input, HUD, audio, effect pools, diagnostics, and the
frame budget. This is the layer above `agents/codemap.md`: the map, not the
index. Every claim carries `file:line`. Kernel-owned work is named, not
described.
The client's state — containers, keys, writers, lifetimes — is §13.

Baseline (`984e20a`, 2026-11-14): 1,618 boxes, 98 doors, 4 cabs, 156 pickups,
16 agents (`loadArena()`); 630 tests. Target frame is 16.7 ms at 60 Hz.

## 1. Boot and composition

**Owns:** page entry, manifest fetch, scene load, socket, and the one RAF loop.

`src/client/main.ts` fetches `/arena.json`, resolves the ws URL, and calls
`boot` (`src/client/boot.ts:54`); `solo-main.ts` does the same through
`startSolo` (`src/client/solo.ts`). `boot` fetches the game files, builds the
renderer/scene (`createArenaScene`), loads visuals (`loadArenaVisuals`), then
constructs input, HUD, scene map, audio, the net link, and the frame closure.
Construction order matters: HUD and audio must exist before the first snapshot
can call `onStatus`/`play`; the scene must exist before `renderSnapshot` sizes
the pawn layer. The entry points run once per page; there is no re-boot path. The containers
this boot creates, with their keys and lifetimes, are §13.

## 2. The frame loop

**Owns:** the 60 Hz presentation loop and its fault path.

`frame(now)` (`boot.ts:557`) calls `drawFrame`, then `hitMarker.tick`
(`:595`), the 98-rig door-swing pass (`:597`), the info probe (`:598-617`), and
schedules the next RAF (`:620`). A throw anywhere in `drawFrame` enters the
catch (`:562-593`): it reports the fault, writes the console hint, clears every
effect pool and both echo dedupes, stops audio, renders once, and continues the
RAF. There is no backoff; the next frame runs the same body.

`drawFrame(now)` (`:632`): dt clamp to 50 ms; prop mixers unless frozen; input
menu gate + `input.update` + `sample`; `client.renderSnapshot()`
(`:642`, kernel); owned-pawn lookup; fire/grenade clocks and sends; use/cab
input; predicted trace and camera presentation; laser/grenade queue drain;
effect pool updates; listener update; character FX; pawn layer apply; bot
labels; input send at `INPUT_HZ`; elevator-room tick; HUD status/profile/pad;
scene map; `renderer.render`; stats overlay when visible. The order is a
contract: input is sampled before clocks, clocks before sends, snapshot render
before all per-frame consumers.

## 3. Snapshot intake and resync

**Owns:** applying host snapshots without stalling the frame.

`net.ts` handles a `snapshot` message by `applySnapshot` (kernel), acking the
seq, then calling `client.renderSnapshot()` **again** (`net.ts:487`) to count
entities for the status line; a delta that renders zero entities requests a
resync (`:488`). Seq gaps request a resync (`:481`). Status is delivered to
`onStatus`, which is `hud.setStatus` via `boot` (`boot.ts:845`). The two
`renderSnapshot` calls per snapshot+frame are kernel-owned (`EngineClient`,
`conveyor-engine-client`).

## 4. Interpolation and presentation

**Owns:** turning 20 Hz snapshots into a 60 Hz picture.

`renderSnapshot()` returns the interpolated entity list; `presentation.ts`
(`PawnLayer`) owns cloned/billboard characters and applies the list each frame
(`boot.ts:795`); `pawn-feet.ts` adjusts root/foot offsets; `viewmodel.ts` keeps
the weapon on the camera. `presentShot` (`shot-view.ts`) positions the camera
at the owned eye and draws an optional segment. Snapshots are the truth;
nothing here integrates gameplay state except the camera and predicted laser.

## 5. Scene construction

**Owns:** what the renderer draws and what it clones.

`loadArenaVisuals` (`arena-scene.ts:793`) loads GLBs and builds the `doors` rig
map (98), placements, and lights. Static meshes go through
`placeStaticInstances` (`:583`): one `InstancedMesh` per non-skinned mesh.
Door frames are instanced by `placeStaticDoorFrames`; the moving **leaf** is a
clone per opening (`placeDoorModel`, `:422`), because each hinges independently.
Pawns are cloned per agent by `PawnLayer` (`presentation.ts`); a missing asset
falls back to a capsule. `tickDoorSwing` (`:392`) eases the hinge by
`group.getObjectByName("hinge")` each frame. `placeRoomLights` (`:522`) adds
point/rect lights; lights have no draw call.

## 6. Input

**Owns:** keyboard, mouse, pointer lock, and the one gamepad.

`createInput` installs 9 window/document listeners once (`input.ts:361-369`);
`update(dt)` polls the pad and `sample()` (`:416`) returns the frame's
`PlaySample`. Menu-open and pointer-lock gates live in `sample`; fire/use/
grenade bits are consumed by `boot`'s clocks. Listeners are page-lifetime; the
options dialog adds its own 8 (`options.ts`), HUD 5 (`hud.ts`), scene map 2
(`scene-map.ts`), arena resize 1 (`arena-scene.ts:255`), audio unlock 3
(`boot.ts:301`, removed on unlock), auth landing 4, net visibility 1
(`net.ts:304`, removed on close).

## 7. HUD, overlay, scene map

**Owns:** the DOM the player reads, and its write gates.

`createHud` builds status/profile/pad/stats/info (`hud.ts`). `setStatus`
(`:145`) writes `textContent`; `setPad` (`:148`) rewrites a label and colour;
`paintInfo` (`:84`) rewrites `textContent` **and the whole `cssText`**;
`setStats` is gated by `statsVisible` (`:171`). `drawFrame` calls
`setStatus`/`setProfile`/`setPad` every frame (`boot.ts:845-850`) and
`probe.refresh` → `paint("")` every frame via the info probe. The scene map
repaints only when `selfMoved`/dirty (`scene-map.ts:473`).

## 8. Audio

**Owns:** one `AudioContext`, decoded samples, positional voices, and dedupe.

`createSfx` fetches and decodes once; `unlock()` runs on the first gesture
(`boot.ts:294-301`). Each effect has `maxVoices`; `pickVoice` (`audio.ts:315`)
reuses a free/ended slot, then allocates up to the cap, then evicts the oldest.
`stopVoice` (`:328`) calls `stop()` and `disconnect()`; `stopAll` walks every
effect (`:441`). `EchoDedupe` gates the local play/host echo pair (three uses in
`boot`). No per-shot node leak found.

## 9. Effect pools

**Owns:** explosions, surface blasts, lasers, grenades, hit marker, character
FX, and beam overlays.

Each pool is bounded and cleared on a frame fault (`boot.ts:568-583`):
`explosions.clear()`, `laserImpacts.clear()`, `surfaceExplosions.clear()`,
`pickupSounds.clear()`, `doorSounds.clear()`, `elevatorSounds.clear()`,
`characterFx.clear()`, both beam `fx.clear()`, plus `lasers.drop()` and
`grenades.drop()`. Per-frame drains reuse arrays (`laserQueue`,
`grenadeQueue`) and call `expire`/`update` with the clamped dt. Pool objects
expose `dispose` (`explosion.ts:544`, `presentation.ts:198`,
`aabb-debug.ts:146`) but no caller runs them at page scale.

## 10. Diagnostics and QA

**Owns:** fault capture and the `qa=1` hooks.

`createClientDiag` (`diag.ts:163`) keys faults and suppresses repeats, emitting
a summary every `SUMMARY_EVERY`; `reportFrameFault` (`:195`) bounds labels and
never prints raw credentials. `boot`'s catch reports the frame fault, writes
`presentFaultHud`, and clears pools. QA installs only for `qa=1`
(`qa.ts:41`, `boot.ts:900+`); `takeHashToken` moves the fragment token into
session storage once.

## 11. Frame budget table

| Operation | Per frame | Basis | % of 16.7 ms | Verdict |
|---|---|---:|---:|---|
| Door-swing search (`getObjectByName` × 98) | **50.2 µs** | measured, median of 3 | 0.30% | cache the hinge |
| Door-swing cached hinge | **24.2 µs** | measured, median of 3 | 0.15% | the fix's floor |
| `renderSnapshot` (frame) | not measured | kernel-owned | — | static |
| `renderSnapshot` (snapshot path) | 20/s extra | counted | — | kernel-owned |
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
  window (`src/client/audio.ts:507`).
- `RateWindow` — no snapshot in a window leaves `tickPerSec` unset
  (`src/client/rates.ts:18`).
- `floorLabel` — floor 1 is the lowest stop; away from a lift it falls back to
  `y <m>m` (`src/client/map-marker.ts:51`).

Missing, found by this review (report findings, not tags): the door rig has no
hinge cache; the info probe paints even when nothing is shown; HUD writes are
not gated on text change; the frame fault path has no backoff; no scene
teardown is called on the page path.

## 13. Client state model

**Owns:** the map of the client's state — which container holds which record, its
key, who writes it, and how long it lives. The frame flow is §1–§10; the sub-system
internals are the linked sections and the codemap. The `S`/`B`/`X` letter is a
classification, not a code tag: `S` structural (a container or shape checkable from
the declaration), `B` behavioral (a lifetime rule: one-shot, per-frame, monotonic,
clear-on-fault), `X` crosses the client↔host/shared/kernel boundary (the contract
belongs to `agents/shared-kb.md` or the model repo).

### 13.1 Boot-time and read-only

| tag | state | container | element type | key → value | written by | lifetime |
|---|---|---|---|---|---|---|
| S | page inputs | `view`, `opts` (`boot.ts:65-73`) | `ArenaView`, opts | — | main/solo | boot-only |
| S | DOM layers and overlays | `hud`, `hitMarker`, `sceneMap`, `options` (`:74-98`) | §7 factories | — | boot | page-lifetime |
| S | renderer, scene, debug overlays | `arena`, `collisionDebug`, `cabDebug` (`:77-81`) | three scene + aabb/cab groups | cab id → debug mesh | boot, `options` | page-lifetime |
| S | loaded visuals | `visuals` (`:100`) | placements/doors/templates/mixers | placement id → model, door id → rig | boot | boot-only; visibility mutates |
| S | page subsystems | `viewmodel`, `pawns`, `input`, `probe` (`:117-148`) | §5–§7 | — | boot | page-lifetime |
| S | effect pools | `lasers`, `grenades`, `explosions`, `laserImpacts`, `surfaceExplosions`, `beamSheets`, `characterFx` (`:174-292`) | §9 pools, bounded | slot/pose → active effect | `drawFrame` plays | bounded; cleared on fault (`:595-603`) |
| S | sound system | `sfx`, `pickupSounds`, `doorSounds`, `elevatorSounds` (`:300-346`) | §8 | effect name → voices | boot, host frames | page-lifetime; unlock listeners removed (`:309-315`) |
| S | elevator rooms | `elevatorRooms` (`:107`) | `createElevatorRooms` | cab id → room | `applyCab` (`:988`) | page-lifetime |
| X | kernel client | `client` (`:188`) | `EngineClient` | entity id → interpolated pose; owned id | `link` | per session, kernel-owned (§3–§4) |
| S | diagnostics and debug hooks | `diag`, `fireDebug`, `botLabels`, `pushModel` (`:83-84,191,99`) | §10 | — | boot | page-lifetime |
| S | QA surface | `installQaApi` (`:909-954`) | `QaApi` | — | boot when `qa` (`:70`) | only with `qa` |

### 13.2 Per-entity containers

| tag | state | container | element type | key → value | written by | lifetime |
|---|---|---|---|---|---|---|
| S | players seen | `playerIds` (`:71`) | Set<number> | entity id | `onPlayers` (`:448-449`) | replaced per `players` frame |
| S | door open state | `doorOpen` (`:102`) | Map | door id → open | welcome, `swingDoor` (`:1089`) | per session; last host frame wins |
| B | cab state and local pick | `cabState`, `cabPick` (`:105-106`) | Maps | cab id → `ElevatorState` / stop | `applyCab` (`:985`), ship input (`:698`), open/closed (`:989`) | per session |
| B | pickups remaining | `pickupIds` + `visuals.placements` (`:115-116`) | Set + placement visibility | placement id | `onPickupSet`/`onPickup` (`:494-503`) | until taken |
| B | predicted-shot boxes | `shotBoxes` (`:104`) | ray list (`createRayBoxList`) | — | rebuilt per shot (`:742`) | per shot |
| X | pawn vitals | `pawnVital` (`:388`) | Map | entity id → `{hp, dead}` | health frames (`:468-470`) | per session |
| S | pawn renders | `pawns` (`:138`) | `PawnLayer` map (`presentation.ts:140`) | entity id → clone | `apply` (`:825`) | per entity lifetime |
| B | scene-map markers | `sceneMap` (`scene-map.ts:272,467-476`) | layer → samples map, `selfLabel`, `dirty` | layer → samples | `setSelf`/`setPlayers` (`:860-866`) | repaint when dirty |
| B | echo dedupes | `ownLaserEcho`, `ownGrenadeEcho` (`:348-349`) | `EchoDedupe` (`audio.ts:541`) | one waiting local play | `noteLocal`/`echo` (`:686,729,776,806`) | window; cleared on fault (`:605-606`) |

### 13.3 Per-frame and per-input

| tag | state | container | element type | key → value | written by | lifetime |
|---|---|---|---|---|---|---|
| B | aimed owned id | `aimedPawn` (`:374`) | `let` number | — | `drawFrame` (`:668-670`) | replaced when the owned id changes |
| B | send sequences | `fireSeq`, `grenadeSeq`, `useSeq` (`:375,377,379`) | `let` number | — | sends (`:684,692,728`) | monotonic per page |
| B | send clocks | `nextFireAt`, `nextGrenadeAt` (`:376,378`) | `let` ms | — | `advance*Clock` (`:677,679`) | per fire/grenade |
| B | fire-debug trace | `pendingFireLog`, `awaitFireReply`, `loggedFireSnap` (`:380-382`) | `let`s | — | send/reply (`:720-733`) | per shot; cleared in `frame` (`:647`) |
| B | inbound queues | `laserQueue`, `grenadeQueue` (`:386-387`) | arrays | push per frame | `onLaser`/`onGrenade` (`:461-466`) | drains per frame (`:788,809`); cleared on fault (`:591,593`) |
| B | QA capture reply | `snapshotSend` (`:414`) | `{ current }` | — | `link` wiring (`:560-562`) | per page; used by `answerQaCapture` (`:415`) |
| B | first snapshot | `sawSnap`, `resolveSnap`, `firstSnapshot` (`:390-394`) | `let` + Promise | — | `onApplied` (`:456-459`) | one-shot |
| B | QA freeze/follow | `frozen`, `followId`, `followBack`, `followUp` (`:395-398`) | `let`s | — | QA API (`:917-927`) | until cleared |
| B | frame clock and input accumulator | `last`, `sendAcc`, `sendDt` (`:564-569`) | `let` / const | — | `drawFrame` (`:652-653,827-829`) | per frame |
| B | counters and rate window | `seenSnaps`, `resyncs`, `rates` (`:566-568`) | numbers + `RateWindow` (`rates.ts:40-43`) | — | frame + `onStatus` (`:454,883-884`) | per session / rolling window |
| B | door-swing clock | `lastDoorTick` (`:570`) | `let` ms | — | `frame` (`:614-615`) | per frame |
| B | info-probe inputs | `wantInfo`, `probeOwn`, `probeOwnedId`, `probePawns` (`:571-574`) | `let`s | — | `drawFrame` (`:664-667`), reset (`:578`) | per frame |
| B | status and hint | `statusText`, `consoleHint` (`:189-190`) | `let`s | — | `onStatus`/faults (`:453,544,583`) | replaced; hint latches |
| B | fire-debug watch | `debugPawn`, `debugPawnWatch`, `sawFiniteCamera` (`:383-385`) | `let`s | — | sends (`:736-737`), frame (`:850`) | per shot / per frame |
| B | effect clock | `fxNow` (`:275`) | `let` ms | — | `drawFrame` (`:821`) | per frame |
| S | input state | `input` (`input.ts:167-172`) | `keys` Set + yaw/pitch/locked/fire | key → down | listeners, `update` (§6) | per page |
| S | HUD state | `hud` (`hud.ts:89-90,137`) | strings + flags | — | `setStatus`/`setStats` (§7) | page-lifetime |
| S | net intake state | `net.ts:204-224` | `lastSeq`, `lastSnapAt`, `recovering`, `inputSeq`, `resyncs`, `closed` | — | frames (§3) | per session |
| S | subsystem containers | `diag.seen` (`diag.ts:180`), `characterFx.states` (`character-fx.ts:96`), `grenades.props` (`grenade.ts:74`), `viewmodel.ticket` (`viewmodel.ts:70`) | maps / counters | id → row/prop | per effect (§9–§10) | per session |

### Ownership graph

```text
page ──▶ boot closure (everything below)
snapshot ──▶ client.renderSnapshot() ──▶ pawns / pawnVital / status / scene map
local input ──▶ fireSeq/grenadeSeq/useSeq ──▶ link.send* ──▶ prediction (owned pawn only)
local play ──▶ EchoDedupe.noteLocal ──▶ host echo ──▶ EchoDedupe.echo (drop the duplicate)
QA capture ──▶ answerQaCapture ──▶ snapshotSend ──▶ link.sendQaSnapshotData
scene ──▶ HUD text / scene-map markers / info probe
host frames ──▶ doorOpen / cabState / pickupIds / playerIds ──▶ per-frame consumers
```

### Trust boundary

Host snapshots are authoritative: `pawnVital`, `doorOpen`, `cabState`,
`pickupIds`, and the rendered entities all come from host frames, and
`client.renderSnapshot()` is the kernel's interpolation of them (`boot.ts:661`,
§3–§4). The client predicts only the owned pawn (`predictOwned` `:73`,
`EngineClient` `:188`); its local fire/grenade play is deduped against the host
echo (`:348-349`). The QA/diag paths are gated by `qa` (`:70`, `:421`, `:909`).
The `X` rows name the boundary only — the contract lives in
`agents/shared-kb.md` or the model repo.

### Candidate invariants

Checkable from the model; none is in §12 yet. One moves to §12 only when a test or
`@invariant` confirms it.

- `firstSnapshot` resolves exactly once, on the first applied snapshot — `boot.ts:456-459`.
- The frame fault clears every effect pool, both queues, and both echo dedupes — `boot.ts:591-606`.
- `fireSeq` / `grenadeSeq` / `useSeq` only advance on a successful send and never decrease in a page — `boot.ts:684,692,728`.
- The owned-pawn prediction never overwrites authoritative state (kernel contract, not written here) — the client only calls `renderSnapshot`/`authoritative`, `boot.ts:661,295`.
- The QA capture and probe paths run only with `qa` — `boot.ts:70,421,909`.
- `laserQueue` / `grenadeQueue` are emptied every frame, including after a fault — `boot.ts:788,809,591,593`.
- `wantInfo` is reset at the top of every frame and set from the frame's input sample — `boot.ts:578,664`.
- The audio unlock listeners are removed on the first running resume — `boot.ts:308-315`.
