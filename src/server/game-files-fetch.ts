import { placementRefsOf } from "./game-manifest.js";
import type { GameFiles } from "./game-files.js";

const MANIFEST_REF = "./web/game/arena.game.json";
const PROFILES_REF = "./web/game/building-profiles.json";

/**
 * Fetch the manifest, every scene file it names, optional building profiles,
 * and every asset uri into memory. `compileGame` stays synchronous over the map.
 * `./web/game/x.json` becomes `${base}game/x.json`. `/assets/...` becomes `${base}assets/...`.
 * `..` and paths outside `game/` and `assets/` are rejected.
 */
export async function preloadGameFiles(base = "./"): Promise<GameFiles> {
  const texts = new Map<string, string>();
  const bytes = new Map<string, Uint8Array>();
  const missing = new Set<string>();

  const manifestUrl = mapRef(base, MANIFEST_REF);
  if (manifestUrl) {
    const res = await fetch(manifestUrl);
    if (res.ok) texts.set(MANIFEST_REF, await res.text());
  }

  let doc: unknown;
  const manifestText = texts.get(MANIFEST_REF);
  if (manifestText !== undefined) {
    try {
      doc = JSON.parse(manifestText);
    } catch {
      doc = undefined;
    }
  }

  for (const ref of sceneRefs(doc)) {
    const url = mapRef(base, ref);
    if (!url) {
      missing.add(ref);
      continue;
    }
    const res = await fetch(url);
    if (!res.ok) {
      missing.add(ref);
      continue;
    }
    texts.set(ref, await res.text());
  }

  const profilesUrl = mapRef(base, PROFILES_REF);
  if (profilesUrl) {
    const res = await fetch(profilesUrl);
    if (res.ok) texts.set(PROFILES_REF, await res.text());
  }

  for (const uri of assetUris(doc)) {
    const url = mapUri(base, uri);
    if (!url) continue;
    const res = await fetch(url);
    if (!res.ok) continue;
    bytes.set(uri, new Uint8Array(await res.arrayBuffer()));
  }

  return {
    text(ref: string): string | undefined {
      if (missing.has(ref)) throw new Error(`file not found: ${ref.trim()}`);
      return texts.get(ref);
    },
    bytes(uri: string): Uint8Array | undefined {
      return bytes.get(uri);
    },
  };
}

function sceneRefs(doc: unknown): string[] {
  if (!doc || typeof doc !== "object") return [];
  const scene = (doc as { scene?: unknown }).scene;
  if (!scene || typeof scene !== "object") return [];
  const record = scene as Record<string, unknown>;
  const refs: string[] = [];
  for (const key of ["bounds", "spawnPoints", "playerSpawnPoints", "lights", "elevators", "sceneGraph"]) {
    if (typeof record[key] === "string") refs.push(record[key]);
  }
  const listed = placementRefsOf(scene);
  for (const ref of listed.refs) refs.push(ref.file);
  return refs;
}

function assetUris(doc: unknown): string[] {
  if (!doc || typeof doc !== "object") return [];
  const assets = (doc as { assets?: unknown }).assets;
  if (!Array.isArray(assets)) return [];
  const uris: string[] = [];
  for (const asset of assets) {
    if (!asset || typeof asset !== "object") continue;
    const uri = (asset as { uri?: unknown }).uri;
    if (typeof uri === "string") uris.push(uri);
  }
  return uris;
}

/** Manifest ref → URL under `base`. Undefined when the ref may not be fetched. */
export function mapRef(base: string, ref: string): string | undefined {
  const trimmed = ref.trim();
  if (!trimmed || trimmed.includes("\0") || trimmed.includes("\\") || trimmed.startsWith("/")) return undefined;
  if (trimmed.split("/").includes("..")) return undefined;
  const slash = trimmed.replace(/^\.\//, "");
  let rel: string | undefined;
  if (slash.startsWith("web/game/") || slash.startsWith("web/assets/")) rel = slash.slice("web/".length);
  if (!rel || (!rel.startsWith("game/") && !rel.startsWith("assets/"))) return undefined;
  return joinBase(base, rel);
}

/** Asset uri → URL under `base`. Undefined when the uri leaves `assets/`. */
export function mapUri(base: string, uri: string): string | undefined {
  if (uri.charCodeAt(0) !== 47 || !uri.startsWith("assets/", 1)) return undefined;
  if (uri.includes("..") || uri.includes("\\") || uri.includes("\0")) return undefined;
  return joinBase(base, uri.slice(1));
}

function joinBase(base: string, rel: string): string {
  if (base.endsWith("/")) return base + rel;
  return `${base}/${rel}`;
}
