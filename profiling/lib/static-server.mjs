import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";

const types = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp",
  ".glb": "model/gltf-binary", ".ktx2": "image/ktx2", ".wasm": "application/wasm", ".map": "application/json",
  ".bin": "application/octet-stream", ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".wav": "audio/wav", ".opus": "audio/ogg",
};

/** Same behavior as scripts/serve-solo.mjs, on 127.0.0.1 and a chosen (or random) port. */
export function serveDir(dir, port = 0) {
  const root = resolve(dir);
  const server = http.createServer(async (req, res) => {
    try {
      const url = decodeURIComponent(new URL(req.url, "http://x").pathname);
      let file = normalize(join(root, url));
      if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
      if ((await stat(file).catch(() => null))?.isDirectory()) file = join(file, "index.html");
      const body = await readFile(file);
      res.writeHead(200, { "Content-Type": types[extname(file).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-cache" });
      res.end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  return new Promise((res, rej) => {
    server.once("error", rej);
    server.listen(port, "127.0.0.1", () => res({ url: `http://127.0.0.1:${server.address().port}/`, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) }));
  });
}
