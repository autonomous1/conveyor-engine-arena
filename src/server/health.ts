import { encodeFrame, type EngineWsServer } from "conveyor-engine-transport-ws";
import type { HealthFrame } from "../shared/health.js";

/**
 * @post Owner always sees their pawn. Everyone else needs it in the last
 *       interest set.
 */
export function clientSeesPawn(server: EngineWsServer, clientId: number, entity: number): boolean {
  const state = server.replicator.get(clientId);
  if (!state?.connected) return false;
  if (state.ownedEntity === entity) return true;
  return state.known.has(entity);
}

/** Last `hp|dead` sent per client session and pawn. A new session (welcome) starts empty. */
const sentHealth = new WeakMap<EngineWsServer, Map<number, { sessionId: number; rows: Map<number, string> }>>();

/** Sent-state for this client's current session. Drops clients that are gone. */
export function sentFor<T>(
  cache: WeakMap<EngineWsServer, Map<number, { sessionId: number } & T>>,
  server: EngineWsServer,
  clientId: number,
  fresh: () => T,
): ({ sessionId: number } & T) | undefined {
  const session = server.session(clientId);
  if (!session) return undefined;
  let byClient = cache.get(server);
  if (!byClient) cache.set(server, (byClient = new Map()));
  if (byClient.size > server.connected.length) {
    const live = new Set(server.connected);
    for (const id of byClient.keys()) if (!live.has(id)) byClient.delete(id);
  }
  let row = byClient.get(clientId);
  if (!row || row.sessionId !== session.sessionId) {
    row = { sessionId: session.sessionId, ...fresh() };
    byClient.set(clientId, row);
  }
  return row;
}

/**
 * Arena health frame on the same socket that already carries snapshots.
 * @post Only a value this client session has not seen for that pawn is sent.
 */
export function deliverHealthFrames(
  server: EngineWsServer,
  clientIds: Iterable<number>,
  frames: readonly HealthFrame[],
): void {
  if (frames.length === 0) return;
  const texts: (string | undefined)[] = [];
  for (const clientId of clientIds) {
    const socket = server.session(clientId)?.socket;
    const sent = socket && sentFor(sentHealth, server, clientId, () => ({ rows: new Map<number, string>() }));
    if (!socket || !sent) continue;
    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i]!;
      if (!clientSeesPawn(server, clientId, frame.entity)) continue;
      const key = `${frame.hp}|${frame.dead}`;
      if (sent.rows.get(frame.entity) === key) continue;
      sent.rows.set(frame.entity, key);
      socket.send((texts[i] ??= encodeFrame(frame)));
    }
  }
}
