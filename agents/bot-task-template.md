# Bot task NN — <the question this run answers, imperative>

Read `~/dev/conveyor-engine-arena/agents/bot-developer-role.md` first. Then this file. Then the task's **Knowledge base** sections (host §… / client §… / shared §2–§3 and §11; the state model is §13 in `host-model`/`client-kb`/`shared-model`; `*-kb.md` is the index, name the half) — query them with `node packages/modev/cli.mjs query section <layer> <§N>`. Then the bot session's code only for the symbols in Files.

**Prohibitions:** `agents/AGENTS.md` (memory/skills, sibling repos); the run's evidence is the live log + this file.
**Artifacts:** every log, trace, capture, and diff goes under `plan/dsh-tasks/logs/` (`<NN>-<what>.log`, `<NN>-trace.json`); the analysis/report under `plan/dsh-tasks/reports/`. Never the repo root. The report links the exact paths.
**Safety:** one long-lived session per trial; clean `close()`; wait before any retry; never more than one bot in the arena while the operator is playing; never target the operator's pawn. Leftover seats are the known cause of `SERVER_FULL` and the stale-pawn confusion (task 49).

> **This is a run/prototype, not a code change.** The bot-developer measures, diagnoses, and recommends; the coder implements.
> Write the run's script under `packages/bot-client/tests/<name>.ts` — tracked and reviewable; the **Files** table names it. The script implements the behaviour itself: it imports the plumbing (connect,
> socket, world), never the behaviour under test (`createCommandHost`, `runMission`)
> — a driver that imports those is a **production probe**, not a prototype. It is a
> rough probe, not a module: when it works repeatedly and the runs table shows it, the script plus its measurements is a **proof-of-concept for the designer**, who drafts the production task from it; the coder builds that. `plan/dsh-tasks/live/` is gitignored and is for raw captures only. A code change you discover goes in the report as a recommended task, with the evidence line that justifies it.

## Question

<The one hypothesis the run resolves, and the decision it informs. Make it falsifiable: “does X happen when Y”, “before A / after B”. If there is no decision, there is no task.>

**Knowledge base:** <the KB file(s) and section(s) this run depends on, with the reason: `agents/host-flow.md` §…, `agents/host-model.md` §…, `agents/client-kb.md` §…, `agents/shared-flow.md` §2–§3 and `agents/shared-model.md` §11; the lane itself is `agents/bot-kb.md` §13. Name one half, not both. Query them with `node packages/modev/cli.mjs query section <layer> <§N>` before the run; the slot is the entry point, not the limit — query any further section the run needs. Do not edit the KB; the report's mechanism fit may cite them. If this slot is missing or names no section, stop.>

## Setup

- **Host:** <the droplet `arena.tszakacs.com` / the local host; why>.
- **Auth/token:** <the bot token/scope; the operator's role — spectator or the third seat; the seats in use>.
- **Sessions:** <names, count, the same token; the clean-close rule>.
- **Scenario / order:** <the exact mission(s), the place, the target id, the arm-up; the timeout>.
- **Operator:** <watching as spectator/player; what they should look for; the map/3D>.

## Instrumentation

<The recorder and the log lines; the metrics (per shot/second, hp before/after, distance/LOS, seat/pawn state, plan ms, tick p99); the exact artifact paths; the format. If a metric is not logged, the conclusion cannot use it.>

## Baseline / comparison

<The previous result this run compares to (the 37 result: 73.5 m duplicate, 2.43 m separation; the 43 dump; the 49 seat probe); the change under test; the expected direction.>

## Evidence

<The observables that make the run a success or failure, stated before the run: the specific log line, the health frame, the seat count, the plan steps, the trace field. Also the “no run” outcome: if the scenario does not occur in the timebox, that is a result, not a failure.>

## Report

<The report must contain: the timeline (t, actor, event, detail); the metrics table; the findings (numbered, each with a log/trace line); the mechanism fit (which explanation the evidence supports and which it does not); the **POC hand-off** (script path, the migration analysis — ordered operations, constants/guards and the live-loop fix each encodes — what production must preserve, the failure modes, the open questions) addressed to the designer; the recommendation (the next coder task or “no change”). The report is the deliverable, not the chat.>

## Safety and abort

<The stop conditions: the timebox; the dump not captured; the host down; the operator leaves; the bot dies/reconnects; the stale seat. The abort action: close cleanly, record the last log line, do not retry in a loop.>

## Out of scope

<The code changes (the coder's); the other scenarios; the kernel; the host restarts; the long-running soak.>

## Files (read only these)

| File | Repo | Use |
|---|---|---|
| `~/dev/conveyor-engine-arena/agents/bot-developer-role.md` | conveyor-engine-arena | Read-only. The operator brief. |
| `agents/<layer>-{flow,model}.md` or `agents/client-kb.md` | conveyor-engine-arena | Read-only. The §… named in Knowledge base (one row per file the run reads); `*-kb.md` is the split's index page. |
| <the bot session/CLI file> | conveyor-engine-arena | Read-only. The commands and the log fields. |
| <the host/arena file> | conveyor-engine-arena | Read-only. The accept path, the seat rule. |
| `packages/bot-client/tests/<name>.ts` | conveyor-engine-arena | **New.** The run's script (tracked, reviewable). |
| `plan/dsh-tasks/logs/<NN>-*` | conveyor-engine-arena | **New.** The raw evidence. |
| `plan/dsh-tasks/reports/<NN>-<slug>.md` | conveyor-engine-arena | **New.** The report. |

## Appendix: the exact commands and the log format

```bash
# the setup and the run; the token path; the operator's spectator state
# the recorder; the metrics; the cleanup
```

The log lines the report quotes verbatim (one per metric family): `<format>`.
