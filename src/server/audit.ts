import { encodeFrame, type EngineWsServer } from "conveyor-engine-transport-ws";
import { AUDIT_FIELDS, type AuditFrame } from "../shared/audit.js";
import { sentFor } from "./health.js";

const sentAudit = new WeakMap<EngineWsServer, Map<number, { sessionId: number; key: string }>>();

/**
 * One host counter frame on the same socket as health.
 * @why Only to client sessions that have not seen these counts.
 */
export function deliverAuditFrame(server: EngineWsServer, frame: AuditFrame): void {
  if (server.connected.length === 0) return;
  const key = AUDIT_FIELDS.map((field) => frame[field]).join(",");
  let text: string | undefined;
  for (const clientId of server.connected) {
    const socket = server.session(clientId)?.socket;
    const sent = socket && sentFor(sentAudit, server, clientId, () => ({ key: "" }));
    if (!socket || !sent || sent.key === key) continue;
    sent.key = key;
    socket.send((text ??= encodeFrame(frame)));
  }
}
