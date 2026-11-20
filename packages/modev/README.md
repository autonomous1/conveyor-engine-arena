# packages/modev — model lints

`agents/` is a deliverable, so it gets the same treatment as `src/`: checks that
are mechanical, one failure mode per lint, and a command that fails red.

```sh
npm --prefix packages/modev run check        # the lints against this repo
npm --prefix packages/modev run self-check   # each lint on a fixture that violates one thing
```

No dependencies, no build step; Node 24.

## The rule

**One lint per failure mode.** A lint that tests two things reports two findings
in one message and cannot be triaged. Each lint here exports `{ id, run(root) }`,
returns `{ file, line, message }[]`, and is wired into `check.mjs` by filename
order. A finding names one place and one defect.

**Advisory only.** A lint reports; it never writes `agents/`. The `promote/`
tool the role brief describes (propose the edit, print the diff) is unbuilt; it
lands when a lint has a mechanical fix worth proposing.

## The lints

| id | Fails when | Authority |
|---|---|---|
| `kb-length` | a KB half is longer than 78% of the read window | `agents/model-developer-role.md` "The 78% rule" |
| `kb-section-refs` | a `host`/`client`/`shared` § reference names no section in that layer, or two files declare it | the KB files themselves |
| `kb-count-claims` | a prose "N \`always\` gates" disagrees with `test/scopes.json` | `test/scopes.json` |

`kb-length` reads the window from `READ_WINDOW_LINES` in
`lints/kb-length.mjs` (currently 400, the operator's stated window). The 78%
rule is the policy; only the window constant moves.

`kb-section-refs` resolves a section by layer, not by file, so the split
(`host-flow.md` / `host-model.md`) keeps `host-kb §13` resolving without
special-casing the index. The index files carry no `## N.` headers, so a
section has exactly one home.

`kb-count-claims` is deliberately narrow: the `always`-gate count. Other counts
(template slots, scopes) get their own lint when they drift.

## Self-check

`self-check.mjs` builds four fixtures under `os.tmpdir()` — one clean, one per
lint — and asserts that each dirty fixture trips exactly its own lint. That is
the proof that a lint tests one thing, and it stays runnable on a machine with
no repo state.

## Wiring

- `npm run modev:check` (root `package.json`) runs this package.
- `test/kb-symbols.test.ts` covers all seven KB files, the split halves included.
- CI runs it too: `.github/workflows/ci.yml` has `- run: npm run modev:check`
  before `npm test`, so a stale model fails the 2-hour run like a red test.
