# AGENTS.md — conveyor-engine-arena

Browser arena client + authoritative Node host for Conveyor Engine. The host ticks at 20 Hz and sends snapshots over a same-origin WebSocket; a Three.js client renders them.

**Repo:** /home/tim/dev/conveyor-engine-arena. Run every command from this folder.

**Node version:** use `/home/tim/.nvm/versions/node/v24.0.2/bin/node`. PATH `node` is nvm v4.4.2, which can't run this repo. Start shell commands with `cd /home/tim/dev/conveyor-engine-arena && export PATH=/home/tim/.nvm/versions/node/v24.0.2/bin:$PATH &&` so `node`, `npm` and `npx` are Node 24. Don't try other Node versions.

**Read order for every task (hard stop)**
1. The task file the user named — only once.
2. This `agents/AGENTS.md` — only once.
3. The task’s **Files table** paths (and only the line ranges / symbols it names).
4. `agents/codemap.md` — **symbol lookup only** (see below). Never open it first. Never re-read it for “context”.

**Codemap is an index, not a document**
- Allowed: one `rg`/search for an **exact** symbol or filename from the Files table (e.g. `compileGame`, `loadArenaVisuals`, `readManifestSources`). Jump to that line; read that symbol’s entry and the file path it names; open **that source file**.
- Forbidden: opening `codemap.md` at a random offset; scrolling; reading multiple chunks; searching vague words (`lights`, `hash`, `scene`); using codemap to decide design; opening it more than twice in one task.
- If the Files table already names the file and symbol, open the source file directly. Skip codemap.

**Do not read memory**
Do **not** read `~/.grok/memory-v2/`, `~/.grok/memory/`, `~/.grok/bundled/skills/` (unless the task names a skill), or any other Grok memory / topic / skill file during a task. Auto-suggestions that open those files are wrong — close them and stay on the Files table. Memory topics mix arena, packages, and blueprint-scene and derail narrow tasks.

**Do not open other repos**
Do **not** open `../conveyor-engine-packages` or `../blueprint-scene` unless the Files table names a path there. “Do not change packages / blueprint-scene” also means do not read them to invent a design or to “match bake snippets”.

If the task sketches collision / movement / lights / input, implement **exactly** that sketch in the listed files. Do not rediscover behaviour by searching the kernel or sibling repos.

## Find code fast
- **Before searching, read `agents/codemap.md`.** Look up symbols in its **Symbol index**: each line is the name in backticks, then `file:line kind`, so `grep -n 'createDoorBlockers' agents/codemap.md` finds it in one step. Each module section lists `imports`, `used by`, and exported signatures.
- Grep the source only when the codemap doesn't answer the question (for example, local helpers or call sites inside a function).
- Regenerate with `npm run codemap` after adding, moving or renaming exports. `npm run codemap:check` exits 1 if it is stale.

## Layout
- `src/server/` host: `main.ts` (HTTP + WS entry, serves `dist/web`), `game.ts` (wander loop, held inputs), `world-loader.ts`/`load-game.ts`/`game-manifest.ts` (manifest → world), `doors.ts`, `fire.ts`, `grenade.ts`, `pickups.ts`, `health.ts`, `host-path.ts`, `placements-file.ts`.
- `src/shared/` code used by both host and client: hitscan, look, movements, doors, pickups, health, grenade, audit, arena-view (what the client gets from the manifest).
- `src/client/` browser: `main.ts` (entry, bundled by esbuild), `net.ts` (WS link), `arena-scene.ts` (Three.js scene/loading), `input.ts`, `hud.ts`, `options.ts`, `scene-map.ts`, `presentation.ts`.
- `src/util/` map bake (`bake-map.ts`, run by `npm run bake:map`).
- `src/app.ts`, `src/run.ts`, `src/bench*.ts`: headless example app, scenarios and bench.
- `web/` static: `index.html`, `game/arena.game.json` (hand-edited manifest) + baked `*.placements.json`, `bounds.json`, `spawn-points.json`; `assets/models` GLBs.
- `dev/scenes/arena-1/` Inkscape designs and source models for the scene bake (`npm run bake:scene` → blueprint-scene).
- `test/*.test.ts` node:test suites. `scripts/` build-client, bake and helper scripts.

## Commands
- Test: `npm test` (`node --import ./scripts/ts-ext-register.mjs --test test/*.test.ts`, on Node 24.0.2, which strips types). Keep the `--import`. `src/` imports siblings as `.js`, and that hook maps them to `.ts` while tests run in place. A deploy check runs this same `npm test`, not a bare `node --test`.
- Typecheck: `npm run typecheck` (server, client and util tsconfigs).
- Build: `npm run build` (server via `tsc -p tsconfig.server.json` → `dist/`, client via esbuild → `dist/web/client.js`). Run: `npm start` (http://127.0.0.1:4173, `PORT` overrides).
- Scene bake: `npm run bake:scene`. Codemap: `npm run codemap`.

## Rules
- **Do not change the kernel** (`conveyor-engine-*` packages from conveyor-engine-packages). Work around it in the arena; if a kernel change seems needed, stop and describe it.
- Server-authoritative: clients send inputs only; gameplay rules live on the host or in `src/shared/`.
- Source is ESM, strict TS. Server/shared imports use `.js` extensions (Node16 resolution).
- Add or update tests in `test/` for behavior changes; run `npm test` and `npm run typecheck` before finishing.
