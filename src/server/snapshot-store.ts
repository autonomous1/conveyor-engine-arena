/**
 * @why Pure bookkeeping: no timers are created, cleared, or fired here. The
 *      caller creates the timer, stores the handle in the job, and clears it
 *      when the job leaves the store via take() or clearAll().
 */
export type SnapJob = {
  id: string;
  requesterId: number;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * @invariant `byRequester` and `byId` hold the same jobs. Every entry in one
 *            has a matching entry in the other. begin() writes both; take()
 *            removes both; clearAll() clears both.
 *            (test: snapshot_store_mutual_membership)
 */
export type SnapshotStore = {
  isBusy(requesterId: number, id: string): boolean;
  begin(job: SnapJob): boolean;
  take(id: string): SnapJob | undefined;
  clearAll(): SnapJob[];
};

export function createSnapshotStore(): SnapshotStore {
  const byRequester = new Map<number, SnapJob>();
  const byId = new Map<string, SnapJob>();
  return {
    isBusy(requesterId, id) {
      return byRequester.has(requesterId) || byId.has(id);
    },
    begin(job) {
      if (byRequester.has(job.requesterId) || byId.has(job.id)) return false;
      byRequester.set(job.requesterId, job);
      byId.set(job.id, job);
      return true;
    },
    take(id) {
      const job = byId.get(id);
      if (!job) return undefined;
      byId.delete(id);
      byRequester.delete(job.requesterId);
      return job;
    },
    clearAll() {
      const jobs = [...byId.values()];
      byId.clear();
      byRequester.clear();
      return jobs;
    },
  };
}
