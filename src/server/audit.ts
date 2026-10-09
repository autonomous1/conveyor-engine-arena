import { encodeFrame, type EngineWsServer } from "conveyor-engine-transport-ws";
import type { AuditFrame } from "../shared/audit.js";

/** One host counter frame on the same socket as health. Every connected client. */
export function deliverAuditFrame(server: EngineWsServer, frame: AuditFrame): void {
  const text = encodeFrame(frame);
  for (const clientId of server.connected) {
    const socket = server.session(clientId)?.socket;
    if (!socket) continue;
    socket.send(text);
  }
}
