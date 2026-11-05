import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, type KeyObject } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SignJWT } from "jose";
import { loadSigner, mint } from "../src/server/auth/tokens.ts";
import { startArenaServer } from "../dist/server/main.js";

const HOUR_S = 60 * 60;

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

type ArenaHello = { world: string; bundleId: string; authoritativeHash: string; authRequired?: boolean };

async function arenaOf(url: string): Promise<ArenaHello> {
  const res = await fetch(`${url}/arena.json`);
  assert.equal(res.status, 200);
  return await res.json() as ArenaHello;
}

function hello(view: ArenaHello, auth?: string): Record<string, unknown> {
  return {
    v: 1,
    type: "hello",
    protocol: 1,
    world: view.world,
    bundleId: view.bundleId,
    authoritativeHash: view.authoritativeHash,
    ...(auth !== undefined ? { auth } : {}),
  };
}

type HelloResult = { kind: "welcome" } | { kind: "close"; code: number; reason: string };

function helloResult(url: string, body: Record<string, unknown>): Promise<HelloResult> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url.replace(/^http/, "ws"));
    let settled = false;
    const finish = (result: HelloResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
      try {
        ws.close();
      } catch {
        // already closing
      }
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        // already closing
      }
      reject(new Error("no welcome or close"));
    }, 4_000);
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data)) as { type?: string };
      if (msg.type === "welcome") finish({ kind: "welcome" });
    });
    ws.addEventListener("close", (ev) => {
      finish({ kind: "close", code: ev.code, reason: ev.reason });
    });
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify(body));
    });
  });
}

function show(item: unknown): string {
  if (typeof item === "string") return item;
  if (item instanceof Error) return item.stack ?? item.message;
  try {
    return JSON.stringify(item);
  } catch {
    return String(item);
  }
}

function captureLogs(): { text(): string; restore(): void } {
  const lines: string[] = [];
  const orig = { log: console.log, error: console.error, info: console.info, warn: console.warn };
  const push = (...args: unknown[]) => {
    lines.push(args.map(show).join(" "));
  };
  console.log = (...args) => {
    push(...args);
    orig.log(...args);
  };
  console.error = (...args) => {
    push(...args);
    orig.error(...args);
  };
  console.info = (...args) => {
    push(...args);
    orig.info(...args);
  };
  console.warn = (...args) => {
    push(...args);
    orig.warn(...args);
  };
  return {
    text: () => lines.join("\n"),
    restore() {
      console.log = orig.log;
      console.error = orig.error;
      console.info = orig.info;
      console.warn = orig.warn;
    },
  };
}

test("hello auth gate", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "arena-auth-gate-"));
  const keyFile = path.join(dir, "ed25519.key.pem");
  const pubFile = path.join(dir, "ed25519.pub.pem");
  const otherFile = path.join(dir, "other.key.pem");
  const revokedFile = path.join(dir, "revoked.json");
  const primary = generateKeyPairSync("ed25519");
  const other = generateKeyPairSync("ed25519");
  writeFileSync(keyFile, exportPem(primary.privateKey, "pkcs8"), { mode: 0o600 });
  writeFileSync(pubFile, exportPem(primary.publicKey, "spki"));
  writeFileSync(otherFile, exportPem(other.privateKey, "pkcs8"), { mode: 0o600 });
  const signer = await loadSigner(keyFile);
  const otherSigner = await loadSigner(otherFile);
  const player = await mint(signer, { sub: "tim-test", role: "player", ttlS: HOUR_S });
  const revoked = await mint(signer, { sub: "tim-revoked", role: "player", ttlS: HOUR_S });
  writeFileSync(revokedFile, `${JSON.stringify([revoked.jti])}\n`);
  const expiredAt = Math.floor(Date.now() / 1000) - 90;
  const expired = await new SignJWT({ role: "player", scope: ["play", "chat", "voice"] })
    .setProtectedHeader({ alg: "EdDSA" })
    .setSubject("tim-test")
    .setJti(randomUUID())
    .setIssuer("ce-arena")
    .setAudience("ce-arena")
    .setIssuedAt(expiredAt - HOUR_S)
    .setExpirationTime(expiredAt)
    .sign(signer);
  const foreign = await mint(otherSigner, { sub: "tim-test", role: "player", ttlS: HOUR_S });
  const noPlay = await new SignJWT({ role: "player", scope: ["chat"] })
    .setProtectedHeader({ alg: "EdDSA" })
    .setSubject("tim-test")
    .setJti(randomUUID())
    .setIssuer("ce-arena")
    .setAudience("ce-arena")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(signer);
  const god = await new SignJWT({ role: "god", scope: ["play"] })
    .setProtectedHeader({ alg: "EdDSA" })
    .setSubject("tim-test")
    .setJti(randomUUID())
    .setIssuer("ce-arena")
    .setAudience("ce-arena")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(signer);
  const secrets = [player.token, revoked.token, expired, foreign.token, noPlay, god];

  try {
    await withEnv({
      ARENA_AUTH: "required",
      ARENA_VERIFY_KEY_FILE: path.join(dir, "missing.pem"),
      ARENA_REVOKED_FILE: revokedFile,
    }, async () => {
      await assert.rejects(() => startArenaServer(0), /ARENA_VERIFY_KEY_FILE/);
    });

    await withEnv({
      ARENA_AUTH: undefined,
      ARENA_VERIFY_KEY_FILE: undefined,
      ARENA_REVOKED_FILE: undefined,
    }, async () => {
      const host = await startArenaServer(0);
      try {
        const view = await arenaOf(host.url);
        assert.equal(view.authRequired, false);
        const open = await helloResult(host.url, hello(view));
        assert.equal(open.kind, "welcome");
        const ignored = "not-a-token";
        const logs = captureLogs();
        try {
          const still = await helloResult(host.url, hello(view, ignored));
          assert.equal(still.kind, "welcome");
          assert.equal(logs.text().includes(ignored), false);
        } finally {
          logs.restore();
        }
        if (existsSync("dist/web/landing-page.html")) {
          const play = await fetch(`${host.url}/play`);
          assert.equal(play.status, 200);
          assert.equal(await play.text(), readFileSync("dist/web/landing-page.html", "utf8"));
        }
      } finally {
        await host.close();
      }
    });

    await withEnv({
      ARENA_AUTH: "required",
      ARENA_VERIFY_KEY_FILE: pubFile,
      ARENA_REVOKED_FILE: revokedFile,
    }, async () => {
      const logs = captureLogs();
      const host = await startArenaServer(0);
      try {
        const view = await arenaOf(host.url);
        assert.equal(view.authRequired, true);
        const good = await helloResult(host.url, hello(view, player.token));
        assert.equal(good.kind, "welcome");
        const cases: Array<{ token?: string; code: number; reason: string }> = [
          { token: expired, code: 4401, reason: "expired" },
          { token: foreign.token, code: 4401, reason: "bad-signature" },
          { token: revoked.token, code: 4401, reason: "revoked" },
          { token: noPlay, code: 4403, reason: "forbidden" },
          { code: 4401, reason: "missing" },
        ];
        for (const item of cases) {
          const result = await helloResult(host.url, hello(view, item.token));
          assert.equal(result.kind, "close", `${item.reason} ${JSON.stringify(result)}`);
          if (result.kind !== "close") continue;
          assert.equal(result.code, item.code, item.reason);
          assert.equal(result.reason, item.reason);
        }
        const badRole = await helloResult(host.url, hello(view, god));
        assert.equal(badRole.kind, "close");
        if (badRole.kind === "close") {
          const allowed = (badRole.code === 4401 && badRole.reason === "bad-claims")
            || (badRole.code === 4403 && badRole.reason === "forbidden");
          assert.equal(allowed, true, `${badRole.code} ${badRole.reason}`);
        }
        const text = logs.text();
        assert.match(text, /\[auth\] ok sub=tim-test role=player/);
        assert.match(text, /\[auth\] reject code=expired ip=\S+/);
        assert.match(text, /\[auth\] reject code=revoked ip=\S+/);
        for (const secret of secrets) assert.equal(text.includes(secret), false);
      } finally {
        logs.restore();
        await host.close();
      }
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
