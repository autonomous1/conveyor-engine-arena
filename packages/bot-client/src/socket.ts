/**
 * The slice of a browser WebSocket that the bot connection uses.
 * `ws` satisfies it. This file does not import `ws` or any Node builtin.
 */
export type SocketEvent = {
  data?: unknown;
  code?: number;
  reason?: unknown;
};

export type SocketLike = {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, handler: (ev: SocketEvent) => void): void;
};
