# Bot-to-bot messaging for GOAP coordination — framework choice

| | |
|---|---|
| **Question** | Which messaging framework should arena bots use to coordinate GOAP tasks, and is the attached claims-carried message prototype the right base? |
| **Decision it informs** | What the designer asks the coder to build: a first-class message frame, a blackboard, an ACL, or nothing beyond the existing claim table. |
| **Timebox** | 60 min research + 30 min local measurement (spent ~75). |
| **Window** | 2026-11-21 09:59 → 11:20 America/New_York. External facts dated 2026-11-21. |
| **Tree** | HEAD `7d6571e`; `src/shared/bots/goap.ts` frozen; D10 already chose a host-mediated claim frame. |
| **Read** | `packages/bot-client/tests/live-link.ts` (219 lines, the proposal), `src/server/claims.ts`, `packages/bot-client/src/{brain,connection,world}.ts` (relevant blocks), `src/shared/bot-protocol.ts`, `src/server/auth/tokens.ts`, `test/claims.test.ts`, `agents/decisions.md` D10. |

## Executive summary

The allocation half of "messaging" is already built and decided: `createArenaClaims` (`src/server/claims.ts:23`)
is a host-authoritative, TTL'd, first-claim-wins table, `claimGoal` (`packages/bot-client/src/brain.ts:116`) makes
every bot acquire its goal id before planning, and D10 chose this over chat or a bot-side store. What is missing is
the *signal* half — a way to say "I have the key, take the other door", or "I'm stuck" — and the attached
`live-link.ts` fakes it by encoding messages into claim keys (`msg:<to>:<stamp>:<base64>`). That works, but it is a
transport built on a coordination space: it costs **40.7 KB/s per client at 5 msg/s** because every claim change
rebroadcasts the whole table (measured below; a dedicated frame would be ~0.9 KB/s), it silently loses messages
when two share a millisecond-stamped key, it has no ack, ordering or delivery guarantee, and it caps text at ~80
bytes with 33 % base64 overhead. The right framework is not FIPA ACL, ROS 2 actions or A2A — all three are
documented below and all three are the wrong size for 2–5 deterministic bots at 20 Hz inside an authoritative
host — it is the one the repo already points at: **a host-authoritative blackboard (world state + claims) as the
default channel, plus one append-only typed signal frame with contract-net semantics for allocation events.**
Recommendation: a designer task for the `msg` frame (slot-by-slot in §6), not an ACL.

## 1. Question, decision, timebox

Restated: the bots already plan with GOAP and already contend for goals. Coordination needs three things — *who
does what* (allocation), *what is happening* (state), *what changed / what I intend* (signals). The question is
which messaging framework carries each of those, and whether the proposed claims-as-carrier survives contact with
the tree. The answer chooses the designer's next task. Moot if bots never contend — they do (`retrieve:key@room`
is a shared order id, D10).

## 2. Sources

External (all retrieved 2026-11-21; fipa.org itself is dead/Cloudflare-blocked, so the two specs come from the
Internet Archive's verbatim copies — cite the archived URL):

| Source | Version / date | What it is good for |
|---|---|---|
| [FIPA ACL Message Structure Specification, SC00061G](https://web.archive.org/web/20130709131347/http://www.fipa.org:80/specs/fipa00061/SC00061G.html) | Standard, 2002-12-03 | the canonical message envelope: performative, sender, receiver, content, reply-with/in-reply-to, protocol, conversation-id, reply-by |
| [FIPA Contract Net Interaction Protocol, SC00029H](https://web.archive.org/web/20120223164111/http://www.fipa.org:80/specs/fipa00029/SC00029H.html) | Standard, 2002-12-03 | task allocation: cfp → propose/refuse → accept/reject-proposal → inform-done/result/failure; deadlines for non-replies; cancel meta-protocol |
| [ROS 2 Actions design](https://design.ros2.org/articles/actions.html) | written 2019-03, modified 2020-05 | long-running goal lifecycle: goal/result/feedback, client-generated UUID goal ids, ACCEPTED/EXECUTING/CANCELING/SUCCEEDED/ABORTED/CANCELED, result cache with timeout |
| [A2A Protocol — What is A2A](https://a2a-protocol.org/latest/topics/what-is-a2a/) | Linux Foundation, docs © 2026 | the modern "agent messaging" answer — HTTP/JSON-RPC/SSE, agent cards, opaque execution; explicitly for cross-vendor LLM agents |
| [Blackboards — *Game AI: Patterns, Not Engines*, ch. 9](https://www.socratopia.app/library/game-ai-patterns-en/chapter-9) | book chapter (undated) | the game-AI pattern: typed key-value store in three scopes (NPC-local, squad-shared, world-global); timestamps/MRU vs single-writer vs CAS for claims; "believability, not correctness" |
| [Tuple space (Wikipedia)](https://en.wikipedia.org/wiki/Tuple_space) | retrieved 2026-11-21 | Linda (1986): producers post tuples, consumers match patterns; the blackboard metaphor; JavaSpaces master-worker |

Labels: the two FIPA specs and the ROS 2 design doc are `documented externally` primary/design sources; the
blackboard chapter and the tuple-space article are secondary (`book`, `encyclopedia`). The Unreal
GameplayMessageSubsystem page returned an empty shell and is **not** used.

Local (the authority): `decisions.md` D10, `src/server/claims.ts`, `src/shared/bot-protocol.ts`,
`packages/bot-client/src/{brain,connection,world}.ts`, `src/server/auth/tokens.ts`, `test/claims.test.ts`.

## 3. Findings

**F1 — the allocation problem is already solved, and not by a message.**
`createArenaClaims` keeps `Map<key, {owner, expires}>`, first claim wins, owner = the claimant's pawn id, TTL
clamped 5–120 s (`src/server/claims.ts:12-14`), broadcast on every change, dropped on disconnect, expired on tick.
`claimGoal` (`brain.ts:116`) acquires the goal id, waits for ownership, renews every 10 s, and `runMission` releases
on every exit. So two bots on `retrieve:key@room` already serialise without a byte of chat.
*Label: verified locally.* **This is the D10 decision, and it is a contract-net with the negotiation phase removed
(claim ≈ propose+accept, expiry ≈ reject-by-silence).**

**F2 — no message frame exists.** `parseArenaFrame` (`src/shared/bot-protocol.ts:186`) dispatches 17 host→client
frame types (`loadout`, `pickup`, `door`, `elevator`, `health`, `botLabel`, `laser`, `grenade`, `audit`, `inventory`,
`players`, `claims`, `sceneGraph`, `regions`, `teleportResult`, `snapshotResult`, `qaCapture`) and returns
`undefined` for anything else; `applyArenaText` (`packages/bot-client/src/connection.ts:354`) then applies the ones
the bot model understands and ignores the rest. Adding `t:"msg"` is therefore **additive**: an old bot drops it and
keeps working, and no kernel package changes.
*Label: verified locally.*

**F3 — the claims-carrier works but pays for it.** Measured from the real `ClaimRow` shape
(`{key, owner, expires}`) with a 80-byte body:

| quantity | value |
|---|---|
| one-row `claims` frame | **185 bytes** |
| 50-row `claims` frame (5 msg/s × 10 s TTL) | **8,137 bytes** |
| traffic per client at 5 msg/s | **40.7 KB/s** (each message triggers a full-table rebroadcast) |
| a dedicated per-message frame of the same text | ~185 bytes → **~0.9 KB/s** |

Also: keys cap at 128 chars (`validKey`, `claims.ts:17`) and the body is clipped to 80 chars *then*
base64url-encoded (+33 %), so the effective text ceiling is ~80 bytes; two messages with the same `to`, the same
millisecond and the same text produce the **same key**, and the second claim is rejected because the owner
differs (`if (current && current.owner !== pawnId) return;`) — a lost message, not a duplicate.
*Label: measured locally (frame sizes), inferred (loss window).*

**F4 — the prototype's messages are invisible to the host's own semantics.** The claim table has no sender field
(`ClaimRow` = key/owner/expires; `owner` doubles as the sender) and no sequence, ack, ordering or delivery
guarantee; a receiver recovering a body from a key must parse a string encoding that any `chat`-scoped client can
forge under any prefix. There is **no per-client frame rate limit** in the host dispatch and no `maxPayload` configured on the ws server,
so the carrier is also an unbounded write path into a table every client reads.
*Label: verified locally.*

**F5 — the QA scope trap.** `createArenaClaims.allowed()` rejects any client whose token scope lacks `chat`, and
`DEFAULT_SCOPES.qa = ["play","spectate","scene-graph","qa"]` has no `chat` (`src/server/auth/tokens.ts:32-37`),
while `player` and `bot` do. The local `qa-token.pem` carries `chat` (decoded claim: `[play, spectate,
scene-graph, qa, teleport, chat]`), so `live-link.ts` works **on this machine**. A freshly minted `--role qa`
token would not, and `session.claims.acquire()` is fire-and-forget (`connection.ts:126`) — the failure is a
server-side log line the bot never sees, so `sendMessage()` still returns `ok: true`.
*Label: verified locally.* **This is the strongest argument for a first-class frame: a message that cannot be
rejected silently.**

**F6 — bots already receive a 20 Hz world-state firehose.** Snapshots interpolate every entity; `pickup`, `door`,
`elevator`, `health`, `players`, `inventory`, `claims` frames carry world facts. Any coordination fact that is a
world fact (the key is gone, the door is open, the pawn is dead) needs **no message at all** — that is stigmergy
through shared state, the same argument the blackboard chapter makes for a typed store over explicit wiring.
Only *intent* and *allocation* are not observable and need a signal.
*Label: verified locally (frames) + documented externally (blackboard pattern).*

**F7 — the external frameworks are each a piece, none is the whole.**
- *FIPA ACL* is a message **envelope** (13 parameters; only `performative` is mandatory; `reply-with`/`in-reply-to`
  thread conversations; `conversation-id` must be globally unique; `reply-by` is a deadline). It says nothing about
  a game loop and assumes agents that reason over content languages and ontologies.
- *Contract Net* is the **allocation** pattern (cfp → propose/refuse → accept/reject → inform); its own spec admits
  the manager "may be left waiting indefinitely" without the `reply-by` deadline — exactly the livelock a claim TTL
  prevents.
- *ROS 2 actions* are the **long-running goal** pattern (goal/result/feedback, cancel, terminal states), with a
  client-generated UUID goal id and a result cache purged on timeout. Closest to a GOAP mission.
- *A2A* is an **inter-org interoperability** protocol (agent cards, HTTPS, opaque agents) — wrong scale, wrong
  trust model, and it deliberately hides internals that a deterministic bot wants to expose.
*Label: documented externally.*

**F8 — the proposal mixes two planes.** `live-link.ts` is two things: a **file mailbox** (inbox/outbox/status under
`plan/dsh-tasks/live/`, `live-link.ts:4-6, 140-185`) that lets a driving session order *one* bot, and the
**claims-carried messages** (`live-link.ts:80-118`) between bots. The mailbox is an operator/LLM control plane; it
is a legitimate bot-developer tool and has nothing to do with GOAP coordination. Conflating them is how the
carrier got chosen: the mailbox needs a transport, the claim table was there.
*Label: verified locally.*

## 4. Local measurement

```bash
node packages/modev/cli.mjs query symbol createArenaClaims          # src/server/claims.ts:23
node packages/modev/cli.mjs query symbol claimGoal 2>/dev/null || rg -n "claimGoal" packages/bot-client/src/brain.ts
rg -n "parseArenaFrame|t === \"" src/shared/bot-protocol.ts | tail -20   # 17 frame types, no msg
sed -n '20,45p' src/server/auth/tokens.ts                            # qa lacks chat
node -e "const r=i=>({key:'msg:42:m'+i.toString(36)+':'+Buffer.from('x'.repeat(80)).toString('base64url'),owner:7,expires:1795215535000}); console.log(JSON.stringify({t:'claims',rows:[r(1)]}).length, JSON.stringify({t:'claims',rows:Array.from({length:50},(_,i)=>r(i))}).length)"  # 185 / 8137
sed -n '116,140p' packages/bot-client/src/brain.ts                   # acquire, wait, renew, release
sed -n '1,40p' test/claims.test.ts                                   # first-claim, expiry, scope rejection
```

Footprint of the recommended change: **2 host/shared files + 3 bot-lane files + 1 new test**, no kernel, no codemap
surprise (no exported symbol is renamed).

## 5. Feasibility matrix

| Option | Verdict | Cost | Risk | What would change it |
|---|---|---|---|---|
| A. Keep the claims-carrier as designed | **conflicts** with the claim table's purpose | 0 src, max compression of the prototype | silent loss, silent scope rejection (F5), 40× traffic, 80-byte cap, no ordering, namespace pollution | if the only consumer is a 2-bot demo and the body stays ≤80 B |
| B. **One `t:"msg"` append-only frame + keep claims for allocation** | **small / recommended** | `bot-protocol.ts` (type + parser), `arena-host.ts` dispatch, 3 bot-lane files, `test/messages.test.ts` | protocol surface +1; needs a rate cap and a body cap | if multi-host federation ever exists (then conversation-id matters) |
| C. FIPA-style ACL inside the arena | **large, over-engineered** | new envelope, performative enum, conversation ids, threading, per-bot handler | bots are deterministic and co-located; content languages/ontology are dead weight | if non-bot agents (LLM) join the arena |
| D. ROS 2 actions-style goals (feedback/result/cancel) | **medium, mostly already have** | `claim` + `status` frames; per-goal feedback topic | duplicates claims and snapshots; two sources of truth | if a bot needs to *report progress* to a coordinator |
| E. A2A | **out of scope** | huge | HTTP, agent cards, opaque agents; wrong trust model | if the arena ever exposes bots to other vendors |
| F. Blackboard only, no messages | **already have (world) / partial** | a host-side squad table + a `squad` frame | cannot express intent; poll-only | if convergence to "who does what" must be immediate |
| G. Do nothing; bots coordinate only through world effects | **already have** | 0 | two bots can duplicate work until the world changes | if duplication is observed live |

## 6. Recommendation

**One action: a designer task for a first-class `msg` frame plus a bot-side signal API, keeping the claim table
exactly as it is for allocation.** The framework, in one line: *blackboard first (world state and claims), one
typed append-only signal channel second, no ACL.* This is the smallest thing that fixes F3/F4/F5 without inventing
a protocol the host cannot enforce.

### Task proposal (designer slots)

**Architecture note.** Cite `src/server/claims.ts:1-3` (host-authoritative, broadcast, owned) and D10's "the host
is the only arbiter". The new frame is the *event* half of the same authority rule: the host stamps `from` from the
connection's owned pawn, caps volume, and delivers per tick — clients never address each other.

**Knowledge base.** `host-model` §13.2 (sub-hosts) and §15/§13.5 (lifetime rules); `shared-model` §13.1 (wire,
`X` row) and §13.6 (entity rows); `host-flow` §3 (ownership and seq gates) and §10 (snapshot path).

**Files to touch.**

| File | Change |
|---|---|
| `src/shared/bot-protocol.ts` | `MsgFrame = { t:"msg"; from:number; seq:number; to:number\|0; text:string; at:number }` (0 = broadcast), `parseMsg`, `parseArenaFrame` branch, `sendMsg` frame type |
| `src/server/messages.ts` (new) | `createArenaMessages({ sendAll, maxText, perSecond, ttlMs })` — ring buffer, per-sender seq, TTL, drop counter; one `deliver()` per tick, not per frame |
| `src/server/arena-host.ts` | construct + dispatch `t:"msg"`, `drop(pawnId)` on close, `tick()` expiry |
| `packages/bot-client/src/connection.ts` | `messages.say(text, to?)` (fire-and-forget) |
| `packages/bot-client/src/world.ts` | `messages(): readonly MsgRow[]` + `messagesSupported()`, applied from the frame |
| `packages/bot-client/src/brain.ts` | one consumer: on `doorBlocked`/`giveUp`, `say("stuck " + goal.id)`; no new planning |
| `test/messages.test.ts` (new) | delivery, broadcast vs unicast, seq monotonic, TTL expiry, rate cap, `from` is the pawn id |

**Codemap delta.** Add `createArenaMessages`, `parseMsg`, `MsgFrame`, `MsgRow`, `messages`, `messagesSupported`.
Remove none. Regenerate with `npm run codemap`.

**Test-must-fail-first.** `test/messages.test.ts` — "a msg frame reaches the other bot and not the sender" fails on
HEAD because `parseArenaFrame` returns `undefined` for `t:"msg"` and the host drops the frame.

**Test scope.** `npm run test:related -- test/messages.test.ts test/claims.test.ts`; then `npm run typecheck`.

**Headers and tags.** `messages.ts` gets the four-slot header; `@invariant` on the ring buffer (one `seq` per
sender, monotonic, TTL-bounded) with `(test: messages_are_ordered_and_expire)`; `@why` on "deliver once per tick,
not per frame" (a per-frame `sendAll` is the 40 KB/s bug in F3).

**Artifacts.** `agents/host-model.md` §13.2 row for the message ring; `agents/shared-model.md` §13.1 `X` row;
`agents/host-flow.md` §10 one line on delivery.

### If the operator wants evidence before a task

A bot-developer **spike** (no src change): run two `live-link.ts` bots with `MSG_TTL_MS` at 2 s and a 60-byte body,
log send→receive latency and loss over 200 messages, and confirm the full-table rebroadcast cost from the host log.
That is a one-evening measurement and it either kills the carrier (expected) or proves it sufficient for a demo.

## 7. Open questions

1. **Does GOAP need *intent* messages, or only claims?** The planner is deterministic and goals are shared ids;
   the two-bot duplicate-work case is the only observed one (D10's race report). If a live run shows no other
   contention, option G is the cheapest answer and the frame can wait.
2. **Who is the coordinator?** Claims are peer-to-peer through the host. A squad blackboard (shared target, alert
   level) needs either a coordinator bot or a host-side squad table — not decided here.
3. **Voice**: `voice` exists as a scope but there is no voice frame; out of scope for GOAP coordination.
4. **Message journaling**: should `msg` frames be recorded with the audit counters for replay? Not asked, not
   designed.
5. **Two planes**: whether the file-mailbox in `live-link.ts` should be promoted into a documented bot-developer
   tool (it is the only way a session can steer one bot mid-run) is a separate decision for the bot-developer role.

## 8. Confidence legend

`verified locally` — reproduced with the commands in §4. `measured locally` — numbers from the frame-size script.
`documented externally` — quoted from the sources in §2, none of which is a game runtime. `inferred` — reasoned
from two measured facts.
