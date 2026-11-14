import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createSnapshotStore, type SnapJob } from "../src/server/snapshot-store.ts";

const timers: ReturnType<typeof setTimeout>[] = [];
function job(id: string, requesterId: number): SnapJob {
  const timer = setTimeout(() => {}, 60_000);
  timers.push(timer);
  return { id, requesterId, timer };
}
after(() => {
  for (const t of timers) clearTimeout(t);
});

test("snapshot_store_mutual_membership", () => {
  const store = createSnapshotStore();
  const a = job("a", 1);
  const b = job("b", 2);
  assert.equal(store.begin(a), true);
  assert.equal(store.begin(b), true);
  assert.equal(store.isBusy(1, "a"), true);
  assert.equal(store.isBusy(2, "b"), true);

  const taken = store.take("a");
  assert.equal(taken, a);
  assert.equal(store.isBusy(1, "a"), false);
  assert.equal(store.isBusy(2, "b"), true);

  // Re-begin with same requester AND same id — proves take() cleared both maps.
  const a2 = job("a", 1);
  assert.equal(store.begin(a2), true);

  // Duplicate requester (different id) refused.
  assert.equal(store.begin(job("c", 1)), false);
  // Duplicate id (different requester) refused.
  assert.equal(store.begin(job("a", 99)), false);
});

test("snapshot_store_clearall", () => {
  const store = createSnapshotStore();
  const a = job("a", 1);
  const b = job("b", 2);
  const c = job("c", 3);
  store.begin(a);
  store.begin(b);
  store.begin(c);
  const cleared = store.clearAll();
  assert.deepEqual(
    cleared.map((j) => j.id),
    ["a", "b", "c"],
  );
  for (const [req, id] of [
    [1, "a"],
    [2, "b"],
    [3, "c"],
  ] as const) {
    assert.equal(store.isBusy(req, id), false);
  }
  assert.deepEqual(store.clearAll(), []);
});
