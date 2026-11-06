import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path, { extname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { authMode, checkHelloAuth, checkQaSnapshotAuth, checkSceneGraphAuth, type AuthMode } from "./auth/gate.js";
import { createRevocationList, loadVerifier, type RevocationList } from "./auth/tokens.js";
import { createArenaHost, type HostConn } from "./arena-host.js";
import { nodeGameFiles } from "./game-files-node.js";
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

/** Raw PNG uploads. Larger than this is rejected and not written. */
const QA_SNAP_MAX = 4_000_000;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function isPngContentType(value: string | string[] | undefined): boolean {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return false;
  return raw.split(";")[0]?.trim().toLowerCase() === "image/png";
}

function isPng(body: Buffer): boolean {
  return body.length >= PNG_SIGNATURE.length && body.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
}

/** Read at most `max` bytes. Over the limit, or a socket error, returns undefined and keeps no bytes. */
function readLimited(req: IncomingMessage, max: number): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let over = false;
    let done = false;
    const finish = (body: Buffer | undefined) => {
      if (done) return;
      done = true;
      resolve(body);
    };
    req.on("data", (chunk: Buffer | string) => {
      if (done || over) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > max) {
        over = true;
        chunks.length = 0;
        return;
      }
      chunks.push(buf);
    });
    req.on("end", () => finish(over ? undefined : Buffer.concat(chunks)));
    req.on("error", () => finish(undefined));
  });
}

/** `<webRoot>/qa-snaps/<uuid>.png`. The id is server-chosen. An existing file gets a new id. */
async function writeQaSnapshot(body: Buffer): Promise<{ id: string; file: string }> {
  await mkdir(join(webRoot, "qa-snaps"), { recursive: true });
  for (let attempt = 0; attempt < 8; attempt++) {
    const id = randomUUID();
    const file = fileUnderWeb(`qa-snaps/${id}.png`);
    if (!file) continue;
    try {
      await writeFile(file, body, { flag: "wx" });
      return { id, file };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw err;
    }
  }
  throw new Error("qa snapshot id");
}

function send(
  res: ServerResponse,
  status: number,
  body: string | Uint8Array,
  contentType: string,
  extra?: Record<string, string>,
): void {
  res.writeHead(status, { "content-type": contentType, "cache-control": "no-store", ...extra });
  res.end(body);
}

function decodeWsData(data: Buffer | ArrayBuffer | Buffer[] | string): string {
  return typeof data === "string" ? data : Buffer.from(data as Buffer).toString("utf8");
}

type AuthGate = {
  mode: AuthMode;
  pub?: CryptoKey;
  revoked: RevocationList;
};

const AUTH_QUEUE_MAX = 8;
const AUTH_VERIFY_MS = 5_000;

/** One line. A subject cannot break the log or hide the fact that the key itself is absent. */
function logField(value: string): string {
  return value.replace(/[\r\n]/g, " ");
}

function peerIp(req: IncomingMessage): string {
  const addr = req.socket.remoteAddress;
  return addr && addr.length > 0 ? addr : "unknown";
}

/**
 * Fail fast when auth is required and the verify key cannot be read.
 * A missing revocation file revokes nothing. Unset `ARENA_REVOKED_FILE` uses the CLI default path.
 */
export async function openAuthGate(env: NodeJS.ProcessEnv = process.env): Promise<AuthGate> {
  const mode = authMode(env);
  const keyFile = env.ARENA_VERIFY_KEY_FILE?.trim() ?? "";
  if (mode === "required" && keyFile === "") throw new Error("ARENA_AUTH=required needs ARENA_VERIFY_KEY_FILE");
  // Auth-off still loads a key when one is set, so GET /scene-graph.json can verify a Bearer.
  if (keyFile === "") return { mode, revoked: { has: () => false } };
  let pub: CryptoKey;
  try {
    pub = await loadVerifier(keyFile);
  } catch (err) {
    if (mode === "off") return { mode, revoked: { has: () => false } };
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`ARENA_AUTH=required could not load ARENA_VERIFY_KEY_FILE (${keyFile}): ${detail}`);
  }
  const revokedFile = env.ARENA_REVOKED_FILE?.trim() || path.join(homedir(), ".config", "ce-arena", "revoked.json");
  return { mode, pub, revoked: createRevocationList(revokedFile) };
}

function withAuthRequired(raw: string, required: boolean): string {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  parsed.authRequired = required;
  return JSON.stringify(parsed);
}

function connFromWs(ws: WebSocket, gate: AuthGate, ip: string): HostConn {
  const texts: Array<(text: string) => void> = [];
  const closes: Array<() => void> = [];
  const queued: string[] = [];
  let admitted = gate.mode === "off";
  let closed = false;
  let checking = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const deliver = (text: string) => {
    for (const handler of texts) handler(text);
  };
  const disarm = () => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
  };
  const fail = (code: 4401 | 4403, reason: string) => {
    if (closed) return;
    closed = true;
    disarm();
    console.log(`[auth] reject code=${logField(reason)} ip=${logField(ip)}`);
    try {
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close(code, reason);
    } catch {
      // The peer already went away.
    }
  };
  const conn: HostConn = {
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
  const admit = (claims?: HostConn["claims"]) => {
    if (closed || admitted) return;
    admitted = true;
    disarm();
    if (claims) {
      conn.claims = claims;
      console.log(`[auth] ok sub=${logField(claims.sub)} role=${logField(claims.role)}`);
    }
    const pending = queued.splice(0);
    for (const text of pending) deliver(text);
  };
  const consider = () => {
    if (closed || admitted || checking || queued.length === 0) return;
    // Start at the first frame, not at accept. The browser sends hello from
    // onopen, and that callback can sit behind the first long render.
    if (timer === undefined) timer = setTimeout(() => fail(4401, "timeout"), AUTH_VERIFY_MS);
    checking = true;
    const first = queued[0]!;
    void checkHelloAuth(first, gate).then((result) => {
      checking = false;
      if (closed) return;
      if (!result.ok) {
        fail(result.code, result.reason);
        return;
      }
      admit(result.claims);
    }).catch(() => {
      checking = false;
      fail(4401, "bad-claims");
    });
  };

  ws.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
    if (closed) return;
    const text = decodeWsData(data);
    if (admitted) {
      deliver(text);
      return;
    }
    queued.push(text);
    if (queued.length > AUTH_QUEUE_MAX) {
      fail(4401, "timeout");
      return;
    }
    consider();
  });
  ws.on("close", () => {
    closed = true;
    disarm();
    for (const handler of closes) handler();
  });
  return conn;
}

export type ArenaHost = {
  port: number;
  url: string;
  close: () => Promise<void>;
};

export type ArenaServerOptions = {
  /** Disk arena root. `ARENA_GAME_ROOT` is the fallback. Omit both to load the installed game. */
  gameRoot?: string;
};

export async function startArenaServer(
  port = Number(process.env.PORT ?? 4173),
  holdNpcs = false,
  opts?: ArenaServerOptions,
): Promise<ArenaHost> {
  const gate = await openAuthGate();
  const gameRoot = opts?.gameRoot || process.env.ARENA_GAME_ROOT || undefined;
  const loaded = gameRoot ? loadArena(nodeGameFiles(gameRoot)) : loadArena();
  const host = createArenaHost(loaded, { holdNpcs });
  await host.sceneGraphReady;
  const arenaJson = withAuthRequired(host.arenaJson, gate.mode === "required");

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/arena.json") {
      send(res, 200, arenaJson, "application/json");
      return;
    }
    if (url.pathname === "/scene-graph.json") {
      const header = req.headers.authorization;
      const result = await checkSceneGraphAuth(Array.isArray(header) ? header[0] : header, gate);
      if (!result.ok) {
        send(res, result.status, result.status === 401 ? "unauthorized" : "forbidden", "text/plain; charset=utf-8");
        return;
      }
      const body = host.sceneGraphJson;
      const hash = host.sceneGraphHash;
      if (!body || !hash) {
        send(res, 404, "not found", "text/plain; charset=utf-8");
        return;
      }
      send(res, 200, body, "application/json", { etag: `"${hash}"` });
      return;
    }
    if (url.pathname === "/regions.json") {
      const header = req.headers.authorization;
      const result = await checkSceneGraphAuth(Array.isArray(header) ? header[0] : header, gate);
      if (!result.ok) {
        send(res, result.status, result.status === 401 ? "unauthorized" : "forbidden", "text/plain; charset=utf-8");
        return;
      }
      const body = host.regionsJson;
      const hash = host.regionsHash;
      if (!body || !hash) {
        send(res, 404, "not found", "text/plain; charset=utf-8");
        return;
      }
      send(res, 200, body, "application/json", { etag: `"${hash}"` });
      return;
    }
    if (req.method === "POST" && url.pathname === "/qa/snapshots") {
      try {
        const header = req.headers.authorization;
        const auth = await checkQaSnapshotAuth(Array.isArray(header) ? header[0] : header, gate);
        const uploaded = await readLimited(req, QA_SNAP_MAX);
        if (!auth.ok) {
          send(res, auth.status, auth.status === 401 ? "unauthorized" : "forbidden", "text/plain; charset=utf-8");
          return;
        }
        if (!isPngContentType(req.headers["content-type"]) || !uploaded || !isPng(uploaded)) {
          send(res, 400, "invalid", "text/plain; charset=utf-8");
          return;
        }
        const saved = await writeQaSnapshot(uploaded);
        send(res, 200, JSON.stringify({ ok: true, id: saved.id, url: `/qa-snaps/${saved.id}.png` }), "application/json");
      } catch {
        if (!res.headersSent) send(res, 500, "unavailable", "text/plain; charset=utf-8");
      }
      return;
    }
    const rel = url.pathname === "/" ? "index.html" : url.pathname === "/play" ? "landing-page.html" : url.pathname;
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
  wss.on("connection", (ws, req) => {
    host.attach(connFromWs(ws, gate, peerIp(req)));
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
