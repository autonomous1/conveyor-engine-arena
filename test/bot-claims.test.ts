import assert from "node:assert/strict";
import { test } from "node:test";
import { claimGoal } from "../packages/bot-client/src/brain.ts";

function stub(owner: () => number | undefined, supported = true) {
  const state = { owner };
  const rows = new Map<string, { key: string; owner: number; expires: number }>();
  const calls: string[] = [];
  const world = {
    claims: () => rows,
    claimsSupported: () => supported,
    self: () => ({ id: 1 }),
  };
  const session = {
    world,
    claims: {
      acquire: (key: string, ttlMs: number) => {
        calls.push(`acquire:${key}:${ttlMs}`);
        const current = state.owner();
        if (current !== undefined) rows.set(key, { key, owner: current, expires: Date.now() + ttlMs });
      },
      release: (key: string) => {
        calls.push(`release:${key}`);
        rows.delete(key);
      },
    },
  };
  return { session: session as never, rows, calls, setOwner: (next: () => number | undefined) => { state.owner = next; } };
}

test("claim_goal_waits_for_the_owner_and_times_out", async () => {
  const { session, rows, calls } = stub(() => 8);
  let done = false;
  const pending = claimGoal(session, "retrieve:key@room", Date.now() + 250, () => {}).then((ok) => {
    done = true;
    return ok;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(done, false);
  rows.set("retrieve:key@room", { key: "retrieve:key@room", owner: 1, expires: Date.now() + 30_000 });
  assert.equal(await pending, true);
  assert.ok(calls.some((line) => line.startsWith("acquire:retrieve:key@room:")));

  const expired = stub(() => 8);
  assert.equal(await claimGoal(expired.session, "other", Date.now() + 80, () => {}), false);
});

test("claim_goal_resolves_when_the_row_disappears", async () => {
  const { session, rows, setOwner } = stub(() => 8);
  const pending = claimGoal(session, "k", Date.now() + 500, () => {});
  await new Promise((resolve) => setTimeout(resolve, 20));
  rows.delete("k");
  setOwner(() => 1);
  assert.equal(await pending, true);
});
