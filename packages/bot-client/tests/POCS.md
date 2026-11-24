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
| 4 | Command surface: `cmd` registry, mission commands, recorder, abort; the full key → unlock/enter hall → exit → arm/ammo → 2-minute laser hunt chain; `projectile` (the grenade aim/matrix/trace) | `packages/bot-client/tests/command-host.ts`; `packages/bot-client/probe/command-suite.ts` (+ `command-suite.trials.json`, `commands-prototype.ts`) | `reports/123-command-host.md`, `125-mission-commands.md`, `126-relay-recorder.md`, `reports/live-2026-11-22-keyhall-laser.md`, `reports/live-2026-11-22-projectile-command.md`, `reports/live-2026-11-22-command-parity.md`, `reports/live-2026-11-23-command-attack-5min.md` (5-min `arm`→`reload`→`hunt 5`→`status`: 73 kills / 325 shots / 0 deaths, 2 heals, PASS), `reports/158-test-arm-1-2026-11-23T18-44-58.md` (fresh-host suite prototype: `arm-1` PASS — `armed` 7.23 s, no `pickup:` stall, clean close), `reports/158-test-patrol-2026-11-23T18-47-55.md` (`patrol` FAIL ×4: transport close, client-join seat takeover, and the inner-door `no-plan:unsatisfiable`), `reports/158-command-suite.md` (attach suite 2026-11-23T19:46: exit 0 but 25 SKIP — not a green suite; `patrol` PASS to HALL0 (3 places) with the coder's `actions.ts` door-token fix, but only 1/3 in the 20:34 re-run (route choice non-deterministic; a `safety` replan from the doorway still yields `steps=0`); the 147 publish stall reproduced in `arm-1` (123.66 s), after `projectile` (2 deaths), and mid-`patrol` in the hall (18.6 s) — now the dominant blocker; teleport-to-pad and per-contact `COLLIDE` logging added), `reports/161-client-close.md` (the qa close probe: rate **1 in 88** fresh-host trials; the instrumented `close code=… reason=… rs=… welcome=… current=…` line and `last_seq`/`last_frame` shipped; not reproduced in 64 attempts; while probing, `patrol` failed **16/20** with `no-plan:unsatisfiable` — the dominant coder item), `reports/164-close-source.md` (close-source probe: **0 closes in 3 attach suites**; 163's host `close client=… code=…` line is live and ready for the next occurrence; one attach suite fully green) | proposed |
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
| 18 | Planner seams (`177`, port `185`): a stand goal in the locked hall plans in 115 ms / 5 steps at a 600 ms warm budget with the route heuristic (was none at the 5 s deadline); grounding cache `(hash, goal want, stand key)` logs 0 ms hits; typed `Map<kind, binder>` executor keeps the 11-command matrix **identical 18/18 rows**; ladder `survive`/`defend`/`assault`/`idle` 4/4. The review's "no plan @ 5,002 ms" is the no-`stand`-arg call, not the brain's; the route heuristic is already the brain's default | `packages/bot-client/tests/plan-probe.ts`; `packages/bot-client/proto/brain.ts` | `reports/live-2026-11-24-plan-seams.md`; `logs/177-plan-2026-11-24T21-00-19.summary.md`; `logs/177-parity-src-2026-11-24T20-54-09.ndjson` vs `logs/177-parity-proto-2026-11-24T20-56-42.ndjson` (identical `id:name:ok:code:why`) | proposed |
| 19 | Shell combat vocabulary (`186`): the `--shell` exposes 184's combat verbs (`seek-health`, `take-cover`, `return-fire`, `retreat`, `reload`→`rearm`, `survive`, `defend`, `assault`), combat-first dispatch, the `reload` winner + `legacy reload` escape, the surface gate (`--surface proto`), the pty transcript, and the 18-row legacy parity | `packages/bot-client/probe/command-suite.ts`; `packages/bot-client/proto/commands.ts` (184's `proto/combat.ts`) | `reports/live-<date>-shell-combat.md` (pending, task 186) | proposed |
| 20 | Combat vocabulary in GOAP (`184`): `survive`/`defend`/`assault` plan from hp/threat/cover facts — 8/8 offline matrices, the locked-door crate closure (246 expansions), and live parity: planned `returnFire` in **25 ms / 1 step**, 5 shots / 1 kill vs control 4/1. Three live-only seams found and fixed (live `usable`, presence-gated order, and a floor heuristic for every ground-only goal — `survive` 131 exp/1,018 ms → 3 exp/19.6 ms; the starved heal plan had produced a 4 s input-loop block and an `input-rate` resync cascade, no longer reproduced: max plan 237 ms, 0 rate-limit). `defend` is one goal, not the review's two-goal OR, so the cost knob decides | `packages/bot-client/tests/combat-goap.ts`; `packages/bot-client/proto/combat.ts`; `packages/bot-client/proto/brain.ts` | `reports/live-2026-11-24-combat-goap.md`; `logs/184-parity-2026-11-24T22-06-30.summary.md`; `logs/184-proto.diff` | proven |

## Adding a row

After a run works repeatedly:

1. Add the row: the behaviour in one sentence, the script (or module), the report
   with its measurements, `proven`.
2. End the report with a **task proposal** (the template's slots) so the designer
   can promote it in one pass — the script is the executable spec.
3. When the designer drafts the task, set the row to `proposed`; when the coder's
   report lands, set `landed` and add the task number.
| 14 | Freeze spike: which layer freezes the 140 patrol `pickup:key` (the client send / the host admission / the pickup path) | `packages/bot-client/tests/probe-patrol-freeze.ts` | `reports/live-2026-11-22-patrol-freeze-spike.md`, `reports/live-2026-11-22-freeze-split.md` | proposed: 147 measured the split on the live host — the 140 freeze **reproduced** (R8 A, pad + `pickup:key`, frozen 28.7 s: `processed=1`, `snap=29`, `stale=0`, 476 sends) and again at the hall door (R5 B, `snap=122` flat 24.3 s); the client keeps sending ~20 Hz while the snapshot stream to it stops, no stale flood; intermittent (2 of 6 patrol runs, R4/R6/R7 clean); the host → client publish task is the coder's |
