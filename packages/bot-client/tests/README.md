# Bot-client live drivers and probes

Scratch drivers used against the operator's local arena (`ws://localhost:4173`,
started with `npm start`). They are not product code and not part of the test
suite; the unit tests are in `test/*.test.ts`. Everything here is run from the
repo root with the TS extension loader:

```bash
node --import ./scripts/ts-ext-register.mjs packages/bot-client/tests/<script>.ts
```

The remote token is read from `CE_TOKEN` (or `~/.config/ce-arena/qa-token.pem`):

```bash
CE_TOKEN="$(cat ~/.config/ce-arena/qa-token.pem)" \
  node --import ./scripts/ts-ext-register.mjs packages/bot-client/tests/attack-run.ts --for-s 300
```

Most scripts write their banners to stdout and (for the longer ones) traces under
`plan/dsh-tasks/logs/`. The `plan/` tree is gitignored: manifests, logs and reports stay
scratch; the scripts here are the tracked record.

## Attack

| Script | Use |
|---|---|
| `attack-live.ts` | one session: arm at the crate steps (10 m east, climb), ammo crate, centre, nearest wander pawn, `attack:<id>`; `--target <id>` to pin the target |
| `attack-run.ts` | the 5-minute loop: arm, reload as needed, camp the centre, one target at a time, re-plan on stall; `--for-s 300`; the five point walks (east / climb / step-off / spawn / spawn-retry) go through the plan (`stand:` → `walkToPoint` → `planPath`, task 151), the per-tick steering (`followPlan`/`avoidPawns`, the door axis, the pursuit) stays `wishTo` |
| `projectile-run.ts` | the grenade soak: bands 5/10/20 m, ballistic and ballistic+lead, the blast curve read from hp frames; the approach is **plan-only** (task 150): `planPath` gates every candidate and the walk is the product `stand:` mission — no straight `wishTo`, no fallback, a rejected candidate is never walked; 50 ms trace with `snap`/`processed` and a **5 s freeze guard** (`FREEZE stale=5s …` ends the run); `--for-s 300`, `--bands 5,10,20`, `--throws 4` |

## Races (two pawns)

| Script | Use |
|---|---|
| `race-ready.ts` | seats both bots on the pads and waits for a `plan/dsh-tasks/live/race-go` sentinel before a shared 3 s start |
| `race-tworace.ts` | two sessions, shared wall-clock start from the second welcome |
| `race-claims.ts` / `race-claims2.ts` | per-bot stand points beside a door (distinct claim keys), 10 s wait |
| `two-race.ts` | two clients, both walk 10 m forward, hold 60 s, exit |

## Door / room / elevator probes

`door-stand.ts`, `door-far.ts`, `door-far2.ts`, `door-near.ts`, `room-stand.ts`,
`through-doors.ts`, `use-out.ts`, `park.ts`, `exit-cab.ts`, `elevator-ride.ts`,
`elevator-drive.ts`, `floor5-door.ts`, `floor5b.ts`, `return-center.ts`, `go-center.ts`,
`stuck-test.ts`, `walk-via.ts`, `visit-remote.ts`.

## Command host

| Script | Use |
|---|---|
| `command-suite.ts` | the 158 per-command, fresh-host suite: `--list` prints the menu from the trial table's `title` (starts nothing); `--test <id>` runs **exactly one** test — one build, one `npm start` host on `--port` (default 4175, auth on), one bot, or `--attach ws://127.0.0.1:4173` uses the operator's **running** host instead (no build, no spawn, never killed; the players present at join are allowed, a new player mid-trial marks the trial INVALID; artifacts say `HOST attach`; a teleport-to-pad that does not land while `snap` is flat aborts the run as `world frozen`, and a closed socket (`rs=3`) during a command fails the trial with `socket:closed` plus `SOCKET closed`, instead of skipping through the remaining trials); `--max-min <n>` caps a suite at n minutes (default 16; a full fresh-host run takes ~18–19, so use 22); a `--suite` on an attached host keeps **one session** for the whole run — one seat, a command host per trial, teleport to the pad before each trial — so the host does not forget the pawn's kit on close and `reload`/`hunt`/`abort` can run, the trial's preconditions and command through `./commands-prototype.ts` (the fork of `src/commands.ts`; a `SURFACE` line prints its sha256 and the harness refuses to import production), a 250 ms `snap`/`processed`/penetration trace, then a verdict and exit 0 (PASS/WARN, or a control that failed as designed) / 1 (FAIL or INVALID after one retry) / 2 (could not start or SKIP); on a **shared** host (`--attach`) a trial that starts off the pad first teleports its **own** pawn to the pad (`TELEPORT …`, qa scope; never another pawn) and records `start_pos`; a trial whose object the bot already holds is skipped (`skip:already-held:<id>`) and one whose object an earlier trial consumed is skipped (`skip:consumed:<id>`) instead of INVALID — `--test` exits 2, `--suite` reports `skip=n` and does not fail on it (use `--passes 1` for an attach suite); `--suite` runs 3 passes of the 14 positives + both controls (44 hosts). Per-trial verdict: result, 15 s hard / 3 s soft stall, ≥5 `replan stuck`, 5 cm penetration, 5 s net freeze, seat, dirty map, arm gate; every building **contact** is logged as `COLLIDE t=… box=… src=… at=…` (one line per episode) and counted in the row's `collision_count`/`collisions` — penetration >5 cm is still the fatal one; artifacts `158-test-<id>-<stamp>.*` / `158-suite-<stamp>.*`; the report is `plan/dsh-tasks/reports/158-test-<id>-<stamp>.md` |
| `command-parity.ts` | one bot, one session: the nine-command matrix + the deliberate failures through `createCommandHost`/`parseCommand` (`src/commands.ts`), one NDJSON row per command with the status before/after and a 5 s `CHECK`; `--url ws://127.0.0.1:4173 --label 140-parity --name parity` |
| `probe-patrol-freeze.ts` | the 145/147 freeze probe: one session with a `sendInput` wrapper (first/10th, `SEND-NONE`) and a 250 ms `PROC processed=… sent=… snap=… stale=…` sampler (the host's admitted seq, the send attempts, the applied snapshots) plus the 500 ms pose/keys/doors sampler; `--trial r1` (patrol), `r2` (raw walk), `r3` (`retrieve:key`), `r4` (patrol on a fresh host), `r5` (A walks off the pad, closes; B rejoins on the inherited pose and patrols), `r7` (A patrols once to collect the key, closes holding it; B rejoins on the inherited pose + key and patrols into the hall — the R5 freeze recipe); NDJSON under the logs with a raw copy in `--dir` |
| `command-host.ts` | one persistent seat as a message-driven command surface: `arm`/`reload`/`hunt` (laser)/`patrol`/`goto`/`stand`/`walk` (raw waypoints)/`projectile` (grenade bands/throws/seconds; the aim/matrix/trace)/`status` handlers (`stand` walks to `(x,z)` by wishTo and faces `yaw`; it does not open doors or plan — `goto:<place>` is the step when a door is in the way), `start`/`done`/`fail` events to the sender with the mission counters (`kills`/`shots`/`places`/`ammo`), packed `status` (≤256): `hp:null` = unknown, `hp:0` + `dead:true` = awaiting respawn (re-query, not terminal), `dead:null` = no health row; each task's end line prints its own `elapsed` window, not the process uptime. Commands in via the mailbox (`{"cmd":"task","id","name","args"}`) or a `msg` row (`{"t":"cmd",…}`); `--scenario scenarios/hunt-laser.ndjson`, `scenarios/patrol.ndjson` or `scenarios/keydoor-patrol.ndjson` (walk waypoints → getkey → goto hall → stand in the hall → interior patrol → status) replays a chain over the msg loopback. Also the session recorder: `<dir>/transcript.ndjson` (one row per dispatched command, with the packed `statusAfter`), `<dir>/session.json` (the roll-up, rewritten at exit), `<dir>/notes.md` (the `{"cmd":"note","text":"…"}` command); transcript and notes append across sessions. The file mailbox (inbox/outbox/status/transcript/notes/session) is `src/mailbox.ts`; the ten handlers (`projectile` included) and the status projection are `src/commands.ts`; this driver keeps the CLI, mailbox, recorder, scenario, samplers and the projectile trace write |

## Link / mailbox

| Script | Use |
|---|---|
| `live-link.ts` | one persistent seat driven by a file mailbox: commands in `<dir>/inbox.ndjson`, events in `outbox.ndjson`, `status.json` every 250 ms; the mailbox is `src/mailbox.ts` (task 137), and the `{t, at, …}` outbox envelope is this driver's; messages use the host `msg` frame (`to` = pawn id or `*`). One bot: `… live-link.ts --dir plan/dsh-tasks/live/122-link-a --label 122-link-a --name link-a`; two bots (operator spectating): a second instance with `122-link-b`/`link-b` |

## Read-only probes

`probe-*.ts` — state/geometry/A* checks (pawns, pickups, doors, grid, seats, health,
weapon). They connect, print, and close; no goals.
