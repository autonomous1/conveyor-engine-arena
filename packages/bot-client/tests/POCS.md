# Bot POC ledger

One row per behaviour a live prototype has **proven**. This is the answer to
"has the bot already done this?" — the bot-developer adds a row when a run works
repeatedly, the designer reads it before drafting, the coder links the task that
ships it. A row is evidence, not a task; only the designer turns it into work.

Status: `proven` (script + runs table/report exists), `proposed` (a designer task
cites it), `landed` (a task/commit shipped it). Update the row in place — never
add a second row for the same behaviour.

| # | Behaviour proven | Script | Evidence | Status |
|---|---|---|---|---|
| 1 | Fire band, face-before-fire, retreat/cover (`127`) | `packages/bot-client/src/brain.ts` (+ `test/bot-attack.test.ts`) | `plan/dsh-tasks/reports/127-combat-policy.md` | landed |
| 2 | Info probe copies the place under the hit (`129`) | `src/shared/info-probe.ts` | `plan/dsh-tasks/reports/129-info-copy-place.md` | landed |
| 3 | Plan the unlock before the walk in (`131`) | `src/shared/bots/actions.ts` | `plan/dsh-tasks/reports/131-plan-unlock.md` | landed |
| 4 | Command surface: `cmd` registry, mission commands, recorder, abort; the full key → unlock/enter hall → exit → arm/ammo → 2-minute laser hunt chain; `projectile` (the grenade aim/matrix/trace) | `packages/bot-client/tests/command-host.ts` | `reports/123-command-host.md`, `125-mission-commands.md`, `126-relay-recorder.md`, `reports/live-2026-11-22-keyhall-laser.md`, `reports/live-2026-11-22-projectile-command.md`, `reports/live-2026-11-22-command-parity.md`, `reports/live-2026-11-23-command-attack-5min.md` (5-min `arm`→`reload`→`hunt 5`→`status`: 73 kills / 325 shots / 0 deaths, 2 heals, PASS) | proven |
| 5 | Link/mailbox transport: one persistent seat, inbox/outbox/status, `msg` to a pawn | `packages/bot-client/tests/live-link.ts` | `reports/122-live-link-msg.md` | proven |
| 6 | Interior-door wedge and the place-goal gap (spike) | spike script + trace | `reports/128-interior-door-spike.md` | proven |
| 7 | Attack loop: arm, reload, camp the centre, one target at a time; no-path → select another target; loadout/health checks (`22 kills / 92 shots / 0 deaths` in 300 s) | `packages/bot-client/tests/attack-run.ts` | `reports/live-2026-11-18-attack-live.md`, `reports/live-2026-11-22-attack-5min.md`, `reports/live-2026-11-23-standat-goal-fix.md` (`25 kills / 101 shots / 0 deaths`, plan-based arm-up) | proven |
| 8 | Door approach and press: stand side, locked/key, press once | `door-stand.ts`, `door-far.ts`, `through-doors.ts` | `reports/live-2026-11-15-door-stand.md` | proven |
| 9 | Elevator ride through the room-door prop | `packages/bot-client/tests/elevator-ride.ts` | `agents/host-model.md` §14 | proven |
| 10 | Two-bot claims / race: distinct keys, shared start | `race-claims.ts`, `race-tworace.ts` | run logs | proven |
| 11 | Visibility diagnosis: why the bot cannot see a pawn | `probe-*.ts` | `reports/live-2026-11-18-bot-visibility-analysis.md` | proven |
| 12 | Command status truth: per-task `elapsed` window + `hp`/`dead` respawn rule (`130`) | `packages/bot-client/tests/command-host.ts` | `reports/130-status-and-elapsed.md` | proven |
| 13 | Point stand by `wishTo`, not the `stand:` planner (`132`); kp4 `d=0.01`, 623 ms | `packages/bot-client/tests/command-host.ts` (+ the six swept drivers) | `reports/132-no-direct-point-stands.md` | proven |
| 14 | Follower never stands still at a blocked probe (`133`) | `src/shared/nav/follow.ts` | `reports/133-goto-open-leaf.md` | landed |
| 15 | Patrol within budget: warm the plan or raise the first budget (`134`) | `packages/bot-client/src/brain.ts` | `reports/134-patrol-plan-budget.md` | landed |
| 16 | The first replan after a plan gets the cold budget (`136`) | `packages/bot-client/src/brain.ts` | `reports/136-cold-replan-budget.md` | landed |
| 17 | Observer follow camera, for any spectate-scoped key (`135`) | `src/client/follow-camera.ts` | `reports/135-observer-follow-camera.md` | landed |

## Adding a row

After a run works repeatedly:

1. Add the row: the behaviour in one sentence, the script (or module), the report
   with its measurements, `proven`.
2. End the report with a **task proposal** (the template's slots) so the designer
   can promote it in one pass — the script is the executable spec.
3. When the designer drafts the task, set the row to `proposed`; when the coder's
   report lands, set `landed` and add the task number.
| 14 | Freeze spike: which layer freezes the 140 patrol `pickup:key` (the client send / the host admission / the pickup path) | `packages/bot-client/tests/probe-patrol-freeze.ts` | `reports/live-2026-11-22-patrol-freeze-spike.md`, `reports/live-2026-11-22-freeze-split.md` | proposed: 147 measured the split on the live host — the 140 freeze **reproduced** (R8 A, pad + `pickup:key`, frozen 28.7 s: `processed=1`, `snap=29`, `stale=0`, 476 sends) and again at the hall door (R5 B, `snap=122` flat 24.3 s); the client keeps sending ~20 Hz while the snapshot stream to it stops, no stale flood; intermittent (2 of 6 patrol runs, R4/R6/R7 clean); the host → client publish task is the coder's |
