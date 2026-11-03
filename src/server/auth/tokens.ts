// Ed25519 access tokens. Signed only: no encryption, and this module never writes a key.
import { importPKCS8, importSPKI, jwtVerify, SignJWT } from "jose";
import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

export const ROLES = ["player", "bot", "qa", "admin"] as const;
export type Role = (typeof ROLES)[number];

export const SCOPES = ["play", "spectate", "scene-graph", "qa", "teleport", "chat", "voice", "admin"] as const;
export type Scope = (typeof SCOPES)[number];

/** Role defaults. `mint` adds any extra scopes on top of these. */
export const DEFAULT_SCOPES: Record<Role, readonly Scope[]> = {
  player: ["play", "chat", "voice"],
  bot: ["play", "chat"],
  qa: ["play", "spectate", "scene-graph", "qa"],
  admin: SCOPES,
};

export type Claims = {
  sub: string;
  role: Role;
  scope: Scope[];
  jti: string;
  iat: number;
  exp: number;
};

export type AuthErrorCode = "expired" | "bad-signature" | "revoked" | "bad-claims";

const ISSUER = "ce-arena";
const AUDIENCE = "ce-arena";
const CLOCK_TOLERANCE_S = 30;

/** Minimum time between revocation-file mtime checks. */
export const REVOCATION_RELOAD_MS = 5_000;

export class AuthError extends Error {
  readonly code: AuthErrorCode;

  constructor(code: AuthErrorCode) {
    super(code);
    this.name = "AuthError";
    this.code = code;
  }
}

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

export function isScope(value: unknown): value is Scope {
  return typeof value === "string" && (SCOPES as readonly string[]).includes(value);
}

/** Defaults for `role`, plus `extra`. Extras never remove a default scope. */
export function resolvedScopes(role: Role, extra?: readonly Scope[]): Scope[] {
  if (!isRole(role)) throw new AuthError("bad-claims");
  const merged = [...new Set<Scope>([...DEFAULT_SCOPES[role], ...(extra ?? [])])];
  for (const item of merged) {
    if (!isScope(item)) throw new AuthError("bad-claims");
  }
  return merged;
}

export async function loadSigner(privateKeyFile: string): Promise<CryptoKey> {
  return importPKCS8(readFileSync(privateKeyFile, "utf8"), "EdDSA");
}

export async function loadVerifier(publicKeyFile: string): Promise<CryptoKey> {
  return importSPKI(readFileSync(publicKeyFile, "utf8"), "EdDSA");
}

export async function mint(
  key: CryptoKey,
  claims: { sub: string; role: Role; scope?: readonly Scope[]; ttlS: number },
): Promise<{ token: string; jti: string; exp: number }> {
  if (typeof claims.sub !== "string" || claims.sub.length === 0) throw new AuthError("bad-claims");
  if (!Number.isFinite(claims.ttlS)) throw new AuthError("bad-claims");
  const scope = resolvedScopes(claims.role, claims.scope);
  const jti = randomUUID();
  // Absolute exp, so the returned exp matches the claim. A relative "Ns" string can slip a second.
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + claims.ttlS;
  const token = await new SignJWT({ role: claims.role, scope })
    .setProtectedHeader({ alg: "EdDSA" })
    .setSubject(claims.sub)
    .setJti(jti)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(key);
  return { token, jti, exp };
}

export async function verify(
  pub: CryptoKey,
  token: string,
  revoked: { has(jti: string): boolean },
): Promise<Claims> {
  let payload: { jti?: unknown; sub?: unknown; role?: unknown; scope?: unknown; iat?: unknown; exp?: unknown };
  try {
    const result = await jwtVerify(token, pub, {
      algorithms: ["EdDSA"],
      issuer: ISSUER,
      audience: AUDIENCE,
      clockTolerance: CLOCK_TOLERANCE_S,
    });
    payload = result.payload;
  } catch (err) {
    throw mapJose(err);
  }
  if (typeof payload.jti !== "string" || payload.jti.length === 0 || revoked.has(payload.jti)) {
    throw new AuthError("revoked");
  }
  return toClaims(payload);
}

export type RevocationList = { has(jti: string): boolean };

/**
 * JSON array of revoked `jti`s. A missing file is an empty list.
 * The mtime is checked at most once every {@link REVOCATION_RELOAD_MS}.
 * `now` defaults to `Date.now` and is only the throttle clock.
 */
export function createRevocationList(file: string, now: () => number = Date.now): RevocationList {
  let revoked = new Set<string>();
  let mtimeMs: number | undefined;
  let checkedAt = Number.NEGATIVE_INFINITY;

  const reload = (): void => {
    const at = now();
    if (at - checkedAt < REVOCATION_RELOAD_MS) return;
    let mtime: number;
    try {
      mtime = statSync(file).mtimeMs;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        checkedAt = at;
        revoked = new Set();
        mtimeMs = undefined;
        return;
      }
      throw err;
    }
    if (mtimeMs !== undefined && mtime === mtimeMs) {
      checkedAt = at;
      return;
    }
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
      throw new Error(`revocation list ${file} is not a JSON array of strings`);
    }
    revoked = new Set(parsed);
    mtimeMs = mtime;
    checkedAt = at;
  };

  return {
    has(jti: string): boolean {
      reload();
      return revoked.has(jti);
    },
  };
}

function toClaims(payload: {
  sub?: unknown;
  role?: unknown;
  scope?: unknown;
  jti?: unknown;
  iat?: unknown;
  exp?: unknown;
}): Claims {
  if (typeof payload.sub !== "string" || payload.sub.length === 0) throw new AuthError("bad-claims");
  if (typeof payload.jti !== "string" || payload.jti.length === 0) throw new AuthError("bad-claims");
  if (typeof payload.iat !== "number" || !Number.isFinite(payload.iat)) throw new AuthError("bad-claims");
  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) throw new AuthError("bad-claims");
  if (!isRole(payload.role) || !isScopeList(payload.scope)) throw new AuthError("bad-claims");
  return {
    sub: payload.sub,
    role: payload.role,
    scope: [...payload.scope],
    jti: payload.jti,
    iat: payload.iat,
    exp: payload.exp,
  };
}

function isScopeList(value: unknown): value is Scope[] {
  return Array.isArray(value) && value.every((item) => isScope(item));
}

function mapJose(err: unknown): AuthError {
  const code = joseCode(err);
  if (code === "ERR_JWT_EXPIRED") return new AuthError("expired");
  if (
    code === "ERR_JWS_SIGNATURE_VERIFICATION_FAILED" ||
    code === "ERR_JOSE_ALG_NOT_ALLOWED" ||
    code === "ERR_JWS_INVALID"
  ) {
    return new AuthError("bad-signature");
  }
  if (code === "ERR_JWT_CLAIM_VALIDATION_FAILED" || code === "ERR_JWT_INVALID") return new AuthError("bad-claims");
  if (code.startsWith("ERR_JWS_") || code.startsWith("ERR_JOSE_")) return new AuthError("bad-signature");
  if (code.startsWith("ERR_JWT_")) return new AuthError("bad-claims");
  throw err;
}

function joseCode(err: unknown): string {
  if (typeof err !== "object" || err === null || !("code" in err)) return "";
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : "";
}
