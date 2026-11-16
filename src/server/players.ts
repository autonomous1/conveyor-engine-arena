// ARCHITECTURE: The host's player roster: owned pawn ids for connected clients,
//   excluding spectators and wander NPCs.
// Wiring: arena-host.ts puts it in welcome and broadcasts changes.
/**
 * player Roster.
 */
export function playerRoster(
  connected: Iterable<number>,
  owned: (clientId: number) => number | undefined,
): number[] {
  const ids: number[] = [];
  for (const clientId of connected) {
    const pawn = owned(clientId);
    if (pawn !== undefined) ids.push(pawn);
  }
  return [...new Set(ids)].sort((a, b) => a - b);
}
