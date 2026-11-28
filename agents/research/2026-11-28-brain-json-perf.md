# Brain-JSON runtime cost — measured

| | |
|---|---|
| **Question** | What is the expected performance impact of a JSON brain (facts, priorities, costs, doctrine) at runtime, and can JSON-Logic-shaped expressions run efficiently in the plan loop? |
| **Decision it informs** | Whether the expression layer needs compiling/caching, and whether the two-tier schema is safe for 15 bots. |
| **Timebox** | 30 min (spent ~25). |
| **Window** | 2026-11-28 12:35 → 13:00 America/New_York. |
| **Method** | an in-house JSON-Logic-subset benchmark (interpreter vs compile-once closures) + an instrumented real plan on the current arena. |

## Answer

**Yes — negligible, if expressions are compiled to closures once per brain load.** A compiled expression costs
**25–100 ns** per evaluation; the untouched JSON-Logic-style interpreter costs **~0.6–2.4 µs**. A real plan on this
arena evaluates **~45 heuristics and ~43 action costs for a 2-expansion plan**; even the pathological 99-expansion plan
seen in the seam work is ~2,000 evaluations. That is **0.002 %–0.02 % of a 200–1,300 ms plan** — the route costing and
grounding dominate by four orders of magnitude. Doctrine values are plain object reads (~ns). Details below.

## 1. Expression evaluation (1,000,000 iterations, Node 24)

| Expression | Interpreted | Compiled (once) | Speed-up |
|---|---:|---:|---:|
| 5-fact bundle (`hpHigh`, `hpWounded`, `hpCritical`, `underFire`, `threatVisible`) | 2,411 ns | **469 ns** | 5.1× |
| goal priority `if hpPressured 90 else 0` | 579 ns | **25 ns** | 23× |
| action cost `8 × (hpWounded ? 2 : 1)` | 603 ns | **103 ns** | 5.9× |

The compiled form is plain JS closures built by a recursive compiler (no `new Function`, no `eval`) — the same rule the
schema already specifies. The interpreter is the fallback; it is still fast enough for priorities/facts, but not the
first choice for the action-cost path.

## 2. Real plan, instrumented (current arena)

Goal `reach:brutalist-building-1-cbake-0.floor-1.hall` from `outside`, key available:

| Metric | Value |
|---|---:|
| actions grounded | 201 |
| plan time | 495 ms |
| expansions | 2 |
| steps | 1 |
| **heuristic calls** | **45** |
| **action-cost calls** | **43** |

So a small plan is **~90 expression evaluations**; the earlier 99-expansion plan (1,307 ms) scales at the measured
~22 evaluations per expansion: **~2,200 heuristic + ~2,100 cost calls ≈ 4,300 evaluations** worst case.

## 3. The math

| Scenario | Evaluations | Compiled (100 ns) | Interpreted (600 ns) | Plan time it sits in |
|---|---:|---:|---:|---:|
| small plan (2 exp) | ~90 | 9 µs | 54 µs | 495 ms → **0.002 % / 0.01 %** |
| worst plan (99 exp) | ~4,300 | 430 µs | 2.6 ms | 1,307 ms → **0.03 % / 0.2 %** |
| 15 bots, 1 small plan/s each | 1,350/s | 0.14 ms/s | 0.8 ms/s | — |
| facts build, 20 Hz × 15 bots × 10 expressions | 3,000/s | 0.03 ms/s | 0.18 ms/s | the 20 Hz loop |

Doctrine reads: a 12-field params object read per attack tick is a property access; even at 20 Hz × 15 bots it is
sub-µs/s.

## 4. Where the runtime actually goes

The measured cost is **not** evaluation: it is `groundActions` (201 actions, ~50 ms in the seam report), **route
costing** inside the heuristic (tens of ms per expansion), and the plan loop's waits. The expression layer must not
change those, and a compiled evaluator does not.

## 5. Requirements this imposes on the design

1. **Compile once per brain load.** `loadBrain` compiles every `priority`, `cost`, and derived-fact expression into a
   closure; the hot path never walks the AST. (The benchmark's "compiled" column is this.)
2. **No `eval`/`new Function`** — the compiler builds closures from the whitelisted AST; that is also the safety rule.
3. **No per-evaluation allocation.** The compiled closure writes into a passed scratch object or returns a number; fact
   bundles are built once per state.
4. **Facts once per state build** (20 Hz), not per action: the engine passes the same `WorldState` into `pre`/`cost`/
   `usable`.
5. **Doctrine as a plain typed object** read by executors — no lookup per call.
6. **Re-measure at P0.** The numbers above are the baseline; the P0 prototype should log `plan ms` with and without the
   expression layer on the same goal, and the gate is "within 2 % of the hand-written baseline".

## 6. Risks that could change the answer

| Risk | Effect | Mitigation |
|---|---|---|
| Recompiling expressions per call | 10–100× the compiled cost (a `compile` inside the loop) | compile at load; assert with a counter |
| Interpreted per call during the heuristic | still < 0.1 % of a plan, but 6–23× compiled | compile; keep the interpreter only for tests/tools |
| `json-logic-js` reference implementation | ~µs per call with array handling and truthiness rules — fine for facts/priorities, not for 2,000 cost calls | the in-house compiled evaluator (decided) |
| A future expression that iterates (`map`/`filter`) | unbounded work inside the heuristic | whitelist excludes iteration (decided) |
| GA multiplying runs | eval *cost* is per-run; total sweep time is runs × match length | measure one match in P3 |

## 7. Confidence

`measured locally` — the benchmark numbers and the instrumented plan (scripts inline in this report's method; the plan
used `loadArena()` + the real scene graph). `inferred` — the 99-expansion evaluation count (scaled from the measured 45 heuristics and 43 costs for 2
expansions) and the GA totals. The conclusion is robust to a 10× error in the evaluation count: even 43,000
evaluations at 600 ns is 26 ms against a 1.3 s plan.
