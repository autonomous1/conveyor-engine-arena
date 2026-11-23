# Bot-client knowledge base

The headless bot lane in `packages/bot-client/`: connect, the world model, the
brain, the mailbox and command surface, and the live drivers. This is the layer
above `agents/codemap.md`: the map, not the index. Every claim names the file and
symbol; the codemap owns `:line`.

Scale (2026-11-23): 11 modules, ~4.7k lines; 8 NDJSON scenarios under `tests/`.
The drivers under `tests/` are rapid prototypes, not model content, and the unit
tests are `test/bot-*.test.ts`, not the drivers.

The lane's state — containers, keys, lifetimes — is §13.

## 1. Boot and connect

**Owns:** one bot seat over the host's WebSocket.

`connectBot` (`connection.ts`) fetches `/arena.json` (`ArenaHelloView`), builds
the world with `createBotWorld`, optionally loads a preloaded scene graph or
regions, opens a `SocketLike` (`socket.ts`; `node-socket.ts` wraps `ws`), and
sends `helloFrame` — the fields of the browser's `connectLive` (`src/client/net.ts`)
plus `name`. The welcome is parsed by `parseWelcomeExtras` (`src/shared/bot-protocol.ts`)
and applied to the world; `WELCOME_MS` bounds the wait.

Failures are typed: `BotAuthRejected` (4401/4403) and `BotRejected` (a non-auth
refusal such as `SERVER_FULL`). A mid-sequence close is an abort, not a retry:
`reconnect` defaults to `"abort"`; `BACKOFF_START_MS`/`BACKOFF_MAX_MS` exist only
for the retry mode. The welcome seeds the owner's `hp`/`dead`, because the health
frame is change-driven — a pawn that never takes damage would have no vital.

`createBotInput` (`input.ts`) sends player-equivalent frames at
`INPUT_INTERVAL_MS`; the sequence starts at 1 and `resetSeq` restarts it on a new
welcome. Buttons carry the noclip/ascend bits.

## 2. The world model

**Owns:** the mutable arena model the brain reads each tick.

`createBotWorld` (`world.ts`) builds `BotWorld` from `WorldView` (aabbs, doors,
pickups, player spawns, pawn radius/height). The welcome fills pickups, doors,
keys, role, scope, elevators, claims, the `messages` flag, and the vital. Frames
then apply rows: spawn/update/despawn (`PoseSnapshot`), health, players, doors,
pickups, claims, `msg` batches, and grenade poses.

The accessors are the brain's whole surface: `self`, `others`, `healthOf`,
`door`/`doors`, `cabs`, `grenades`/`landed`, `claims`, `messages`, `playerIds`,
`weapon`/`ammo`, `placeOf`, `summary`, `sceneGraph`/`sceneGraphHash`, `regions`.

Two rings bound memory: `MSG_RING` keeps the last 64 signal rows and `messages()`
returns a copy; `landed` keeps the last 16 stop poses. `pickupPlacements()`
deliberately keeps taken ids, so a plan can still name them.

## 3. The brain

**Owns:** the mission loop — plan, step, replan, fight.

`runBrain`/`runMission`/`runAttack` (`brain.ts`) drive the frozen shared planner
(`src/shared/bots/goap.ts`) with the shared actions, goals, cover, and state.
`STEP_MS` is the per-step sleep and `REPLAN_MS` the periodic replan.

Two plan budgets: `PLAN_BUDGET_MS` (250) for a periodic safety replan on the same
state, and `COLD_PLAN_BUDGET_MS` (4000) for the first plan and the first plan
after an action, a door/pickup change, or a `stuck`. `goap.plan` calls `h(start)`
before its first `expired()` check, so a changed state's cold route compile is
charged here; the safety pool keeps 250 ms.

Pursuit has its own cadence (`PURSUE_*`): re-plan at 5 Hz, re-plan on drift, a
two-pose velocity window, and a lead cap. Combat policy: a fire band of 12–18 m,
the body turns and settles (`FACE_SETTLE_MS`) before the frame fires, and a
retreat below `RETREAT_HP` or against `RETREAT_THREATS` within `RETREAT_THREAT_M`,
then cover. `createMotionPredictor` (`predict.ts`) snaps above 1 m of error and
blends 20% otherwise.

Exit codes: 0 met; 2 no plan, refused, lost, `no_ammo`, died, or retreat; 3
timeout; 4 auth/seat.

## 4. Missions

**Owns:** the text order into the planner's goal.

`parseMission` (`missions.ts`) is the only text surface: `reach:<place>`,
`retrieve:<pickup>@<place>`, `patrol:<place,place,…>`, `stand:<x>,<y>,<z>[,yaw]`,
`stand:door:<id>[:in|:out]`, and `idle`. It returns a `Mission` — one goal, a
patrol loop, or a stand target; execution is `brain.ts`.

## 5. Mailbox and the command surface

**Owns:** the operator's commands in and the bot's events out.

`openMailbox` (`mailbox.ts`) creates the directory and exposes `poll`, `send`,
`writeStatus`, and notes over `inbox.ndjson`, `outbox.ndjson`, `status.json`,
`transcript.ndjson`, and `notes.md`. A row is returned at most once until the
inbox is truncated; `NOTE_MAX` bounds the note text.

`createCommandHost` (`commands.ts`) is the production interface: eleven typed
handlers (`CommandName`), `dispatch`, `status`, `abort`, and the
`CommandResult`/`CommandArtifact`/`CommandStatus` shapes. One dispatch at a time;
`TASK_TIMEOUT_MS` (180 s) clamps a task; the packed status is trimmed to
`MAX_TEXT` (256) for the host's text frame.

`tests/command-host.ts` is the driver over both: CLI, token, socket, mailbox,
recorder, trace, and the `start`→`done`/`fail` envelope. It no longer holds the
handlers — those are `commands.ts`.

## 6. The driver lane

`tests/*.ts` are rapid prototype drivers: git-tracked, but not tracked in this
model — no count, no per-driver list. `tests/scenarios/*.ndjson` replay command
chains over the `msg` loopback; `tests/POCS.md` is the ledger of proven
behaviours.

## 7. Determinism

The brain and the sensor take a clock and the `splitMix` RNG from the caller; the
shared planner and `aim` state their determinism. `predict` is a pure per-`dt`
model. A new hidden clock in this lane would break replays.

## 8. Single sources

The bot imports, never copies: `bot-protocol.ts`, `wire.ts`, `arena-view.ts`,
`health.ts`, `hitscan.ts`, `look.ts`, `pickups.ts`, `nav/follow.ts`, and
`bots/goap.ts` live in `src/shared/`, one file each, shared with the host and the
browser.

## 11. Invariant index

- `createCommandHost` — one dispatch at a time; a second dispatch while busy
 rejects with `code:1,why:"busy"` (`commands.ts`, test:
 dispatch_rejects_while_busy).
- `openMailbox.poll` — a row at most once until the inbox is truncated; a
 truncated inbox restarts at zero (`mailbox.ts`, test:
 mailbox_polls_only_new_rows_and_restarts_after_truncation).

## 12. Layer map

| Group | Modules | Consumer |
|---|---|---|
| connection | `connection.ts`, `socket.ts`, `node-socket.ts` | the CLI, the drivers |
| world | `world.ts` | the brain, every driver |
| brain | `brain.ts`, `missions.ts`, `predict.ts` | the CLI, the command host |
| commands/mailbox | `commands.ts`, `mailbox.ts` | the command-host driver |
| input | `input.ts` | the connection |

## 13. Bot state model

**Owns:** the lane's containers, keys, and lifetimes. The flows are §1–§6; the
cross-layer contract is `agents/shared-model.md` §13.

### 13.1 Session

| tag | state | container | element type | key → value | written by | lifetime |
|---|---|---|---|---|---|---|
| B | owned pawn | `ownedId` (`connection.ts`) | number | — | welcome | per session |
| B | input sequence | `inputSeq` (`input.ts`) | number | — | `sendInput` | monotonic; reset by `resetSeq` |
| B | reconnect policy | `reconnect` | `"auto" \| "abort"` | — | `connectBot` | per session |
| X | socket | `SocketLike` (`socket.ts`) | `ws` / browser socket | — | `connectBot` | per session |

### 13.2 World

| tag | state | container | element type | key → value | written by | lifetime |
|---|---|---|---|---|---|---|
| S | pawn rows | `BotWorld` pawn map | `PawnPose` | entity id → pose | snapshot rows | per session |
| B | health rows | `health` map | `{hp,dead}` | entity → vital | health frames, welcome | per session |
| B | doors | `doors` map | `DoorState` | door id → open/locked | welcome, door frames | per session |
| B | pickups | `pickups` set | placement id | — | welcome, pickup frames | until taken |
| B | keys | `keys` set | key id | — | welcome, key frames | per session |
| B | claims | `claims` map | `ClaimRow` | goal key → owner/expires | `claims` frames | until released or expired |
| B | signals | `messages` ring | `MsgRow[64]` | — | `msg` frames | ring; oldest dropped |
| B | landed | `landed` ring | `GrenadePose[16]` | — | stop poses | ring; oldest dropped |
| S | player ids | `playerIds` set | entity id | — | `players` frames | per session |
| S | scene graph/regions | `graph`, `regions` | parsed | — | welcome or preload | boot-only |

### 13.3 Command host

| tag | state | container | element type | key → value | written by | lifetime |
|---|---|---|---|---|---|---|
| B | busy task | `busy` (`commands.ts`) | `{id,name}` | — | `dispatch` | one at a time; `TASK_TIMEOUT_MS` 180 s |
| B | abort | `abortRequested` | boolean | — | abort command | one task |
| B | last result | `lastResult` | `{id, ok}` | — | dispatch end | replaced per command |
| B | status | packed body | ≤ `MAX_TEXT` 256 | — | dispatch | per command |

### 13.4 Mailbox

| tag | state | container | element type | key → value | written by | lifetime |
|---|---|---|---|---|---|---|
| B | inbox offset | `offset` (`mailbox.ts`) | bytes | — | `poll` | per process; truncation resets |
| S | recorder files | inbox/outbox/status/transcript/notes | lines | — | `openMailbox` | directory lifetime |

### 13.5 Lifetime rules

- A close ends the session; the drivers never retry into a restarting host.
- The welcome seeds `hp`/`dead`; every later vital is a change frame.
- `MSG_RING` and `landed` drop the oldest row, never grow.
- `TASK_TIMEOUT_MS` clamps a command's seconds; the status is trimmed to `MAX_TEXT`.

## 14. Open gaps

- The message sender (`connection.ts` `messages.say`) has no unit test: it is a
 live-session closure.
- A rejected message is silent to the sender (`stats().dropped` is operator-only);
 a msgReject frame (not yet defined) is the documented follow-up.
