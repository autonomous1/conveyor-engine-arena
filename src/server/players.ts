// ARCHITECTURE: The host's player roster: owned pawn ids for connected clients,
//   excluding spectators and wander NPCs, and the team each pawn spawned with.
// Wiring: arena-host.ts puts it in welcome and broadcasts changes.
import type { PlayerTeamRow } from "../shared/bot-protocol.js";

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

/**
 * Team rows for the connected roster, in `ids` order.
 * @post A pawn with no team is omitted; neither input is mutated.
 */
export function playerTeams(
  ids: readonly number[],
  agents: readonly { id: number; team?: string }[],
): PlayerTeamRow[] {
  const team = new Map<number, string>();
  for (const agent of agents) if (agent.team !== undefined) team.set(agent.id, agent.team);
  return ids.flatMap((id) => {
    const name = team.get(id);
    return name === undefined ? [] : [{ id, team: name }];
  });
}
