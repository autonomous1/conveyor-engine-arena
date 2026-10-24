/**
 * `npm run bake:map`. Loads the installed game, opens a headless Chrome page
 * that builds the static Three.js scene, and writes one top-down PNG.
 * Three r186 needs WebGL2, which this Node process does not have, so the
 * render runs in Chrome. The game server is not started.
 */

import { build as bundle } from "esbuild";
import { spawn, type ChildProcess } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ArenaView } from "../shared/arena-view.ts";
import { MAP_BAKE_PATH, MAP_BAKE_PX } from "../shared/map-frame.ts";

const PNG_LIMIT = 32 * 1024 * 1024;
const BAKE_MS = 300_000;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".glb": "model/gltf-binary",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
};

const root = repoRoot();

const view = await loadView(root);
const pageJs = await bundlePage();
const png = await renderInChrome(view, pageJs);
if (png.length < 8 || png[0] !== 0x89 || png.toString("ascii", 1, 4) !== "PNG") {
  throw new Error("chrome returned a file that is not a png");
}
const out = join(root, MAP_BAKE_PATH);
await mkdir(dirname(out), { recursive: true });
await writeFile(out, png);
const served = join(root, "dist/web/assets");
if (existsSync(served)) await writeFile(join(served, "map-bake.png"), png);
console.log(`wrote ${MAP_BAKE_PATH} (${png.length} bytes, ${MAP_BAKE_PX}px)`);

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i += 1) {
    if (existsSync(join(dir, "web", "game", "arena.game.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("web/game/arena.game.json not found");
}

async function loadView(repo: string): Promise<ArenaView> {
  const file = join(repo, "dist/server/load-game.js");
  if (!existsSync(file)) throw new Error("dist/server/load-game.js is missing. Run npm run build:server first.");
  const mod = await import(pathToFileURL(file).href) as { loadInstalledGame: () => { view: ArenaView } };
  return mod.loadInstalledGame().view;
}

async function bundlePage(): Promise<string> {
  const result = await bundle({
    entryPoints: [join(root, "src/util/bake-map-page.ts")],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    write: false,
    legalComments: "none",
    logLevel: "silent",
  });
  const text = result.outputFiles?.[0]?.text;
  if (!text) throw new Error("esbuild produced no page bundle");
  return text;
}

async function renderInChrome(arena: ArenaView, script: string): Promise<Buffer> {
  const userDir = await mkdtemp(join(tmpdir(), "map-bake-"));
  const debugPort = await freePort();
  let chrome: ChildProcess | undefined;
  let http: Server | undefined;
  let socket: WebSocket | undefined;
  let stop = false;
  try {
    const posted = deferred<Buffer>();
    const server = await listen(arena, script, posted);
    http = server.http;
    chrome = launchChrome(chromeBin(), debugPort, userDir, server.port);
    let log = "";
    const note = (chunk: Buffer) => {
      log = (log + chunk.toString()).slice(-4000);
    };
    chrome.stdout?.on("data", note);
    chrome.stderr?.on("data", note);
    chrome.on("exit", (code) => {
      if (!stop) posted.reject(new Error(`chrome exited ${code ?? "signal"}\n${log}`));
    });
    const page = await waitForPage(debugPort);
    socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      socket?.addEventListener("open", () => resolve());
      socket?.addEventListener("error", () => reject(new Error("devtools socket failed")));
    });
    const cdp = cdpClient(socket);
    socket.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data)) as { method?: string; params?: { args?: Array<{ value?: unknown; description?: string }> } };
      if (msg.method !== "Runtime.consoleAPICalled") return;
      const text = (msg.params?.args ?? []).map((arg) => arg.value ?? arg.description ?? "").join(" ");
      if (text) console.log("page:", text);
    });
    await cdp.send("Runtime.enable");
    const watch = (async () => {
      try {
        while (!stop) {
          const status = await readStatus(cdp);
          if (status.startsWith("error:")) throw new Error(status.slice("error:".length).trim());
          await sleep(400);
        }
      } catch (err) {
        if (!stop) throw err;
      }
    })();
    const timeout = sleep(BAKE_MS).then(() => {
      if (!stop) throw new Error("bake timed out");
    });
    const png = await Promise.race([posted.promise, watch, timeout]);
    if (!Buffer.isBuffer(png)) throw new Error("bake produced no png");
    return png;
  } finally {
    stop = true;
    socket?.close();
    if (chrome) await stopChrome(chrome);
    if (http) {
      http.closeAllConnections?.();
      await new Promise<void>((resolve) => http?.close(() => resolve()));
    }
    await rm(userDir, { recursive: true, force: true });
  }
}

function listen(
  arena: ArenaView,
  script: string,
  posted: Deferred<Buffer>,
): Promise<{ http: Server; port: number }> {
  const viewJson = JSON.stringify(arena);
  const html = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:#000}</style><script type="module" src="/bake.js"></script>`;
  const web = resolve(root, "web");
  const http = createServer((req, res) => {
    void handle(req, res, web, html, script, viewJson, posted).catch((err) => {
      if (!res.headersSent) res.writeHead(500);
      res.end(err instanceof Error ? err.message : String(err));
    });
  });
  return new Promise((resolve, reject) => {
    http.once("error", reject);
    http.listen(0, "127.0.0.1", () => {
      const addr = http.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ http, port });
    });
  });
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  web: string,
  html: string,
  script: string,
  viewJson: string,
  posted: Deferred<Buffer>,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (req.method === "POST" && url.pathname === "/png") {
    const body = await readBody(req, PNG_LIMIT);
    res.writeHead(204);
    res.end();
    posted.resolve(body);
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405);
    res.end();
    return;
  }
  if (url.pathname === "/" || url.pathname === "/index.html") {
    send(res, 200, html, "text/html; charset=utf-8");
    return;
  }
  if (url.pathname === "/bake.js") {
    send(res, 200, script, "text/javascript; charset=utf-8");
    return;
  }
  if (url.pathname === "/view.json") {
    send(res, 200, viewJson, "application/json");
    return;
  }
  if (url.pathname === "/favicon.ico") {
    res.writeHead(204);
    res.end();
    return;
  }
  let rel: string;
  try {
    rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
  } catch {
    send(res, 400, "bad path", "text/plain; charset=utf-8");
    return;
  }
  if (rel.includes("\0") || rel.split("/").includes("..")) {
    send(res, 400, "bad path", "text/plain; charset=utf-8");
    return;
  }
  const basisName = rel.startsWith("assets/basis/") ? rel.slice("assets/basis/".length) : "";
  const basisFile =
    basisName === "basis_transcoder.js" || basisName === "basis_transcoder.wasm"
      ? resolve(root, "node_modules/three/examples/jsm/libs/basis", basisName)
      : undefined;
  const file = basisFile ?? resolve(web, rel);
  const fromWeb = relative(web, file);
  if (!basisFile && (fromWeb.startsWith("..") || fromWeb.includes(`..${sep}`) || fromWeb === "")) {
    send(res, 403, "forbidden", "text/plain; charset=utf-8");
    return;
  }
  let info;
  try {
    info = await stat(file);
  } catch {
    console.warn("404", rel);
    send(res, 404, "not found", "text/plain; charset=utf-8");
    return;
  }
  if (!info.isFile()) {
    send(res, 404, "not found", "text/plain; charset=utf-8");
    return;
  }
  const type = TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
  res.writeHead(200, { "content-type": type, "content-length": info.size, "cache-control": "no-store" });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(file).pipe(res);
}

function send(res: ServerResponse, status: number, body: string, type: string): void {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("png too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function launchChrome(bin: string, debugPort: number, userDir: string, pagePort: number): ChildProcess {
  return spawn(bin, [
    "--headless=new",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${userDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-sync",
    "--disable-background-networking",
    "--mute-audio",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    "--window-size=256,256",
    `http://127.0.0.1:${pagePort}/`,
  ], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
}

function chromeBin(): string {
  const fromEnv = process.env.CHROME_PATH;
  if (fromEnv) return fromEnv;
  for (const candidate of ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium"]) {
    if (existsSync(candidate)) return candidate;
  }
  return "google-chrome";
}

async function waitForPage(port: number): Promise<{ webSocketDebuggerUrl: string }> {
  const deadline = Date.now() + 20_000;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (res.ok) {
        const list = await res.json() as Array<{ type?: string; webSocketDebuggerUrl?: string }>;
        const page = list.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
        if (page?.webSocketDebuggerUrl) return { webSocketDebuggerUrl: page.webSocketDebuggerUrl };
      } else {
        last = `devtools ${res.status}`;
      }
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await sleep(100);
  }
  throw new Error(`chrome devtools did not open (${last})`);
}

type Cdp = { send(method: string, params?: object): Promise<Record<string, unknown>> };

function cdpClient(ws: WebSocket): Cdp {
  let next = 0;
  const pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (err: Error) => void }>();
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(String(ev.data)) as { id?: number; result?: Record<string, unknown>; error?: { message?: string } };
    if (msg.id === undefined || !pending.has(msg.id)) return;
    const slot = pending.get(msg.id)!;
    pending.delete(msg.id);
    if (msg.error) slot.reject(new Error(msg.error.message ?? "cdp error"));
    else slot.resolve(msg.result ?? {});
  });
  return {
    send(method, params) {
      const id = ++next;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
  };
}

async function readStatus(cdp: Cdp): Promise<string> {
  const result = await cdp.send("Runtime.evaluate", {
    expression: "globalThis.__mapBakeStatus ?? ''",
    returnByValue: true,
  });
  const remote = result.result as { value?: unknown } | undefined;
  return typeof remote?.value === "string" ? remote.value : "";
}

async function stopChrome(proc: ChildProcess): Promise<void> {
  if (proc.pid === undefined || proc.exitCode !== null) return;
  try { process.kill(-proc.pid, "SIGTERM"); } catch { /* already gone */ }
  await sleep(400);
  if (proc.exitCode !== null) return;
  try { process.kill(-proc.pid, "SIGKILL"); } catch { /* already gone */ }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (err: Error) => void };

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  let reject: (err: Error) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
