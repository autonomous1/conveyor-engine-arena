/**
 * Host elevator cabs. A call frame is accepted from inside the cab or from
 * the landing of that stop. E calls the next stop up from the cab, or the
 * landing the pawn is standing on. Riders are carried with setTransform and
 * shielded by the wander loop so a hall slab cannot push them out of the shaft.
 */
import type { AuthoritativeWorld } from "conveyor-engine-world";
import type { ArenaElevator } from "../shared/arena-view.js";
import {
  callElevator,
  elevatorFrame,
  elevatorPolygonBounds,
  inCab,
  landingAt,
  nextStopUp,
  parseElevatorCall,
  seedElevator,
  stepElevator,
  type ElevatorRuntime,
  type ElevatorState,
} from "../shared/elevators.js";
import { yawFromQuat } from "../shared/look.js";
import type { PawnBody } from "../shared/pickups.js";
import { placePawn } from "./game.js";

type FloorBox = { minX: number; maxX: number; minZ: number; maxZ: number; maxY?: number };

type Cab = {
  def: ArenaElevator;
  rt: ElevatorRuntime;
  riders: number[];
};

export function createArenaElevators(opts: {
  elevators: readonly ArenaElevator[];
  world: AuthoritativeWorld;
  pawns(): PawnBody[];
  ownedPawn(clientId: number): number | undefined;
  alive(pawnId: number): boolean;
  sendAll(frame: ElevatorState): void;
  log?(line: string): void;
}) {
  const cabs: Cab[] = opts.elevators.map((def) => ({ def, rt: seedElevator(def), riders: [] }));
  const byId = new Map(cabs.map((cab) => [cab.def.id, cab]));
  warnMissingFloors(opts.elevators, opts.world, opts.log);

  const living = (id: number): boolean => {
    if (!opts.alive(id)) return false;
    const pawn = opts.pawns().find((body) => body.id === id);
    return pawn?.alive === true;
  };

  const capture = (cab: Cab): number[] => {
    const ids: number[] = [];
    for (const pawn of opts.pawns()) {
      if (!pawn.alive || !opts.alive(pawn.id)) continue;
      if (inCab(cab.def, cab.rt, pawn.x, pawn.y, pawn.z)) ids.push(pawn.id);
    }
    return ids;
  };

  const moveRider = (cab: Cab, id: number): void => {
    const view = opts.world.store.view(id);
    const pawn = opts.pawns().find((body) => body.id === id);
    if (!view || !pawn) return;
    placePawn(opts.world, id, {
      x: pawn.x,
      y: cab.rt.y,
      z: pawn.z,
      yaw: yawFromQuat(view.rotation),
    });
  };

  return {
    /** Current cab rows for the welcome. Empty when the manifest has no elevators. */
    snapshot(): ElevatorState[] {
      return cabs.map((cab) => elevatorFrame(cab.rt));
    },
    onFrame(clientId: number, frame: unknown): void {
      const call = parseElevatorCall(frame);
      if (!call) return;
      const pawnId = opts.ownedPawn(clientId);
      if (pawnId === undefined) return;
      const cab = byId.get(call.id);
      const pawn = opts.pawns().find((body) => body.id === pawnId);
      if (!cab || !pawn || !pawn.alive || !opts.alive(pawnId)) {
        opts.log?.(`[elevator] call id=${call.id} stop=${call.stop} client=${clientId} pawn=${pawnId ?? "none"}: rejected`);
        return;
      }
      const inside = inCab(cab.def, cab.rt, pawn.x, pawn.y, pawn.z);
      const atLanding = landingAt(cab.def, pawn.x, pawn.y, pawn.z) === call.stop;
      if (!inside && !atLanding) {
        opts.log?.(`[elevator] call id=${call.id} stop=${call.stop} client=${clientId} pawn=${pawnId}: not in the cab or at that landing`);
        return;
      }
      callElevator(cab.rt, cab.def, call.stop, inside);
    },
    /** E while a door is not in reach. True when the pawn is in a cab or on a landing. */
    onUse(pawnId: number): boolean {
      const pawn = opts.pawns().find((body) => body.id === pawnId);
      if (!pawn || !pawn.alive || !opts.alive(pawnId)) return false;
      for (const cab of cabs) {
        if (!inCab(cab.def, cab.rt, pawn.x, pawn.y, pawn.z)) continue;
        callElevator(cab.rt, cab.def, nextStopUp(cab.rt, cab.def), true);
        return true;
      }
      for (const cab of cabs) {
        const stop = landingAt(cab.def, pawn.x, pawn.y, pawn.z);
        if (stop === undefined) continue;
        callElevator(cab.rt, cab.def, stop, false);
        return true;
      }
      return false;
    },
    /**
     * Advance every cab. Returns the pawn ids carried on this tick, including
     * the arrival tick. The wander loop skips their input and shields them.
     */
    step(dt: number): number[] {
      const carried: number[] = [];
      for (const cab of cabs) {
        const before = cab.rt.phase;
        const event = stepElevator(cab.rt, cab.def, dt);
        if (event === "departed") cab.riders = capture(cab);
        cab.riders = cab.riders.filter(living);
        if (cab.rt.phase === "moving" || event === "arrived") {
          for (const id of cab.riders) moveRider(cab, id);
        }
        if (event !== undefined || cab.rt.phase === "moving" || (before === "dwell" && cab.rt.phase === "idle")) {
          opts.sendAll(elevatorFrame(cab.rt));
        }
        if (cab.rt.phase === "moving" || event === "arrived") carried.push(...cab.riders);
        if (event === "arrived") cab.riders = [];
      }
      return carried;
    },
  };
}

/** A stop above the ground with no obstacle top within 1 cm under the cab centre. */
function warnMissingFloors(
  elevators: readonly ArenaElevator[],
  world: { listObstacles(): readonly FloorBox[] },
  log?: (line: string) => void,
): void {
  if (!log) return;
  const boxes = world.listObstacles();
  for (const def of elevators) {
    const bounds = elevatorPolygonBounds(def.polygon);
    if (!Number.isFinite(bounds.minX)) continue;
    const cx = (bounds.minX + bounds.maxX) / 2;
    const cz = (bounds.minZ + bounds.maxZ) / 2;
    def.stops.forEach((stop, index) => {
      if (!(stop > 0.01)) return;
      const supported = boxes.some((box) =>
        typeof box.maxY === "number"
        && Math.abs(box.maxY - stop) <= 0.01
        && cx >= box.minX && cx <= box.maxX
        && cz >= box.minZ && cz <= box.maxZ,
      );
      if (!supported) log(`[elevator] ${def.id} stop ${index} y=${stop} has no floor under the cab`);
    });
  }
}
