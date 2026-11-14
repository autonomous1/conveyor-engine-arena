import type { ArenaSoundName } from "../shared/arena-view.js";
import type { DoorFrame } from "../shared/doors.js";

/**
 * Door sounds, from the host's door frames.
 *
 * The host sends `{ t: "door", id, open, locked }` to every client when a door really
 * changes (a use that opens or closes it, an unlock that opens it, or a lift forcing
 * its door). Welcome carries the whole list once. This module keeps each door's last
 * known `open` and plays only on a change of it:
 *  - closed to open: the creak, at once (the leaf starts to swing);
 *  - open to closed: the close sound, at once too (the swing is as long as the file).
 *    `closeDelayMs` can hold it back to the end of the swing instead; a door that
 *    opens again before then is not slammed.
 * The welcome list and the doors' initial state set the baseline and are silent. A
 * frame that repeats the known state, a lock change alone, a locked-door attempt (the
 * host sends nothing for it), and an id with no door in the view are all silent.
 *
 * Doors that change together (a lift bank, a group) would stack the same sound. A
 * play is skipped when the same effect already played within `mergeMetres` and
 * `mergeMs`. The effect's voice cap does the rest. Plays are positioned at the leaf.
 */

type Point = { x: number; y: number; z: number };

type Pending = { id: string; sound: ArenaSoundName; due: number };

/**
 * Door open and close from host frames. Plays sit at the leaf.
 * @post Welcome and repeats are silent.
 */
export interface DoorSounds {
  /** Welcome list. Sets the baseline and drops a waiting close. Silent. */
  onSet(doors: ReadonlyArray<Pick<DoorFrame, "id" | "open" | "locked">>): void;
  /** An open change of a known door. An unknown id or a repeat is silent. A close can wait for update. */
  onDoor(door: Pick<DoorFrame, "id" | "open">, now: number): void;
  /** Once per frame. No-op when nothing waits. Plays a close whose delay has elapsed. `now` is ms. */
  update(now: number): void;
  /** Close sounds not played yet. */
  readonly waiting: number;
  /** Drop waiting closes. Remembered open state stays. */
  clear(): void;
}

export function createDoorSounds(opts: {
  /** `at` is the leaf centre in world metres. */
  doors: ReadonlyArray<{ id: string; at: Point; open?: boolean; locked?: boolean }>;
  play: (name: ArenaSoundName, at: Point) => unknown;
  /** Delay from an open to closed frame to the close sound. Default 0: at the start. */
  closeDelayMs?: number;
  mergeMetres?: number;
  mergeMs?: number;
}): DoorSounds {
  const closeDelayMs = opts.closeDelayMs ?? 0;
  const mergeSq = (opts.mergeMetres ?? 2) ** 2;
  const mergeMs = opts.mergeMs ?? 150;
  const centres = new Map<string, Point>();
  const state = new Map<string, boolean>();
  for (const door of opts.doors) {
    centres.set(door.id, { x: door.at.x, y: door.at.y, z: door.at.z });
    state.set(door.id, door.open === true && door.locked !== true);
  }
  let pending: Pending[] = [];
  // Last plays, to merge doors that change together. Fixed storage.
  const RECENT = 8;
  const recentSound: Array<ArenaSoundName | undefined> = new Array(RECENT).fill(undefined);
  const recentAt = new Float64Array(RECENT);
  const recentPoint: Point[] = Array.from({ length: RECENT }, () => ({ x: 0, y: 0, z: 0 }));
  let recentNext = 0;

  function emit(id: string, sound: ArenaSoundName, now: number) {
    const at = centres.get(id);
    if (!at) return;
    for (let i = 0; i < RECENT; i++) {
      if (recentSound[i] !== sound || now - recentAt[i]! > mergeMs) continue;
      const p = recentPoint[i]!;
      if ((p.x - at.x) ** 2 + (p.y - at.y) ** 2 + (p.z - at.z) ** 2 <= mergeSq) return;
    }
    recentSound[recentNext] = sound;
    recentAt[recentNext] = now;
    recentPoint[recentNext]!.x = at.x;
    recentPoint[recentNext]!.y = at.y;
    recentPoint[recentNext]!.z = at.z;
    recentNext = (recentNext + 1) % RECENT;
    opts.play(sound, at);
  }

  return {
    /** Welcome: the whole door list. Sets the baseline, silent. */
    onSet(doors: ReadonlyArray<Pick<DoorFrame, "id" | "open" | "locked">>) {
      pending = [];
      for (const door of doors) if (state.has(door.id)) state.set(door.id, door.open);
    },
    /** One door frame. Plays only on a real open/closed change. */
    onDoor(door: Pick<DoorFrame, "id" | "open">, now: number) {
      const before = state.get(door.id);
      if (before === undefined) return;
      if (before === door.open) return;
      state.set(door.id, door.open);
      pending = pending.filter((entry) => entry.id !== door.id);
      if (door.open) emit(door.id, "doorOpen", now);
      else if (closeDelayMs > 0) pending.push({ id: door.id, sound: "doorClose", due: now + closeDelayMs });
      else emit(door.id, "doorClose", now);
    },
    /** Once per frame. Free when nothing waits. */
    update(now: number) {
      if (pending.length === 0) return;
      let kept = 0;
      for (const entry of pending) {
        if (now >= entry.due) emit(entry.id, entry.sound, now);
        else pending[kept++] = entry;
      }
      pending.length = kept;
    },
    get waiting() {
      return pending.length;
    },
    clear() {
      pending = [];
    },
  };
}
