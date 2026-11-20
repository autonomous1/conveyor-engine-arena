# packages/modev — model lints and the query CLI

`agents/` is a deliverable, so it gets the same treatment as `src/`: checks that
are mechanical, one failure mode per lint, a command that fails red — and a
query surface so a session reads **one entry**, not the whole codemap.

```sh
npm --prefix packages/modev run verify       # lints + tests (what CI runs)
npm run modev:check                          # same, from the repo root
node packages/modev/cli.mjs query symbol chooseGoal
node packages/modev/cli.mjs query file src/server/arena-host.ts
node packages/modev/cli.mjs query section shared-model 13.6
node packages/modev/cli.mjs query entity Pawn
node packages/modev/cli.mjs drift
```

No dependencies, no build step, no daemon, no network. Node 24.

## The query CLI

| Command | Prints | Exit |
|---|---|---|
| `query symbol <name> [--file <substr>] [--kind <k>]` | `name kind file:line`, signature, doc line, tags, calls, used-by | 0 hit, 1 miss |
| `query file <path>` | the module: line count, doc, imports, packages, used-by, and every symbol | 0, 1 |
| `query section <layer\|file> <§N>` | that section's text, bounded; `shared` or `shared-model` both work | 0, 1 |
| `query entity <name>` | the `shared-model` §13.6 row: shared factory, host container, client copy, tests | 0, 1 |
| `find <text> [--limit <n>]` | substring hits in symbol names and section titles (discovery) | 0, 1 |
| `drift` | advisory findings: a `§` ref that does not resolve, a KB `src/…` path that is gone or absent from the codemap, a §13.6 test pin with no test file | 0 clean, 1 findings |
| `stats` | what has been queried (from `.cache/queries.jsonl`) | 0 |

Options: `--root <dir>` (default: this repo), `--json` (machine output), `--help`.

**Exact, not fuzzy.** `query symbol` takes one name; a miss exits 1 with no
guess. `find` is the only substring entry point. That preserves the codemap rule
— one exact lookup, then open the source file; the CLI is the lookup, not a
second map.

**JSON is internal.** The CLI parses the markdown into a JSON-shaped index in
memory, but the agent-facing output is compact text: the token saving comes from
returning one entry (~6 lines) rather than the file (5,278 lines). `--json` is
for piping, not for reading.

**Read-only.** It reads `agents/codemap.md`, the KB halves and `test/`; it writes
only `.cache/` (the query log). It never writes `agents/`.

## The lints

**One lint per failure mode.** A lint that tests two things reports two findings
in one message and cannot be triaged. Each lint exports `{ id, run(root) }`,
returns `{ file, line, message }[]`, and is wired into `check.mjs` by filename
order.

| id | Fails when | Authority |
|---|---|---|
| `kb-length` | a KB half is longer than 78% of the read window | `agents/model-developer-role.md` "The 78% rule" |
| `kb-section-refs` | a `host`/`client`/`shared` § reference names no section in that layer, or two files declare it | the KB files themselves |
| `kb-count-claims` | a prose "N \`always\` gates" disagrees with `test/scopes.json` | `test/scopes.json` |

`kb-length` reads the window from `READ_WINDOW_LINES` in `lints/kb-length.mjs`
(currently 400). The 78% rule is the policy; only the window constant moves.

**Advisory only.** A lint reports; it never writes `agents/`. `drift` is the same
contract: it proposes, the operator applies.

## Tests

`test/cli.test.mjs` runs against `test/fixtures/` — a miniature codemap and KB
set. It pins the exactness of `query symbol`, the section-boundary rule (a
numbered subsection stops at the next unnumbered heading; a chapter keeps its
unnumbered subsections), the entity row, the drift report (one finding per
defect), and the CLI exit codes.

`self-check.mjs` proves the lints one failure mode at a time on throwaway
fixtures. `npm run verify` runs the lints, the self-check and the CLI tests; CI
runs `npm run modev:check` before `npm test`.

## Not built

- A `promote/` tool that proposes an edit as a diff. It lands when a lint has a
  mechanical fix worth proposing.
- A codemap `--json` emission from `scripts/codemap.ts`. The CLI parses the
  markdown today; when the generator gains the flag, the CLI prefers it and
  keeps parsing as the fallback.
