// ARCHITECTURE: Elevator start and ride loops, positional at the cab.
// Wiring: boot.ts drains it each frame.
import type { ArenaSoundName } from "../shared/arena-view.js";
import type { ElevatorState } from "../shared/elevators.js";

/**
 * The elevator start sound, from the host's cab frames.
 *
 * The host sends `{ t: "elevator", id, y, doorsOpen, stop }` on every cab event and on every tick
 * while a cab moves. `doorsOpen` is false exactly while the cab is moving, so the first frame with
 * `doorsOpen: false` after a frame with `doorsOpen: true` is the departure (the cab has just left
 * a stop for its target). That one transition plays `elevatorStart`, at the cab. The frames that
 * follow, while it moves, only move the sound with the cab. Welcome carries every cab once: it is the
 * silent baseline, so a late joiner does not hear a cab that is already moving, and a repeated
 * frame in the same state is silent. An id with no cab in the view is silent.
 *
 * The cab does not wait for its doors: on a departure the host shuts the room doors and the cab
 * rises on the next tick, so the sound starts with the motion.
 */

type Point = { x: number; y: number; z: number };

type Handle = { move(x: number, y: number, z: number): boolean };

/** `elevatorStart` when a cab leaves a stop. The voice follows the cab until the doors open. */
export interface ElevatorSounds {
  /** Welcome. Records motion and does not play. Drops any follow handles. */
  onSet(rows: readonly ElevatorState[]): void;
  /**
   * Plays when a known cab goes from stopped to moving. Unknown ids are silent.
   * Doors opening drops the follow handle. The node keeps playing.
   */
  onCab(row: ElevatorState): void;
  /** Forget follow handles and remembered motion. Sounding nodes keep playing. */
  clear(): void;
  /** Cabs whose voice is still being moved. */
  readonly following: number;
}

export function createElevatorSounds(opts: {
  /** `x`, `z`: the cab centre. `y` of a frame is the cab floor; the sound sits `earHeight` above it. */
  cabs: ReadonlyArray<{ id: string; x: number; z: number }>;
  /** Starts the sound; the handle follows the cab while it plays. Undefined when nothing started. */
  play: (name: ArenaSoundName, at: Point) => Handle | undefined;
  earHeight?: number;
}): ElevatorSounds {
  const earHeight = opts.earHeight ?? 1.2;
  const centres = new Map(opts.cabs.map((cab) => [cab.id, cab] as const));
  const moving = new Map<string, boolean>();
  const handles = new Map<string, Handle>();
  const scratch: Point = { x: 0, y: 0, z: 0 };

  function follow(id: string, y: number) {
    const handle = handles.get(id);
    const cab = centres.get(id);
    if (!handle || !cab) return;
    if (!handle.move(cab.x, y + earHeight, cab.z)) handles.delete(id);
  }

  return {
    /** Welcome: record every cab's state without a sound. */
    onSet(rows: readonly ElevatorState[]) {
      handles.clear();
      moving.clear();
      for (const row of rows) if (centres.has(row.id)) moving.set(row.id, !row.doorsOpen);
    },
    /** One cab frame. Plays only on a stationary-to-moving change of a known cab. */
    onCab(row: ElevatorState) {
      const cab = centres.get(row.id);
      if (!cab) return;
      const was = moving.get(row.id);
      const now = !row.doorsOpen;
      moving.set(row.id, now);
      if (!now) {
        handles.delete(row.id);
        return;
      }
      if (was === false) {
        scratch.x = cab.x;
        scratch.y = row.y + earHeight;
        scratch.z = cab.z;
        const handle = opts.play("elevatorStart", scratch);
        if (handle) handles.set(row.id, handle);
        else handles.delete(row.id);
        return;
      }
      if (was === true) follow(row.id, row.y);
    },
    clear() {
      handles.clear();
      moving.clear();
    },
    /** Cabs whose sound is being followed. */
    get following() {
      return handles.size;
    },
  };
}
