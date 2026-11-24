// The command modules a probe can dispatch. `--surface` picks one; the tree
// switch (`--tree`) picks the plumbing the probe imports. The module itself is
// loaded by path, so `--surface proto` is the branch's `commands.ts` whatever
// the tree is.
import type { CommandHost, CreateCommandHostOptions } from "./commands-prototype.ts";

export const SURFACES = {
  proto: "packages/bot-client/proto/commands.ts",
  probe: "packages/bot-client/probe/commands-prototype.ts",
} as const;

export type SurfaceName = keyof typeof SURFACES;

/** Both surfaces expose the same command-host factory. */
export type SurfaceModule = { createCommandHost: (options: CreateCommandHostOptions) => CommandHost };

/**
 * Load one named surface lazily.
 * @post An unknown name throws; the two named modules are the only paths.
 */
export async function loadSurface(name: string): Promise<{ path: string; mod: SurfaceModule }> {
  const path = SURFACES[name as SurfaceName];
  if (!path) throw new Error(`unknown surface: ${name} (proto|probe)`);
  const rel = `../${path.replace("packages/bot-client/", "")}`;
  return { path, mod: (await import(rel)) as SurfaceModule };
}
