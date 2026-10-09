import { createServer, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { decodeFrame, encodeFrame, EngineWsServer } from "conveyor-engine-transport-ws";
import type { TransportSocket } from "conveyor-engine-transport-ws";
import { createArenaFire } from "./fire.js";
import { createHeldInputs, startWanderLoop } from "./game.js";
import { createHostSocketPaths } from "./host-path.js";
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

function socketFromWs(
  ws: WebSocket,
  refused: Set<number>,
  drop: (clientId: number) => void,
  onArena: (socket: TransportSocket, frame: unknown) => void,
): TransportSocket {
  const messages: Array<(text: string) => void> = [];
  const closes: Array<() => void> = [];
  const wire = (data: Buffer | ArrayBuffer | Buffer[] | string): string =>
    typeof data === "string" ? data : Buffer.from(data as Buffer).toString("utf8");
  let self: TransportSocket | undefined;
  const paths = createHostSocketPaths({
    writeWire(text) {
      if (ws.readyState !== ws.OPEN) return;
      const clientId = refusedWelcome(text, refused);
      if (clientId === undefined) {
        ws.send(text);
        return;
      }
      refused.delete(clientId);
      ws.send(encodeFrame({ v: 1, type: "reject", reason: "no free pawn", code: "SERVER_FULL" }));
      drop(clientId);
    },
    onEngineText(text) {
      for (const handler of messages) handler(text);
    },
    onArenaFrame(frame) {
      if (self) onArena(self, frame);
    },
  });
  ws.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
    paths.deliverEncoded(wire(data));
  });
  ws.on("close", () => {
    paths.close();
    for (const handler of closes) handler();
  });
  self = {
    send(text) {
      paths.sendEncoded(text);
    },
    close() {
      paths.close();
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close();
    },
    onMessage(handler) {
      messages.push(handler);
    },
    onClose(handler) {
      closes.push(handler);
    },
  };
  return self;
}

function clientIdFor(engine: EngineWsServer, socket: TransportSocket): number | undefined {
  for (const clientId of engine.connected) {
    if (engine.session(clientId)?.socket === socket) return clientId;
  }
  return undefined;
}

export type ArenaHost = {
  port: number;
  url: string;
  close: () => Promise<void>;
};

function refusedWelcome(text: string, refused: Set<number>): number | undefined {
  try {
    const frame = decodeFrame(text) as { type?: string; clientId?: number };
    if (frame.type === "welcome" && typeof frame.clientId === "number" && refused.has(frame.clientId)) return frame.clientId;
  } catch {
    return undefined;
  }
  return undefined;
}

export async function startArenaServer(port = Number(process.env.PORT ?? 4173)): Promise<ArenaHost> {
  const loaded = loadArena();
  const held = createHeldInputs();
  const refused = new Set<number>();
  const engine: EngineWsServer = new EngineWsServer({
    compatibility: { protocol: 1, world: loaded.view.world },
    bundle: { bundleId: loaded.view.bundleId, authoritativeHash: loaded.view.authoritativeHash },
    onHello: (session): number | undefined => {
      const used = new Set<number>();
      for (const clientId of engine.connected) {
        if (clientId === session.clientId) continue;
        const record = engine.gateway.get(clientId);
        if (record?.connected && record.ownedEntity !== undefined) used.add(record.ownedEntity);
      }
      const previous = engine.gateway.get(session.clientId);
      if (previous?.connected && previous.ownedEntity !== undefined && !used.has(previous.ownedEntity)) {
        return previous.ownedEntity;
      }
      const free = loaded.agents.find((agent) => !used.has(agent.id))?.id;
      if (free === undefined) refused.add(session.clientId);
      return free;
    },
    onAdmit: (input) => {
      const owned = engine.gateway.get(input.clientId)?.ownedEntity;
      if (owned === undefined) return;
      held.admit(owned, { moveX: input.moveX, moveZ: input.moveZ, yaw: input.yaw, seq: input.seq, clip:"" });
    },
  });
  const stopLoop = startWanderLoop(loaded.world, loaded.agents, engine, held, (line) => console.error(line));
  const fire = createArenaFire({
    world: loaded.world,
    server: engine,
    send(clientId, frame) {
      engine.session(clientId)?.socket.send(encodeFrame(frame));
    },
  });
  const arenaJson = JSON.stringify(loaded.view);

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
    engine.attach(socketFromWs(ws, refused, (clientId) => engine.disconnect(clientId), (socket, frame) => {
      const clientId = clientIdFor(engine, socket);
      if (clientId === undefined) return;
      try {
        fire.onFrame(clientId, frame);
      } catch (err) {
        console.error("fire threw", err);
      }
    }));
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
        stopLoop();
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
