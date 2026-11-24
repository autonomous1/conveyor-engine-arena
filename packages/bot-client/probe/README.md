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
