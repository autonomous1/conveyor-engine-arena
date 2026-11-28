# `packages/bot-client` — the bot client, the probe shell, and the proto loop

The bot client is the arena's bot player: it connects a bot to the host with a
token, builds an arena model from the welcome and frames, and runs a brain
(GOAP) that plans, walks, opens doors, picks up, fights, and reports. The
package also carries the **live probe harness** that drives it and the **tracked
proto fork** where behaviour is prototyped before it reaches production.

Two trees hold the same client:

- **`src/`** — the production client, the **coder's** migration output. The
  probe imports `../src/…`; `--tree src` runs it.
- **`proto/`** — a tracked copy of `src/`, the **bot-developer's** workspace.
  `--tree proto` redirects the probe's imports here; this is the rapid loop.

The probe source never names a tree. The runner decides (see §3).

## Layout

| Path | What it is |
|---|---|
| `src/` | The production bot client: `connection.ts` (WS, hello/auth, claims/input senders), `world.ts` (the arena model), `brain.ts` (the executor), `commands.ts` (the command host), `missions.ts`, `input.ts`, `mailbox.ts`, `predict.ts`, `cli.ts` (the `ce-bot` CLI), `index.ts`. Built to `dist/ce-bot.mjs` by `npm run build:bot`. **Coder's lane.** |
| `proto/` | The tracked fork of `src/` — the bot-developer's rapid workspace. The coder never edits it; the operator re-syncs it from `src/` after a migration; it is never deleted. |
| `probe/` | The live harness: `run.mjs` (the tree switch), `command-suite.ts` (the per-command suite **and** the `--shell`), `commands-prototype.ts` (the legacy pinned copy), `tree.ts` (the tree self-check), `pickup-trap.ts` (an offline chain driver), and `README.md` (the full surface). |
| `tests/` | The older tracked live drivers plus `POCS.md` — the POC ledger — and `README.md`. |
| `dist/` | The built client (`ce-bot.mjs`). Generated; the probes themselves need no build (Node strips types). |

## Prerequisites

- **Node** `~/.nvm/versions/node/v24.0.2/bin` on `PATH` (the repo's Node 24). Run
  everything from the repo root.
- **The operator's host** at `ws://127.0.0.1:4173` with auth on. The host is the
  operator's; this lane never starts, replaces, or kills it. If `/arena.json`
  does not answer, stop and tell the operator.
- **The host's `dist/`** is the operator's/coder's. **Never run `npm run build`**
  — it writes the same `dist/` the coder's scoped tests build and read. The
  probes run TypeScript directly.

## 1. Host keys and the QA token

The host gates joins with Ed25519 access tokens (signed JWTs; the full auth
contract is in the root [`README.md`](../../README.md#authentication)). The
keypair and issued tokens live **outside** the repo, under
`~/.config/ce-arena/` by default. The token CLI runs from the built server, so
the operator (or the coder) must have a current `dist/`; this lane does not
build it.

### Host keypair

```bash
# from the repo root, with a built dist/server/auth/token-cli.js
npm run token -- keygen
# or: npm run token -- keygen --out ~/.config/ce-arena/ed25519
```

This writes `<prefix>.key.pem` (PKCS8) and `<prefix>.pub.pem` (SPKI), both mode
`0600`. The **private** key mints tokens; the **public** key only verifies.
Environment: `ARENA_CONFIG_DIR` (default `~/.config/ce-arena`),
`ARENA_SIGNING_KEY_FILE` (mint; default `$ARENA_CONFIG_DIR/ed25519.key.pem`),
`ARENA_VERIFY_KEY_FILE` (host; no default — required when auth is on), and
`ARENA_REVOKED_FILE` (default `$ARENA_CONFIG_DIR/revoked.json`). Point the host at
the public file:

```bash
ARENA_AUTH=required \
ARENA_VERIFY_KEY_FILE=~/.config/ce-arena/ed25519.pub.pem \
npm start
```

`ARENA_AUTH=required` is the exact value that turns the hello gate on (anything
else is off). The host refuses to start with `ARENA_AUTH=required` and no
`ARENA_VERIFY_KEY_FILE`. `/arena.json` then reports `"authRequired": true`, and
the host logs `[auth] ok sub=… role=…` for accepted joins. The operator owns
this host and its restarts.

### The QA token

The bot lane uses `role: qa`. The QA defaults are `play`, `spectate`,
`scene-graph`, `qa`; the probe additionally needs:

- **`chat`** — the host's claim gate (`src/server/claims.ts`) admits claim frames
  only for a token with `chat` (or auth off). Without it, goal/door claims are
  rejected and the team work silently stalls. Chat itself is not implemented;
  the scope is kept for the gate.
- **`teleport`** — only if a trial uses the suite's `TELEPORT` (the `--test` /
  `--suite` start-pad teleport, which moves **its own** pawn). The shell's
  `<seat> goto-at` and `stand` do not need it. The standing policy is: **never
  teleport unless the operator explicitly asks**, even when the token carries
  the scope.

```bash
npm run token -- mint --role qa --sub qa-1 \
  --scope chat,teleport --hours 12 \
  --out ~/.config/ce-arena/qa-token.pem
```

- `--scope` **adds** to the role defaults; it never removes one.
- `--out` writes mode `0600`; without it the JWT prints to stdout.
- The file is a **raw JWT** despite the `.pem` name. Never copy it into the repo.
- `--hours 12` / `--days N` set the lifetime (default 30 days); both cannot be
  combined.
- `npm run token -- list` prints the issued records (`issued.jsonl`) and their
  revocation state; `npm run token -- revoke <jti>` revokes one.

The probe reads the token from `CE_TOKEN` (the token string, not a path) or,
when unset, from `~/.config/ce-arena/qa-token.pem`. The CLI (`ce-bot connect`,
`ce-bot run`) also takes `--token-file` and `--role qa`; the `--role` must match
the token's role, not a preference. The shell derives the role from the token.

### Checks before a run

1. `/arena.json` answers and, when auth is on, says `"authRequired": true`.
2. The token file is the QA token (role `qa`; scopes include `scene-graph` and
   `chat`). Without `scene-graph` the scene graph never arrives and the brain
   cannot plan.
3. No stray session holds a seat. The host's free pawns bound the shell's
   seats; a leftover bot causes `SERVER_FULL` on the next join.

## 2. The probe shell

The shell keeps **n** seats open for a whole conversation on one host: one
`createCommandHost` per seat, a `bot>` prompt, and the pawns keep their seat,
weapon, keys, and ammo between commands. It attaches to the operator's host —
no build, no server spawn, no kill.

```bash
cd ~/dev/conveyor-engine-arena && export PATH=~/.nvm/versions/node/v24.0.2/bin:$PATH

CE_TOKEN="$(cat ~/.config/ce-arena/qa-token.pem)" \
  npm run probe -- --tree proto command-suite.ts --shell --seats 7 \
    --attach ws://127.0.0.1:4173 --label my-run
```

- `--tree proto` runs the fork; `--tree src` runs production (the default).
- `--attach` uses the running host. The runner prints `probe tree=proto …` and
  the shell prints `SHELL start … host=attach`.
- `--seats` accepts 1..16; the host's free pawns bound it. The operator's usual
  host roster is 8 pawns (the operator + 7 shell seats), so `--seats 7`; `8`
  only works when the operator is not holding a pawn. A failed seat prints
  `SHELL seat <i> failed why=SERVER_FULL` and the shell continues with the rest.
- `--label <name>` names the artifact base; otherwise the shell writes
  `plan/dsh-tasks/logs/171-shell-<stamp>.{log,summary.md}`.
- The command module (`--surface proto|probe`) defaults to `proto` when
  `proto/combat.ts` exists. Combat verbs (`reload`→`rearm`, `survive`, `defend`,
  `assault`, …) need the proto surface; `legacy reload` keeps the old handler.

### Reading the start

```
SHELL seats=[1,2,3,4,5,6,7] selfs=[10,…] players=[9,…] operator=9
SHELL team-seat=1 self=10 team=a
…
```

- `operator=` is the shell's non-shell player (the human's pawn); the team
  leader/rank excludes it.
- `team-seat=` lines exist when the proto world carries the host roster's teams.
  The shell then has a `team` selector (below).

### At the prompt

A command is `<seat> <verb> [args…]`. Dispatch is not awaited: the prompt
returns, and a tagged `SHELL result seat=<i> name=<n> ok=… code=… why=… ms=…`
prints when it ends. A busy seat prints `SHELL busy seat=<i>`.

| text | request |
|---|---|
| `<seat> arm` / `reload [crate]` / `getkey` | arm the nearest available weapon / refill ammo / take the nearest key |
| `<seat> goto <place>` / `stand <x,y,z[,yaw]>` / `path <x,y,z[,yaw]>` | reach a place / point stand / plan a point |
| `<seat> goto-at <x,y,z>` | ad-hoc point (y parsed and ignored; the pawn's floor supplies height) |
| `<seat> walk <x,z> [<x,z> …]` | raw waypoints |
| `<seat> patrol <place,…> [minutes]` / `hunt [minutes]` | the timed loops |
| `<seat> retrieve <pickup\|@outside-ammo> [@place]` | pick up an item |
| `<seat> projectile [bands] [throws] [seconds]` | the grenade aim/trace |
| `<seat> seek-health <crate>` / `take-cover` / `return-fire <pawnId>` / `retreat <place>` | combat (184's vocabulary) |
| `<seat> survive` / `defend [minutes] [radius]` / `assault <pawnId>` / `regroup <place>` | the combat/goal posture verbs |
| `status [seat]` | the packed status (`place`, `hp`, `dead`, `weapon`, `ammo`, `pos`, `task`, `last`) and the collision counts |
| `seats` / `help` / `abort\|stop <seat\|all>` / `q`\|`quit`\|`exit` / Ctrl-C / Ctrl-D | built-ins |

The full verb/argument surface, the legacy `probe` mode, and every trial id are
in [`probe/README.md`](probe/README.md).

### Team selector (needs `--tree proto`)

`team <id> <verb> [args…]` resolves the shell's seats whose pawn is on the host
roster's team `<id>` (the `players` frame's `teams`, carried by the proto world's
`teamOf(id)`), then runs `<verb>` on each exactly as a hand-typed `<seat> <verb>`
would. It prints `SHELL team=<id> seats=[…] count=<n>` first; an empty team is
`SHELL rejected team=<id> why=no-seat`; a built-in is
`SHELL rejected team=<id> why=builtin`. It selects only the shell's seats, never
the operator's pawn. A team order is **advisory**: each member acquires and acts
without waiting on another member's goal claim.

```text
team b arm
team a goto-at 47.63,0,-13.44
team b reload
```

### Console vs run log

The handler's chatter (`plan start`, `plan done`, `start …`, `replan …`,
`finish …`, the attack/patrol lines) is written **only** to the run log, not the
console. The console keeps the shell's `SHELL` lines plus anything the bot writes
to stdout (a probe's `console.log`, e.g. `TrapProbe …`). To keep both, pipe the
run:

```bash
CE_TOKEN="$(cat ~/.config/ce-arena/qa-token.pem)" \
  npm run probe -- --tree proto command-suite.ts --shell --seats 7 \
    --attach ws://127.0.0.1:4173 --label my-run 2>&1 | tee /tmp/my-run-console.log
```

A long `hunt`/`patrol` prints the accepted line and stays quiet until the
result — `tail -f` the run log for the loop.

### Other probe modes

| mode | use |
|---|---|
| `--list` | print the trial menu (starts nothing) |
| `--test <id>` | one fresh-host trial: one build, one spawned host, one bot; `--attach` uses the running host instead; `--no-build` reuses `dist/` |
| `--suite` | 3 passes of the positive trials + both controls; one session on an attached host |
| `--goto-at x,y,z` | one ad-hoc point through `gotoAt` on the suite's own host |
| `--tree src\|proto` | which client tree the probe loads; `--tree proto tree` is the self-check |
| `--surface proto\|probe` | the command module (`proto` for the combat/team verbs) |

`--shell` and `--goto-at` never build. `--test`/`--suite` spawn a host and
therefore build by default; on an operator host use `--attach` (or `--no-build`
against a current `dist/`). A run that reports `probe tree=src` is production;
`tree=proto` is the fork. Exit codes: the suite `0` PASS/WARN, `1` FAIL/INVALID,
`2` cannot start/SKIP; the bot's mission/handler codes are `0` met, `1`
handler/usage failure (bad args, busy), `2` no plan (including the attack's
refused/lost/no-ammo), `3` timeout, `4` auth/seat — those are the `code=` in a
`SHELL result`.

## 3. Rapid prototyping: `proto/` vs `src/`, and the loop

### The two trees

- **`src/`** is the product. The coder owns it; a behaviour change lands there
  only with tests and review. The probe's canonical imports are `../src/…`; the
  default `--tree src` runs it.
- **`proto/`** is a tracked copy of `src/` and the **bot-developer's** edit
  surface. Copy once (`cp -r packages/bot-client/src packages/bot-client/proto`),
  then edit only `proto/`. The fork's internal imports are relative, so it runs
  as-is; it may import `src/shared/**` (the shared plumbing/contract) but never
  `src/**` (the behaviour under test).
- **The tree switch.** `npm run probe -- --tree proto …` redirects every
  `packages/bot-client/src/…` import to the matching `proto/…` file **when that
  file exists**; `src/shared/…` is never redirected (one contract for both
  trees). The probe source never names a tree. Verify the switch before trusting
  a run: `npm run probe -- --tree proto tree` prints the resolved
  `connection.ts`, and every run prints its `probe tree=` line.
- **The lifecycle.** The fork is tracked for the life of the lane and never
  deleted. After the coder's migration, the **operator** copies `src/` back over
  `proto/` so the next POC starts from the new base. The bot-developer does not
  commit/push the fork; the operator does.

### The loop

1. **Task.** The designer writes a bot task (the template in
   [`agents/task-template.md`](../../agents/task-template.md)); its Files table
   bounds the edits. Read the task, the KB sections it names, the POC ledger,
   and the prior driver for the behaviour.
2. **Prototype.** Edit `proto/` (and a driver under `probe/` or `tests/`). Keep
   it rough and inline; the behaviour under test is written in the prototype,
   not imported from `src/`.
3. **Run live.** Against the operator's host, with the operator's `GO` for the
   trial: a shell session, a `--test`, or a small driver. One variable per
   trial; sample the world and the brain log.
4. **Measure.** A runs table (start, goal, outcome, elapsed, failures) in
   `plan/dsh-tasks/reports/live-<date>-<slug>.md`, the raw logs under
   `plan/dsh-tasks/logs/`, and any proven behaviour as a row in
   [`tests/POCS.md`](tests/POCS.md).
5. **Publish the diff, not the tree.**
   ```bash
   git diff --no-index packages/bot-client/src packages/bot-client/proto \
     > plan/dsh-tasks/logs/<task>-proto.diff
   ```
   The report's POC hand-off gives the script, the runs, the exact evidence,
   the migration analysis (ordered operations, constants, guards), and the task
   proposal. That package is the **executable spec**.
6. **Migrate.** The designer drafts the coder task from the POC; the coder
   integrates the diff into `src/` with the fail-first test and the scoped run.
   Then the bot-developer re-runs the same scenario with `--tree src` — the
   driver is the control — and the operator re-syncs `src/` → `proto/`.

### The lanes, in one line

The **bot-developer** writes `proto/`, `probe/`, the drivers under `tests/`, the
`POCS.md` row, and the live reports — **never** `src/`, the repo `src/`, or
`test/`. The **coder** writes `src/` and `test/`. The **operator** owns the host,
the token, the runs, and the `src/` → `proto/` re-sync. The shared contract
(`src/shared/**`) is read-only for both bot lanes.

## References

- [`probe/README.md`](probe/README.md) — the full suite/shell surface, the tree
  switch, the artifacts, and every trial id.
- [`tests/README.md`](tests/README.md) — the older tracked drivers.
- [`tests/POCS.md`](tests/POCS.md) — the POC ledger (`proven` / `proposed` /
  `landed`); read it before prototyping a behaviour again.
- [`agents/bot-developer-role.md`](../../agents/bot-developer-role.md) — the
  method, the lanes, the live-run protocol.
- [`agents/task-template.md`](../../agents/task-template.md) — the coder task
  the designer drafts from a POC.
- [`README.md`](../../README.md#authentication) — the host auth/token contract in
  full (keys, env, roles, scopes, revocation).
