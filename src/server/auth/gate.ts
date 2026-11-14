// ARCHITECTURE: The WebSocket hello gate and the two HTTP Bearer gates: auth
//   mode, claim checks, and the 401/403 decisions.
// Wiring: main.ts installs it on the WS upgrade and the two HTTP routes;
//   auth/gate.ts calls auth/tokens.ts to verify claims.
// WebSocket hello gate. The access key arrives in `auth`. `token` stays the reconnect token.
import { AuthError, isRole, verify, type Claims, type RevocationList } from "./tokens.js";

export type AuthMode = "off" | "required";

/** `"required"` only when ARENA_AUTH is exactly `required`. Anything else is off. */
export function authMode(env: NodeJS.ProcessEnv = process.env): AuthMode {
  return env.ARENA_AUTH === "required" ? "required" : "off";
}

export type HelloAuth =
  | { ok: true; claims?: Claims }
  | { ok: false; code: 4401 | 4403; reason: string };

/**
 * Check the first frame. `mode === "off"` accepts it and does not verify `auth`
 * (a bad key is ignored). `required` demands a hello whose `auth` verifies,
 * with role player|bot|qa|admin and scope `play`.
 */
export async function checkHelloAuth(
  text: string,
  deps: { pub?: CryptoKey; revoked: RevocationList; mode: AuthMode },
): Promise<HelloAuth> {
  if (deps.mode === "off") return { ok: true };
  const auth = readAuth(text);
  if (!auth) return { ok: false, code: 4401, reason: "missing" };
  if (!deps.pub) return { ok: false, code: 4401, reason: "bad-claims" };
  try {
    const claims = await verify(deps.pub, auth, deps.revoked);
    if (!isRole(claims.role) || !claims.scope.includes("play")) {
      return { ok: false, code: 4403, reason: "forbidden" };
    }
    return { ok: true, claims };
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, code: 4401, reason: err.code };
    return { ok: false, code: 4401, reason: "bad-claims" };
  }
}

export type BearerAuth =
  | { ok: true; claims: Claims }
  | { ok: false; status: 401 | 403 };

/**
 * `GET /scene-graph.json`. Missing, bad, or expired is 401.
 * A verified token whose `scope` omits `scene-graph` is 403.
 * @why Auth-off still needs a Bearer that verifies. No public graph.
 */
export async function checkSceneGraphAuth(
  authorization: string | undefined,
  deps: { pub?: CryptoKey; revoked: RevocationList },
): Promise<BearerAuth> {
  return checkBearerScope(authorization, deps, "scene-graph");
}

/**
 * `POST /qa/snapshots`. Missing, bad, or expired is 401.
 * A verified token whose `scope` omits `qa` is 403.
 * @why Auth-off still needs a Bearer that verifies. Solo has no JWT, so it
 *      cannot upload.
 */
export async function checkQaSnapshotAuth(
  authorization: string | undefined,
  deps: { pub?: CryptoKey; revoked: RevocationList },
): Promise<BearerAuth> {
  return checkBearerScope(authorization, deps, "qa");
}

async function checkBearerScope(
  authorization: string | undefined,
  deps: { pub?: CryptoKey; revoked: RevocationList },
  scope: "scene-graph" | "qa",
): Promise<BearerAuth> {
  if (!deps.pub) return { ok: false, status: 401 };
  const token = readBearer(authorization);
  if (!token) return { ok: false, status: 401 };
  try {
    const claims = await verify(deps.pub, token, deps.revoked);
    if (!claims.scope.includes(scope)) return { ok: false, status: 403 };
    return { ok: true, claims };
  } catch {
    return { ok: false, status: 401 };
  }
}

function readBearer(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1];
}

/** Hello `auth` string, or undefined when the frame is not a keyed hello. */
function readAuth(text: string): string | undefined {
  let frame: unknown;
  try {
    frame = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!frame || typeof frame !== "object" || Array.isArray(frame)) return undefined;
  const rec = frame as Record<string, unknown>;
  if (rec.type !== "hello") return undefined;
  if (typeof rec.auth !== "string" || rec.auth.length === 0) return undefined;
  return rec.auth;
}
