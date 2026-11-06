/**
 * Arena world model for a connected bot. No Node builtins and no WebSocket.
 * Snapshots supply pawn poses. Arena frames supply doors, keys, and the scene graph.
 */
import type { ArenaView } from "../../../src/shared/arena-view.js";
import { yawFromQuat } from "../../../src/shared/look.js";
import type { PickupKind, PickupPlacement } from "../../../src/shared/pickups.js";
import { parseBakedRegions, type BakedRegionsFile } from "../../../src/shared/nav/regions.js";
import { placeAt, parseSceneGraph, type SceneGraph } from "../../../src/shared/scene-graph.js";

export type PawnPose = {
  id: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  kind: string;
};

export type DoorState = { id: string; open: boolean; locked: boolean };

export type ElevatorCab = { id: string; y: number; doorsOpen: boolean; stop: number };

export type WorldAabb = ArenaView["aabbs"][number];

/** Leaf geometry from `arena.json`. Open and locked live on `door()`. */
export type DoorBody = {
  id: string;
  model: string;
  position: [number, number, number];
  yaw: number;
  hinge: "left" | "right";
  size: [number, number, number];
  key?: string;
};

export type WorldView = {
  aabbs?: readonly WorldAabb[];
  doors?: ArenaView["doors"];
  pickups?: readonly WorldPickup[];
  playerSpawns?: readonly { id: string; x: number; z: number; yaw: number }[];
  pawnRadius?: number;
  pawnHeight?: number;
};

type WorldPickup = {
  id: string;
  kind?: PickupKind;
  model?: string;
  weapon?: string;
  amount?: number;
  minX?: number;
  maxX?: number;
  minY?: number;
  maxY?: number;
  minZ?: number;
  maxZ?: number;
};

export type WelcomeState = {
  pickups: readonly string[];
  doors: readonly DoorState[];
  elevators?: readonly ElevatorCab[];
  weapon?: string;
  ammo: number;
  keys: readonly string[];
  role?: string;
  scope?: readonly string[];
};

export type PoseSnapshot = {
  spawns?: readonly { entity: unknown; view?: unknown }[];
  updates?: readonly { entity: unknown; view?: unknown }[];
  despawns?: readonly { entity: unknown }[];
};

export type BotWorld = {
  readonly aabbs: readonly WorldAabb[];
  readonly playerSpawns: readonly { id: string; x: number; z: number; yaw: number }[];
  readonly pawnRadius: number;
  readonly pawnHeight: number;
  self(): PawnPose | undefined;
  others(): PawnPose[];
  door(id: string): DoorState | undefined;
  doors(): DoorState[];
  /** Placement leaf. Open and locked stay on `door()`. */
  doorBody(id: string): DoorBody | undefined;
  pickups(): readonly string[];
  /** Static pickup boxes from the arena view. Gone ids stay here so a plan can still name them. */
  pickupPlacements(): readonly PickupPlacement[];
  keys(): readonly string[];
  weapon(): string | undefined;
  ammo(): number;
  health(): { entity: number; hp: number; dead: boolean } | undefined;
  role(): string | undefined;
  scope(): readonly string[] | undefined;
  sceneGraph(): SceneGraph | undefined;
  sceneGraphHash(): string | undefined;
  regions(): BakedRegionsFile | undefined;
  regionsHash(): string | undefined;
  placeOf(pos: { x: number; y: number; z: number }): { id: string; kind: string } | undefined;
  summary(): string;
  noteOwned(id: number | undefined): void;
  applyWelcome(welcome: WelcomeState): void;
  applyInventory(keys: readonly string[]): void;
  applyPickupGone(id: string): void;
  applyDoor(door: DoorState): void;
  applyElevator(cab: ElevatorCab): void;
  applyHealth(row: { entity: number; hp: number; dead: boolean }): void;
  applyLoadout(row: { ammo: number; weapon?: string }): void;
  /** Returns a short reason when the file does not become a graph. */
  loadSceneGraph(file: unknown, hash?: string): string | undefined;
  /** Returns a short reason when the file is not a baked region graph. */
  loadRegions(file: unknown, hash?: string): string | undefined;
  applySnapshot(snap: PoseSnapshot): void;
};

export function createBotWorld(view: WorldView): BotWorld {
  let regions: BakedRegionsFile | undefined;
  let regionsHash: string | undefined;
  const aabbs = [...(view.aabbs ?? [])];
  const playerSpawns = [...(view.playerSpawns ?? [])];
  const doorDefs = view.doors ?? [];
  const doorBodies = new Map<string, DoorBody>();
  for (const door of doorDefs) {
    doorBodies.set(door.id, {
      id: door.id,
      model: door.model,
      position: [door.position[0], door.position[1], door.position[2]],
      yaw: door.yaw,
      hinge: door.hinge,
      size: [door.size[0], door.size[1], door.size[2]],
      ...(typeof door.key === "string" && door.key.length > 0 ? { key: door.key } : {}),
    });
  }
  const placements = placementsFrom(view.pickups ?? []);
  const pawnRadius = view.pawnRadius !== undefined && view.pawnRadius > 0 ? view.pawnRadius : 0.5;
  const pawnHeight = view.pawnHeight !== undefined && view.pawnHeight > 0 ? view.pawnHeight : 1.8;
  const pawns = new Map<number, PawnPose>();
  const doorMap = new Map<string, DoorState>();
  const cabs = new Map<string, ElevatorCab>();
  const vitals = new Map<number, { entity: number; hp: number; dead: boolean }>();
  let ownedId: number | undefined;
  let pickupIds: string[] = [];
  let heldKeys: string[] = [];
  let sawKeys = false;
  let weapon: string | undefined;
  let ammo = 0;
  let role: string | undefined;
  let scope: string[] | undefined;
  let graph: SceneGraph | undefined;
  let graphHash: string | undefined;

  const self = (): PawnPose | undefined => (ownedId === undefined ? undefined : pawns.get(ownedId));

  return {
    aabbs,
    playerSpawns,
    pawnRadius,
    pawnHeight,
    self,
    others() {
      const rows: PawnPose[] = [];
      for (const pawn of pawns.values()) {
        if (pawn.id !== ownedId) rows.push(pawn);
      }
      rows.sort((a, b) => a.id - b.id);
      return rows;
    },
    door(id: string) {
      return doorMap.get(id);
    },
    doors() {
      return [...doorMap.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    },
    doorBody(id: string) {
      return doorBodies.get(id);
    },
    pickups() {
      return pickupIds;
    },
    pickupPlacements() {
      return placements;
    },
    keys() {
      return heldKeys;
    },
    weapon() {
      return weapon;
    },
    ammo() {
      return ammo;
    },
    health() {
      return ownedId === undefined ? undefined : vitals.get(ownedId);
    },
    role() {
      return role;
    },
    scope() {
      return scope;
    },
    sceneGraph() {
      return graph;
    },
    sceneGraphHash() {
      return graphHash;
    },
    regions() {
      return regions;
    },
    regionsHash() {
      return regionsHash;
    },
    placeOf(pos) {
      if (!graph) return undefined;
      const place = placeAt(graph, pos.x, pos.y, pos.z, cabStates(cabs));
      return { id: place.id, kind: place.kind };
    },
    summary() {
      const pawn = self();
      const place = pawn ? this.placeOf(pawn) : undefined;
      const pos = pawn ? `${pawn.x.toFixed(2)} ${pawn.y.toFixed(2)} ${pawn.z.toFixed(2)}` : "none";
      const keyText = !sawKeys ? "none" : heldKeys.length ? heldKeys.join(",") : "none";
      const scopeText = scope && scope.length ? scope.join(",") : "none";
      return `self=${pos} place=${place?.id ?? "none"} keys=${keyText} role=${role ?? "none"} scope=${scopeText}`;
    },
    noteOwned(id) {
      ownedId = id;
    },
    applyWelcome(welcome) {
      pickupIds = [...welcome.pickups];
      doorMap.clear();
      for (const door of welcome.doors) doorMap.set(door.id, { ...door });
      if (welcome.elevators) {
        for (const cab of welcome.elevators) cabs.set(cab.id, { ...cab });
      }
      weapon = welcome.weapon;
      ammo = welcome.ammo;
      heldKeys = [...welcome.keys];
      sawKeys = true;
      role = welcome.role;
      scope = welcome.scope ? [...welcome.scope] : undefined;
    },
    applyInventory(keys) {
      heldKeys = [...keys];
      sawKeys = true;
    },
    applyPickupGone(id) {
      pickupIds = pickupIds.filter((item) => item !== id);
    },
    applyDoor(door) {
      doorMap.set(door.id, { ...door });
    },
    applyElevator(cab) {
      cabs.set(cab.id, { ...cab });
    },
    applyHealth(row) {
      vitals.set(row.entity, { ...row });
    },
    applyLoadout(row) {
      ammo = row.ammo;
      weapon = row.weapon;
    },
    loadSceneGraph(file, hash) {
      const parsed = parseSceneGraph(file, doorDefs);
      if (!parsed.graph) {
        const reason = parsed.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
        return reason || "scene graph rejected";
      }
      graph = parsed.graph;
      if (hash) graphHash = hash;
      return undefined;
    },
    loadRegions(file, hash) {
      const parsed = parseBakedRegions(file);
      if (!parsed.file) {
        const reason = parsed.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
        return reason || "regions rejected";
      }
      regions = parsed.file;
      if (hash) regionsHash = hash;
      return undefined;
    },
    applySnapshot(snap) {
      for (const row of [...(snap.spawns ?? []), ...(snap.updates ?? [])]) {
        const pose = readPose(row.entity, row.view);
        if (pose) pawns.set(pose.id, pose);
      }
      for (const row of snap.despawns ?? []) {
        const id = entityId(row.entity);
        if (id !== undefined) pawns.delete(id);
      }
    },
  };
}

function placementsFrom(items: readonly WorldPickup[]): PickupPlacement[] {
  const out: PickupPlacement[] = [];
  for (const item of items) {
    if (!item.kind || !item.model) continue;
    const { minX, maxX, minY, maxY, minZ, maxZ } = item;
    if (minX === undefined || maxX === undefined || minY === undefined || maxY === undefined || minZ === undefined || maxZ === undefined) continue;
    if (!Number.isFinite(minX) || !Number.isFinite(maxX) || !Number.isFinite(minY) || !Number.isFinite(maxY) || !Number.isFinite(minZ) || !Number.isFinite(maxZ)) continue;
    out.push({
      id: item.id,
      kind: item.kind,
      model: item.model,
      ...(item.weapon ? { weapon: item.weapon } : {}),
      amount: typeof item.amount === "number" && Number.isFinite(item.amount) ? item.amount : 0,
      minX,
      maxX,
      minY,
      maxY,
      minZ,
      maxZ,
    });
  }
  return out;
}

function cabStates(cabs: Map<string, ElevatorCab>) {
  return [...cabs.values()].map((cab) => ({
    id: cab.id,
    at: cab.stop,
    phase: cab.doorsOpen ? "idle" as const : "moving" as const,
    y: cab.y,
  }));
}

function entityId(value: unknown): number | undefined {
  const id = typeof value === "bigint" ? Number(value) : typeof value === "number" ? value : Number.NaN;
  if (!Number.isInteger(id)) return undefined;
  return id;
}

function readPose(entity: unknown, view: unknown): PawnPose | undefined {
  const id = entityId(entity);
  if (id === undefined || !view || typeof view !== "object") return undefined;
  const rec = view as {
    position?: { x?: unknown; y?: unknown; z?: unknown };
    rotation?: { y?: unknown; w?: unknown };
    render?: { type?: unknown };
  };
  const position = rec.position;
  if (!position || typeof position.x !== "number" || typeof position.y !== "number" || typeof position.z !== "number") {
    return undefined;
  }
  const rotation = rec.rotation;
  const yaw = rotation && typeof rotation.y === "number" && typeof rotation.w === "number"
    ? yawFromQuat({ y: rotation.y, w: rotation.w })
    : 0;
  const renderType = rec.render && typeof rec.render.type === "string" ? rec.render.type : "";
  return {
    id,
    x: position.x,
    y: position.y,
    z: position.z,
    yaw,
    kind: renderType.length > 0 ? renderType : "pawn",
  };
}
