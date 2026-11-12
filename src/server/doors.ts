/**
 * Door state for the arena host. A use frame toggles the overlapping door.
 * Locked doors open only for the pawn who holds `key`. That id stays held.
 * The clear volume is not a collider. A shut leaf is: `blockers` keeps one
 * obstacle per door in the world and parks it while the door is open.
 * Changes are broadcast by the caller on the socket, not as a snap envelope.
 */
import type { ArenaView } from "../shared/arena-view.js";
import type { ElevatorDoors } from "./elevators.js";
import { markDynamicObstacle } from "../shared/movements.js";
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

/** One live kernel obstacle per door. Opening parks it; nothing is removed. */
export type DoorBlockers = {
  /**
   * Shut: the leaf box blocks. Open: the box is parked.
   * The first call for this door adds the obstacle.
   */
  sync(door: Pick<DoorRuntime, "id" | "open" | "position" | "yaw" | "hinge" | "size">): void;
  /** Kernel obstacle id after `sync`. An unknown door is undefined and does not create one. */
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
      // The leaf box moves in XZ in place, so the floor grid checks it every query.
      markDynamicObstacle(box);
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

/**
 * What a use press did. `none`: no door in reach. `open`: the door was already
 * open and was left alone (a brain press only). `lift`: it rides a moving cab.
 */
export type DoorUseResult = "none" | "open" | "lift" | "locked" | "opened" | "closed";

/** Open, locked, and held doors, plus the use-seq gate. In memory, lost on restart. */
export interface ArenaDoors {
  /** Sorted by id. New array of detached rows. */
  snapshot(): Array<{ id: string; open: boolean; locked: boolean }>;
  /** Forgets this client's use seq. An unknown client is a no-op. */
  drop(clientId: number): void;
  /**
   * False only for a fresh use from a live pawn with no door in reach.
   * A toggle mutates the door, syncs its blocker, and broadcasts.
   */
  onFrame(clientId: number, frame: unknown): boolean;
  /**
   * Same reach, lock, and key rules as a player. A dead or missing pawn returns `none`.
   * Only that door is considered, and an open door is left alone.
   */
  useDoorAs(pawnId: number, only: { door: string }): DoorUseResult;
  /** Shifts the door to home y + `dy` metres and re-syncs its blocker. An unknown id is a no-op. */
  offset(id: string, dy: number): void;
  /** Sets open or shut, syncs the blocker, and broadcasts. No-op if missing or unchanged. */
  force(id: string, open: boolean): void;
  /** While held, use presses on this door are refused. An unknown id is still recorded. */
  hold(id: string, held: boolean): void;
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
  /**
   * A key was consumed for this pawn. Unlock does not consume keys, so
   * nothing calls this. Wire it only on a future consume path.
   */
  onKeysChanged?(pawnId: number): void;
}): ArenaDoors {
  const state = new Map<string, DoorRuntime>();
  const homeY = new Map<string, number>();
  for (const door of opts.doors) {
    if (typeof door.id !== "string" || door.id.length === 0) continue;
    const seeded = seedDoor(door);
    state.set(door.id, seeded);
    homeY.set(door.id, seeded.position[1]);
  }
  for (const door of state.values()) opts.blockers?.sync(door);
  const gates = new Map<number, DoorGate>();
  const held = new Set<string>();

  const ride: ElevatorDoors = {
    offset(id, dy) {
      const door = state.get(id);
      const y0 = homeY.get(id);
      if (!door || y0 === undefined) return;
      const y = y0 + dy;
      if (door.position[1] !== y) door.position = [door.position[0], y, door.position[2]];
      opts.blockers?.sync(door);
    },
    force(id, open) {
      const door = state.get(id);
      if (!door || door.open === open) return;
      door.open = open;
      opts.blockers?.sync(door);
      opts.sendAll(doorFrame(door.id, door.open, door.locked));
    },
    hold(id, on) {
      if (on) held.add(id);
      else held.delete(id);
    },
  };

  /** One use press by `pawn`. `only` limits it to that door, and never closes it. */
  function press(pawnId: number, pawn: PawnBody, at: string, only?: string): DoorUseResult {
    let pool = [...state.values()];
    if (only !== undefined) pool = pool.filter((item) => item.id === only);
    const door = pickDoorForUse(pool, pawn);
    if (!door) {
      if (only === undefined) opts.log?.(`[door] use ${at}: no door in reach${nearestNote(pool, pawn)}`);
      return "none";
    }
    if (only !== undefined && door.open) return "open";
    if (held.has(door.id)) {
      opts.log?.(`[door] use ${at}: ${door.id} rides a moving lift`);
      return "lift";
    }
    const next = tryUseDoor(door, pawnId, opts.keys);
    if (!next) {
      opts.log?.(`[door] use ${at}: ${door.id} is locked; this pawn does not hold "${door.key ?? ""}"`);
      return "locked";
    }
    opts.blockers?.sync(door);
    opts.log?.(`[door] use ${at}: ${door.id} open=${next.open} locked=${next.locked}`);
    opts.sendAll(doorFrame(next.id, next.open, next.locked));
    return next.open ? "opened" : "closed";
  }

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
    /**
     * False only for a fresh use from a live pawn with no door in reach.
     * Every other use frame returns true, so one E press is not handled twice.
     */
    onFrame(clientId: number, frame: unknown): boolean {
      const use = parseUse(frame);
      if (!use) return true;
      const sessionId = opts.sessionId(clientId);
      if (sessionId === undefined) return true;
      const pawnId = opts.ownedPawn(clientId);
      if (pawnId === undefined) return true;
      let row = gates.get(clientId);
      if (!row || row.sessionId !== sessionId) {
        row = { sessionId, lastSeq: 0 };
        gates.set(clientId, row);
      }
      if (!(use.seq > row.lastSeq)) return true;
      row.lastSeq = use.seq;
      if (opts.alive && !opts.alive(pawnId)) return true;
      const pawn = opts.pawnOf(pawnId);
      if (!pawn || !pawn.alive) return true;
      const at = `client=${clientId} pawn=${pawnId} at (${pawn.x.toFixed(2)}, ${pawn.y.toFixed(2)}, ${pawn.z.toFixed(2)})`;
      return press(pawnId, pawn, at) !== "none";
    },
    /**
     * A host brain presses use for a pawn it drives. Same reach volume, lift,
     * lock and key rules as a player's frame. Only `door` is considered, and
     * an open door is left alone, so a bot never closes one.
     */
    useDoorAs(pawnId: number, only: { door: string }): DoorUseResult {
      const pawn = opts.pawnOf(pawnId);
      if (!pawn || !pawn.alive) return "none";
      if (opts.alive && !opts.alive(pawnId)) return "none";
      const at = `bot pawn=${pawnId} at (${pawn.x.toFixed(2)}, ${pawn.y.toFixed(2)}, ${pawn.z.toFixed(2)})`;
      return press(pawnId, pawn, at, only.door);
    },
    offset: ride.offset,
    force: ride.force,
    hold: ride.hold,
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
    position: [door.position[0], door.position[1], door.position[2]],
    size: door.size,
    yaw: door.yaw,
  };
}
