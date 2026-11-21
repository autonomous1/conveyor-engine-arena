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
| 4 | Command surface: `cmd` registry, mission commands, recorder, abort | `packages/bot-client/tests/command-host.ts` | `reports/123-command-host.md`, `125-mission-commands.md`, `126-relay-recorder.md` | proven |
| 5 | Link/mailbox transport: one persistent seat, inbox/outbox/status, `msg` to a pawn | `packages/bot-client/tests/live-link.ts` | `reports/122-live-link-msg.md` | proven |
| 6 | Interior-door wedge and the place-goal gap (spike) | spike script + trace | `reports/128-interior-door-spike.md` | proven |
| 7 | Attack loop: arm, reload, camp the centre, one target at a time | `packages/bot-client/tests/attack-run.ts` | `reports/live-2026-11-18-attack-live.md` | proven |
| 8 | Door approach and press: stand side, locked/key, press once | `door-stand.ts`, `door-far.ts`, `through-doors.ts` | `reports/live-2026-11-15-door-stand.md` | proven |
| 9 | Elevator ride through the room-door prop | `packages/bot-client/tests/elevator-ride.ts` | `agents/host-model.md` §14 | proven |
| 10 | Two-bot claims / race: distinct keys, shared start | `race-claims.ts`, `race-tworace.ts` | run logs | proven |
| 11 | Visibility diagnosis: why the bot cannot see a pawn | `probe-*.ts` | `reports/live-2026-11-18-bot-visibility-analysis.md` | proven |

## Adding a row

After a run works repeatedly:

1. Add the row: the behaviour in one sentence, the script (or module), the report
   with its measurements, `proven`.
2. End the report with a **task proposal** (the template's slots) so the designer
   can promote it in one pass — the script is the executable spec.
3. When the designer drafts the task, set the row to `proposed`; when the coder's
   report lands, set `landed` and add the task number.
