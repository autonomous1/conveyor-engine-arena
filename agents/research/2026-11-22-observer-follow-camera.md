# Observer follow camera (third-person chase) — method

| | |
|---|---|
| **Question** | How does an observer attach to any player or bot and watch from slightly behind and above, without playing? |
| **Decision it informs** | What the designer asks for: a client-only observer mode, or a host-supported spectator seat with its own camera. |
| **Timebox** | 45 min research + 20 local (spent ~55). |
| **Window** | 2026-11-22 10:35 → 11:40 America/New_York. |
| **Tree** | HEAD as of 2026-11-22; `src/client/boot.ts`, `net.ts`, `qa.ts`, `input.ts`, `arena-host.ts`, kernel replicator. |

## Executive summary

The perspective has a name: a **third-person follow camera** (also "chase cam"); the "slightly back and above" framing is
the centered variant — *over-the-shoulder* adds a lateral offset, *orbit* adds user-controlled yaw, and *lazy follow*
is the industry term for a camera that behaves like a human operator rather than a rigid arm. **The repo already has
this camera and the unseated spectator handshake**: `placeFollow` (`src/client/boot.ts:399-412`) places the camera at
`target − yaw·back` with `+up`, looking at eye height, defaults **back 3 m / up 1.6 m**; `?qa=1` makes the client send
`spectate: true`, the host declines to seat it (`arena-host.ts:224`, `spectateHello`), and `__qa.follow(id)` attaches
it. What is missing is not the method but the **product around it**: the path is gated on QA (which also *freezes* the
world), the only way to pick a target is the console, the camera is rigid (no damping), the observer still runs the
game controller and sends inputs, and there is no occlusion handling. Because the interest radius (**192 m**) exceeds
the map's radius (**85.5 m**), an unseated observer already receives every player **and every bot** — so a
client-only observer mode needs **no host change**. Recommendation: a small client task — `?observe=1` + a target
cycler + one damped follow helper — and keep `qa.ts` behaviour byte-identical.

## 1. Question, decision, timebox

Restated: (a) what is the correct name for the view, (b) is there a method already, (c) what is the cheapest path to
"attach to any player or bot, no controller". The decision selects the designer's next task and whether it touches the
host. Moot if the operator only ever wants QA capture — the QA API already does it.

## 2. Sources

| Source | Version / date | Use |
|---|---|---|
| [Ryan Juckett, *Damped Springs*](https://www.ryanjuckett.com/damped-springs/) | 2012, updated 2020-11-29 | the frame-rate-independent critically damped spring with coefficients; "never let the player outrun the camera"; three camera needs (no discontinuity, catch-up, frame-rate independence) |
| [Unity Cinemachine 3.1.7 — Follow component](https://docs.unity3d.com/Packages/com.unity.cinemachine@3.1/manual/CinemachineFollow.html) | package 3.1.7, docs built 2026-06-09 | fixed offset + binding modes (`Lock To Target With World Up` = our current rigid yaw-locked behaviour; `Lazy Follow` = the human-operator feel) + position/rotation damping |
| [Unity Cinemachine 3.1.7 — Deoccluder](https://docs.unity3d.com/Packages/com.unity.cinemachine@3.1/manual/CinemachineDeoccluder.html) | same | camera occlusion: raycast to the target, push forward / preserve height / preserve distance, damping + minimum occlusion time |
| Local: `src/client/boot.ts`, `qa.ts`, `input.ts`, `net.ts`, `src/server/arena-host.ts`, `conveyor-engine-replication/src/replicator.ts` | HEAD | what exists and what it costs |

No game-engine talk was retrievable as text (GDC Vault session link resolved to a different talk); the three above are
the usable primary references. Everything else in this report is measured in the tree.

## 3. Findings

**F1 — the camera already exists, rigid, QA-only.** `placeFollow` (`boot.ts:399-412`): `followId`,
`followBack = 3`, `followUp = 1.6`; each frame it reads the interpolated entity from `renderSnapshot()`, derives
`yaw = yawFromQuat(entity.rotation)`, sets the camera to `(x − sin(yaw)·back, y + up, z − cos(yaw)·back)` and looks at
`(x, y + 1.6, z)`. Called at `boot.ts:873`, after the normal camera path, only while `followId !== undefined`.
*Label: verified locally.*

**F2 — the unseated spectator handshake already exists.** `net.ts:192` sends `spectate?: true` in the hello; the host's
`onHello` returns `undefined` for it before any seat logic — "A spectator watches. They do not take a seat and are not
a full server" (`arena-host.ts:222-224`) — and `spectateHello` is a one-line predicate (`:730-732`). `boot.ts:553`
sends `spectate: qa`, so only `?qa=1` reaches it today.
*Label: verified locally.*

**F3 — an unseated observer receives every player and every bot.** The kernel replicator filters by
`world.queryRadius(s.focusX, s.focusZ, s.interestRadius)` and only updates `focusX/focusZ` from an owned pawn
(`conveyor-engine-replication/src/replicator.ts:96-103`); an unseated session keeps focus `(0,0)`. The host sets
`interestRadius = ARENA_INTEREST_RADIUS` (**192 m**, `game.ts:59`, `:116`). The map's radius from centre is
**85.5 m** (`web/game/bounds.json`: x −70.9…72.6, z −45.5…47.2). **192 > 85.5**, so the "everything near origin"
query is the whole arena. Following any bot works client-side **today**.
*Label: measured locally.*

**F4 — QA mode is not an observer mode.** `installQaApi` calls `ctx.freeze()` (`qa.ts:101`) → `frozen = true` →
effect pools, mixers and pawn animation are ticked with `dt = 0` (`boot.ts:811-825`). It also sets
`cameraLocked = true`, which skips the normal camera path (`boot.ts:752`). So the QA follow is a *still frame* tool,
not a player-like view.
*Label: verified locally.*

**F5 — there is no target picker.** The only entry is `window.__qa.follow(entityId, {back, up})` (`qa.ts:114`) after
`__qa.pawns()` (declared in `QaApi`, `qa.ts:47`), i.e. the browser console. No keys, no HUD list, no URL parameter.
*Label: verified locally.*

**F6 — the observer still plays.** `drawFrame` sends `link.sendInput(...)` unconditionally (`boot.ts:834`); with no
owned pawn the host drops the input, but the client still samples the gamepad/keyboard and sends at `INPUT_HZ`, and
`attachPlayInput` is created with `requestLock` defaulting to true. "Without using the game controller" is therefore
true only by accident.
*Label: verified locally.*

**F7 — the camera is rigid by construction.** Position is recomputed from the target's yaw every frame: a pawn that
turns 90° whips the camera 90° in one frame, and a teleport teleports the camera. The industry fix is damping —
Cinemachine exposes position/rotation damping and a `Lazy Follow` mode that "attempts to move as little as possible to
maintain the same distance", and Juckett's damped spring is the reference implementation with per-frame coefficients,
explicitly because "the player's motion may create sharp, discontinuous changes in direction, speed or even
position".
*Label: documented externally + verified locally.*

**F8 — framing math.** With `back 3 / up 1.6` and a look-at at eye height, the camera looks **down ~28°**
(`atan(1.6/3)`). Player-like chase cameras usually sit at 10–20° (e.g. `back 4.5 / up 1.5` ≈ 18°); the current values
are a fine QA framing and a slightly steep observer framing. Nothing is wrong; it is a knob.
*Label: inferred from the constants.*

**F9 — no occlusion handling.** At `back 3` in a room, a wall between camera and pawn shows the wall, not the pawn.
Cinemachine's Deoccluder is the reference: raycast to the target, then pull forward / preserve height / preserve
distance, with damping and a minimum occlusion time. The client has `three-mesh-bvh` only indirectly (server-side
`SpatialDAG`), so a client camera ray means `THREE.Raycaster` against the scene's `InstancedMesh`es — possible but not
free.
*Label: documented externally + inferred locally.*

**F10 — the "name" answer, recorded so the task and KB use one term.** *Third-person follow/chase camera*; ours is the
centered, yaw-locked, fixed-offset variant. `Lock To Target With World Up` is Cinemachine's name for the same binding
(yaw only, no pitch/roll). If the operator later wants the pawn to stay off-centre, that is *over-the-shoulder*
(a lateral `right` offset); if they want to look around while following, that is an *orbit* camera (mouse yaw/pitch
around the target) — both are additive to this method, not replacements.
*Label: documented externally.*

## 4. Local measurement

```bash
rg -n "followId|followBack|followUp|frozen" src/client/*.ts          # boot.ts:395-398, 399-412, 873
rg -n "spectate" src/client/net.ts src/server/arena-host.ts          # net.ts:192, arena-host.ts:222-224, 730-732
rg -n "interestRadius" node_modules/conveyor-engine-replication/src/replicator.ts   # :48, :103
node -e "…bounds.json…"                                              # max radius 85.5 m vs radius 192 m
node -e "…scopes client…"                                            # 33 of 138 test files selected
rg -n "cameraLocked" src/client/*.ts                                # arena-scene.ts:36, boot.ts:752, qa.ts:112/117
```

Footprint of the recommended change: **3 client files + 1 test** (`follow-camera.ts` new, `boot.ts`, `input.ts` for the
`keys` accessor, `test/client-follow-camera.test.ts`), no host, no kernel, no protocol.

## 5. Method options

| Option | Verdict | Cost | Risk | What would change it |
|---|---|---|---|---|
| **A. Keep QA-only** (`?qa=1` + `__qa.follow`) | **already have** | 0 | frozen world, console-only, no damping, observer still sends input | only if observers are always QA capture |
| **B. `?observe=1` in `boot.ts`: unseated spectate + target cycler + damped follow helper, viewmodel hidden, input sends skipped** | **small, recommended** | 1 new module + 2 files + 1 test | none load-bearing; reuses `placeFollow` math | if the operator wants mouse orbit or shoulder offset (add to the same helper) |
| **C. B + camera occlusion (raycast, pull forward)** | **medium** | +1 module, per-frame ray against instanced meshes | frame cost in rooms, jitter without damping | a visible wall-clip in the observer view |
| **D. Full orbit camera (mouse yaw/pitch around target)** | **medium** | new input mode + yaw/pitch state + clamp | fights the existing pointer-lock/menu gates | if the operator wants to look around independently of the pawn |
| **E. Host-owned spectator seat (pawn-less session with a `spectate` scope, focus = target)** | **large, unnecessary** | host seat policy + focus frame + tests | touches the authority path for a view feature | if the interest radius shrinks below the map, or spectators must be scoped/audited |

## 6. Recommendation

**One action: a designer task for client observer mode (option B).** Reuse the existing `placeFollow` math, move it
into a testable helper, add damping, expose a target cycler, and stop the controller. Do not add the occlusion pass
(option C) or an orbit camera (D) until the observer view exists and someone has watched a bot through a room
boundary.

### Task proposal (designer slots)

**Architecture note.** Cite `boot.ts:399-412` (`placeFollow` — the offset math to keep) and `net.ts:192` +
`arena-host.ts:222-224` (the `spectate` hello that makes an unseated observer possible). The task adds no authority:
the observer has no pawn, sends no gameplay frames, and the host is unchanged.

**Knowledge base.** `agents/client-kb.md` §1 (boot/composition — where the observer entry lives), §2 (frame loop —
where the camera is placed), §5 (scene construction — viewmodel/pawn layer) and §13 (client state — the per-frame
`let`s). `agents/host-flow.md` §2 (the tick/heartbeat the observer still receives) for why no host change is needed.

**Files to touch.**

| File | Change |
|---|---|
| `src/client/follow-camera.ts` (new) | pure `followCamera(target, prev, opts, dt)`: offset (`back` along target yaw, `up`), look-at at eye height, exponential damping; returns `{ x,y,z, lookY }`; no DOM, no clock |
| `src/client/boot.ts` | `observe` flag from the search string; pass `spectate: qa \|\| observe`; `followId` + cycler; call the helper in `drawFrame` instead of the inline math; hide viewmodel; skip `sendInput` and the fire/use clocks while observing; HUD status `observing <id>` |
| `src/client/input.ts` | expose `readonly keys: ReadonlySet<string>` on `PlayInput` (the cycler reads `BracketLeft`/`BracketRight`); no new listener |
| `test/client-follow-camera.test.ts` (new) | the pure math + damping + frame-rate independence |

**Codemap delta.** Add `followCamera` and its options/target types (`src/client/follow-camera.ts`), and `keys` on
`PlayInput`. Remove nothing. `npm run codemap` after the edit.

**Headers and tags.** Four-slot header on `follow-camera.ts`; `@why` on "damp position, not yaw-derived offset" (the
whip on a 90° turn); `@invariant` "the returned position is within `back + up` of the target once converged", with
`(test: follow_camera_converges_within_the_offset)`; `@pre` on `dt > 0` clamping.

**Test-must-fail-first.** `node --import ./scripts/ts-ext-register.mjs --test test/client-follow-camera.test.ts`
fails on HEAD with `ERR_MODULE_NOT_FOUND` for `src/client/follow-camera.ts` — the honest import fail-first; state that
it is weaker than an assertion fail-first.

**Test scope.** `npm run test:scope client` — `test/client-follow-camera.test.ts` matches the existing `^client-`
pattern, so **no `test/scopes.json` change**; expect **34/138** files selected (33 today + the new one).

**Artifacts.** `plan/dsh-tasks/logs/<nn>-fail-first.log`, `<nn>-tests.log`, `<nn>-codemap.diff`.

**Tests.**
- `follow_camera_places_behind_and_above` — target at origin, yaw 0, `back 3 / up 1.6` → camera `(0, 1.6, −3)`
  (yaw 0 faces +Z, so "behind" is −Z), `lookY = 1.6`; yaw π/2 → camera `(−3, 1.6, 0)`.
- `follow_camera_converges_within_the_offset` — a target that jumps 10 m away: after 1 s of 60 Hz steps the camera is
  within 0.2 m of the ideal offset.
- `follow_camera_is_frame_rate_independent` — one 1/30 s step vs two 1/60 s steps differ by < 1e-3 in position.
- `follow_camera_keeps_the_last_pose_when_the_target_is_missing` — `undefined` target returns `prev` unchanged.
- `follow_camera_yaw_wraps` — target yaw crossing ±π produces the same position as the equivalent wrapped yaw.
- `observe_parameter_selects_spectate` — `?observe=1` builds a hello with `spectate: true`; `?qa=1` unchanged.

**Acceptance.**
- `npm run typecheck`; `npm run test:scope client` passes (34/138, 0 fail); the standalone run of the new file passes.
- Fail-first pasted verbatim (import error).
- Observer path: no `sendInput`, no fire/use/grenade sends while `observe`; viewmodel hidden; HUD shows the target.
- `src/client/qa.ts` behaviour unchanged: `__qa.follow(id, {back, up})` still freezes and locks the camera, and
  `test/qa-*.test.ts` (client scope) still passes.
- `npm run codemap:check`; codemap diff only the expected additions.
- No new `Math.random`; `follow-camera.ts` takes `dt` and never reads `Date.now`.

**Out of scope.**
- Occlusion/Deoccluder work (option C) — a follow-up if walls clip.
- Orbit/mouse-look around the target (option D).
- Host-side `spectate` scope enforcement or a focus frame — see Open questions.
- Over-the-shoulder lateral offset — a one-line `right` offset if requested later.

## 7. Open questions

1. **Should `spectate: true` require the `spectate` scope?** Today `spectateHello` accepts any authenticated hello —
   any player token can join unseated and see the whole arena. A one-line host check
   (`conn.claims?.scope.includes("spectate")`) would close it; verify that the scope is reachable inside `onHello`
   before writing the task (the dispatch at `arena-host.ts:610` reads it after attach). Default for this task: leave
   the host alone; open a separate host task if spectator policy matters.
2. **Does the observer need the target's vitals in the HUD?** `pawnVital` is per entity in the client, so it is
   available; whether exposing an enemy's hp to an observer is acceptable is a policy call for the operator.
3. **Attachment stability.** `renderSnapshot()` interpolates; if the target is despawned or leaves the snapshot the
   helper holds the last pose (test above). Should the cycler auto-advance when the target disappears? Default: hold
   and show `observing <id> (lost)`.
4. **Sticky camera on teleport.** With damping a teleport would sweep the camera across the map; clamp the per-frame
   correction (e.g. snap if the ideal position is > 10 m away). Default: snap on > 10 m.
