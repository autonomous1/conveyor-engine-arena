# Bottom-Up profiling suite

CPU profiles of the **arena host** (Node) and the **solo client** (host + client in one Chrome tab), reduced to
DevTools-style **Bottom-Up** tables (self time / total time per function and per file), plus a **compare** tool for
diffing two builds. It is not part of `npm test` and has **no npm dependencies** (Node ≥ 22.18: it uses the global
`WebSocket`, `node:inspector`, and the repo's own `esbuild` to bundle the scripted player).

```
profiling/
  profile-host.mjs     host scenarios: wander | stationary | moving
  profile-client.mjs   solo client scenarios: idle | moving (headless, --headed, or --attach <port>)
  run-all.mjs          host + client for one build -> results/<sha>/
  analyze.mjs          any .cpuprofile (e.g. saved from DevTools) -> summary JSON + markdown
  callers.mjs          drill into one hot function: its callers (like expanding a Bottom-Up row)
  compare.mjs          baseline vs current (files or result dirs) -> markdown with flagged regressions
  lib/                 CDP client, Bottom-Up analysis, source-map reader, host runner, page probe
```

## Install

Unzip at the repo root so the folder sits at `conveyor-engine-arena/profiling/`. Nothing to `npm install`.
Add `profiling/results/` to `.gitignore` (a `profiling/.gitignore` is included). Build first: `npm run build`
(the host needs `dist/server/`, the client needs `dist/solo/`). No bake is required.

## Run

```bash
npm run build
node profiling/run-all.mjs                    # host (3 scenarios) + headless client (2) -> profiling/results/<sha>/
node profiling/profile-host.mjs --scenario moving --duration 30
node profiling/profile-client.mjs --scenario idle,moving
node profiling/compare.mjs profiling/results/<old-sha> profiling/results/<new-sha> --out compare.md
```

Defaults: host warmup 5 s, client warmup 8 s (after the canvas is up and frames are flowing), 30 s recording,
500 µs sampling interval. The label is `git rev-parse --short HEAD` (`-dirty` if `src/`, `packages/` or `scripts/`
have uncommitted changes); override with `--label`.

### Host scenarios (`profile-host.mjs`)

The host runs `dist/server/main.js` → `startArenaServer()` in a child process (auth off, 127.0.0.1, random port).
The CPU profile is taken in that process with `node:inspector`, so the driver and the players are **not** in it.

| scenario | what runs |
|---|---|
| `wander` | the game's own NPC wander loop only (fixed scene = installed `web/game`) |
| `stationary` | + `--players N` (default 1) scripted players joined, sending zero-move input at 20 Hz |
| `moving` | + players walking a fixed WASD-style pattern (forward/back every 6 s, strafe bursts, yaw sweep) |

Players use the build's own `packages/bot-client/src/connection.ts` (`connectBot`), bundled per build into
`.profiling-tmp/player.mjs`, so the protocol always matches the build under test (add `.profiling-tmp/` to `.gitignore`).

Host metrics: `tickMs` (duration of each 50 ms `setInterval` tick, measured by wrapping that timer), `tickGapMs`
(tick-to-tick spacing; > 50 means late ticks), `ticksPerSec`, `cpuPctOneCore` (process CPU incl. GC/IO threads and
the sampler), event-loop delay, RSS.

### Client scenarios (`profile-client.mjs`)

Serves `dist/solo` on 127.0.0.1, opens a tab over raw CDP, injects a probe before the page scripts, and records with
`Profiler.start/stop`. The tab joins as a player (solo), so `idle` = joined and standing still; `moving` drives WASD
through `Input.dispatchKeyEvent` (no pointer lock needed).

Client metrics: `frameMs`/`fps` (rAF deltas), `framesOver33ms`, `hostTickMs` (the in-tab host's 50 ms tick, same
wrapper as above), long tasks, `mainThreadTaskPct`/`scriptPct` (Performance.getMetrics), JS heap, and
`processCpuPct.<type>` (CPU of Chrome's browser / renderer / GPU processes from `SystemInfo.getProcessInfo` —
this matches what the system monitor shows).

Modes:

- **headless** (default): `--headless=new` with SwiftShader WebGL at 960x540. Good for JS Bottom-Up shares of
  game/host code; **frame times and GPU/renderer CPU are not representative** (software rendering). SwiftShader decodes
  compressed textures in software (one `compressedTexSubImage2D` took 5 minutes on a test box), so headless hides the
  compressed-texture extensions (`*_compressed_texture_*`, `EXT_texture_compression_*`) and KTX2 textures are transcoded to RGBA instead; `--compressed-textures` keeps them.
- **`--headed`**: launches a visible Chrome with a temp profile (needs a display).
- **`--attach <port>`**: use your regular Chrome with the real GPU. Start it yourself:

  ```bash
  google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/arena-prof-chrome --no-first-run
  node profiling/profile-client.mjs --attach 9222          # opens its own window/tab, closes only that tab
  ```

  Recent Chrome refuses remote debugging on the default profile, hence `--user-data-dir`. Keep the window visible
  (hidden tabs throttle rAF), close other tabs, and keep the same window size between runs (`--width/--height`
  apply to the new window). `processCpuPct.*` then covers the whole attached browser.

Before the warmup the driver waits for rendering to settle (HUD past "loading arena", then two 2 s windows with no shader compiles and no frame > 1 s, at
most `--settle-max 120` s), so texture uploads and shader compiles stay out of the recording. A watchdog closes Chrome
if a scenario overruns.

Other flags: `--chrome <path>` (or `CHROME_PATH`), `--url <http://…>` (profile an already-served build),
`--query "noclip=1"`, `--width 1280 --height 720`, `--sample-us 500`, `--no-profile-file`.

Client names come from `dist/solo/client.js.map` (esbuild minifies the bundle): the original file:line is mapped and the
function name is read from the original source, so keys like `floorHeight src/shared/movements.ts` match the host's.

## Reports

Each run writes `<kind>-<scenario>.cpuprofile` (open in DevTools → Performance → Load profile, or in
VS Code), `.summary.json` and `.md`. The markdown has metrics, self time by category (`arena`, `engine` =
`conveyor-engine-*`, `three`, `node`, `native`, `(garbage collector)`, `(program)`; `(idle)` and the profiler's own
cost are separated), the **top 30 functions by self time**, top functions by total time and self time by file.

Two percentages are reported:

- **% busy** — share of non-idle samples. This is the number to compare: it doesn't move when the machine is just
  more or less idle, and it is what Bottom-Up shows after you deselect `(idle)`.
- **% rec** — share of the whole recording, which is what DevTools Bottom-Up shows by default.

Function keys are `name + file` (line shown for info; anonymous functions keep the line in the key), so a function that
only moved lines still matches between builds.

## Drill-down

```bash
node profiling/callers.mjs profiling/results/<sha>/host-moving.cpuprofile decodeFrame --depth 4
node profiling/callers.mjs profiling/results/<sha>/client-idle.cpuprofile floorHeight --solo-root dist/solo
```

## Compare

```bash
node profiling/compare.mjs <baseline.summary.json|dir> <current.summary.json|dir> [--out file.md]
     [--threshold-pp 2] [--ratio 1.5] [--min-pct 1] [--metric-ratio 1.5] [--top 25] [--fail-on-regress]
```

Directories are matched by `<kind>-<scenario>`. Per scenario: metric table with p95 ratio, category deltas, biggest
self % increases/decreases, new hot functions, per-file deltas, and flags. A function is flagged when its self % busy
rises by ≥ 2 percentage points, or by ≥ 1.5x while ≥ 1%; tick/frame/CPU metrics are flagged at ≥ 1.5x p95. Exit code
is 0 unless `--fail-on-regress` (then 2).

Noise: run each build 2–3 times (`run-all.mjs --repeat 3` writes `run1..3`) and treat deltas under ~1–2 pp as
noise. Compare runs from the same machine and mode; across machines use only the % busy columns.

## Optional `package.json` scripts

```json
"profile:host": "node profiling/profile-host.mjs",
"profile:client": "node profiling/profile-client.mjs",
"profile:all": "node profiling/run-all.mjs",
"profile:compare": "node profiling/compare.mjs"
```

e.g. `npm run profile:client -- --attach 9222`, `npm run profile:compare -- profiling/results/a profiling/results/b`.

## Comparing two commits without touching your working tree

```bash
git worktree add --detach ../prof-a <old-sha> && (cd ../prof-a && npm ci && npm run build)
git worktree add --detach ../prof-b <new-sha> && (cd ../prof-b && npm ci && npm run build)
node profiling/run-all.mjs --root ../prof-a --out profiling/results/a
node profiling/run-all.mjs --root ../prof-b --out profiling/results/b
node profiling/compare.mjs profiling/results/a profiling/results/b --out profiling/results/compare-a-b.md
```

The suite itself can live in the current checkout; `--root` points it at the build to profile.
