// ARCHITECTURE: Seat lifecycle writes: bring a player-seat pawn alive or
//   despawn it, without adding game entities.
// Wiring: arena-host.ts calls these on hello and close.
import type { AuthoritativeWorld } from "conveyor-engine-world";

export function setSeatAlive(world: AuthoritativeWorld, id: number, render: unknown): void {
  world.enqueue({ kind: "setLifecycle", entity: id, render } as never);
}

export function despawnSeat(world: AuthoritativeWorld, id: number): void {
  world.enqueue({ kind: "setLifecycle", entity: id });
}
