import assert from "node:assert/strict";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadSigner, mint } from "../src/server/auth/tokens.ts";
import { startArenaServer } from "../dist/server/main.js";

const HOUR_S = 60 * 60;
const webRoot = fileURLToPath(new URL("../dist/web/", import.meta.url));
const snapDir = path.join(webRoot, "qa-snaps");

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function exportPem(key: KeyObject, type: "pkcs8" | "spki"): string {
  const pem = key.export({ type, format: "pem" });
  if (typeof pem !== "string") throw new Error(`expected ${type} PEM text`);
  return pem;
}

async function withEnv(values: Record<string, string | undefined>, run: () => Promise<void>): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function snapNames(): string[] {
  try {
    return readdirSync(snapDir).filter((name) => name.endsWith(".png")).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

function rawPost(
  port: number,
  urlPath: string,
  body: Buffer,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: "127.0.0.1",
      port,
      path: urlPath,
      method: "POST",
      headers: { ...headers, "content-length": String(body.length) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("POST /qa/snapshots writes a public png and rejects the rest", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "arena-qa-snap-"));
  const keyFile = path.join(dir, "ed25519.key.pem");
  const pubFile = path.join(dir, "ed25519.pub.pem");
  const pair = generateKeyPairSync("ed25519");
  writeFileSync(keyFile, exportPem(pair.privateKey, "pkcs8"), { mode: 0o600 });
  writeFileSync(pubFile, exportPem(pair.publicKey, "spki"));
  const signer = await loadSigner(keyFile);
  const qa = await mint(signer, { sub: "qa-teleport", role: "qa", scope: ["qa"], ttlS: HOUR_S });
  const player = await mint(signer, { sub: "qa-teleport", role: "player", ttlS: HOUR_S });
  const before = snapNames();
  const created: string[] = [];

  try {
    await withEnv({
      ARENA_AUTH: undefined,
      ARENA_VERIFY_KEY_FILE: pubFile,
      ARENA_REVOKED_FILE: path.join(dir, "revoked.json"),
    }, async () => {
      const host = await startArenaServer(0, true);
      try {
        const post = (body: Buffer, headers: Record<string, string>) => fetch(`${host.url}/qa/snapshots`, {
          method: "POST",
          headers,
          body,
        });
        const qaHeaders = { authorization: `Bearer ${qa.token}`, "content-type": "image/png" };

        const refused = async (label: string, status: number, run: () => Promise<Response>) => {
          const names = snapNames();
          const res = await run();
          assert.equal(res.status, status, label);
          assert.deepEqual(snapNames(), names, label);
          return res;
        };

        const missing = await refused("no authorization", 401, () => post(PNG, { "content-type": "image/png" }));
        assert.equal(await missing.text(), "unauthorized");

        const forbidden = await refused("scope without qa", 403, () => post(PNG, {
          authorization: `Bearer ${player.token}`,
          "content-type": "image/png",
        }));
        assert.equal(await forbidden.text(), "forbidden");

        const notPng = await refused("not a png", 400, () => post(Buffer.from("not a png"), qaHeaders));
        assert.equal(await notPng.text(), "invalid");

        const huge = Buffer.alloc(4_000_001);
        PNG.copy(huge);
        const tooBig = await refused("over 4000000 bytes", 400, () => post(huge, qaHeaders));
        assert.equal(await tooBig.text(), "invalid");

        const names = snapNames();
        const escaped = await rawPost(host.port, "/qa/snapshots/../secrets.png", PNG, qaHeaders);
        assert.equal(escaped.status, 404);
        assert.equal(escaped.body, "not found");
        assert.equal(escaped.body.includes("\"ok\""), false);
        assert.deepEqual(snapNames(), names);
        assert.equal(existsSync(path.join(webRoot, "secrets.png")), false);
        assert.equal(existsSync(path.join(webRoot, "qa", "secrets.png")), false);

        const res = await post(PNG, qaHeaders);
        assert.equal(res.status, 200);
        assert.equal(res.headers.get("content-type"), "application/json");
        const payload = await res.json() as { ok?: unknown; id?: unknown; url?: unknown };
        assert.equal(payload.ok, true);
        assert.equal(typeof payload.id, "string");
        assert.match(String(payload.id), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
        const id = String(payload.id);
        assert.equal(payload.url, `/qa-snaps/${id}.png`);
        created.push(id);
        const disk = readFileSync(path.join(snapDir, `${id}.png`));
        assert.ok(disk.equals(PNG));
        const got = await fetch(`${host.url}/qa-snaps/${id}.png`);
        assert.equal(got.status, 200);
        assert.equal(got.headers.get("content-type"), "image/png");
        assert.ok(Buffer.from(await got.arrayBuffer()).equals(PNG));
      } finally {
        await host.close();
      }
    });
  } finally {
    for (const id of created) {
      try {
        unlinkSync(path.join(snapDir, `${id}.png`));
      } catch {
        // already gone
      }
    }
    for (const name of snapNames()) {
      if (!before.includes(name)) unlinkSync(path.join(snapDir, name));
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
