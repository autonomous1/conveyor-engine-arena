/**
 * Snapshot revival shared by the browser client and a Node or Worker bot.
 * No Node builtin imports. Bigint tags match the transport codec.
 */
// ARCHITECTURE: Snapshot revival from the `$i` wire form, and `asSnapshot`'s
//   conversion into the client's snapshot type.
// Wiring: client/net.ts revives every inbound frame; no server consumer.
import type { IncomingSnapshot } from "conveyor-engine-client";

export function revive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(revive);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.$i === "string" && Object.keys(record).length === 1) return BigInt(record.$i);
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(record)) out[key] = revive(item);
    return out;
  }
  return value;
}

export function asSnapshot(envelope: Record<string, unknown>): IncomingSnapshot {
  const tick = envelope.tick;
  return {
    kind: envelope.kind === "full" ? "full" : "delta",
    seq: Number(envelope.seq),
    tick: typeof tick === "bigint" ? tick : BigInt(Number(tick ?? 0)),
    lastProcessedInput: Number(envelope.lastProcessedInput ?? 0),
    spawns: (envelope.spawns as IncomingSnapshot["spawns"]) ?? [],
    updates: (envelope.updates as IncomingSnapshot["updates"]) ?? [],
    despawns: (envelope.despawns as IncomingSnapshot["despawns"]) ?? [],
  };
}
