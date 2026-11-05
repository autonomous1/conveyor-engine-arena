import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTH_KEY,
  clearKey,
  decodeClaims,
  loadKey,
  saveKey,
} from "../src/client/auth-key.ts";

class MemoryStorage implements Storage {
  #map = new Map<string, string>();

  get length(): number {
    return this.#map.size;
  }

  clear(): void {
    this.#map.clear();
  }

  getItem(key: string): string | null {
    return this.#map.has(key) ? this.#map.get(key)! : null;
  }

  key(index: number): string | null {
    return [...this.#map.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.#map.delete(key);
  }

  setItem(key: string, value: string): void {
    this.#map.set(key, value);
  }
}

function part(value: object | string): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return Buffer.from(text).toString("base64url");
}

function jwt(payload: object): string {
  return `${part({ alg: "EdDSA" })}.${part(payload)}.sig`;
}

const now = 1_700_000_000_000;
const exp = Math.floor(now / 1000) + 3600;

test("decodeClaims reads a shaped key and rejects a bad one", () => {
  assert.deepEqual(decodeClaims(jwt({ sub: "tim", role: "qa", exp }), now), { sub: "tim", role: "qa", exp });
  assert.deepEqual(decodeClaims("not-a-key", now), { error: "malformed" });
  assert.deepEqual(decodeClaims(`${part({ alg: "EdDSA" })}.${part("not-json")}.sig`, now), { error: "malformed" });
  assert.deepEqual(decodeClaims(jwt({ role: "player", exp }), now), { error: "no-sub" });
  assert.deepEqual(decodeClaims(jwt({ sub: "", role: "player", exp }), now), { error: "no-sub" });
  assert.deepEqual(decodeClaims(jwt({ sub: "tim", role: "god", exp }), now), { error: "bad-role" });
  assert.deepEqual(decodeClaims(jwt({ sub: "tim", role: "player", exp: Math.floor(now / 1000) }), now), { error: "expired" });
});

test("saveKey, loadKey, and clearKey", () => {
  const session = new MemoryStorage();
  const local = new MemoryStorage();
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: session });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: local });
  const valid = jwt({ sub: "tim", role: "player", exp });
  const other = jwt({ sub: "other", role: "bot", exp });

  saveKey(valid, false);
  assert.equal(session.getItem(AUTH_KEY), valid);
  assert.equal(local.getItem(AUTH_KEY), null);

  local.setItem(AUTH_KEY, "stale");
  saveKey(valid, false);
  assert.equal(local.getItem(AUTH_KEY), null);

  saveKey(valid, true);
  assert.equal(session.getItem(AUTH_KEY), valid);
  assert.equal(local.getItem(AUTH_KEY), valid);

  session.setItem(AUTH_KEY, other);
  assert.equal(loadKey(now), other);

  clearKey();
  assert.equal(session.getItem(AUTH_KEY), null);
  assert.equal(local.getItem(AUTH_KEY), null);

  const expired = jwt({ sub: "tim", role: "player", exp: 1 });
  session.setItem(AUTH_KEY, expired);
  local.setItem(AUTH_KEY, valid);
  assert.equal(loadKey(now), valid);
  assert.equal(session.getItem(AUTH_KEY), null);
  assert.equal(local.getItem(AUTH_KEY), valid);

  local.setItem(AUTH_KEY, expired);
  assert.equal(loadKey(now), undefined);
  assert.equal(local.getItem(AUTH_KEY), null);
});
