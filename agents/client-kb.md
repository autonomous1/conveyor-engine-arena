# Client knowledge base

The browser frame of the arena client: boot, the RAF loop, snapshot intake,
scene construction, input, HUD, audio, effect pools, diagnostics, and the
frame budget. This is the layer above `agents/codemap.md`: the map, not the
index. Every claim carries `file:line`. Kernel-owned work is named, not
described.

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
the pawn layer. The entry points run once per page; there is no re-boot path.

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
