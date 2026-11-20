# AGENTS.md — conveyor-engine-arena

Browser arena client + authoritative Node host for Conveyor Engine. The host ticks at 20 Hz and sends snapshots over a same-origin WebSocket; a Three.js client renders them.

**Repo:** ~/dev/conveyor-engine-arena. Run every command from this folder.

**Node version:** use `~/.nvm/versions/node/v24.0.2/bin/node`. PATH `node` is nvm v4.4.2, which can't run this repo. Start shell commands with `cd ~/dev/conveyor-engine-arena && export PATH=~/.nvm/versions/node/v24.0.2/bin:$PATH &&` so `node`, `npm` and `npx` are Node 24. Don't try other Node versions.

**Roles:** the role briefs are `agents/coder-role.md` (coder method and Pre-Flight/HALT contract), `agents/designer-role.md`, `agents/bot-developer-role.md`, and `agents/model-developer-role.md` (the model is a deliverable; a stale model costs a coder session; split a KB before it passes the read window); this file is the repo-wide rule set common to them. `src/shared/bots/goap.ts` is frozen unless the task explicitly requires a change.

**Read order for every task (hard stop)**
1. The task file the user named — only once.
2. This `agents/AGENTS.md` — already injected; do not re-read.
3. `agents/operator-notes.md` — the **Standing rules** at the top (the dated entries are history); apply the rules tagged for your role.
4. The KB sections named in the task's **Knowledge base** slot (only those sections; the KB is the map, not a field dump). Query them: `node packages/modev/cli.mjs query section <host|shared|client|file> <§N>`. `*-kb.md` is an index of the split; that is not a missing section. If the slot is missing or names no section, stop.
5. The task’s **Files table** paths (and only the line ranges / symbols it names).
6. **Symbol lookup:** `node packages/modev/cli.mjs query symbol <exact name>`, then open the source file it names. Never read `agents/codemap.md`.

**Query the model — never read the map**
`agents/codemap.md` and the KB files are inputs to `modev`; a session asks for one entry, not the document.
- **Symbol:** `node packages/modev/cli.mjs query symbol <exact name>` → `file:line`, signature, doc line, tags, calls, used-by. Open that source file and verify: the source is the truth, the codemap is the index.
- **Module:** `query file <path>` → imports, packages, used-by, and the symbol list.
- **KB section:** `query section <layer|file> <§N>` → exactly that section (`entity <Name>` stitches the §13.6 row).
- **Discovery** (no task, no Files table): the first search is `find <text>` (unknown name) or `query symbol <name>` (known name); open the file the query names. `rg` follows and is scoped to that file or directory; it is right for call sites, function-locals, `test/` and `packages/` (not in the codemap). A repo-wide `rg --include` sweep is the last resort — say what the query missed.
- `rg` stays for what the codemap does not index: call sites inside a function, function-locals, and the text of a file you are about to edit.
- Never open `agents/codemap.md` as a document — not at an offset, not scrolling, not for context. If the CLI is unavailable, make one exact `rg` in `codemap.md`, open the source it names, and say so in the report.
- **Freshness:** the codemap describes the last regeneration (normally `HEAD`). While you are editing, source outranks it — a symbol you are removing still appears, and one you are adding does not. Regenerate (`npm run codemap`) before reporting, then re-query.

**Do not read memory or skills**
dsh has no built-in memory directory. Its only always-on instruction surface is `AGENTS.md`: the project file and `~/.dsh/AGENTS.md` are already injected into the session. Skill bodies under `~/.dsh/skills/` and `<repo>/.dsh/skills/` are progressively disclosed — the catalog shows only name + description until the body is loaded. Both are cheap to leave alone:

- Do **not** re-read `~/.dsh/AGENTS.md` (or the project `AGENTS.md`) for “context”. It is already in the prompt. Re-reading adds noise, not information.
- Do **not** open a `SKILL.md` body unless this task names that skill. The catalog line is enough to decide.
- If a memory plugin is installed, do **not** call its tools (`mem_search`, `mem_pack`, `memory_*`) and do **not** read its state directories (`~/.dsh/memory*`, `~/.dsh/self-evolve`, plugin-configured paths). Auto-suggestions that open those paths are wrong — close them and stay on the Files table.
- Memory topics mix arena, packages, and blueprint-scene and derail narrow tasks. A loaded skill body does the same: it pulls the task toward its own workflow.
**Do not open other repos**
Do **not** open `../conveyor-engine-packages` or `../blueprint-scene` unless the Files table names a path there. “Do not change packages / blueprint-scene” also means do not read them to invent a design or to “match bake snippets”.

If the task sketches collision / movement / lights / input, implement **exactly** that sketch in the listed files. Do not rediscover behaviour by searching the kernel or sibling repos.

## Find code fast
- **Ask modev for the exact symbol** (`node packages/modev/cli.mjs query symbol <name>`); open the file it names and verify it there. Do not read the codemap first or use it for design.
- `rg` the source for a symbol modev does not know (function-locals, call sites inside a function), or to verify an entry.
- Regenerate with `npm run codemap` after adding, moving or renaming exports. `npm run codemap:check` exits 1 if it is stale. `node packages/modev/cli.mjs drift` reports a KB/codemap mismatch.

## Comment as contract
Comments carry what types cannot: *why*, *when*, and cross-call invariants. They are load-bearing, not decorative — the codemap extracts them and the per-task diff surfaces them. A stale comment is a bug.

**Module header.** Every module that exports more than one symbol opens with four labeled slots, one line each. Omit a slot rather than fill it with filler. `src/server/arena-host.ts` is the worked example.

// ARCHITECTURE: <what this module is for, one sentence>.
// Wiring: <who constructs it, who calls it, what it composes>.
// Order: <load/init invariants a refactor would break>.
// Invariants: <state that must hold across calls and is not typed>.

**Tag vocabulary (closed set — additions need a consumer).**
- `@invariant` — must remain true across calls. Pair with an explicit `(test: <name>)` reference to an existing test in `test/`, or defer with `(test lands …)` if the test is scheduled for a later task. Silence is a bug; `test/contract-grep.test.ts` enforces this.
- `@pre` / `@post` — contracts the type cannot express: call order, required prior action.
- `@why` — the non-obvious choice; the "looks wrong but isn't". Highest-value tag.
- `@when` — lifecycle: "set once `sceneGraphReady` resolves", "call before `take`".
- `@see` — cross-reference the codemap can link.
- `@internal` — excluded from the exported surface.

Do not tag `@param` / `@returns` when the signature already says it. Do not restate the types.

**KB row classifications.** The state-model tables (`host-model`/`client-kb`/`shared-model` §13) tag each row:
- `S` structural — a container or shape checkable from the declaration.
- `B` behavioral — a lifetime rule: one-shot, per-tick/snapshot/frame clear, monotonic, TTL.
- `X` cross-boundary — the state or reference crosses the host↔client↔shared boundary; the contract lives in `agents/shared-model.md`.
A candidate invariant is not an `@invariant` until a test or tag confirms it; then it moves to that layer's §12/§11 and the tag is added.

**Editorial rule: why and when, not how.** "How it works" duplicates the body and rots fastest. If the *how* is non-obvious, the fix is a named type, a helper, or a test — not a comment. The exception is *how to use it* (calling convention), which is `@pre` / `@when`.

**Tag on touch.** When a task edits a module, update that module's four-slot header (if it exports at least two symbols) and the tags on every new or changed export. Do not sweep untouched code or adjacent modules. Acceptance gate for every task that edits code: *codemap diff is reviewable and includes no unexplained comment churn*.

## Layout
- `src/server/` host: `main.ts` (HTTP + WS entry, serves `dist/web`), `game.ts` (wander loop, held inputs), `world-loader.ts`/`load-game.ts`/`game-manifest.ts` (manifest → world), `doors.ts`, `fire.ts`, `grenade.ts`, `pickups.ts`, `health.ts`, `host-path.ts`, `placements-file.ts`.
- `src/shared/` code used by both host and client: hitscan, look, movements, doors, pickups, health, grenade, audit, arena-view (what the client gets from the manifest).
- `src/client/` browser: `main.ts` (entry, bundled by esbuild), `net.ts` (WS link), `arena-scene.ts` (Three.js scene/loading), `input.ts`, `hud.ts`, `options.ts`, `scene-map.ts`, `presentation.ts`.
- `src/util/` map bake (`bake-map.ts`, run by `npm run bake:map`).
- `src/app.ts`, `src/run.ts`, `src/bench*.ts`: headless example app, scenarios and bench.
- `web/` static: `index.html`, `game/arena.game.json` (hand-edited manifest) + baked `*.placements.json`, `bounds.json`, `spawn-points.json`; `assets/models` GLBs.
- `dev/scenes/arena-1/` Inkscape designs and source models for the scene bake (`npm run bake:scene` → blueprint-scene).
- `packages/bot-client/` the bot lane: `connection.ts`, `world.ts`, `input.ts`, `cli.ts`, `brain.ts`, and the tracked drivers under `tests/`.
- `test/*.test.ts` node:test suites. `scripts/` build-client, bake and helper scripts.

## Commands
- Test: `npm test` (`node --import ./scripts/ts-ext-register.mjs --test test/*.test.ts`, on Node 24.0.2, which strips types). Keep the `--import`. `src/` imports siblings as `.js`, and that hook maps them to `.ts` while tests run in place. A deploy check runs this same `npm test`, not a bare `node --test`.
- Scoped (per task): `npm run test:scope nav,bot` or `npm run test:related -- <files>`. The full `npm test` is still the gate: every push/PR and every two hours via the CI schedule.
- Typecheck: `npm run typecheck` (server, client and util tsconfigs).
- Build: `npm run build` (server via `tsc -p tsconfig.server.json` → `dist/`, client via esbuild → `dist/web/client.js`). Run: `npm start` (http://127.0.0.1:4173, `PORT` overrides).
- Scene bake: `npm run bake:scene`. Codemap: `npm run codemap`.
- Model queries: `node packages/modev/cli.mjs query symbol|file|section|entity …`, `find`, `drift`, `stats` (`packages/modev/README.md`).

## Rules
- **Do not change the kernel** (`conveyor-engine-*` packages from conveyor-engine-packages). Work around it in the arena; if a kernel change seems needed, stop and describe it.
- Server-authoritative: clients send inputs only; gameplay rules live on the host or in `src/shared/`.
- Source is ESM, strict TS. Server/shared imports use `.js` extensions (Node16 resolution).
- Add or update tests in `test/` for behavior changes; run the scoped command from the task's Test scope slot (`npm run test:scope …` or `test:related`) and `npm run typecheck`. The full `npm test` is the merge gate (push/PR and every two hours), not the per-task loop.
