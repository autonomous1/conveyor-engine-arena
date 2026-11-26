# Bot-client probe harness

The live command suite and the prototype surface it runs. Tracked like the drivers
under `tests/`, but the harness is the one that drives the **proto** fork against a
live host; its trial table is data, and the prototype is the fork of `src/commands.ts`
that the coder later integrates (D15/D16).

| File | What it does |
|---|---|
| `command-suite.ts` | the 158 per-command, fresh-host suite: `--list` prints the menu from the trial table's `title` (starts nothing); `--test <id>` runs **exactly one** test — one build, one `npm start` host on `--port` (default 4175, auth on), one bot, or `--attach ws://127.0.0.1:4173` uses the operator's **running** host instead (no build, no spawn, never killed; the players present at join are allowed, a new player mid-trial marks the trial INVALID; artifacts say `HOST attach`; a teleport-to-pad that does not land while `snap` is flat aborts the run as `world frozen`, and a closed socket (`rs=3`) during a command fails the trial with `socket:closed` plus `SOCKET closed`, instead of skipping through the remaining trials); `--max-min <n>` caps a suite at n minutes (default 16; a full fresh-host run takes ~18–19, so use 22); a `--suite` on an attached host keeps **one session** for the whole run — one seat, a command host per trial, teleport to the pad before each trial — so the host does not forget the pawn's kit on close and `reload`/`hunt`/`abort` can run, the trial's preconditions and command through `./commands-prototype.ts` (the fork of `src/commands.ts`; a `SURFACE` line prints its sha256 and the harness refuses to import production), a 250 ms `snap`/`processed`/penetration trace, then a verdict and exit 0 (PASS/WARN, or a control that failed as designed) / 1 (FAIL or INVALID after one retry) / 2 (could not start or SKIP); on a **shared** host (`--attach`) a trial that starts off the pad first teleports its **own** pawn to the pad (`TELEPORT …`, qa scope; never another pawn) and records `start_pos`; a trial whose object the bot already holds is skipped (`skip:already-held:<id>`) and one whose object an earlier trial consumed is skipped (`skip:consumed:<id>`) instead of INVALID — `--test` exits 2, `--suite` reports `skip=n` and does not fail on it (use `--passes 1` for an attach suite); `--suite` runs 3 passes of the 14 positives + both controls (44 hosts). Per-trial verdict: result, 15 s hard / 3 s soft stall, ≥5 `replan stuck`, 5 cm penetration, 5 s net freeze, seat, dirty map, arm gate; every building **contact** is logged as `COLLIDE t=… box=… src=… at=…` (one line per episode) and counted in the row's `collision_count`/`collisions` — penetration >5 cm is still the fatal one; artifacts `158-test-<id>-<stamp>.*` / `158-suite-<stamp>.*`; the report is `plan/dsh-tasks/reports/158-test-<id>-<stamp>.md` |

## Tree switch

Every probe keeps its canonical `../src/…` imports; the runner decides which
tree they load from, so no probe source names a tree. `--tree src` (the default)
runs the production plumbing; `--tree proto` redirects imports that resolve into
`packages/bot-client/src/` to `packages/bot-client/proto/`, including proto's
own `./x.js` siblings. `../src/shared/…` is not redirected — the branch shares
the one contract. If `proto/` is absent the redirect does not fire and the probe
runs on `src/`.

```bash
npm run probe -- --tree proto command-suite.ts --list
npm run probe -- --tree proto command-suite.ts --test patrol --port 4175
```

`probe/tree.ts` is the self-check: it prints the resolved `connection.ts` URL and
exits non-zero if the wrong tree loaded.

## Ad-hoc coordinate (task 168)

`--goto-at x,y,z` runs **one** ad-hoc coordinate through 167's `gotoAt` command
on the suite's own fresh host, without a trial-table row and without a menu
entry. Three comma-separated finite numbers are required; `y` is parsed, logged
(`MENU choice=goto-at … y_ignored=1`), and then ignored — the handler plans
`stand:x,<pawn y>,z`, so the pawn's own floor always supplies the height. The
trial asserts arrival within 0.75 m of the given `x,z`, with the usual 250 ms
trace and row. Artifacts are named `168-goto-at-<x>_<z>-<stamp>.{log,ndjson,
trace.ndjson,summary.md}` unless `--label` overrides the base. Exit: 0 PASS/WARN,
1 FAIL, 2 cannot start / bad arguments / bad mode / SKIP (including any
`--goto-at` with `--test` or `--suite`). The trial table and `--list` are
unchanged by the flag.

## Shell (task 171)

`--shell [--seats n]` keeps **n** seats (1..4, default 1) open for a whole
conversation on one host: one `bot>` prompt, one `createCommandHost` per seat,
the command module from `--surface proto|probe` (default: `proto` in shell mode
when `proto/combat.ts` exists, else `probe`; an explicit `--surface probe` runs
the legacy pinned-pad copy), the plumbing from `--tree src|proto`. Unlike `--test`/`--goto-at`/`--suite`, the sessions are
not closed between commands — each pawn keeps its seat, kit, keys and ammo. The
start lists `SHELL seats=[1,2] selfs=[14,15] players=[14,15]` and one
`SHELL seat <i> self=… place=… weapon=… keys=…` per seat, then one
`SHELL team-seat=<i> self=<pawn> team=<a|b|->` per seat when the proto world
carries the host roster's teams (208). Piped stdin works (no
prompt); a TTY shows `bot> `, re-printed after any console line — a `SHELL
result`, a `status` dump, a collision line — coalesced per burst, so the prompt
is never left buried.

**`--shell` never builds `src/`.** The host is spawned from the existing `dist/` (`npm run build:server` is never run by the shell; `--build 1` is ignored and the log prints `BUILD skipped reason=shell-never-builds`). Build once yourself if `dist` is stale; `--test`/`--suite` still build because a fresh host needs a current dist.

Commands are `<seat> <verb> [args…]`, e.g. `1 goto-at -11.5,0,8.0`; a line
without a numeric seat is an error naming the seats. Dispatch is **not awaited**:
the prompt returns at once and the tagged `SHELL result seat=<i> …` prints when
the command ends; a second command on a busy seat prints `SHELL busy seat=<i>`.
Commands on different seats run concurrently. `q`/EOF drain the in-flight
commands (15 s cap) before closing; `abort`/Ctrl-C abort immediately.

| text | request |
|---|---|
| `<seat> arm` | `{name:"arm"}` |
| `<seat> goto <place>` | `{name:"goto",place}` |
| `<seat> stand <x,y,z[,yaw]>` | `{name:"stand",x,y,z[,yaw]}` |
| `<seat> path <x,y,z[,yaw]>` | `{name:"path",x,y,z[,yaw]}` |
| `<seat> goto-at <x,y,z>` | `{name:"gotoAt",x,z}` — `y` parsed and ignored |
| `<seat> walk <x,z> [<x,z> …]` | `{name:"walk",points:[{x,z},…]}` |
| `<seat> reload [crate]` | `{name:"reload"[,crate]}` |
| `<seat> hunt [minutes]` | `{name:"hunt",minutes,weapon:"laser"}` |
| `<seat> patrol <place,place,…> [minutes]` | `{name:"patrol",places,minutes}` |
| `<seat> retrieve <pickup\|@outside-ammo> [@place]` | `{name:"retrieve",pickup[,place]}` |
| `<seat> getkey` | `{name:"getkey"}` — the nearest available key |
| `<seat> arm` | `{name:"arm"}` — the nearest available weapon (one prop selector; no pinned id/pad) |
| `<seat> projectile [bands] [throws] [seconds]` | `{name:"projectile",…}` (parser defaults) |
| `<seat> seek-health <crate>` | `{name:"seekHealth",crate}` — combat (184's `survive`) |
| `<seat> take-cover` | `{name:"takeCover"}` — combat (`defend`, cover) |
| `<seat> return-fire <pawnId>` | `{name:"returnFire",pawnId}` — combat (`assault`) |
| `<seat> retreat <place>` | `{name:"retreat",place}` — a reach to the place |
| `<seat> reload` | `{name:"rearm"}` — **combat wins the collision**; legacy: `legacy reload` |
| `<seat> survive` / `<seat> defend` | `{name:"survive"}` / `{name:"defend"}` — combat goals (`defend` takes `[minutes] [radius]` and holds/fires as a posture) |
| `<seat> regroup <place>` | `{name:"regroup", place}` — anchor at 45 (not forced; combat orders pre-empt) |
| `<seat> assault <pawnId>` | `{name:"assault",pawnId}` — the assault goal (one plan; `hunt` stays the timed loop) |
| `help` / `seats` / `status [seat]` / `abort\|stop <seat\|all>` / `team <id> <verb>` / `q`\|`quit`\|`exit` / Ctrl-C / Ctrl-D | built-ins (unprefixed; `<seat> stop` also works) |

**Combat verbs and the override.** The combat table is checked **before** the legacy
switch, so the first match wins. The only collision is `reload`: the combat `rearm`
wins and the legacy handler stays reachable as `legacy reload` (`SHELL legacy reload`
then `name=reload`); `help` prints one row per name plus a `shadowed: reload` line.
Builtins are never shadowable. The handlers live in the **proto** command surface
(`proto/commands.ts`), so combat verbs need `--surface proto`; under the default
`--surface probe` the shell prints `SHELL combat surface=probe unavailable` at start
and rejects a combat verb with `why=surface-probe`.

The shell maps text only — the command module validates (`bad-args` comes from
`parseCommand`). `@outside-ammo` resolves at dispatch time through the suite's
`outsideAmmo(world)` per seat.

**Team selector (task 210).** `team <id> <verb> [args…]` resolves the **probe's**
seats whose pawn is on the host roster's team `<id>` — the `players` frame's
`teams` rows, carried by the proto world's `teamOf(id)` — then runs `<verb>
[args…]` on each member exactly as a hand-typed `<seat> <verb>` would (the same
`SHELL accepted seat=<i> …` / `SHELL result seat=<i> …` records). It prints
`SHELL team=<id> seats=[…] count=<n>` first; an empty team prints
`SHELL rejected team=<id> why=no-seat` and dispatches nothing. `status` and
`abort|stop` work as team verbs; any other built-in is
`SHELL rejected team=<id> why=builtin`. A missing id/verb is
`SHELL rejected team why=usage`. Under `--tree src` (no `teamOf`) it prints
`SHELL team=<id> why=no-teamof tree=src` and does nothing — the selector needs
the fork. It selects only the shell's own seats, never the operator's pawn.

A team-issued goal is **advisory** (D10): the shell dispatches each member with
`{claim:"advisory"}`, so every member acquires the host claim and acts without
waiting for another member's goal claim; a single-seat `<seat> <verb>` still
takes the default `claim:"goal"` and waits (the 211 control). While a team
`goto-at` is in flight the shell samples every member's distance to the target
at 4 Hz (`TEAM t=… seat=<i> d=…`) and stops when the last member returns.

**Console vs log.** The handler's own chatter (plan/start/finish, `hunt attack: …`
targets, `patrol plan …` legs, projectile traces) is written **only** to the run
log (`171-shell-<stamp>.log`), not echoed to the console. The console keeps the
shell's lines: `SHELL line`, `SHELL accepted seat=<i> name=<n> args=…` or
`SHELL rejected seat=<i> … why=<busy|unknown-verb|bad-args|no-seat>`, and the
`SHELL result seat=<i> name=<n> ok=… code=… why=… ms=…` when the command ends.
A long `hunt`/`patrol` therefore prints the accepted line and then stays quiet
until the result; `tail -f` the run log for the loop.

Logs: `SHELL start … seats=<n>`, per-seat lines,
`SHELL line=`, `SHELL result`, `SHELL exit reason=<q|ctrl-c|eof|session-closed>`,
then `SESSION close seat=<i>` per seat and `HOST kill`; artifacts
`171-shell-<stamp>.{log,summary.md}`. A seat's mid-session socket close drops
that seat (the others continue); when none remain the shell exits
`session-closed` (no reconnect). `--shell` conflicts with
`--test`/`--goto-at`/`--suite` (exit 2); `--seats` must be 1..3 (exit 2).

**Stop/abort.** `stop <seat|all>` (alias `abort`, and the seat-prefixed
`<seat> stop`/`<seat> abort`) aborts the seat's running command and sends a
zero-move input so the pawn halts where it stands; the result prints
`SHELL result … why=aborted` and the seat is idle again. It is cooperative: the
mission loop checks `onTick`, the arm's `standAtPoint` checks it, and the proto
branch's `walkWithRecovery`/`runAttack` now check `abortRequested` too (the
probe surface's stand and the branch's attack; the production `src` still has the
158 abort gap until the coder ports these). A `stop` during `arm` cuts the
crate-climb stall; if it lands before the weapon is in hand, the next `reload`
reports `not-armed` — retry `arm`.

**Wall-contact logging.** In shell mode the harness samples every seat's pawn
every 250 ms against the world AABBs (the suite's true-radius rule: penetration
at `radius - 5 cm`, contact at `radius`, pickup trigger boxes skipped) and
records `COLLIDE seat=<i> t=<s> box=<id> src=<source> at=<x,y,z>
phase=<attack phase> move=<forward|back|side|still> speed=<m/s>` per new box
contact (counted), and `CONTACT … from=<phase> to=<phase>` when the attack phase
changes while the pawn is still touching the same box (not counted, so a retreat
slide into the pursuit is visible without inflating the collision count). `phase` is the last
`attack:` handler line (`pursue`/`retreat`/`standoff`/`cover`/`no-plan`; `-` for
non-attack commands), `move` is the pawn's motion along its facing. `SHELL
collisions seat=<i> count=<n> pen=<m> phases=<phase:count,…>` prints on `status`
and at exit, so the forward vs retreat contacts are separable. `pen` counts
samples with >5 cm penetration; the `COLLIDE` count counts episodes, not ticks.
