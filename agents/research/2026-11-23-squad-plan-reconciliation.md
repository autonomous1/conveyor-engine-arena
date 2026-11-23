# Squad plan reconciliation — response to the bot-developer's review

| | |
|---|---|
| **Question** | Does the bot-developer's review of `2026-11-22-squad-commander.md` hold against the tree, and what is the one plan both documents should point at? |
| **Decision it informs** | The order of the first tasks: M1 now, M2 now, M3 before arena-2, L0 in parallel; and the two corrections each side owes the other. |
| **Timebox** | 40 min (spent ~35). |
| **Window** | 2026-11-23 11:36 → 12:15 America/New_York. |
| **Tree** | HEAD `c9dd5ce` plus a dirty working tree (the `path` command, the 152 fix, and the parity driver are uncommitted). |
| **Rev** | 2 — updated after the review's §9 answers (the 186 s freeze is real; my first read was wrong). |
| **Read** | `plan/dsh-tasks/reports/2026-11-23-squad-prototyping-review.md`, `live-2026-11-23-standat-goal-fix.md`, `live-2026-11-22-freeze-split.md`, `live-2026-11-22-patrol-freeze-spike.md`, `live-2026-11-22-projectile-5min.md`, `live-2026-11-22-projectile-command.md`, current `commands.ts`/`command-parity.ts`. |

## Verdict

Accepted. The review is right on all four operational points that matter — 11 commands with `path` untested, the
152 point-walk change, the 147 freeze as a measured hazard, and the P0 gate being 4 sessions with a threshold — and its
M1→M4 ordering is the right shape. I owe it three corrections to my earlier docs; it owed me two citation fixes, of
which **one is withdrawn** (the 186 s freeze is real — my miss, see §3.1; the review has already corrected its §3 to
cite the right report) and one stands (the commit split, now in §6a). Both documents should now point at **one** phase
table because three renamings (P0–P4, L0–L1, M1–M4) have accumulated in two days. The review's §9 accepts the other
three points in full.

## 1. Claims re-measured today (`verified locally`)

| Review claim | Tree evidence | Verdict |
|---|---|---|
| The vocabulary is 11, not 10 | `CommandName` at `commands.ts:29` includes `path`; `path: {x,y,z,yaw?}` at `:38`; `pathHandler` at `:454` builds `stand:x,y,z` | **true**, my doc is stale |
| `path` is the router-walk and `stand` is wishTo | `pathHandler` → `runMissionTask(missionText,"path")`; `standHandler` keeps `walkWithRecovery` | **true** |
| `path` has no live run | no live report names `path`; `command-parity.ts` is modified, not committed | **true**, evidence is working-tree |
| The parity driver now runs 11 + failures + a `snap/processed` freeze guard | `m10 path` `:113`, `m11 projectile` `:116`, `FREEZE stale=5s …` `:159` | **true**, uncommitted |
| 152 tally 25 kills / 101 shots / 0 deaths, armed 12.8 s | `live-2026-11-23-standat-goal-fix.md:215-222` | **true** |
| 147 freeze: 2 of 6 patrol runs, `stale=0`, `processed` flat | `live-2026-11-22-freeze-split.md:23`, table `R5 B` and `R8 A`; plus `live-2026-11-22-projectile-5min.md:118-128` §9 | **true**; the 147 windows are **24.3 s** and **28.7 s**, and there is a **third occurrence of 186.3 s** (pose `-22.05,8.34`, `t=108.2→300.3`, 3,725 stuck samples) in the projectile run |
| `projectile` proven (16 fired, 7 kills) | `live-2026-11-22-projectile-5min.md:29` — 300.7 s, 16 fired, 12 hits, 7 kills, 2 self-kills | **true** |
| 3 seats today; P0 is the largest allowed | `loadArena()`: 13 npc + 3 player | **true** |

## 2. Three corrections to my earlier docs

1. **Vocabulary.** `2026-11-22-squad-commander.md` §3/§6 says ten commands; it is **eleven** (`path` is the missing
   one), and `path` is the point-walk the commander should prefer. `2026-11-22-arena-2-two-halls.md` §7 inherits the
   same count and is corrected by this note.
2. **Point-walk choice.** The commander's vocabulary carries **both**: `path` for a routed point (plan + grid
   follower), `stand` for a cheap straight stop inside 1–2 m (132's wishTo, which collides on a wall). Default for
   squad orders: `path`; `stand` only for a face-and-stop.
3. **P0 is a bandwidth/tick spike, not a squad rehearsal.** 4 sessions (2 seats + 2 spectate), and it needs the
   threshold the review asks for. My proposal: **p95 host tick ≤ 45 ms of the 50 ms frame**, plus a delta rule — abort
   if p95 at 4 sessions exceeds **1.5× the 1-session baseline** even when under 45 ms. The operator confirms the
   number; the baseline is measured in the same run.

## 3. Corrections to the review (one withdrawn)

1. ~~The freeze window is 24–29 s, not 24–186 s.~~ **My correction was wrong; the review's 186 s is real.** It is the
   projectile run's §9: pose `-22.05,8.34`, `t=108.2 → 300.3` (**186.3 s**), `snap`/`processed` flat, `stale=0`,
   3,725 stuck samples, socket open (`live-2026-11-22-projectile-5min.md:118-128`). The mistake was mine: I checked only
   the two freeze-named reports and concluded "typo" instead of searching every live report. The hazard is therefore
   **24–186 s across at least three occurrences in two reports**, and the review's §3 now states both numbers correctly.
2. **M3 does not need the coder's queue.** A driver-local `Map<number, CommandRequest[]>` is enough for the 3-seat
   prototype: the queue is a data structure, not a module. With 3 seats today and an unseated commander, **M3 can run on
   arena-1 before L0**. That moves the commander prototype off the arena-2 critical path and de-risks C1 earlier.
   (The coder's `squad/queue.ts` still lands later; it is the production form, not the prerequisite.)

Also worth recording: `command-parity.ts` and the `path`/152 changes are **uncommitted** — M1's baseline must be
committed before a coder task cites it, or the evidence has no HEAD.

## 4. The one plan (supersedes the phase names in both docs)

| # | Phase | Owner | Gate |
|---|---|---|---|
| **M1** | command matrix: 11 commands + failure modes (`bad-args`, `wrong-floor`, `unknown-task`, `stuck`, `aborted`), `snap/processed/stale` guard; ~5 min, 1 seat | bot-developer | every command returns its designed result; no freeze; matrix committed |
| **M2** | capacity: 2 seated + 2 spectate × 60 s; p95 tick, bytes/session, `SERVER_FULL`, freezes per session; 1-session baseline first | bot-developer | p95 ≤ 45 ms **and** ≤ 1.5× baseline, no seat error, no frozen session counted |
| **M3** | commander prototype on **arena-1**: 3 seats + unseated commander, driver-local queue, roster, roles, 2 Hz status + enemy scan, regroup-first ladder | bot-developer + operator | a 3-bot squad regroups and follows one order chain twice, no seat leak |
| **L0** | arena-2: Inkscape layers → bake → `arenas/arena-2/web/game`, 16 pods 8+8, 16 weapons/ammo/keys, locked doors, `ARENA_GAME_ROOT` | operator | `loadArena()` acceptance (§5 of the arena-2 doc) |
| **M4** | 16-bot roster on arena-2: 8 vs 8, 2 unseated commanders, arena-aware `arm`/`reload`/`attack {target}` | bot-developer + operator | every order acked; both squads leave their halls; concentration measured |
| **C1** | port the proven loop: `squad/queue.ts`, `squad/commander.ts`, `attack`, place-aware gear commands, claim modes | designer → coder | task cites the M3/M4 reports |
| **C2** | per-seat respawn; any command that survives M4 | coder | typecheck + scoped tests |
| **L1** | two-team live run with the shipped interface | bot-developer | order completion + concentration at 16 sessions; 147 freeze under a retry policy |

## 5. Answers to the review's questions

1. **Seats:** M1 uses 1; M2 uses 2, operator **observes** (pad free); M3 uses **3** plus one unseated commander (the
   third seat is the commander's squad third — or leave it free and run 2). Confirmed pattern: the operator observes
   unless a run needs a human.
2. **Tick threshold:** p95 **≤ 45 ms** at 20 Hz for 4 sessions, plus the **1.5× baseline** delta rule; if either fails,
   split by squad (one process per squad). Name a different number and it replaces both.
3. **`stand` vs `path`:** both, as §2 above — `path` default for routed points, `stand` for a short stop. The commander
   exposes `path`; the vocabulary keeps `stand` because a cover step is often 1 m.
4. **Commander visibility:** **unseated** (operator confirmed 2026-11-22, and the review defaults to it). It never
   consumes a seat, a claim, or a pawn.

## 6. The freeze as a gate, not a footnote

M2 and M3 must log `snap/processed/stale` per session and treat a frozen session as **retried, not counted**. The 186.3 s occurrence changes the weight of this: a freeze can begin at t=1.4 s or t=6.2 s and eat 64 % of a
300 s run, so it can hit a **60 s** capacity spike too. Consequence for the plan: a frozen session invalidates the
capacity number (retry, do not average), and **the 147 fix becomes a prerequisite for M3 onward**, not only L1 — a
designer task (host/client defect, not a prototype change). M1 can still run: its CHECK guard detects the freeze and
the matrix reports it as a finding rather than a command failure.

## 6a. The commit split (review §9.5)

The review is right that a clean M1 baseline needs a commit. Recommended split, in this order:

1. **Coder/operator commit 152 + 155/156** (`brain.ts`, `commands.ts`, `missions.ts`, `connection.ts`) — this is the
   source M1 measures.
2. **Bot-developer commits `command-parity.ts`, `scenarios/attack-5min.ndjson`, the README/POCS rows** as one
   tests-only commit, on top of (1).
3. **M1 runs on that HEAD** and its report names both SHAs (`git log -2 --format=%h`), not "the dirty tree".

If (1) cannot happen today, M1 may run on the dirty tree, but the report must paste `git status --porcelain` and the
`git diff` hash of the source files; a coder task must not cite that baseline without the commit.

## 7. Open questions

1. ~~Where does the 186 s figure come from?~~ **Answered by the review:** it is `live-2026-11-22-projectile-5min.md`
   §9 (186.3 s); the 147 report's windows are 24.3 s and 28.7 s. No open question here.
2. **Does the operator confirm 45 ms / 1.5×?** Both numbers are proposals; the alternative is a fixed "no session
   above 2× the 1-session p95".
3. **Does `path` replace `stand` in the commander's ladder entirely?** M3 decides from the trace: if `stand` never wins
   a cover step, drop it from the squad vocabulary.
4. **Where does the M1 matrix live after commit?** `packages/bot-client/tests/command-parity.ts` is the right home;
   its report should name the commit sha so C1 can cite a stable baseline.

## 8. Confidence legend

`verified locally` — every row of §1 re-measured today. `inferred` — the 1.5× baseline rule (no 4-session run yet).
`documented externally` — none; this is an internal reconciliation.
