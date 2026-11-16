// ARCHITECTURE: Node-only wander-dump writer. Installs the global used by
//   game.ts; the client/solo bundle never imports it.
// Wiring: main.ts calls `installWanderDebug` at startup.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WanderDumpWriter, WanderStall } from "./wander-debug.js";

/**
 * install Wander Debug.
 */
export function installWanderDebug(): boolean {
  if (process.env.ARENA_WANDER_DEBUG !== "1") return false;
  (globalThis as { __wanderDebugEnabled?: boolean }).__wanderDebugEnabled = true;
  const writer: WanderDumpWriter = (dump: WanderStall, dir = process.env.ARENA_WANDER_DUMP ?? "/tmp") => {
    try {
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `wander-stall-${dump.tick}-${dump.agent}.json`);
      writeFileSync(path, `${JSON.stringify(dump, null, 2)}\n`);
      return path;
    } catch {
      return undefined;
    }
  };
  (globalThis as { __wanderDumpWriter?: WanderDumpWriter }).__wanderDumpWriter = writer;
  return true;
}
