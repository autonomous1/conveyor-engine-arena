/**
 * The bound elevator room is the cab. Meshes, the door, the lamp, and the
 * client's wall copies shift by `cab.y − stops[0]`. A rider's rendered y
 * wins while the cab is moving, so the floor stays on their feet (pawns
 * draw 80 ms late). Everyone else samples cab frames at `now − 80`.
 * Elevated hall meshes hide only for the owned rider, and only while moving.
 */
import type { Object3D } from "three";
import type { ArenaElevator, ArenaView } from "../shared/arena-view.ts";
import { inCab, type ElevatorRuntime, type ElevatorState } from "../shared/elevators.ts";
import type { PlacementVisibility } from "./placements.ts";

/** Same lag as `EngineClient` `delayMs`. Cab frames have no delay of their own. */
const SAMPLE_LAG_MS = 80;

const MOVE_EPS_M = 0.001;

type Frame = { t: number; y: number; doorsOpen: boolean; stop: number };

type AabbHome = { box: ArenaView["aabbs"][number]; minY: number; maxY: number };

type DoorHome = { door: ArenaView["doors"][number]; y: number };

type Cab = {
  def: ArenaElevator;
  room: string;
  placementIds: string[];
  lightIds: string[];
  halls: string[];
  aabbs: AabbHome[];
  doors: DoorHome[];
  frames: Frame[];
  applied: number | undefined;
  hallsHidden: boolean;
};

export type ElevatorRoomVisuals = {
  placements: Pick<PlacementVisibility, "setOffsetY" | "setVisible" | "flushBounds">;
  lights: ReadonlyMap<string, Object3D>;
};

export type ElevatorRoomDebug = {
  offsetY(prefix: string, dy: number): void;
};

export type RenderPawn = { x: number; y: number; z: number };

/**
 * Cab-room meshes, lights, doors, and view boxes shift with host cab frames.
 * @why Nothing is added or removed.
 */
export interface ElevatorRooms {
  /** One cab frame. An unknown id is a no-op. The stamp is performance.now. Two frames are kept. */
  onCab(row: ElevatorState): void;
  /**
   * Once per frame. A rider's y wins while the cab moves. Halls hide only for that rider.
   * Writes offsets in place. `now` is ms. Always flushes placement bounds.
   */
  tick(now: number, pawn: RenderPawn | undefined): void;
}

export function createElevatorRooms(
  view: ArenaView,
  visuals: ElevatorRoomVisuals,
  collisionDebug: ElevatorRoomDebug,
): ElevatorRooms {
  const lightHome = new Map<Object3D, number>();
  const cabs = new Map<string, Cab>();
  for (const def of view.elevators ?? []) {
    if (!def.room) continue;
    const room = def.room;
    const prefix = `${room}.`;
    cabs.set(def.id, {
      def,
      room,
      placementIds: placementIds(view, room),
      lightIds: (view.lights ?? []).filter((light) => light.id.startsWith(prefix)).map((light) => light.id),
      halls: hallIds(def.building, view.buildings),
      aabbs: (view.aabbs ?? []).flatMap((box) => {
        if (!box.source?.startsWith(prefix)) return [];
        if (typeof box.minY !== "number" || typeof box.maxY !== "number") return [];
        return [{ box, minY: box.minY, maxY: box.maxY }];
      }),
      doors: (view.doors ?? []).flatMap((door) => {
        if (!door.id.startsWith(prefix)) return [];
        return [{ door, y: door.position[1] }];
      }),
      frames: [],
      applied: undefined,
      hallsHidden: false,
    });
  }

  const apply = (cab: Cab, dy: number) => {
    for (const id of cab.placementIds) visuals.placements.setOffsetY(id, dy);
    for (const id of cab.lightIds) {
      const light = visuals.lights.get(id);
      if (!light) continue;
      const stored = lightHome.get(light);
      const home = stored === undefined ? light.position.y : stored;
      if (stored === undefined) lightHome.set(light, home);
      light.position.y = home + dy;
    }
    collisionDebug.offsetY(`${cab.room}.`, dy);
    for (const row of cab.aabbs) {
      row.box.minY = row.minY + dy;
      row.box.maxY = row.maxY + dy;
    }
    for (const row of cab.doors) row.door.position[1] = row.y + dy;
  };

  const riding = (cab: Cab, pawn: RenderPawn | undefined): boolean => {
    if (!pawn) return false;
    const latest = cab.frames.at(-1);
    if (!latest || latest.doorsOpen) return false;
    return inCab(cab.def, runtime(cab.def, latest), pawn.x, pawn.y, pawn.z);
  };

  return {
    onCab(row: ElevatorState) {
      const cab = cabs.get(row.id);
      if (!cab) return;
      cab.frames.push({ t: performance.now(), y: row.y, doorsOpen: row.doorsOpen, stop: row.stop });
      if (cab.frames.length > 2) cab.frames.shift();
    },
    tick(now: number, pawn: RenderPawn | undefined) {
      for (const cab of cabs.values()) {
        const y = renderY(cab, now, pawn);
        const dy = y - (cab.def.stops[0] ?? 0);
        if (cab.applied === undefined || Math.abs(dy - cab.applied) > MOVE_EPS_M) {
          apply(cab, dy);
          cab.applied = dy;
        }
        const ride = riding(cab, pawn);
        if (ride !== cab.hallsHidden) {
          for (const id of cab.halls) visuals.placements.setVisible(id, !ride);
          cab.hallsHidden = ride;
        }
      }
      visuals.placements.flushBounds();
    },
  };
}

function placementIds(view: ArenaView, room: string): string[] {
  const prefix = `${room}.`;
  const ids = [room];
  for (const door of view.doors ?? []) {
    if (door.id.startsWith(prefix)) ids.push(door.id);
  }
  for (const prop of view.props ?? []) {
    if (prop.id.startsWith(prefix)) ids.push(prop.id);
  }
  return ids;
}

function hallIds(building: string | undefined, buildings: ArenaView["buildings"]): string[] {
  if (!building) return [];
  const prefix = `${building}.floor-`;
  const ids: string[] = [];
  for (const placed of buildings) {
    if (placed.id.startsWith(prefix) && placed.id.endsWith(".hall")) ids.push(placed.id);
  }
  return ids;
}

function runtime(def: ArenaElevator, frame: Frame): ElevatorRuntime {
  return {
    id: def.id,
    at: frame.stop,
    queue: [],
    phase: frame.doorsOpen ? "idle" : "moving",
    t: 0,
    y: frame.y,
  };
}

function renderY(cab: Cab, now: number, pawn: RenderPawn | undefined): number {
  const latest = cab.frames.at(-1);
  if (!latest) return cab.def.stops[0] ?? 0;
  const moving = latest.doorsOpen === false;
  if (moving && pawn && inCab(cab.def, runtime(cab.def, latest), pawn.x, pawn.y, pawn.z)) return pawn.y;
  if (!moving) return latest.y;
  const prev = cab.frames.length >= 2 ? cab.frames[cab.frames.length - 2] : undefined;
  if (!prev || prev.t === latest.t) return latest.y;
  const sample = now - SAMPLE_LAG_MS;
  if (sample >= latest.t) return latest.y;
  if (sample <= prev.t) return prev.y;
  const span = latest.t - prev.t;
  const u = (sample - prev.t) / span;
  return prev.y + (latest.y - prev.y) * u;
}
