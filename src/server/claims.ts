// ARCHITECTURE: Host-authoritative goal claims: first client to claim a goal id
//   owns it until release, expiry, or disconnect; the table is broadcast.
// Wiring: arena-host.ts creates it, dispatches frames, ticks expiry, and drops
//   on close; bot clients acquire/release their goal id.
import type { ClaimRow, ClaimsFrame } from "../shared/bot-protocol.js";

type Claim = { owner: number; expires: number };
type ClaimFrame =
  | { v?: number; t: "claim"; key: string; ttlMs?: number }
  | { v?: number; t: "release"; key: string };

const TTL_MIN = 5_000;
const TTL_MAX = 120_000;
const TTL_DEFAULT = 30_000;

function validKey(key: unknown): key is string {
  return typeof key === "string" && key.length > 0 && key.length <= 128 && !/[\u0000-\u001f\u007f]/.test(key);
}

/**
 * Creates Arena Claims.
 */
export function createArenaClaims(opts: {
  sendAll(frame: ClaimsFrame): void;
  log?(line: string): void;
}): {
  onFrame(clientId: number, frame: unknown, scope: readonly string[] | undefined, pawnId: number | undefined): void;
  tick(now: number): void;
  drop(pawnId: number): void;
  snapshot(): ClaimRow[];
} {
  const table = new Map<string, Claim>();
  const warned = new Set<number>();
  let lastSig = "";
  const snapshot = (): ClaimRow[] =>
    [...table.entries()]
      .map(([key, claim]) => ({ key, owner: claim.owner, expires: claim.expires }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const broadcast = (force = false): void => {
    const rows = snapshot();
    const sig = rows.map((row) => `${row.key}:${row.owner}:${row.expires}`).join("|");
    if (!force && sig === lastSig) return;
    lastSig = sig;
    opts.sendAll({ t: "claims", rows });
  };
  const allowed = (clientId: number, scope: readonly string[] | undefined): boolean => {
    if (scope === undefined) return true;
    if (scope.includes("chat")) return true;
    if (!warned.has(clientId)) {
      warned.add(clientId);
      opts.log?.(`[claims] client ${clientId} lacks chat scope; rejected`);
    }
    return false;
  };

  return {
    onFrame(clientId, frame, scope, pawnId) {
      if (!frame || typeof frame !== "object" || Array.isArray(frame)) return;
      const rec = frame as ClaimFrame;
      if (rec.t !== "claim" && rec.t !== "release") return;
      if (!validKey(rec.key)) return;
      if (pawnId === undefined || !allowed(clientId, scope)) return;
      if (rec.t === "release") {
        const current = table.get(rec.key);
        if (!current || current.owner !== pawnId) return;
        table.delete(rec.key);
        broadcast(true);
        return;
      }
      const ttl = typeof rec.ttlMs === "number" && Number.isFinite(rec.ttlMs)
        ? Math.max(TTL_MIN, Math.min(TTL_MAX, rec.ttlMs))
        : TTL_DEFAULT;
      const current = table.get(rec.key);
      if (current && current.owner !== pawnId) return;
      table.set(rec.key, { owner: pawnId, expires: Date.now() + ttl });
      broadcast(true);
    },
    tick(now) {
      let changed = false;
      for (const [key, claim] of table) {
        if (claim.expires <= now) {
          table.delete(key);
          changed = true;
        }
      }
      if (changed) broadcast(true);
    },
    drop(pawnId) {
      let changed = false;
      for (const [key, claim] of table) {
        if (claim.owner !== pawnId) continue;
        table.delete(key);
        changed = true;
      }
      if (changed) broadcast(true);
    },
    snapshot,
  };
}
