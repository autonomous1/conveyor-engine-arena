import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync, randomUUID, type KeyObject } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { SignJWT } from "jose";
import {
  AuthError,
  REVOCATION_RELOAD_MS,
  createRevocationList,
  loadSigner,
  loadVerifier,
  mint,
  verify,
  type AuthErrorCode,
} from "../src/server/auth/tokens.ts";

const DAY_S = 24 * 60 * 60;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "dist", "server", "auth", "token-cli.js");

let dir: string;
let signer: CryptoKey;
let verifier: CryptoKey;
let otherSigner: CryptoKey;

function exportPem(key: KeyObject, type: "pkcs8" | "spki"): string {
  const pem = key.export({ type, format: "pem" });
  if (typeof pem !== "string") throw new Error(`expected ${type} PEM text`);
  return pem;
}

async function expectCode(work: Promise<unknown>, code: AuthErrorCode): Promise<void> {
  try {
    await work;
  } catch (err) {
    assert.ok(err instanceof AuthError, err instanceof Error ? err.message : String(err));
    assert.equal(err.code, code);
    return;
  }
  assert.fail(`expected AuthError ${code}`);
}

test.before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "arena-auth-"));
  const primary = generateKeyPairSync("ed25519");
  const other = generateKeyPairSync("ed25519");
  const keyFile = path.join(dir, "ed25519.key.pem");
  const pubFile = path.join(dir, "ed25519.pub.pem");
  const otherKey = path.join(dir, "other.key.pem");
  writeFileSync(keyFile, exportPem(primary.privateKey, "pkcs8"), { mode: 0o600 });
  writeFileSync(pubFile, exportPem(primary.publicKey, "spki"));
  writeFileSync(otherKey, exportPem(other.privateKey, "pkcs8"), { mode: 0o600 });
  signer = await loadSigner(keyFile);
  verifier = await loadVerifier(pubFile);
  otherSigner = await loadSigner(otherKey);
});

test.after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test("a minted bot token has default scopes, extras, and a 30-day exp", async () => {
  const ttlS = 30 * DAY_S;
  const before = Math.floor(Date.now() / 1000);
  const minted = await mint(signer, {
    sub: "bot-1",
    role: "bot",
    scope: ["scene-graph", "teleport"],
    ttlS,
  });
  const after = Math.floor(Date.now() / 1000);
  const claims = await verify(verifier, minted.token, { has: () => false });
  assert.equal(claims.sub, "bot-1");
  assert.equal(claims.role, "bot");
  assert.deepEqual(claims.scope, ["play", "chat", "scene-graph", "teleport"]);
  assert.equal(claims.jti, minted.jti);
  assert.equal(claims.exp, minted.exp);
  assert.equal(claims.exp - claims.iat, ttlS);
  assert.ok(claims.exp >= before + ttlS && claims.exp <= after + ttlS);
});

test("a token signed by another key is bad-signature", async () => {
  const minted = await mint(otherSigner, { sub: "bot-1", role: "bot", ttlS: DAY_S });
  await expectCode(verify(verifier, minted.token, { has: () => false }), "bad-signature");
});

test("an expired token is expired", async () => {
  const exp = Math.floor(Date.now() / 1000) - 90;
  const token = await new SignJWT({ role: "bot", scope: ["play", "chat"] })
    .setProtectedHeader({ alg: "EdDSA" })
    .setSubject("bot-1")
    .setJti(randomUUID())
    .setIssuer("ce-arena")
    .setAudience("ce-arena")
    .setIssuedAt(exp - DAY_S)
    .setExpirationTime(exp)
    .sign(signer);
  await expectCode(verify(verifier, token, { has: () => false }), "expired");
});

test("HS256 is bad-signature and a god role is bad-claims", async () => {
  const hs = await new SignJWT({ role: "bot", scope: ["play", "chat"] })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("bot-1")
    .setJti(randomUUID())
    .setIssuer("ce-arena")
    .setAudience("ce-arena")
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(new Uint8Array(32));
  await expectCode(verify(verifier, hs, { has: () => false }), "bad-signature");

  const god = await new SignJWT({ role: "god", scope: ["play"] })
    .setProtectedHeader({ alg: "EdDSA" })
    .setSubject("bot-1")
    .setJti(randomUUID())
    .setIssuer("ce-arena")
    .setAudience("ce-arena")
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(signer);
  await expectCode(verify(verifier, god, { has: () => false }), "bad-claims");

  const unknownScope = await new SignJWT({ role: "bot", scope: ["play", "nope"] })
    .setProtectedHeader({ alg: "EdDSA" })
    .setSubject("bot-1")
    .setJti(randomUUID())
    .setIssuer("ce-arena")
    .setAudience("ce-arena")
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(signer);
  await expectCode(verify(verifier, unknownScope, { has: () => false }), "bad-claims");
});

test("revoke is visible on the next reload, and not before the window", async () => {
  const file = path.join(dir, "revoked.json");
  let now = 10_000;
  const list = createRevocationList(file, () => now);
  const minted = await mint(signer, { sub: "bot-1", role: "bot", ttlS: DAY_S });
  const claims = await verify(verifier, minted.token, list);
  assert.equal(claims.jti, minted.jti);

  writeFileSync(file, `${JSON.stringify([minted.jti])}\n`);
  now += REVOCATION_RELOAD_MS - 1;
  const still = await verify(verifier, minted.token, list);
  assert.equal(still.jti, minted.jti);

  now += 1;
  await expectCode(verify(verifier, minted.token, list), "revoked");
});

test("token cli keygen, mint, and list", { skip: existsSync(cliPath) ? false : "dist/server/auth/token-cli.js is missing; run npm run build" }, async () => {
  const cliDir = mkdtempSync(path.join(tmpdir(), "arena-token-cli-"));
  const config = path.join(cliDir, "config");
  const insidePrefix = path.join(repoRoot, "auth-token-keygen-refused");
  const insideToken = path.join(repoRoot, "auth-token-mint-refused");
  const env = {
    ...process.env,
    ARENA_CONFIG_DIR: config,
    ARENA_SIGNING_KEY_FILE: path.join(config, "ed25519.key.pem"),
    ARENA_VERIFY_KEY_FILE: path.join(config, "ed25519.pub.pem"),
    ARENA_REVOKED_FILE: path.join(config, "revoked.json"),
  };
  const run = (args: string[]) =>
    spawnSync(process.execPath, [cliPath, ...args], { encoding: "utf8", env, cwd: repoRoot });
  try {
    const keygen = run(["keygen", "--out", path.join(config, "ed25519")]);
    assert.equal(keygen.status, 0, `${keygen.stderr}${keygen.stdout}`);
    assert.equal(statSync(env.ARENA_SIGNING_KEY_FILE).mode & 0o777, 0o600);
    assert.equal(statSync(env.ARENA_VERIFY_KEY_FILE).mode & 0o777, 0o600);

    const refused = run(["keygen", "--out", insidePrefix]);
    assert.notEqual(refused.status, 0, "keygen inside the repo should fail");
    assert.match(refused.stderr, /refusing to write inside the repo/);
    assert.equal(existsSync(`${insidePrefix}.key.pem`), false);
    assert.equal(existsSync(`${insidePrefix}.pub.pem`), false);

    const minted = run(["mint", "--role", "bot", "--sub", "bot-1", "--scope", "scene-graph,teleport", "--days", "30"]);
    assert.equal(minted.status, 0, minted.stderr);
    const token = minted.stdout.trim();
    assert.match(token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const claims = await verify(await loadVerifier(env.ARENA_VERIFY_KEY_FILE), token, { has: () => false });
    assert.equal(claims.role, "bot");
    assert.equal(claims.sub, "bot-1");
    assert.deepEqual(claims.scope, ["play", "chat", "scene-graph", "teleport"]);
    assert.equal(claims.exp - claims.iat, 30 * DAY_S);

    const issuedPath = path.join(config, "issued.jsonl");
    const issued = readFileSync(issuedPath, "utf8");
    assert.equal(issued.includes(token), false);
    assert.doesNotMatch(issued, /[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/);
    const record = JSON.parse(issued.trim()) as { jti: string; token?: string };
    assert.equal(record.token, undefined);
    assert.equal(record.jti, claims.jti);

    const refusedMint = run(["mint", "--role", "bot", "--sub", "bot-2", "--out", insideToken]);
    assert.notEqual(refusedMint.status, 0);
    assert.match(refusedMint.stderr, /refusing to write inside the repo/);
    assert.equal(existsSync(insideToken), false);
    assert.equal(readFileSync(issuedPath, "utf8"), issued);

    const outFile = path.join(cliDir, "bot.token");
    const mintedOut = run(["mint", "--role", "bot", "--sub", "bot-2", "--hours", "12", "--out", outFile]);
    assert.equal(mintedOut.status, 0, mintedOut.stderr);
    assert.equal(mintedOut.stdout, "");
    assert.equal(statSync(outFile).mode & 0o777, 0o600);
    const written = readFileSync(outFile, "utf8").trim();
    assert.match(written, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assert.equal(readFileSync(issuedPath, "utf8").includes(written), false);
    const writtenClaims = await verify(await loadVerifier(env.ARENA_VERIFY_KEY_FILE), written, { has: () => false });
    assert.equal(writtenClaims.sub, "bot-2");
    assert.equal(writtenClaims.exp - writtenClaims.iat, 12 * 60 * 60);

    const listed = run(["list"]);
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, new RegExp(record.jti));
    assert.match(listed.stdout, /revoked=no/);

    const revoked = run(["revoke", record.jti]);
    assert.equal(revoked.status, 0, revoked.stderr);
    const listedAfter = run(["list"]);
    assert.match(listedAfter.stdout, new RegExp(record.jti));
    assert.match(listedAfter.stdout, /revoked=yes/);
    await expectCode(verify(await loadVerifier(env.ARENA_VERIFY_KEY_FILE), token, createRevocationList(env.ARENA_REVOKED_FILE)), "revoked");
  } finally {
    rmSync(`${insidePrefix}.key.pem`, { force: true });
    rmSync(`${insidePrefix}.pub.pem`, { force: true });
    rmSync(insideToken, { force: true });
    rmSync(cliDir, { recursive: true, force: true });
  }
});
