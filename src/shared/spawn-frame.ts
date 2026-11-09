/**
 * One-shot host frame: a player took a seat and was placed on a spawn pad. Sent to every
 * client once, at the join. Deaths and respawns need no frame: the health frame already says so.
 * Welcome and a late join never replay it, so a character that is already there does not beam.
 */
export type SpawnFrame = { t: "spawn"; id: number; x: number; y: number; z: number };

export function spawnFrame(id: number, x: number, y: number, z: number): SpawnFrame {
  return { t: "spawn", id, x, y, z };
}

export function parseSpawn(frame: unknown): SpawnFrame | undefined {
  if (!frame || typeof frame !== "object") return undefined;
  const rec = frame as Record<string, unknown>;
  if (rec.t !== "spawn") return undefined;
  if (typeof rec.id !== "number" || !Number.isInteger(rec.id)) return undefined;
  for (const key of ["x", "y", "z"] as const) {
    if (typeof rec[key] !== "number" || !Number.isFinite(rec[key] as number)) return undefined;
  }
  return spawnFrame(rec.id, rec.x as number, rec.y as number, rec.z as number);
}
