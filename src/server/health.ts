import { encodeFrame, type EngineWsServer } from "conveyor-engine-transport-ws";
import type { HealthFrame } from "../shared/health.js";

/** Owner always sees their pawn. Everyone else needs it in the last interest set. */
export function clientSeesPawn(server: EngineWsServer, clientId: number, entity: number): boolean {
  const state = server.replicator.get(clientId);
  if (!state?.connected) return false;
  if (state.ownedEntity === entity) return true;
  return state.known.has(entity);
}

/** Arena health frame on the same socket that already carries snapshots. */
export function deliverHealthFrames(
  server: EngineWsServer,
  clientIds: Iterable<number>,
  frames: readonly HealthFrame[],
): void {
  if (frames.length === 0) return;
  for (const clientId of clientIds) {
    const socket = server.session(clientId)?.socket;
    if (!socket) continue;
    for (const frame of frames) {
      if (!clientSeesPawn(server, clientId, frame.entity)) continue;
      socket.send(encodeFrame(frame));
    }
  }
}
