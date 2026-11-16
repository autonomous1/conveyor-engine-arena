import assert from "node:assert/strict";
import { test } from "node:test";
import { createArenaClaims } from "../src/server/claims.ts";
import type { ClaimsFrame } from "../src/shared/bot-protocol.ts";

function host(scope = ["play", "chat"]) {
  const sent: ClaimsFrame[] = [];
  const claims = createArenaClaims({ sendAll: (frame) => sent.push(frame) });
  return { claims, sent, scope };
}

test("first_claim_wins_and_second_is_ignored", () => {
  const { claims, sent, scope } = host();
  claims.onFrame(1, { v: 1, t: "claim", key: "retrieve:key@room", ttlMs: 30_000 }, scope, 7);
  claims.onFrame(2, { v: 1, t: "claim", key: "retrieve:key@room", ttlMs: 30_000 }, scope, 8);
  assert.equal(claims.snapshot()[0]!.owner, 7);
  assert.equal(sent.at(-1)!.rows[0]!.owner, 7);
});

test("expiry_disconnect_and_scope", () => {
  const { claims, sent, scope } = host();
  claims.onFrame(1, { v: 1, t: "claim", key: "k", ttlMs: 5_000 }, scope, 7);
  claims.tick(Date.now() + 5_001);
  assert.deepEqual(claims.snapshot(), []);
  claims.onFrame(1, { v: 1, t: "claim", key: "k", ttlMs: 30_000 }, scope, 7);
  claims.drop(7);
  assert.deepEqual(claims.snapshot(), []);
  claims.onFrame(1, { v: 1, t: "claim", key: "k", ttlMs: 30_000 }, ["play"], 7);
  assert.deepEqual(claims.snapshot(), []);
  claims.onFrame(1, { v: 1, t: "claim", key: "local", ttlMs: 30_000 }, undefined, 7);
  assert.deepEqual(claims.snapshot().map((row) => row.key), ["local"]);
  assert.ok(sent.length >= 3);
});
