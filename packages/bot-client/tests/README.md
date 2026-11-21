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
| `attack-run.ts` | the 5-minute loop: arm, reload as needed, camp the centre, one target at a time, re-plan on stall; `--for-s 300` |

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

## Link / mailbox

| Script | Use |
|---|---|
| `live-link.ts` | one persistent seat driven by a file mailbox: commands in `<dir>/inbox.ndjson`, events in `outbox.ndjson`, `status.json` every 250 ms; messages use the host `msg` frame (`to` = pawn id or `*`). One bot: `… live-link.ts --dir plan/dsh-tasks/live/122-link-a --label 122-link-a --name link-a`; two bots (operator spectating): a second instance with `122-link-b`/`link-b` |

## Read-only probes

`probe-*.ts` — state/geometry/A* checks (pawns, pickups, doors, grid, seats, health,
weapon). They connect, print, and close; no goals.
