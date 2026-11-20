# Shared knowledge base — index

`shared-kb.md` is split in two (2026-11-20) so each read stays inside the window
(the 78% rule in `agents/model-developer-role.md`). The section numbers are the
pre-split ones: a task that names `shared-kb` §13 still resolves, and the table
below is the only mapping.

| Sections | File | Read it for |
|---|---|---|
| §1–§10 | `agents/shared-flow.md` | the layer map, wire, data model, geometry, movement, nav, bots, determinism, single sources, hot paths |
| §11–§13 | `agents/shared-model.md` | the invariant index and test pins §11, the pointer §12, the shared state model and cross-layer contract §13 (incl. §13.6 entities) |

`src/shared/` is the contract both halves run; the host owns the rows and the
client predicts only its owned pawn and camera. `agents/host-kb.md` and
`agents/client-kb.md` are the layer indexes.

A **Knowledge base** slot names one half, not both: `shared-flow` §2–§3 for the
wire and data model, `shared-model` §13 for the contract.
