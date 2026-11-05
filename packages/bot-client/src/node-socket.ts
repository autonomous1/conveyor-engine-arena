import WebSocket from "ws";
import type { SocketLike } from "./socket.js";

/** Node entry. The connection module does not import this. */
export function openNodeSocket(url: string): SocketLike {
  return new WebSocket(url) as unknown as SocketLike;
}
