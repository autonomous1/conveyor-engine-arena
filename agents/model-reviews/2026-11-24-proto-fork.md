# Model review — the proto fork (2026-11-24)

## 1. Scope

Read: the operator's procedure (copy `packages/bot-client/src` → `proto`, edit
there, run probes live, iterate, publish the diff); the current prototype wiring
(`command-suite.ts` and `command-parity.ts` import `./commands-prototype.ts`);
`packages/bot-client/` (no `proto/`), `agents/bot-developer-role.md` (406 lines),
`agents/designer-role.md`, `agents/coder-role.md`, both task templates,
`agents/bot-kb.md`, `agents/decisions.md`.

Changed: the five briefs/templates above, `agents/decisions.md` (D18), and the same
content in `agent-alley`'s generic templates.

## 2. Findings

1. **The single-file prototype does not scale.** `commands-prototype.ts` is 73 KB
   duplicating the command surface, with every import re-threaded by hand; the
   harness then imports that file. A fork of `src/` gets every module, the real
   import graph and the real types for free, so prototype and production stay
   structurally comparable. Layer: role briefs. **Fixed: D18 + the fork procedure.**
2. **The procedure was not in the model.** Nothing named a `proto/` directory, and
   the task template's `Rapid prototype solution` slot named a "driver path" rather
   than a diff — so a fork-based POC would have had no place to cite. Layer: task
   template, designer/coder briefs. **Fixed.**
3. **The publish artifact was undefined.** The operator says "publish changes to
   designer/coder to integrate back into src"; the missing piece is the mechanical
   artifact. **Fixed: the published artifact is `logs/<task>-proto.diff`** from
   `git diff --no-index src proto`, with the runs table — the same pattern as the
   codemap delta (D5).
4. **No ignore rule.** `proto/` would show as untracked and be swept by a broad
   `git add`. `.gitignore` needs `packages/bot-client/proto/` — a repo-root change,
   outside this lane's write surface, so it is handed to the bot lane.

## 3. Edits

- `agents/bot-developer-role.md` — a **The proto fork** subsection under the craft:
  copy, edit only `proto/`, point the driver at `../proto/…`, iterate live, publish
  the diff and delete the fork.
- `agents/designer-role.md` — **the POC hand-off is the fork diff**; check the
  driver imports `../proto/…`, cite the diff and its base commit.
- `agents/coder-role.md` — **the prototype is a package fork**: the migration is
  the diff file by file, then switch the driver back to `../src/…` and delete
  `proto/`.
- `agents/task-template.md` — the `Rapid prototype solution` slot now names the
  published diff and the base commit.
- `agents/bot-task-template.md` — a run's script imports the fork, not the source.
- `agents/bot-kb.md` §6 — names the fork as the loop's workspace.
- `agents/decisions.md` — **D18**, with the single-file prototype as the
  counter-example.

Package (`agent-alley`): the same six edits in the generic templates; `npm run
verify` green (31 tests).

## 4. Task proposals

None. The follow-up is adoption, not a designer task: the bot lane starts the next
POC on `proto/`, and the `.gitignore` line is a one-line repo change.

## 5. Open loops

- **`.gitignore`**: add `packages/bot-client/proto/` (bot lane or operator).
- **The current drivers still import `./commands-prototype.ts`.** The fork migration
  replaces that file; until it does, two prototype mechanisms coexist.
- **`proto/` is scratch.** After a POC lands, delete it; a stale fork is a second
  source tree that will drift.
- **This procedure is the strongest skill candidate** (the `prototype-port` idea):
  it is cross-lane, rare enough not to sit in every brief, and now fully written
  down. If the bot-developer brief grows past ~450 lines, extract it as a skill
  with a mechanical trigger (the task's `Rapid prototype solution` line) rather
  than adding more prose there.

## 6. `modev` status

Arena: `modev:check` green (3 lints, 11 tests), `drift` clean, codemap up to date.
Package: `npm run verify` green (31 tests).

## 7. Task 165 — the tree switch (2026-11-24)

The coder landed task 165: `npm run probe -- --tree src|proto`,
`scripts/probe-tree-hook.mjs` redirecting `packages/bot-client/src/…` URLs to
`proto/…` under `--tree proto`, the `probe/tree.ts` self-check,
`test/probe-tree.test.ts`, the `probe` npm script, and `meta` gaining `^probe-`.
Verified in the report: both trees load the 16-trial menu, the self-check prints
`connection=…/proto/connection.ts`, a bogus tree exits 2, and a missing `proto/`
silently falls back to `src/`.

**Model effect.** D18's step "point the driver at it" is now wrong — probes keep
their canonical `../src/…` imports and the runner chooses the tree. Updated:
`bot-developer-role` (the six-step loop now says *switch, never rewire*, adds the
`probe tree=` and `SURFACE` lines and the silent-fallback trap); `designer-role`
(check the runs report `probe tree=proto`, not the driver's import); `coder-role`
(the parity run is `--tree src`, nothing rewired); `bot-kb` §6; `bot-task-template`;
**D18** rewritten. Package templates mirrored (31 tests green).

**Open.** The suite's surface is still `probe/commands-prototype.ts`: under
`--tree proto` its *dependencies* load from `proto/`, but `proto/commands.ts` is
only exercised once the suite's import is the canonical `../src/commands.ts`. Until
then a proto run is a hybrid — read the `SURFACE` line as well as `probe tree=`.

## 8. Proto is tracked, not scratch (2026-11-24, operator)

The operator reversed the scratch decision: "I actually want to track proto because
it could take several iterations to work something out." A POC can span sessions and
an untracked fork dies with the working tree; a tracked fork also lets the designer
diff `src` against it at any time.

Changed: the briefs and templates now say `proto/` is **tracked while the branch
lives**, and deleted in the commit that lands the port. D18 updated; no `.gitignore`
line (the fork is added to git). The current fork is an exact copy of `src/` — 11
modules, 4,823 lines, `diff -rq` clean — so this first commit is the baseline.

**Open.** `tsconfig.bot.json` includes only `src/`, so a tracked `proto/` is neither
typechecked nor built, and the codemap roots exclude it. If the fork lives long
enough to matter, a `tsconfig.proto.json` (or adding `proto/` to the bot project) is
the fix.
