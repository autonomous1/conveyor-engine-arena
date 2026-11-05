/**
 * Synchronous reads of the installed game. `text` refs are manifest paths
 * such as `./web/game/bounds.json`. `bytes` uris are `/assets/...`.
 * Both return undefined when the file is absent. A path that is not allowed throws.
 */
export type GameFiles = {
  text(ref: string): string | undefined;
  bytes(uri: string): Uint8Array | undefined;
};
