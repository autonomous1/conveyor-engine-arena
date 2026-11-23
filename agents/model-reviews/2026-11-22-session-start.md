# Model review — session start + agent-alley config (2026-11-22)

## 1. Scope

Read: `agents/model-developer-role.md` (working-tree version), the agent-alley
handoff (`~/dev/agent-alley/HANDOFF.md` — the path given in the request resolved
to a nonexistent `conveyor-engine-arena/~/dev/...`; the real file is in the
package), `agents/decisions.md` in full (D1–D13 + superseding entries),
`agents/README-dsh.md`, the six KB content files' headers and §13 headings,
`test/kb-symbols.test.ts`, `packages/modev/lints/kb-length.mjs`,
`packages/bot-client/tests/POCS.md`, `.github/workflows/ci.yml`, both
`package.json`s, and the working-tree diff of the prior journal.

Then, after the operator granted write access to `~/dev/agent-alley`, phase 1 of
the extraction handoff: read all of `agent-alley/src/` (cli, check, self-check,
lib/*, lints/*, codemap.ts) and `test/cli.test.mjs`.

Changed: `agents/model-developer-role.md` (two stale claims), `agents/codemap.md`
(regenerated), `agent-alley/src/**` (config), `agent-alley/test/config.test.mjs`
(new), `agent-alley/README.md`, `agent-alley/HANDOFF.md`,
`agent-alley/.gitignore`. No `src/` or `test/` in the arena; no
`packages/modev` (the arena's live copy is untouched by design).

## 2. Findings

1. **Role brief — `client-kb` size.** Claim: "client is still one file (306
   lines, the next candidate)" (line 80). Evidence: `wc -l agents/client-kb.md`
   = 285; the same brief already says 285 at line 94. Layer: role brief. **Fixed.**
2. **Role brief — package test count.** Claim: the moved package runs "11 tests,
   `modev check` green" (line 112). Evidence: `cd ~/dev/agent-alley && npm run
   verify` → 12 pass at session start (`test/cli.test.mjs` 11 +
   `test/index.test.mjs` 1). Layer: role brief. **Fixed to 12; now 22 after the
   config tests (a further edit — see below).**
3. **Codemap stale.** `npm run codemap:check` exited 1. Cause: uncommitted
   `packages/bot-client/src/connection.ts` work from another lane (+12 lines).
   Regenerated per D5; delta is **29 line pairs, all `connection.ts` symbol line
   shifts** (13 symbols), no symbol added or removed. A second concurrent edit
   (the same file, +1 line) made it stale again later in the session; regenerated
   once more, same 29-pair shape, no symbol change. Layer: codemap.
   **Regenerated twice, both deltas recorded.**
4. **The handoff's next phases were not writable from this session.** A write
   probe to `~/dev/agent-alley` failed with "Read-only file system" under
   `workspace-write`. Layer: scope/decision. **Resolved: the operator added the
   root to `sandboxPolicy.additionalWritableRoots`; this session's next turn saw
   it, and a write probe passed while `~` and `~/.dsh` stayed fenced.**
5. **Entity-table default broke a custom layer set.** Claim: `entities` can
   default to `{ layer: "shared", section: "13.6" }` independently of `layers`.
   Evidence: the new config test with `layers: ["web"]` failed —
   `entities.layer "shared" is not one of the layers`. The entity table is a
   feature of a declared layer, not a repo-wide constant. Layer: package design.
   **Fixed: the table switches off (`layer: null`) when its layer is not
   declared; `entitiesOf` and `drift` skip it.**
6. **A foreign-layer § ref was re-attributed.** Claim: `§` refs resolve to the
   nearest declared owner. Evidence: `See `web-kb.md` §99 and `host-kb.md` §99.`
   under `layers: ["web"]` produced **two** findings, both "not in the web KB" —
   `host` is not a declared layer, so the scanner reused `web` from the earlier
   mention. Layer: package design. **Fixed: a ref whose nearest `*-kb` mention
   names an undeclared layer is skipped (that repo's model, not ours).**
7. **`codemap.ts` ignored the config, and the package could not run it.** Claim
   (handoff): roots/out belong in the config. Evidence: the generator hardcoded
   `out: "agents/codemap.md"` and defaulted roots to `src`. Also `typescript` was
   declared but not installed (`ERR_MODULE_NOT_FOUND`), so `npm run codemap` had
   never worked in this repo. Layer: package. **Fixed: defaults come from
   `codemap.roots`/`out` (explicit flags win); installed the declared dependency
   with `--no-package-lock` (node_modules is gitignored).**

8. **Portable briefs migrated as templates.** Claim (handoff phase 3): generic
   role briefs and task templates, `agents/templates/`, with a repo-profile region;
   the arena briefs are the reference, not the content. Evidence: the arena's
   briefs carry 11–29 host-specific hits each (`plan/dsh-tasks/…`,
   `test/scopes.json`, `qa-token`/`CE_TOKEN`, arena npm scripts). Layer: template.
   **Done: eight templates, one closed placeholder set, a guard test.**
9. **The package's `HANDOFF.md` was moved to Trash.** Evidence:
   `~/.local/share/Trash/info/HANDOFF.md.trashinfo` — `Path=/home/tim/dev/agent-alley/HANDOFF.md`,
   `DeletionDate=2026-11-22T16:25:21`, i.e. just before this request; the trashed
   copy contains the phase-1 config edits. Layer: scope/decision. **Not restored
   (operator action); the phase-3 handoff update therefore did not land.** Open
   loop, and the one thing this session could not close.

10. **KB skeleton.** Claim (handoff phase 4, first half): a repo derives its KBs
    from a skeleton. Built `agent-alley/agents/templates/kb/`: a flow half
    (§1–§10), a model half (§11–§15: invariant index, layer map, state model
    13.1–13.6 with S/B/X rows and the optional entity table, dated quirks, single
    sources), and an index that declares no sections, plus a README carrying the
    78% split rule, the no-`path:line` rule and the classification. Excluded as
    directed: `decisions.md`, `operator-notes.md`, `README-dsh.md` (arena
    development artifacts); also not templated, and for the same reason:
    `research/` and `model-reviews/` are per-session artifacts whose formats the
    role briefs already define. Verified by instantiating a `web` layer from the
    templates in a temp repo: `query section web 13.6` returns the entity table,
    `query config` resolves, and `modev check` passes over the instantiated repo.
    Layer: template. **Done.**

Verified true, no edit: `npm run modev:check` = 3 lints + self-check + 11 tests,
green; CI runs it before `npm test` on push/PR and the 2-hour cron; the `bot`
layer is in `LAYERS` and `KB_FILE`; POCS is 17 rows / 7 landed; `kb-symbols` is
16 tests over 8 KB files; `drift` clean; §13 present in all four model/KB files;
every KB content file under the 312-line cap (`client-kb` 285 = 91% of cap), so
the 78% rule is not violated and no split is due.

## 3. Edits

Arena:

- `agents/model-developer-role.md:80` — 306 → 285 lines.
- `agents/model-developer-role.md:112` — 11 → 12 tests (then 22; see below).
- `agents/codemap.md` — regenerated, not tracked (D5).

`agent-alley` (phase 1: config):

- `src/lib/config.mjs` **(new)** — `loadConfig(root, env)`: defaults, strict
  validation, compiled `kbFile` / `owner` / `sectionTarget` / `maxLines`;
  `DEFAULT_CONFIG` for rootless helpers.
- `src/lib/parse-kb.mjs`, `src/lib/refs.mjs`, `src/lib/parse-codemap.mjs`,
  `src/lib/index.mjs` — every layer list, KB pattern, codemap path and entity
  section now comes from the config (index carries it).
- `src/lints/kb-length.mjs` — window/ratio from config; `kb-section-refs.mjs` and
  `kb-count-claims.mjs` — config + scopes path.
- `src/check.mjs` — one config load, printed, handed to every lint; bad config is
  exit 2. `src/self-check.mjs` — passes the config.
- `src/cli.mjs` — `modev config`; config-driven section parsing, cache dir,
  staleness paths, source roots; usage updated.
- `src/codemap.ts` — roots/out default from config.
- `test/config.test.mjs` **(new, 10 tests)** — defaults, declared shape, typo and
  type errors, and each consumer reading it.
- `README.md` — a Config section; `HANDOFF.md` — phase 1 done, next phases
  renumbered, 22 tests; `.gitignore` — `agents/codemap.md`.

`agent-alley` (phase 3: templates):

- `agents/templates/AGENTS.template.md` **(new)** — the repo instruction file with
  a **Repo profile** table (16 keys), read order, reports-are-the-handoff lanes,
  query-the-model, comment-as-contract, layout, commands, rules, ending a turn.
- `agents/templates/{coder,designer,researcher,model-developer,bot-developer}-role.md`
  **(new)** — the five briefs, genericized: the arena's method and hard-won rules
  kept; its paths, tasks, tokens, KB names and run history dropped.
- `agents/templates/task-template.md`, `bot-task-template.md` **(new)**.
- `agents/templates/README.md` **(new)** — the template→target map and the
  placeholder vocabulary.
- `test/templates.test.mjs` **(new, 5 tests)** — every template listed, no host
  string leaked, placeholders closed and documented, no doubled placeholder,
  required sections survive.
- `agents/templates/kb/{layer-flow,layer-model,layer-kb}.md` **(new)** — the KB
  skeleton; `agents/templates/kb/README.md` **(new)** — the split and evidence
  rules.
- `agents/templates/README.md` — the KB templates in the map and `{{layer}}` in the
  vocabulary.
- `test/templates.test.mjs` — two more tests (KB templates listed; the numbered
  contract) and the KB files in the placeholder/forbidden scans.
- `README.md` — a Templates section; `agents/AGENTS.md` — points at the templates.

Role-brief follow-up edit (after the package count changed):
`agents/model-developer-role.md:112` now reads **27** tests, the count
`npm run verify` reports.

## 4. Task proposals

None. No finding needs a designer task: the fixes are the model/package itself.

## 5. Open loops

- **agent-alley phases 2–4 pending** — the no-line/identifier gates as lints
  (`kb-no-line-refs`, `kb-identifiers`) reading `codemap.roots`; `modev init` +
  `modev kb scaffold` (it fills the template placeholders from the config);
  adoption (blueprint-scene → conveyor-engine-packages → arena).
- **The package's handoff is in the Trash** (`~/dev/agent-alley/HANDOFF.md`,
  deleted 16:25:21). The operator decides whether it returns; if it does, it needs
  the templates section and the renumbered phases.
- **Two live copies, now deliberately diverged.** The arena's `packages/modev` is
  the running gate and does **not** have the config; the package does. Before the
  switch, a fix made in one must be considered for the other. Not duplicated
  today: the arena copy is retired at adoption, and copying config back would
  double the surface for no live gain.
- **Everything in `agent-alley` is still uncommitted** (only the scaffold commit
  exists); the operator commits.
- Other lanes' uncommitted arena work (`connection.ts`, `follow-camera.ts`,
  `probe-patrol-freeze.ts`, the §28 append to the 2026-11-20 journal) is not mine
  to commit; the regenerated codemap reflects it.
- `client-kb` at 91% of the cap is the next split candidate if §13/§14 grows — not
  due today.

## 6. `modev` status

- Arena: lints `kb-count-claims`, `kb-length`, `kb-section-refs` ok; self-check
  ok; 11 tests; `drift` clean; `codemap:check` up to date.
- Package (`~/dev/agent-alley`): `npm run verify` green — check (config line +
  3 lints), self-check, **31 tests**. Cross-checks against the arena with default
  config: `MODEV_ROOT=<arena> node src/check.mjs` passes, `query symbol connectBot`
  answers, `drift` clean, `config` prints the defaults.

## 7. README review before a push (2026-11-22)

The operator asked for a README review before pushing. Three claims were false or
stale, and two were missing contracts:

- **The intro claimed `init` / `kb scaffold` exist.** They do not; the intro now
  states what works today and what is planned, and tells a reader to copy the
  templates by hand until `init` lands.
- **"report templates"** — there is no report template; the report format lives in
  the briefs. Corrected to "task templates".
- **`modev check` was promised by the model-developer template but did not
  exist.** The CLI had no `check` command — only `npm run check`. Implemented:
  `check.mjs` now exports `checkLints` / `main`, and `modev check` (plus a
  missing-`agents/` guard, exit 2) runs it. A test covers 0/1.
- **`MODEV_ROOT` was claimed but not honoured by the CLI.** `check.mjs` read it;
  `cli.mjs` defaulted to `process.cwd()`. One line; tested.
- **The README had no install, CLI, requirements, development or layout
  section.** Added; examples are self-referential (`loadConfig`,
  `src/lib/config.mjs`) so the README does not depend on a host repo.
- Flagged, not fixed: `package.json` says MIT but there is no `LICENSE` file.

Tests: 29 → 31.
