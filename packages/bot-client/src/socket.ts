// ARCHITECTURE: The minimal socket shape the bot connection needs, independent of ws or the browser WebSocket.
// Wiring: connection.ts and node-socket.ts implement or satisfy it.
/**
 * The slice of a browser WebSocket that the bot connection uses.
 * `ws` satisfies it. This file does not import `ws` or any Node builtin.
 */
export type SocketEvent = {
  data?: unknown;
  code?: number;
  reason?: unknown;
};

/**
 * The browser WebSocket surface the bot connection uses; `ws` satisfies it.
 */
export type SocketLike = {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, handler: (ev: SocketEvent) => void): void;
};
