# Model review — build ownership (2026-11-25)

## 1. Scope

Read: `agents/bot-developer-role.md` (the environment/connect list, the journal
item 6, the permissions section), `agents/bot-task-template.md`,
`packages/bot-client/probe/command-suite.ts` (the build path), and
`packages/bot-client/probe/README.md`.

Changed: `agents/bot-developer-role.md`, `agents/bot-task-template.md`,
`agents/decisions.md` (D19), and the package templates.

## 2. Findings

1. **The bot lane built into the coder's artifact.** `command-suite.ts:74` sets
   `BUILD = true` unless `--no-build` or `--attach`, and `:224-226` runs
   `npm run build:server`; the README documents "one build, one `npm start` host".
   The coder's scoped runner builds and reads the same `dist/`, so two builds
   interleave and leave a half-written tree — the coder's gate then flakes on code
   nobody changed. Layer: role brief + template. **Fixed: the no-build rule.**
2. **The role instructed the collision.** The permissions section said bot source
   edits are "still prototype-grade; rebuild, start a fresh session"; the journal
   item said "diff summary, rebuild, re-test". Both told the lane to run the build
   that D19 now forbids. **Fixed: both lines now say `--no-build`/`--attach`, and a
   bot-source edit asks the operator to rebuild.**
3. **No owner was recorded for `dist/`.** D8 splits the lanes, D16 the prototype,
   D18 the fork — none says who writes the build output. **Fixed: D19.**

## 3. Edits

- `agents/bot-developer-role.md` — a **Never build** bullet in the environment list:
  `dist/` is shared with the coder's scoped tests; use `--attach` or `--no-build`;
  a needed build is the operator's, or a worktree; probes need no build (Node strips
  types).
- `agents/bot-developer-role.md` — journal item 6 and the bot-source-edit
  permission no longer say "rebuild".
- `agents/bot-task-template.md` — a **Build** line in the preamble, next to Safety.
- `agents/decisions.md` — **D19**: the build output is the coder's; the bot lane
  attaches or uses `--no-build`.
- Package templates mirrored (`bot-developer-role`, `bot-task-template`);
  `npm run verify` green (31 tests).

## 4. Task proposals

None. One code follow-up is worth a bot-lane task (see open loops), but it is not
required for the rule to hold.

## 5. Open loops

- **The suite default is now mode-dependent** (bot-lane fix, 2026-11-25):
  `--shell` never builds unless `--build 1`; `--test`/`--suite` still build unless
  `--no-build`/`--attach`. Those two modes therefore remain discipline-enforced —
  flipping their default too would make D19 mechanical. Bot lane.
- The orchestration report (`plan/…/live-2026-11-24-orchestration-collisions.md`)
  should gain an eleventh guarantee: **`dist/` is a single shared artifact; only the
  coder builds it.** The report is untracked, so this belongs in the next tracked
  summary.
- `/dist` is also written by `npm run build` in CI and by `npm start` setup; the
  rule is about concurrent sessions, not one-at-a-time builds.

## 6. `modev` status

Arena: `modev:check` green (3 lints, 11 tests), `drift` clean.
Package: `npm run verify` green (31 tests).
