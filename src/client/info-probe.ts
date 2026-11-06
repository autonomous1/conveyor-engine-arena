/**
 * Browser half of the crosshair probe. Camera ray, leaf bounds, and the HUD
 * string live here. The pick and the place lookup stay in `shared/info-probe`.
 * Nothing here opens a socket or reads a scene-graph file.
 */
import * as THREE from "three";
import type { ArenaView } from "../shared/arena-view.js";
import type { SceneGraphFrame } from "../shared/bot-protocol.js";
import { doorLeafBox } from "../shared/doors.js";
import {
  collectInfoCandidates,
  createInfoSession,
  type Aabb,
  type InfoOwn,
  type PawnPick,
  type Vec3,
} from "../shared/info-probe.js";
import type { CabState } from "../shared/scene-graph.js";

export type { Aabb, Vec3 };

type DoorDef = ArenaView["doors"][number];
type Volume = ArenaView["aabbs"][number];

export type ProbePawn = {
  id: unknown;
  position: { x: number; y: number; z: number };
  lifecycle?: string;
  render?: { assetKey?: string };
};

export type InfoProbe = {
  onDoors(rows: readonly { id: string; open: boolean; locked: boolean }[]): void;
  onDoor(row: { id: string; open: boolean; locked: boolean }): void;
  onPickupSet(ids: readonly string[]): void;
  onPickupGone(id: string): void;
  onSceneGraph(frame: SceneGraphFrame | undefined): void;
  inspect(args: {
    now: number;
    origin: Vec3;
    direction: Vec3;
    leaves: ReadonlyMap<string, Aabb | undefined>;
    volumes: readonly Volume[];
    pawns: readonly ProbePawn[];
    ownedId?: number;
    radius: number;
    height: number;
    own?: InfoOwn;
    cabs?: readonly CabState[];
    pickupHidden?: (id: string) => boolean;
  }): void;
  refresh(now: number, own?: InfoOwn, cabs?: readonly CabState[]): void;
};

export function cameraAim(camera: THREE.Camera): { origin: Vec3; direction: Vec3 } {
  const origin = new THREE.Vector3();
  const direction = new THREE.Vector3();
  camera.getWorldPosition(origin);
  camera.getWorldDirection(direction);
  return {
    origin: { x: origin.x, y: origin.y, z: origin.z },
    direction: { x: direction.x, y: direction.y, z: direction.z },
  };
}

/** World bounds of the swinging leaf. The frame is not included. */
export function leafAabb(group: THREE.Object3D): Aabb | undefined {
  let leaf: THREE.Object3D | undefined;
  group.traverse((obj) => {
    if (!leaf && obj !== group && obj.name === "door") leaf = obj;
  });
  if (!leaf) return undefined;
  return objectAabb(leaf);
}

export function objectAabb(object: THREE.Object3D): Aabb | undefined {
  object.updateWorldMatrix(true, true);
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return undefined;
  if (![box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z].every(Number.isFinite)) return undefined;
  return {
    minX: box.min.x,
    maxX: box.max.x,
    minY: box.min.y,
    maxY: box.max.y,
    minZ: box.min.z,
    maxZ: box.max.z,
  };
}

export function createInfoProbe(opts: {
  doors: ArenaView["doors"];
  pickups: readonly { id: string; kind?: string; minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number }[];
  props: readonly { id: string }[];
  show(text: string): void;
  /** Hit id from a fresh inspect. Refresh does not call this. */
  copy?(id: string): void;
}): InfoProbe {
  const session = createInfoSession({ doors: opts.doors, pickups: opts.pickups });
  const doors = opts.doors;
  const pickups = opts.pickups;
  const propIds = opts.props.map((prop) => prop.id);
  const pickupIds = pickups.map((pickup) => pickup.id);
  let own: InfoOwn | undefined;
  let cabs: readonly CabState[] | undefined;

  const paint = (value: string) => {
    opts.show(value);
  };

  return {
    onDoors(rows) {
      session.onDoors(rows);
    },
    onDoor(row) {
      session.onDoor(row);
    },
    onPickupSet(ids) {
      session.onPickupSet(ids);
    },
    onPickupGone(id) {
      session.onPickupGone(id);
    },
    onSceneGraph(frame) {
      session.onSceneGraph(frame);
    },
    inspect(args) {
      own = args.own;
      cabs = args.cabs;
      const candidates = collectInfoCandidates({
        doors: doors.map((door) => doorPick(door, session.doorLive(door.id)?.open === true, args.leaves.get(door.id))),
        pickups: pickups.map((pickup) => {
          const corners = pickupCorners(pickup, args.volumes);
          return {
            id: pickup.id,
            kind: pickup.kind,
            available: session.pickupAvailable(pickup.id) && args.pickupHidden?.(pickup.id) !== true,
            min: corners.min,
            max: corners.max,
          };
        }),
        pawns: pawnPicks(args.pawns, args.ownedId, args.radius, args.height),
        volumes: args.volumes,
        propIds,
        pickupIds,
      });
      const value = session.inspect({
        now: args.now,
        origin: args.origin,
        direction: args.direction,
        candidates,
        own: args.own,
        cabs: args.cabs,
      });
      paint(value);
      const id = session.hitId;
      if (id) opts.copy?.(id);
    },
    refresh(now, nextOwn, nextCabs) {
      if (nextOwn) own = nextOwn;
      if (nextCabs) cabs = nextCabs;
      paint(session.refresh(now, own, cabs));
    },
  };
}

function doorPick(door: DoorDef, open: boolean, leaf: Aabb | undefined): {
  id: string;
  open: boolean;
  leaf?: Aabb;
  closed?: Aabb;
} {
  if (leaf) return { id: door.id, open, leaf };
  if (open) return { id: door.id, open };
  const box = doorLeafBox(door);
  return {
    id: door.id,
    open,
    closed: {
      minX: box.minX,
      maxX: box.maxX,
      minY: box.minY,
      maxY: box.maxY,
      minZ: box.minZ,
      maxZ: box.maxZ,
    },
  };
}

function pickupCorners(
  pickup: { id: string; minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number },
  volumes: readonly Volume[],
): { min: Vec3; max: Vec3 } {
  const live = volumes.find((volume) => volume.source === pickup.id || volume.source === `${pickup.id}-box`);
  if (
    live
    && Number.isFinite(live.minX)
    && Number.isFinite(live.maxX)
    && Number.isFinite(live.minZ)
    && Number.isFinite(live.maxZ)
  ) {
    const minY = typeof live.minY === "number" && Number.isFinite(live.minY) ? live.minY : pickup.minY;
    const maxY = typeof live.maxY === "number" && Number.isFinite(live.maxY) ? live.maxY : pickup.maxY;
    return {
      min: { x: live.minX, y: minY, z: live.minZ },
      max: { x: live.maxX, y: maxY, z: live.maxZ },
    };
  }
  return {
    min: { x: pickup.minX, y: pickup.minY, z: pickup.minZ },
    max: { x: pickup.maxX, y: pickup.maxY, z: pickup.maxZ },
  };
}

function pawnPicks(pawns: readonly ProbePawn[], ownedId: number | undefined, radius: number, height: number) {
  if (!(radius > 0) || !(height > 0)) return [];
  const out: PawnPick[] = [];
  for (const pawn of pawns) {
    const id = Number(pawn.id);
    if (!Number.isFinite(id) || id === ownedId || pawn.lifecycle === "despawned") continue;
    const { x, y, z } = pawn.position;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    const name = readName(pawn);
    const model = typeof pawn.render?.assetKey === "string" && pawn.render.assetKey.length > 0
      ? pawn.render.assetKey
      : undefined;
    out.push({
      id: String(id),
      min: { x: x - radius, y, z: z - radius },
      max: { x: x + radius, y: y + height, z: z + radius },
      ...(name ? { name } : {}),
      ...(model ? { model } : {}),
    });
  }
  return out;
}

function readName(pawn: ProbePawn): string | undefined {
  const extra = pawn as ProbePawn & { name?: unknown; render?: { name?: unknown; assetKey?: string } };
  if (typeof extra.name === "string" && extra.name.length > 0) return extra.name;
  const renderName = extra.render?.name;
  if (typeof renderName === "string" && renderName.length > 0) return renderName;
  return undefined;
}
