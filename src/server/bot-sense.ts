/**
 * Host adapter for {@link createBotSensor}. Reads the world. Writes nothing.
 */
import type { AuthoritativeWorld } from "conveyor-engine-world";
import { yawFromQuat } from "../shared/look.js";
import type { PawnBody, PickupPlacement } from "../shared/pickups.js";
import type { PawnHealth } from "../shared/health.js";
import { placeAt, type SceneGraph } from "../shared/scene-graph.js";
import {
  createBotSensor,
  createExitIndex,
  type BotSense,
  type ExitDoor,
  type SenseDeps,
  type SensePawn,
  type SensePickup,
  type SenseTuning,
} from "../shared/bots/sense.js";
import type { WanderAgent } from "./world-loader.js";

const EMPTY_BODIES: readonly PawnBody[] = [];

/** Per-bot sense for the host. Reads the world during `update` and writes nothing. */
export type HostBotSense = {
  /** Once per host tick, before the brain. The array is held only for this call, then dropped. */
  update(bodies: readonly PawnBody[]): void;
  /** Live row from the sensor. An unknown id is undefined and does not create one. */
  get(id: number): BotSense | undefined;
  /** Sorted copy of ids sensed at least once. */
  ids(): number[];
  /** How many sensor `update` calls have started. */
  readonly tick: number;
};

export type HostBotSenseOptions = {
  world: AuthoritativeWorld;
  agents: readonly WanderAgent[];
  health: PawnHealth;
  sceneGraph?: SceneGraph;
  doors: () => ReadonlyArray<{ id: string; open: boolean; locked: boolean }>;
  pickups: readonly PickupPlacement[];
  remainingPickups: () => readonly string[];
  ownedEntities: () => Iterable<number>;
  /** Same clock `health` was built with. Defaults to `Date.now`. */
  now?: () => number;
  log?: (line: string) => void;
  tuning?: Partial<SenseTuning>;
};

export function createHostBotSense(opts: HostBotSenseOptions): HostBotSense {
  const slots: number[] = [];
  const botSet = new Set<number>();
  const playerSet = new Set<number>();
  for (let i = 0; i < opts.agents.length; i++) {
    const agent = opts.agents[i]!;
    if (agent.role === "player") playerSet.add(agent.id);
    else {
      slots.push(agent.id);
      botSet.add(agent.id);
    }
  }

  const candidates: SensePickup[] = [];
  for (let i = 0; i < opts.pickups.length; i++) {
    const pickup = opts.pickups[i]!;
    if (pickup.kind !== "health" && pickup.kind !== "ammo") continue;
    candidates.push({
      id: pickup.id,
      kind: pickup.kind,
      x: (pickup.minX + pickup.maxX) / 2,
      y: (pickup.minY + pickup.maxY) / 2,
      z: (pickup.minZ + pickup.maxZ) / 2,
    });
  }

  const rowById = new Map<number, SensePawn>();
  const pawnList: SensePawn[] = [];
  const ownedSet = new Set<number>();
  const remain = new Set<string>();
  const visible: SensePickup[] = [];
  const doorMap = new Map<string, ExitDoor>();
  let bodies: readonly PawnBody[] = EMPTY_BODIES;

  const graph = opts.sceneGraph;
  const exits = graph ? createExitIndex(graph.portals) : undefined;

  const deps: SenseDeps = {
    now: opts.now ?? Date.now,
    botIds: () => slots,
    pawns() {
      ownedSet.clear();
      for (const id of opts.ownedEntities()) ownedSet.add(id);
      pawnList.length = 0;
      for (let i = 0; i < bodies.length; i++) {
        const body = bodies[i]!;
        const player = playerSet.has(body.id);
        if (player) {
          if (!ownedSet.has(body.id)) continue;
        } else if (!botSet.has(body.id)) {
          continue;
        }
        let row = rowById.get(body.id);
        if (!row) {
          row = { id: body.id, kind: player ? "player" : "bot", x: 0, y: 0, z: 0, alive: false };
          rowById.set(body.id, row);
        }
        row.kind = player ? "player" : "bot";
        row.x = body.x;
        row.y = body.y;
        row.z = body.z;
        row.alive = body.alive;
        pawnList.push(row);
      }
      return pawnList;
    },
    headingOf(id) {
      const view = opts.world.store.view(id);
      return view ? yawFromQuat(view.rotation) : 0;
    },
    health(id) {
      const row = opts.health.get(id);
      return { hp: row.hp, dead: row.dead };
    },
    lastDamage(id) {
      return opts.health.lastDamage(id);
    },
    pickups() {
      remain.clear();
      const ids = opts.remainingPickups();
      for (let i = 0; i < ids.length; i++) remain.add(ids[i]!);
      visible.length = 0;
      for (let i = 0; i < candidates.length; i++) {
        const item = candidates[i]!;
        if (remain.has(item.id)) visible.push(item);
      }
      return visible;
    },
    log: opts.log,
  };

  if (graph && exits) {
    deps.placeOf = (x, y, z) => placeAt(graph, x, y, z).id;
    deps.exits = exits;
    deps.doors = () => {
      doorMap.clear();
      const rows = opts.doors();
      for (let i = 0; i < rows.length; i++) {
        const door = rows[i]!;
        doorMap.set(door.id, { open: door.open, locked: door.locked });
      }
      return doorMap;
    };
  }

  const sensor = createBotSensor(deps, opts.tuning);
  return {
    update(next) {
      bodies = next;
      sensor.update();
      bodies = EMPTY_BODIES;
    },
    get: (id) => sensor.get(id),
    ids: () => sensor.ids(),
    get tick() {
      return sensor.tick;
    },
  };
}
