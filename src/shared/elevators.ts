/**
 * Elevator cab motion shared by the host and the client.
 * Stops are world y, ascending. Key 1 is the lowest stop. Key 0 is the 10th.
 * The doors are open unless the cab is moving. A call from inside the cab
 * shortens a dwell to one second. A call from the landing waits out `waitS`.
 */
import type { ArenaElevator } from "./arena-view.js";

export type { ArenaElevator };

export const MIN_DWELL_S = 1;
export const RIDE_Y_TOL_M = 0.5;
export const LANDING_HALF_M = 0.6;

/** A few ulps. Keeps an exact metre boundary from slipping one tick or one edge. */
const MEASURE_EPS = 1e-6;

export type ElevatorPhase = "idle" | "moving" | "dwell";

export type ElevatorRuntime = {
  id: string;
  /** Stop index the cab last arrived at. */
  at: number;
  /** Stop index while `phase` is `moving`. */
  target?: number;
  queue: number[];
  phase: ElevatorPhase;
  /** Seconds left in a dwell. */
  t: number;
  /** Current cab floor, world metres. */
  y: number;
};

export type ElevatorCall = {
  t: "elevator";
  id: string;
  stop: number;
};

export type ElevatorState = {
  t: "elevator";
  id: string;
  y: number;
  doorsOpen: boolean;
  stop: number;
};

export function seedElevator(def: ArenaElevator): ElevatorRuntime {
  return {
    id: def.id,
    at: 0,
    queue: [],
    phase: "idle",
    t: 0,
    y: def.stops[0] ?? 0,
  };
}

/** Queue `stop`. False when the stop is out of range, already queued, or the cab is already there and not moving. */
export function callElevator(rt: ElevatorRuntime, def: ArenaElevator, stop: number, fromCab: boolean): boolean {
  if (!Number.isInteger(stop) || stop < 0 || stop >= def.stops.length) return false;
  if (rt.queue.includes(stop)) return false;
  if (rt.phase !== "moving" && stop === rt.at) return false;
  rt.queue.push(stop);
  if (fromCab && rt.phase === "dwell") rt.t = Math.min(rt.t, MIN_DWELL_S);
  return true;
}

/**
 * One tick. A dwell that ends with a queued stop departs in the same call.
 * Arrival snaps `y` onto the stop. A departure does not move `y` yet.
 */
export function stepElevator(rt: ElevatorRuntime, def: ArenaElevator, dt: number): "departed" | "arrived" | undefined {
  if (rt.phase === "dwell") {
    rt.t -= dt;
    if (rt.t > MEASURE_EPS) return;
    rt.phase = "idle";
  }
  if (rt.phase === "idle") {
    const next = rt.queue.shift();
    if (next === undefined) return;
    rt.target = next;
    rt.phase = "moving";
    return "departed";
  }
  const index = rt.target;
  if (index === undefined) return;
  const goal = def.stops[index];
  if (goal === undefined) return;
  const step = def.speed * dt;
  if (Math.abs(goal - rt.y) <= step + MEASURE_EPS) {
    rt.y = goal;
    rt.at = index;
    rt.target = undefined;
    rt.phase = "dwell";
    rt.t = def.waitS;
    return "arrived";
  }
  rt.y += Math.sign(goal - rt.y) * step;
}

/** Landing XZ minus the polygon-bounds centre, snapped to the dominant axis. */
export function elevatorDoorSide(def: ArenaElevator): [number, number] {
  const bounds = elevatorPolygonBounds(def.polygon);
  const landing = def.landings[0];
  if (!landing || !Number.isFinite(bounds.minX)) return [1, 0];
  const dx = landing[0] - (bounds.minX + bounds.maxX) / 2;
  const dz = landing[2] - (bounds.minZ + bounds.maxZ) / 2;
  if (Math.abs(dx) >= Math.abs(dz)) return [dx >= 0 ? 1 : -1, 0];
  return [0, dz >= 0 ? 1 : -1];
}

export function elevatorPolygonBounds(polygon: ReadonlyArray<readonly [number, number]>): {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
} {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const [x, z] of polygon) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  return { minX, maxX, minZ, maxZ };
}

/** Pawn centre inside the cab polygon and within {@link RIDE_Y_TOL_M} of the cab floor. */
export function inCab(def: ArenaElevator, rt: ElevatorRuntime, x: number, y: number, z: number): boolean {
  if (Math.abs(y - rt.y) >= RIDE_Y_TOL_M) return false;
  return pointInPolygon(def.polygon, x, z);
}

/** Stop index whose 1.2 m landing box holds the pawn, else undefined. */
export function landingAt(def: ArenaElevator, x: number, y: number, z: number): number | undefined {
  for (let index = 0; index < def.landings.length; index += 1) {
    const landing = def.landings[index];
    if (!landing) continue;
    if (Math.abs(x - landing[0]) > LANDING_HALF_M + MEASURE_EPS) continue;
    if (Math.abs(z - landing[2]) > LANDING_HALF_M + MEASURE_EPS) continue;
    if (Math.abs(y - landing[1]) >= RIDE_Y_TOL_M) continue;
    return index;
  }
  return undefined;
}

/** `Digit1` is stop 0. `Digit0` is stop 9. Undefined when the stop does not exist. */
export function stopForKey(code: string, stopCount: number): number | undefined {
  const match = /^(?:Digit|Numpad)([0-9])$/.exec(code);
  if (!match) return undefined;
  const digit = Number(match[1]);
  const stop = digit === 0 ? 9 : digit - 1;
  if (stop >= stopCount) return undefined;
  return stop;
}

/** Next stop above `at`, or the lowest stop when the cab is at the top. */
export function nextStopUp(rt: ElevatorRuntime, def: ArenaElevator): number {
  const next = rt.at + 1;
  return next < def.stops.length ? next : 0;
}

export function parseElevatorCall(frame: unknown): ElevatorCall | undefined {
  if (!frame || typeof frame !== "object") return undefined;
  const rec = frame as Record<string, unknown>;
  if (rec.t !== "elevator") return undefined;
  if (typeof rec.id !== "string" || rec.id.length === 0) return undefined;
  if (typeof rec.stop !== "number" || !Number.isInteger(rec.stop)) return undefined;
  return { t: "elevator", id: rec.id, stop: rec.stop };
}

export function elevatorFrame(rt: ElevatorRuntime): ElevatorState {
  return { t: "elevator", id: rt.id, y: rt.y, doorsOpen: rt.phase !== "moving", stop: rt.at };
}

export function parseElevatorState(frame: unknown): ElevatorState | undefined {
  if (!frame || typeof frame !== "object") return undefined;
  const rec = frame as Record<string, unknown>;
  if (rec.t !== "elevator") return undefined;
  if (typeof rec.id !== "string" || rec.id.length === 0) return undefined;
  if (typeof rec.y !== "number" || !Number.isFinite(rec.y)) return undefined;
  if (typeof rec.doorsOpen !== "boolean") return undefined;
  if (typeof rec.stop !== "number" || !Number.isInteger(rec.stop)) return undefined;
  return { t: "elevator", id: rec.id, y: rec.y, doorsOpen: rec.doorsOpen, stop: rec.stop };
}

export function parseElevatorSet(value: unknown): ElevatorState[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: ElevatorState[] = [];
  for (const item of value) {
    const row = parseElevatorState(item);
    if (row) out.push(row);
  }
  return out;
}

function pointInPolygon(polygon: ReadonlyArray<readonly [number, number]>, x: number, z: number): boolean {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const xi = polygon[i]![0];
    const zi = polygon[i]![1];
    const xj = polygon[j]![0];
    const zj = polygon[j]![1];
    const crosses = (zi > z) !== (zj > z);
    if (!crosses) continue;
    const at = ((xj - xi) * (z - zi)) / (zj - zi) + xi;
    if (x < at) inside = !inside;
  }
  return inside;
}
