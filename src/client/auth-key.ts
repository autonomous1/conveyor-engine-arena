// Browser-only access key. This file does not verify the signature. The host does.

/**
 * @why Separate from the reconnect token `ce-arena-token`.
 */
export const AUTH_KEY = "ce-arena-auth";

/** Set by the game client before it sends the player back to the landing page. */
export const AUTH_MSG = "ce-arena-auth-msg";

const ROLES = ["player", "bot", "qa", "admin"] as const;
export type AuthRole = (typeof ROLES)[number];

export type DecodedClaims = { sub: string; role: AuthRole; exp: number };
export type DecodeError = "malformed" | "expired" | "no-sub" | "bad-role";
export type DecodeResult = DecodedClaims | { error: DecodeError };

declare const __ARENA_SOLO__: boolean;

/** True in the solo bundle. The web bundle defines this as false. Node leaves it unset. */
export function isArenaSolo(): boolean {
  return typeof __ARENA_SOLO__ !== "undefined" && __ARENA_SOLO__ === true;
}

/**
 * Read `sub`, `role`, and `exp` from a JWT-shaped string.
 * Checks shape, a non-empty subject, one of the four roles, and `exp` (unix
 * seconds) after now.
 * @why Does not verify the signature.
 */
export function decodeClaims(key: string, nowMs = Date.now()): DecodeResult {
  const parts = key.split(".");
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) return { error: "malformed" };
  let payload: unknown;
  try {
    payload = decodePart(parts[1]!);
  } catch {
    return { error: "malformed" };
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return { error: "malformed" };
  const rec = payload as Record<string, unknown>;
  if (typeof rec.sub !== "string" || rec.sub.length === 0) return { error: "no-sub" };
  if (!isRole(rec.role)) return { error: "bad-role" };
  if (typeof rec.exp !== "number" || !Number.isFinite(rec.exp)) return { error: "malformed" };
  if (rec.exp * 1000 <= nowMs) return { error: "expired" };
  return { sub: rec.sub, role: rec.role, exp: rec.exp };
}

/**
 * Session always. `localStorage` only when `remember` is set.
 * @why An unchecked box does not keep a key.
 */
export function saveKey(key: string, remember: boolean): void {
  sessionStore().setItem(AUTH_KEY, key);
  if (remember) localStore().setItem(AUTH_KEY, key);
  else localStore().removeItem(AUTH_KEY);
}

/**
 * Session, then local.
 * @post An unusable key is removed. A later store is tried after that.
 */
export function loadKey(nowMs = Date.now()): string | undefined {
  const session = readStore(sessionStore());
  if (session !== undefined) {
    if (usable(session, nowMs)) return session;
    sessionStore().removeItem(AUTH_KEY);
  }
  const local = readStore(localStore());
  if (local !== undefined) {
    if (usable(local, nowMs)) return local;
    localStore().removeItem(AUTH_KEY);
  }
  return undefined;
}

export function clearKey(): void {
  sessionStore().removeItem(AUTH_KEY);
  localStore().removeItem(AUTH_KEY);
}

function isRole(value: unknown): value is AuthRole {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

function usable(key: string, nowMs: number): boolean {
  return !("error" in decodeClaims(key, nowMs));
}

function readStore(store: Storage): string | undefined {
  const value = store.getItem(AUTH_KEY);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function sessionStore(): Storage {
  return globalThis.sessionStorage;
}

function localStore(): Storage {
  return globalThis.localStorage;
}

function decodePart(part: string): unknown {
  if (part.length === 0 || !/^[A-Za-z0-9_-]+$/.test(part)) throw new Error("malformed");
  const pad = "=".repeat((4 - (part.length % 4)) % 4);
  const b64 = part.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const binary = atob(b64);
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

const DECODE_TEXT: Record<DecodeError, string> = {
  malformed: "That key is malformed.",
  expired: "That key is expired.",
  "no-sub": "That key has no subject.",
  "bad-role": "That key has a bad role.",
};

function signedIn(claims: DecodedClaims): string {
  const when = new Date(claims.exp * 1000).toLocaleString();
  return `signed in as ${claims.sub} (${claims.role}), expires ${when}`;
}

/** Landing page only. The game bundle imports the helpers and finds no `#play` form. */
function bootLanding(): void {
  if (typeof document === "undefined") return;
  const input = document.getElementById("auth-key");
  const remember = document.getElementById("auth-remember");
  const msg = document.getElementById("auth-msg");
  const play = document.getElementById("auth-play");
  const signOut = document.getElementById("auth-signout");
  const toggle = document.getElementById("auth-show");
  if (!(input instanceof HTMLInputElement) || !(remember instanceof HTMLInputElement) || !msg) return;
  if (!(play instanceof HTMLButtonElement) || !(signOut instanceof HTMLButtonElement)) return;

  const showStatus = (text: string) => {
    msg.textContent = text;
  };
  const showStored = () => {
    const key = loadKey();
    if (!key) return;
    const decoded = decodeClaims(key);
    if ("error" in decoded) return;
    showStatus(signedIn(decoded));
  };

  const notice = sessionStore().getItem(AUTH_MSG);
  if (notice !== null) {
    sessionStore().removeItem(AUTH_MSG);
    showStatus(notice);
  } else {
    showStored();
  }

  const submit = () => {
    const raw = input.value.trim();
    const decoded = decodeClaims(raw);
    if ("error" in decoded) {
      showStatus(DECODE_TEXT[decoded.error]);
      return;
    }
    saveKey(raw, remember.checked);
    input.value = "";
    showStatus(signedIn(decoded));
    location.href = "/";
  };

  play.addEventListener("click", submit);
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") submit();
  });
  signOut.addEventListener("click", () => {
    clearKey();
    input.value = "";
    remember.checked = false;
    showStatus("signed out");
  });
  if (toggle instanceof HTMLButtonElement) {
    toggle.addEventListener("click", () => {
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      toggle.textContent = show ? "Hide" : "Show";
    });
  }
  document.documentElement.dataset.authReady = "1";
}

bootLanding();
