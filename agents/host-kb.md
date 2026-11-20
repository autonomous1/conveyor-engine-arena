# Host knowledge base — index

`host-kb.md` is split in two (2026-11-20) so each read stays inside the window
(the 78% rule in `agents/model-developer-role.md`). The section numbers are the
pre-split ones: a task that names `host-kb` §13 still resolves, and the table
below is the only mapping.

| Sections | File | Read it for |
|---|---|---|
| §1–§10 | `agents/host-flow.md` | boot, the 20 Hz tick, ownership, collision, doors, elevators, hitscan, bots, health, the snapshot path |
| §11–§15 | `agents/host-model.md` | the hot-path table, the invariant index, the state model §13, the quirks §14, the layer map §15 |

The host is the authority for movement, doors, health, and pickups; the client
predicts only the camera and its own visual step. `agents/shared-kb.md` is the
cross-layer index.

A **Knowledge base** slot names one half, not both: `host-flow` §5 for the door
flow, `host-model` §13 for the containers.
