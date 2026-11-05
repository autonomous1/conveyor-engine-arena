import { createServer, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { createArenaHost, type HostConn } from "./arena-host.js";
import { loadArena } from "./world-loader.js";

const webRoot = fileURLToPath(new URL("../../dist/web/", import.meta.url));

const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".webp": "image/webp",
  ".glb": "model/gltf-binary",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function fileUnderWeb(rel: string): string | undefined {
  const clean = rel.replace(/^\/+/, "");
  if (clean === "" || clean.includes("\0") || clean.split("/").includes("..")) return undefined;
  const file = resolve(webRoot, clean);
  const fromRoot = relative(webRoot, file);
  if (fromRoot.startsWith("..") || fromRoot === "") return undefined;
  if (extname(file) === ".map") return undefined;
  return file;
}

function send(res: ServerResponse, status: number, body: string | Uint8Array, contentType: string): void {
  res.writeHead(status, { "content-type": contentType, "cache-control": "no-store" });
  res.end(body);
}

function decodeWsData(data: Buffer | ArrayBuffer | Buffer[] | string): string {
  return typeof data === "string" ? data : Buffer.from(data as Buffer).toString("utf8");
}

function connFromWs(ws: WebSocket): HostConn {
  const texts: Array<(text: string) => void> = [];
  const closes: Array<() => void> = [];
  ws.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
    const text = decodeWsData(data);
    for (const handler of texts) handler(text);
  });
  ws.on("close", () => {
    for (const handler of closes) handler();
  });
  return {
    send(text) {
      if (ws.readyState === ws.OPEN) ws.send(text);
    },
    close() {
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close();
    },
    onText(handler) {
      texts.push(handler);
    },
    onClose(handler) {
      closes.push(handler);
    },
    isOpen() {
      return ws.readyState === ws.OPEN;
    },
  };
}

export type ArenaHost = {
  port: number;
  url: string;
  close: () => Promise<void>;
};

export async function startArenaServer(port = Number(process.env.PORT ?? 4173), holdNpcs = false): Promise<ArenaHost> {
  const loaded = loadArena();
  const host = createArenaHost(loaded, { holdNpcs });
  const arenaJson = host.arenaJson;

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/arena.json") {
      send(res, 200, arenaJson, "application/json");
      return;
    }
    const rel = url.pathname === "/" ? "index.html" : url.pathname;
    const file = fileUnderWeb(rel);
    if (!file) {
      send(res, 404, "not found", "text/plain; charset=utf-8");
      return;
    }
    try {
      const info = await stat(file);
      if (!info.isFile()) {
        send(res, 404, "not found", "text/plain; charset=utf-8");
        return;
      }
      const bytes = await readFile(file);
      send(res, 200, bytes, types[extname(file)] ?? "application/octet-stream");
    } catch {
      send(res, 404, "not found", "text/plain; charset=utf-8");
    }
  });

  const wss = new WebSocketServer({ server: httpServer });
  wss.on("connection", (ws) => {
    host.attach(connFromWs(ws));
  });

  await new Promise<void>((resolveListen, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, "127.0.0.1", () => resolveListen());
  });
  const address = httpServer.address();
  const bound = typeof address === "object" && address ? address.port : port;

  return {
    port: bound,
    url: `http://127.0.0.1:${bound}`,
    close: () =>
      new Promise((resolveClose, reject) => {
        host.stop();
        wss.close();
        httpServer.close((err) => (err ? reject(err) : resolveClose()));
      }),
  };
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const host = await startArenaServer();
  console.log(JSON.stringify({ url: host.url, ws: host.url.replace(/^http/, "ws") }));
}
