# Operator Notes & Pipeline Philosophy

## Entry 11-18-2026 12:34 pm

## The Cascade Effect
You are working in a serial pipeline: Designer → Coder → Bot-Developer.
- A flawed task from the Designer costs the Coder time (they must halt and ask questions).
- A flawed implementation costs the Bot-Developer time (they must hunt the bug in the live environment).
- **Rule:** Spend the time upfront to verify symbols and invariants. A 10-minute analysis that prevents a 2-hour debugging loop is a net win.

## Avoiding Analysis Paralysis
- **Timeboxing:** If analysis for a single task exceeds [X minutes], stop. 
- **The Spike Protocol:** If the root cause is unknown or too complex to model statically, do not force a task. Instead, write a "Spike Task" for the Bot-Developer. 
  - *Spike format:* "Goal: Determine why the elevator door livelocks. Prototype required. Do not write production code. Return findings."

## Emergent Collaboration
You may read the other roles' specifications in the `agents/` directory. 
- The Designer should know the Coder's constraints (e.g., "no symbol names the generator cannot see").
- The Coder should know the Bot-Developer will test in the live match (so unit tests must mirror live conditions).
- The Bot-Developer should know the Coder needs clean, reproducible evidence.

## The "Ghost in the Machine" Protocol
If a task involves an ephemeral bug (race condition, intermittent collision, network desync):
- The Designer should write a narrow task that asks for telemetry logging first, before asking for a fix.
- The Coder should implement the telemetry.
- The Bot-Developer runs the live probe to capture the ghost, then hands the logs back to the Designer.

## Entry 11-18-2026 1:11 pm:

## Pipeline Topology: Two Flows, Not One
The pipeline is not strictly linear. There are two distinct workflows depending on the nature of the task:

1. **The Feature/Bugfix Flow:** Designer writes task → Coder implements in `src/` → Bot-Developer verifies in the live match.
2. **The Discovery/Spike Flow:** Bot-Developer prototypes the live gap → Designer formalizes the findings into a task → Coder ports it to `src/` with tests.

**Resolution Rule:** When there is disagreement about where a fix belongs, the spike belongs to the Bot-Developer, the production build belongs to the Coder, and the Operator has final judgment. The prototype is the executable spec; the Coder makes it production.

## Entry 11-18-2026 1:40 pm:

## The "Designer-Initiated Spike" (The Direct-to-Probe Flow)
The standard flow is Designer → Coder → Bot-Developer. However, there is a sanctioned exception:

- **When to use it:** The Designer encounters a problem that cannot be modeled statically (e.g., moving portals, ephemeral desyncs, nested spatial hierarchies) and lacks the empirical data to write a safe, narrow task for the Coder.
- **The Action:** The Designer may skip the Coder and write a **Spike Task** directly for the Bot-Developer.
- **Spike Task Requirements:** The Designer must specify the Goal, the exact hypothesis to test, the required telemetry (e.g., `PathReason`, 10Hz pose trace), and the boundaries (e.g., "Do not edit `src/`. Prototype in `plan/dsh-tasks/live/` only").
- **The Return:** The Bot-Developer returns the exact log evidence and a working prototype. The Designer then incorporates this into the Code Map / Decisions and writes the final implementation task for the Coder.

## Entry 11-18-2026 3:47 pm

## Environment — the prop guard (live arena)

## bot-developer environment needs to disable random wander bot effects on live arena
Wander bots pick up props, including the alien weapon and the key. A host that
has been up for a while has usually lost them, so a bot that joins late cannot
arm (`alien-weapon-1 present=false` → the attack mission exits `no_ammo`). The
operator therefore restarts the host to protect the weapon/key long enough for
the bot to arm.

**What the bot sees:** a restart closes its socket after welcome and the client
logs `[conn] session abort` (reconnect policy is `abort`, no retry). That is a
deliberate restart, not host instability — the bot stops, waits for "ready",
and takes a fresh session. Never retry into a restarting host.

**Run shape:** operator restarts → bot joins and arms immediately → the actual
test. If the bot joins and `alien-weapon-1` is already gone, do not chase it;
ask for a fresh map.

**Requested fix:** a "wander bots pick up props" option in the options
interface disables wander bots from changing the test environment (host/game side, covering both the weapon and the key).
