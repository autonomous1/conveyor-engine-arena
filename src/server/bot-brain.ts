/**
 * Host brain for the unowned wander bots. It reads the sensed state, picks a
 * goal, and claims the bot through `agent.override`. With no claim the bot
 * wanders as before. Only Escape presses doors, and only a shut unlocked one on
 * its own way out, once, as it reaches it. It never closes a door, never uses a
 * key and never touches a locked door. If a door will not open the bot gives up
 * on doors and the 120 s respawn takes it.
 */
import type { AuthoritativeWorld } from "conveyor-engine-world";
import { createBotContext, groundActions, type BotCtx } from "../shared/bots/actions.js";
import {
  DEFAULT_ARBITER_TUNING,
  EXIT_PLACE,
  createMind,
  judge,
  resetMind,
  type ArbiterTuning,
  type GoalId,
  type Mind,
} from "../shared/bots/arbiter.js";
import { plan, type Action } from "../shared/bots/goap.js";
import { reach } from "../shared/bots/goals.js";
import type { BotSenseReader } from "../shared/bots/sense.js";
import { buildWorldState } from "../shared/bots/state.js";
import { MAX_HP, type PawnHealth } from "../shared/health.js";
import { createNavCache } from "../shared/nav/legs.js";
import type { BakedRegionsFile } from "../shared/nav/regions.js";
import type { PickupPlacement } from "../shared/pickups.js";
import type { SceneGraph } from "../shared/scene-graph.js";
import type { Vec3 } from "../shared/scene-graph.js";
import type { DoorUseResult } from "./doors.js";
import { doorsOnRoute, planEscapeGoal, type WanderNav } from "./game.js";
import type { WanderAgent } from "./world-loader.js";

/** An Escape claim is checked again this often (door changes, a lost route). */
export const ESCAPE_REPLAN_MS = 5000;
/** A door is pressed at most this often per bot, and only within {@link DOOR_NEAR_M} of it. */
export const DOOR_PRESS_MS = 250;
export const DOOR_NEAR_M = 2.5;
/** Near a shut door this long without it opening: give up on doors. */
export const DOOR_GIVE_UP_MS = 15_000;
/** The door opened and was shut again this many times: give up on doors. */
export const DOOR_MAX_OPENS = 3;
const MAX_LOGGED = 8;

export type HostBotBrainOptions = {
  world: AuthoritativeWorld;
  agents: readonly WanderAgent[];
  health: PawnHealth;
  sense: BotSenseReader;
  /** The nav the wander loop uses. The brain needs the graph and the regions. */
  nav: WanderNav & { sceneGraph: SceneGraph; regions: BakedRegionsFile };
  pickups?: readonly PickupPlacement[];
  /** Same clock the sensor and `health` use. Defaults to `Date.now`. */
  now?: () => number;
  log?: (line: string) => void;
  tuning?: Partial<ArbiterTuning>;
  /**
   * Press use for a pawn on one door (`useDoorAs`). Absent: Escape never uses a
   * door and plans only through open ones.
   */
  useDoor?: (pawnId: number, doorId: string) => DoorUseResult;
};

/** Goal claims for unowned wander bots. In memory, lost on restart. */
export type HostBotBrain = {
  /**
   * Once per host tick, after the sensor. A bot is replanned only when its `sense.tick` changes.
   * A claimed door press still runs. May set `agent.override` or wound the bot. Swallows errors.
   */
  update(): void;
  /** Last goal stored for this bot. An unknown id is undefined and does not create a slot. */
  goalOf(id: number): GoalId | undefined;
};

type Slot = {
  agent: WanderAgent;
  mind: Mind;
  /** Sensor tick last handled. */
  seen: number;
  goal: GoalId;
  claim?: { goal: { x: number; y: number; z: number }; openDoors?: boolean };
  planAt: number;
  /** Escape may plan through shut unlocked doors and press them. Off after a failed door. */
  useDoors: boolean;
  pressAt: number;
  pathRef?: object;
  pathDoors: string[];
  /** Per door: first time the bot was near it still shut, and how often it opened. */
  doorLog: Map<string, { since: number; opened: number }>;
  /** Killed itself. Nothing more until the sensor sees it dead. */
  dying: boolean;
};

export function createHostBotBrain(opts: HostBotBrainOptions): HostBotBrain {
  const now = opts.now ?? Date.now;
  const tuning: ArbiterTuning = { ...DEFAULT_ARBITER_TUNING, ...opts.tuning };
  const cache = createNavCache();
  const slots: Slot[] = [];
  const byId = new Map<number, Slot>();
  for (const agent of opts.agents) {
    if (agent.role === "player") continue;
    const slot: Slot = {
      agent,
      mind: createMind(),
      seen: -1,
      goal: "wander",
      planAt: -Infinity,
      useDoors: opts.useDoor !== undefined,
      pressAt: -Infinity,
      pathDoors: [],
      doorLog: new Map(),
      dying: false,
    };
    slots.push(slot);
    byId.set(agent.id, slot);
  }

  // Built on the first trapped bot, then kept.
  let planner: { ctx: BotCtx; actions: Action<BotCtx>[] } | undefined;
  const goal = reach(EXIT_PLACE);
  function hasPlan(place: string, useDoors: boolean): boolean {
    if (!planner) {
      const ctx = createBotContext(opts.nav.sceneGraph, opts.pickups ?? []);
      planner = { ctx, actions: groundActions(opts.nav.sceneGraph, [], [goal]) };
    }
    // A bot that cannot press a door treats a shut one as locked. One that can
    // still sees a locked door as locked.
    const rows: ReadonlyArray<{ id: string; open?: boolean; locked?: boolean }> = opts.nav.liveDoors?.() ?? opts.nav.doors;
    const state = buildWorldState({
      at: place,
      pickups: [],
      doors: rows.map((door) => ({
        id: door.id,
        open: door.open === true,
        locked: useDoors ? door.locked === true && door.open !== true : door.open !== true,
      })),
    });
    return plan(state, goal, planner.actions, planner.ctx, { minCost: planner.ctx.minActionS, maxExpand: 64 }) !== undefined;
  }

  function release(slot: Slot): void {
    slot.claim = undefined;
    slot.agent.override = undefined;
  }

  function standDown(slot: Slot): void {
    release(slot);
    slot.planAt = -Infinity;
    slot.useDoors = opts.useDoor !== undefined;
    slot.pathRef = undefined;
    slot.pathDoors = [];
    slot.doorLog.clear();
  }

  function claim(slot: Slot, to: { x: number; y: number; z: number }): void {
    if (slot.claim?.goal === to && slot.claim.openDoors === slot.useDoors) return;
    slot.claim = { goal: to, openDoors: slot.useDoors };
    slot.agent.override = slot.claim;
  }

  /** No more doors for this trap. The claim is dropped and replanned through open doors only. */
  function giveUp(slot: Slot, doorId: string, why: string): void {
    slot.useDoors = false;
    release(slot);
    slot.planAt = -Infinity;
    opts.log?.(`[live] brain ${slot.agent.id} gave up on door ${doorId}: ${why}`);
  }

  function escape(slot: Slot, place: string | undefined, at: number): void {
    if (at - slot.planAt < ESCAPE_REPLAN_MS) return;
    slot.planAt = at;
    if (place === undefined || place === EXIT_PLACE || !hasPlan(place, slot.useDoors)) {
      release(slot);
      return;
    }
    const to = planEscapeGoal(opts.world, slot.agent, opts.nav, cache, slot.claim?.goal, slot.useDoors);
    if (to) claim(slot, to);
    else release(slot);
  }

  /**
   * Every tick, for a claimed Escape bot: press the shut unlocked doors on its
   * path as it comes within reach. The walk was planned through them.
   */
  function drive(slot: Slot): void {
    if (!slot.claim?.openDoors || !opts.useDoor || slot.dying) return;
    const at = now();
    if (at - slot.pressAt < DOOR_PRESS_MS) return;
    slot.pressAt = at;
    const path = slot.agent.path;
    if (!path || path.length === 0) return;
    if (path !== slot.pathRef) {
      slot.pathRef = path;
      slot.pathDoors = doorsOnRoute(opts.nav.doors, path as readonly Vec3[], opts.nav.sceneGraph);
    }
    if (slot.pathDoors.length === 0) return;
    const view = opts.world.store.view(slot.agent.id);
    if (!view) return;
    const rows = opts.nav.liveDoors?.() ?? opts.nav.doors;
    for (const id of slot.pathDoors) {
      const row = rows.find((item) => item.id === id);
      if (!row || row.open === true) continue;
      if (row.locked === true) return giveUp(slot, id, "locked");
      const door = opts.nav.doors.find((item) => item.id === id);
      if (!door) continue;
      if (Math.hypot(view.position.x - door.position[0], view.position.z - door.position[2]) > DOOR_NEAR_M) continue;
      let note = slot.doorLog.get(id);
      if (!note) {
        note = { since: at, opened: 0 };
        slot.doorLog.set(id, note);
      }
      const result = opts.useDoor(slot.agent.id, id);
      if (result === "locked" || result === "lift") return giveUp(slot, id, result);
      if (result === "opened") {
        note.opened += 1;
        note.since = at;
        if (note.opened > DOOR_MAX_OPENS) return giveUp(slot, id, "it keeps shutting");
      } else if (at - note.since >= DOOR_GIVE_UP_MS) {
        return giveUp(slot, id, "out of reach");
      }
    }
  }

  function step(slot: Slot): void {
    const sense = opts.sense.get(slot.agent.id);
    if (!sense || sense.tick === slot.seen) return;
    slot.seen = sense.tick;
    if (!sense.alive) {
      resetMind(slot.mind);
      standDown(slot);
      slot.goal = "wander";
      slot.dying = false;
      return;
    }
    if (slot.dying) return;
    const at = now();
    const verdict = judge(slot.mind, sense, at, tuning);
    slot.goal = verdict.goal;
    if (verdict.respawn) {
      // The normal death path: the host beams it out and back in at a spawn.
      standDown(slot);
      slot.dying = true;
      opts.health.wound(slot.agent.id, undefined, MAX_HP);
      return;
    }
    if (verdict.goal === "wander") {
      standDown(slot);
      return;
    }
    escape(slot, sense.place, at);
  }

  const logged = new Set<string>();
  return {
    update() {
      for (let i = 0; i < slots.length; i += 1) {
        try {
          step(slots[i]!);
          drive(slots[i]!);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (logged.size < MAX_LOGGED && !logged.has(message)) {
            logged.add(message);
            opts.log?.(`[live] brain ${message}`);
          }
        }
      }
    },
    goalOf: (id) => byId.get(id)?.goal,
  };
}
