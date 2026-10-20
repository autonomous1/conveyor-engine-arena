/**
 * Door state for the arena host. A use frame toggles the overlapping door.
 * Locked doors open only for the pawn who holds `key`, and that id is consumed.
 * The clear volume is not a collider. A shut leaf is: `blockers` keeps one
 * obstacle per door in the world and parks it while the door is open.
 * Changes are broadcast by the caller on the socket, not as a snap envelope.
 */
import type { ArenaView } from "../shared/arena-view.js";
import {
  doorFrame,
  doorLeafBox,
  doorUseVolume,
  parseUse,
  pickDoorForUse,
  tryUseDoor,
  type DoorFrame,
  type DoorRuntime,
  type KeyRing,
} from "../shared/doors.js";
import type { PawnBody } from "../shared/pickups.js";

type DoorGate = { sessionId: number; lastSeq: number };

/** Live obstacle shape the kernel keeps. Only these fields are read or written. */
type LiveBox = { id: number; minX: number; maxX: number; minZ: number; maxZ: number; minY?: number; maxY?: number };

/** The two public kernel calls a blocker needs. No kernel change, no splice. */
export type ObstacleWorld = {
  addObstacle(obstacle: LiveBox): void;
  listObstacles(): readonly LiveBox[];
};

export type DoorBlockers = {
  /** Shut: the leaf box blocks. Open: the box is parked. */
  sync(door: Pick<DoorRuntime, "id" | "open" | "position" | "yaw" | "hinge" | "size">): void;
  /** Kernel obstacle id of this door's blocker, once synced. */
  obstacleId(doorId: string): number | undefined;
};

/** Far below the floor and zero size: no push-out, no floor, no trace hit. */
const PARKED = -1e6;

/**
 * One kernel obstacle per door, added once with `addObstacle`. Opening and
 * closing rewrite that live box in place (the kernel loops every obstacle each
 * commit, so the next tick sees it). Nothing is spliced out of `listObstacles`.
 */
export function createDoorBlockers(world: ObstacleWorld): DoorBlockers {
  const ids = new Map<string, number>();
  const live = (id: number): LiveBox | undefined => world.listObstacles().find((box) => box.id === id);
  return {
    sync(door) {
      let id = ids.get(door.id);
      if (id === undefined) {
        id = world.listObstacles().reduce((max, box) => Math.max(max, box.id), 0) + 1;
        world.addObstacle({ id, minX: PARKED, maxX: PARKED, minY: PARKED, maxY: PARKED, minZ: PARKED, maxZ: PARKED });
        ids.set(door.id, id);
      }
      const box = live(id);
      if (!box) return;
      const shut = door.open ? undefined : doorLeafBox(door);
      box.minX = shut ? shut.minX : PARKED;
      box.maxX = shut ? shut.maxX : PARKED;
      box.minY = shut ? shut.minY : PARKED;
      box.maxY = shut ? shut.maxY : PARKED;
      box.minZ = shut ? shut.minZ : PARKED;
      box.maxZ = shut ? shut.maxZ : PARKED;
    },
    obstacleId(doorId) {
      return ids.get(doorId);
    },
  };
}

export function createArenaDoors(opts: {
  doors: ReadonlyArray<ArenaView["doors"][number]>;
  pawnOf(pawnId: number): PawnBody | undefined;
  keys: KeyRing;
  /** Every connected client. Do not consult the snap envelope map. */
  sendAll(frame: DoorFrame): void;
  ownedPawn(clientId: number): number | undefined;
  sessionId(clientId: number): number | undefined;
  alive?(pawnId: number): boolean;
  /** Shut leaves block movement, shots, and grenades. Omit for no collision. */
  blockers?: DoorBlockers;
  /** One line per accepted use press, with the outcome. */
  log?(line: string): void;
}) {
  const state = new Map<string, DoorRuntime>();
  for (const door of opts.doors) {
    if (typeof door.id !== "string" || door.id.length === 0) continue;
    state.set(door.id, seedDoor(door));
  }
  for (const door of state.values()) opts.blockers?.sync(door);
  const gates = new Map<number, DoorGate>();

  return {
    /** Current open/locked rows, sorted by id. Welcome attaches this list. */
    snapshot(): Array<{ id: string; open: boolean; locked: boolean }> {
      return [...state.values()]
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map((door) => ({ id: door.id, open: door.open, locked: door.locked }));
    },
    /** Drop the use seq for a disconnect so the map does not keep dead clients. */
    drop(clientId: number) {
      gates.delete(clientId);
    },
    onFrame(clientId: number, frame: unknown) {
      const use = parseUse(frame);
      if (!use) return;
      const sessionId = opts.sessionId(clientId);
      if (sessionId === undefined) return;
      const pawnId = opts.ownedPawn(clientId);
      if (pawnId === undefined) return;
      let row = gates.get(clientId);
      if (!row || row.sessionId !== sessionId) {
        row = { sessionId, lastSeq: 0 };
        gates.set(clientId, row);
      }
      if (!(use.seq > row.lastSeq)) return;
      row.lastSeq = use.seq;
      if (opts.alive && !opts.alive(pawnId)) return;
      const pawn = opts.pawnOf(pawnId);
      if (!pawn || !pawn.alive) return;
      const at = `client=${clientId} pawn=${pawnId} at (${pawn.x.toFixed(2)}, ${pawn.y.toFixed(2)}, ${pawn.z.toFixed(2)})`;
      const door = pickDoorForUse([...state.values()], pawn);
      if (!door) {
        opts.log?.(`[door] use ${at}: no door in reach${nearestNote([...state.values()], pawn)}`);
        return;
      }
      const next = tryUseDoor(door, pawnId, opts.keys);
      if (!next) {
        opts.log?.(`[door] use ${at}: ${door.id} is locked; this pawn does not hold "${door.key ?? ""}"`);
        return;
      }
      opts.blockers?.sync(door);
      opts.log?.(`[door] use ${at}: ${door.id} open=${next.open} locked=${next.locked}`);
      opts.sendAll(doorFrame(next.id, next.open, next.locked));
    },
  };
}

/** Which door volume is closest, and how far the capsule is from it. For the log only. */
function nearestNote(doors: readonly DoorRuntime[], pawn: PawnBody): string {
  let best = "";
  let bestGap = Infinity;
  for (const door of doors) {
    const v = doorUseVolume(door);
    const dx = Math.max(v.minX - pawn.x, 0, pawn.x - v.maxX);
    const dz = Math.max(v.minZ - pawn.z, 0, pawn.z - v.maxZ);
    const dy = pawn.y >= v.maxY ? pawn.y - v.maxY : pawn.y + pawn.height <= v.minY ? v.minY - (pawn.y + pawn.height) : 0;
    const gap = Math.hypot(Math.max(Math.hypot(dx, dz) - pawn.radius, 0), dy);
    if (gap < bestGap) {
      bestGap = gap;
      best = `; nearest ${door.id} volume x ${v.minX.toFixed(2)}..${v.maxX.toFixed(2)} y ${v.minY.toFixed(2)}..${v.maxY.toFixed(2)} z ${v.minZ.toFixed(2)}..${v.maxZ.toFixed(2)}, ${gap.toFixed(2)} m away`;
    }
  }
  return best;
}

function seedDoor(door: ArenaView["doors"][number]): DoorRuntime {
  const locked = door.locked === true;
  const key = typeof door.key === "string" && door.key.length > 0 ? door.key : undefined;
  return {
    id: door.id,
    hinge: door.hinge,
    open: locked ? false : door.open === true,
    locked,
    ...(key ? { key } : {}),
    position: door.position,
    size: door.size,
    yaw: door.yaw,
  };
}
