import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadSigner, mint } from "../../src/server/auth/tokens.ts";
import { startArenaServer, type ArenaHost } from "../../src/server/main.ts";
import { connectBot, type BotSession } from "../../packages/bot-client/src/connection.ts";
import { openNodeSocket } from "../../packages/bot-client/src/node-socket.ts";

const HOUR_S = 60 * 60;

export type LiveArena = {
  url: string;
  token: string;
  host: ArenaHost;
  close(): Promise<void>;
};

const AUTH_ENV = ["ARENA_AUTH", "ARENA_VERIFY_KEY_FILE", "ARENA_REVOKED_FILE"] as const;

export async function startLiveArena(): Promise<LiveArena> {
  const dir = mkdtempSync(join(tmpdir(), "arena-live-"));
  const keyFile = join(dir, "ed25519.key.pem");
  const pubFile = join(dir, "ed25519.pub.pem");
  const pair = generateKeyPairSync("ed25519");
  const priv = pair.privateKey.export({ type: "pkcs8", format: "pem" });
  const pub = pair.publicKey.export({ type: "spki", format: "pem" });
  if (typeof priv !== "string" || typeof pub !== "string") throw new Error("expected PEM text");
  writeFileSync(keyFile, priv, { mode: 0o600 });
  writeFileSync(pubFile, pub);
  const signer = await loadSigner(keyFile);
  const bot = await mint(signer, { sub: "bot-live", role: "bot", scope: ["scene-graph", "chat"], ttlS: HOUR_S });
  const previous = new Map<string, string | undefined>();
  for (const key of AUTH_ENV) previous.set(key, process.env[key]);
  process.env.ARENA_AUTH = "required";
  process.env.ARENA_VERIFY_KEY_FILE = pubFile;
  process.env.ARENA_REVOKED_FILE = join(dir, "revoked.json");
  const host = await startArenaServer(0, true);
  return {
    url: host.url,
    token: bot.token,
    host,
    async close() {
      await host.close();
      for (const key of AUTH_ENV) {
        const value = previous.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function connectTestBot(
  arena: LiveArena,
  name: string,
  extra: Record<string, unknown> = {},
): Promise<BotSession> {
  return connectBot({ url: arena.url, token: arena.token, name, openSocket: openNodeSocket, ...extra });
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function until<T>(read: () => T | undefined, ms: number, label: string): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() - started > ms) throw new Error(label);
    await delay(20);
  }
}
