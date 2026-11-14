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
export const WebSocket = nodeOnly;
export const WebSocketServer = nodeOnly;
export const readFile = nodeOnly;
export const isAbsolute = nodeOnly;
export const normalize = nodeOnly;
export const relative = nodeOnly;
export const resolve = nodeOnly;
export const sep = "/";
