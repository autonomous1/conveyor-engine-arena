// `npm run token -- …`. Keys and issued records stay outside the repo.
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isRole, isScope, loadSigner, mint, resolvedScopes, type Role, type Scope } from "./tokens.js";

const DAY_S = 24 * 60 * 60;
const DEFAULT_TTL_S = 30 * DAY_S;

type Opts = {
  out?: string;
  role?: string;
  sub?: string;
  scope?: string;
  days?: string;
  hours?: string;
};

function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return path.join(homedir(), value.slice(2));
  return value;
}

function absPath(value: string): string {
  return path.resolve(expandHome(value));
}

function envPath(name: string, fallback: string): string {
  const fromEnv = process.env[name];
  if (fromEnv !== undefined && fromEnv.trim() !== "") return absPath(fromEnv);
  return fallback;
}

function configDir(): string {
  return envPath("ARENA_CONFIG_DIR", path.join(homedir(), ".config", "ce-arena"));
}

function signingKeyFile(): string {
  return envPath("ARENA_SIGNING_KEY_FILE", path.join(configDir(), "ed25519.key.pem"));
}

function issuedFile(): string {
  return path.join(configDir(), "issued.jsonl");
}

function revokedFile(): string {
  return envPath("ARENA_REVOKED_FILE", path.join(configDir(), "revoked.json"));
}

/** Repo root from this file: src/server/auth or dist/server/auth, three levels up. */
function repoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return realpathSync(path.resolve(here, "..", "..", ".."));
}

function nearestExisting(target: string): string {
  let current = path.resolve(target);
  const stop = path.parse(current).root;
  while (!existsSync(current)) {
    if (current === stop) return current;
    current = path.dirname(current);
  }
  return current;
}

function resolvesInsideRepo(target: string): boolean {
  const root = repoRoot();
  const resolved = realpathSync(nearestExisting(absPath(target)));
  const rel = path.relative(root, resolved);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function assertOutsideRepo(target: string): void {
  if (resolvesInsideRepo(target)) {
    throw new Error(`refusing to write inside the repo: ${absPath(target)}`);
  }
}

function usage(): void {
  console.error(`Usage: npm run token -- <command>

  keygen [--out <prefix>]
      Write <prefix>.key.pem (mode 0600) and <prefix>.pub.pem.
      Default prefix: $ARENA_CONFIG_DIR/ed25519. Refuses a path inside this repo.

  mint --role <player|bot|qa|admin> --sub <id> [--scope a,b] [--days N | --hours N] [--out file]
      Print a token, or write it mode 0600. Default lifetime is 30 days.
      --scope adds to the role defaults. Appends jti, sub, role, scope, and exp to issued.jsonl.

  revoke <jti>
      Add the jti to revoked.json.

  list
      Print issued.jsonl with each expiry and whether that jti is revoked.

Environment (defaults under ~/.config/ce-arena, via the home directory, never a literal ~):
  ARENA_CONFIG_DIR          base directory (issued.jsonl, default key and revoked paths)
  ARENA_SIGNING_KEY_FILE    private key used to mint
  ARENA_VERIFY_KEY_FILE     public key (for the host; not read by this CLI)
  ARENA_REVOKED_FILE        JSON array of revoked jti values
`);
}

function parseArgs(argv: string[]): { cmd: string | undefined; opts: Opts; positionals: string[] } {
  const [cmd, ...rest] = argv;
  const opts: Opts = {};
  const positionals: string[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === undefined) continue;
    if (arg === "--") {
      positionals.push(...rest.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (key !== "out" && key !== "role" && key !== "sub" && key !== "scope" && key !== "days" && key !== "hours") {
      throw new Error(`unknown option --${key}`);
    }
    const value = rest[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`missing value for --${key}`);
    i += 1;
    opts[key] = value;
  }
  return { cmd, opts, positionals };
}

function positiveInt(label: string, value: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`${label} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function parseScopes(value: string): Scope[] {
  const parts = value.split(",").map((item) => item.trim()).filter((item) => item.length > 0);
  if (parts.length === 0) throw new Error("--scope is empty");
  const scopes: Scope[] = [];
  for (const part of parts) {
    if (!isScope(part)) throw new Error(`unknown scope ${part}`);
    scopes.push(part);
  }
  return scopes;
}

function ttlFrom(opts: Opts): number {
  if (opts.days !== undefined && opts.hours !== undefined) throw new Error("pass only one of --days or --hours");
  if (opts.days !== undefined) return positiveInt("--days", opts.days) * DAY_S;
  if (opts.hours !== undefined) return positiveInt("--hours", opts.hours) * 60 * 60;
  return DEFAULT_TTL_S;
}

function exportPem(key: KeyObject, type: "pkcs8" | "spki"): string {
  const pem = key.export({ type, format: "pem" });
  if (typeof pem !== "string") throw new Error(`expected ${type} PEM text`);
  return pem;
}

function writeNewFile(file: string, contents: string, mode: number): void {
  assertOutsideRepo(file);
  mkdirSync(path.dirname(file), { recursive: true });
  try {
    writeFileSync(file, contents, { mode, flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`refusing to overwrite ${file}`);
    throw err;
  }
  chmodSync(file, mode);
}

function keygen(opts: Opts): void {
  const prefix = absPath(opts.out ?? path.join(configDir(), "ed25519"));
  const keyFile = `${prefix}.key.pem`;
  const pubFile = `${prefix}.pub.pem`;
  assertOutsideRepo(prefix);
  assertOutsideRepo(keyFile);
  assertOutsideRepo(pubFile);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  writeNewFile(keyFile, exportPem(privateKey, "pkcs8"), 0o600);
  writeNewFile(pubFile, exportPem(publicKey, "spki"), 0o600);
  console.error(`wrote ${keyFile}`);
  console.error(`wrote ${pubFile}`);
}

type Issued = { jti: string; sub: string; role: Role; scope: Scope[]; exp: number };

function appendIssued(record: Issued): void {
  const file = issuedFile();
  assertOutsideRepo(file);
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

async function mintCommand(opts: Opts): Promise<void> {
  if (opts.role === undefined) throw new Error("mint requires --role");
  if (opts.sub === undefined || opts.sub.length === 0) throw new Error("mint requires --sub");
  if (!isRole(opts.role)) throw new Error(`unknown role ${opts.role}`);
  const extra = opts.scope === undefined ? undefined : parseScopes(opts.scope);
  const role = opts.role;
  const scope = resolvedScopes(role, extra);
  const out = opts.out === undefined ? undefined : absPath(opts.out);
  // Refuse an in-repo --out before the token is logged, so a failed write leaves no record.
  if (out !== undefined) assertOutsideRepo(out);
  const keyFile = signingKeyFile();
  if (!existsSync(keyFile)) throw new Error(`missing signing key ${keyFile} (npm run token -- keygen)`);
  const signed = await mint(await loadSigner(keyFile), { sub: opts.sub, role, scope: extra, ttlS: ttlFrom(opts) });
  appendIssued({ jti: signed.jti, sub: opts.sub, role, scope, exp: signed.exp });
  if (out !== undefined) {
    writeNewFile(out, `${signed.token}\n`, 0o600);
    console.error(`wrote ${out}`);
    console.error(`jti=${signed.jti}`);
    return;
  }
  console.log(signed.token);
}

function readRevoked(file: string): string[] {
  if (!existsSync(file)) return [];
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error(`${file} is not a JSON array of strings`);
  }
  return parsed;
}

function revoke(jti: string | undefined): void {
  if (jti === undefined || jti.length === 0) throw new Error("revoke requires a jti");
  const file = revokedFile();
  assertOutsideRepo(file);
  mkdirSync(path.dirname(file), { recursive: true });
  const ids = readRevoked(file);
  if (!ids.includes(jti)) ids.push(jti);
  writeFileSync(file, `${JSON.stringify(ids, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  console.error(`revoked ${jti}`);
}

function parseIssued(line: string, lineNo: number): Issued {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error(`issued.jsonl line ${lineNo} is not JSON`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`issued.jsonl line ${lineNo} is not an object`);
  }
  const rec = value as Record<string, unknown>;
  if (typeof rec.jti !== "string" || typeof rec.sub !== "string" || typeof rec.exp !== "number" || !Number.isFinite(rec.exp)) {
    throw new Error(`issued.jsonl line ${lineNo} is missing jti, sub, or exp`);
  }
  if (!isRole(rec.role)) throw new Error(`issued.jsonl line ${lineNo} has a bad role`);
  if ("token" in rec) throw new Error(`issued.jsonl line ${lineNo} must not contain a token`);
  if (!Array.isArray(rec.scope)) throw new Error(`issued.jsonl line ${lineNo} has a bad scope`);
  const scope: Scope[] = [];
  for (const item of rec.scope) {
    if (!isScope(item)) throw new Error(`issued.jsonl line ${lineNo} has a bad scope`);
    scope.push(item);
  }
  return { jti: rec.jti, sub: rec.sub, role: rec.role, scope, exp: rec.exp };
}

function list(): void {
  const file = issuedFile();
  if (!existsSync(file)) return;
  const revoked = new Set(readRevoked(revokedFile()));
  const lines = readFileSync(file, "utf8").split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (line.trim() === "") continue;
    const rec = parseIssued(line, i + 1);
    const exp = new Date(rec.exp * 1000).toISOString();
    const state = revoked.has(rec.jti) ? "yes" : "no";
    console.log(`jti=${rec.jti} sub=${rec.sub} role=${rec.role} scope=${rec.scope.join(",")} exp=${exp} revoked=${state}`);
  }
}

async function main(): Promise<void> {
  const { cmd, opts, positionals } = parseArgs(process.argv.slice(2));
  if (cmd === undefined || cmd === "help" || cmd === "--help" || cmd === "-h") {
    usage();
    process.exit(cmd === undefined ? 1 : 0);
  }
  if (cmd === "keygen") {
    if (positionals.length > 0) throw new Error("keygen takes no positional arguments");
    keygen(opts);
    return;
  }
  if (cmd === "mint") {
    if (positionals.length > 0) throw new Error("mint takes no positional arguments");
    await mintCommand(opts);
    return;
  }
  if (cmd === "revoke") {
    if (positionals.length !== 1) throw new Error("revoke takes one jti");
    revoke(positionals[0]);
    return;
  }
  if (cmd === "list") {
    if (positionals.length > 0 || Object.keys(opts).length > 0) throw new Error("list takes no arguments");
    list();
    return;
  }
  throw new Error(`unknown command ${cmd}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
