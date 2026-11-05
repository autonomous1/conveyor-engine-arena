import { memoryPair, type TransportSocket } from "conveyor-engine-transport-ws";
import type { ArenaView } from "../shared/arena-view.js";
import { createArenaHost, type HostConn } from "../server/arena-host.js";
import { preloadGameFiles } from "../server/game-files-fetch.js";
import { loadArena } from "../server/world-loader.js";
import type { WebSocketLike } from "./net.js";

const OPEN = 1;
const CLOSED = 3;

/** In-tab host. The page loads `game/` and `assets/` relative to itself. */
export async function startSolo(): Promise<{ view: ArenaView; open: () => WebSocketLike }> {
  const params = new URLSearchParams(location.search);
  const files = await preloadGameFiles("./");
  const loaded = loadArena(files, { ARENA_NOCLIP: params.get("noclip") ?? undefined });
  rewriteAssetUris(loaded.view);
  const host = createArenaHost(loaded);
  const view = JSON.parse(host.arenaJson) as ArenaView;
  const pair = memoryPair();
  host.attach(hostConn(pair.server));
  return {
    view,
    open() {
      return browserSocket(pair.client);
    },
  };
}

function hostConn(sock: TransportSocket): HostConn {
  let open = true;
  return {
    send(text) {
      if (open) sock.send(text);
    },
    close() {
      open = false;
      sock.close();
    },
    onText(handler) {
      sock.onMessage(handler);
    },
    onClose(handler) {
      sock.onClose(() => {
        open = false;
        handler();
      });
    },
    isOpen() {
      return open;
    },
  };
}

function browserSocket(client: TransportSocket): WebSocketLike {
  let readyState = 0;
  const socket: WebSocketLike = {
    get readyState() {
      return readyState;
    },
    OPEN,
    send(data) {
      client.send(data);
    },
    close() {
      readyState = CLOSED;
      client.close();
    },
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  client.onMessage((text) => {
    socket.onmessage?.({ data: text });
  });
  client.onClose(() => {
    readyState = CLOSED;
    socket.onclose?.({});
  });
  queueMicrotask(() => {
    if (readyState === CLOSED) return;
    readyState = OPEN;
    socket.onopen?.({});
  });
  return socket;
}

function isAssetUri(uri: string): boolean {
  return uri.charCodeAt(0) === 47 && uri.startsWith("assets/", 1);
}

/** The compiled view stores absolute asset uris. Solo pages load them relative to the document. */
function rewriteAssetUris(value: unknown): void {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const item = value[index];
      if (typeof item === "string" && isAssetUri(item)) value[index] = `./${item.slice(1)}`;
      else rewriteAssetUris(item);
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const item = record[key];
    if (typeof item === "string" && isAssetUri(item)) record[key] = `./${item.slice(1)}`;
    else rewriteAssetUris(item);
  }
}
