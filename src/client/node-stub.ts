// ARCHITECTURE: Stand-in for Node built-ins that kernel barrels import and the
//   solo host never calls.
// Wiring: no importer; the solo build aliases `node:http`, `ws`,
//   `node:fs/promises`, and `node:path` here.
/**
 * Stand-in for Node built-ins that kernel barrels import and the solo host never calls.
 * esbuild aliases `node:http`, `ws`, `node:fs/promises`, and `node:path` here.
 */
const nodeOnly = (): never => {
  throw new Error("node-only");
};

export default {};
/**
 * Web Socket.
 */
export const WebSocket = nodeOnly;
/**
 * Web Socket Server.
 */
export const WebSocketServer = nodeOnly;
/**
 * read File.
 */
export const readFile = nodeOnly;
/**
 * True when is Absolute.
 */
export const isAbsolute = nodeOnly;
/**
 * normalize.
 */
export const normalize = nodeOnly;
/**
 * relative.
 */
export const relative = nodeOnly;
/**
 * resolve.
 */
export const resolve = nodeOnly;
/**
 * sep.
 */
export const sep = "/";
