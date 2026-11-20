# Shared knowledge base — model

## 11. Invariant index

- `plan` — ties break by id.

## 13. Shared state model

The contract.

### 13.6 Domain entities

| entity | shared factory / type | host container | client copy | test |
|---|---|---|---|---|
| Pawn | `createPawnHealth` | `health.rows` — host §13.4 | `pawnVital` — client §13.2 | `health.test.ts` |
| Door | `doorLeafBox` | `doorHost` — host §13.2 | `doorOpen` — client §13.2 | `door-block.test.ts` |

### Ownership and authority graph

host -> client
