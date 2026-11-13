/**
 * Host brain for the unowned wander bots. It reads the sensed state, picks a
 * goal, and claims the bot through `agent.override`. With no claim the bot
 * wanders as before. Only Escape presses doors, and only a shut unlocked one on
 * its own way out, once, as it reaches it. An hp drop forces Evade on that tick:
 * the bot drops its leg and runs. Evade then holds until it is out of sight or
 * far enough, and does not press doors. It never closes a door, never uses a
 * key and never touches a locked door. If a door will not open the bot gives
 * up on doors and the 120 s respawn takes it.
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
  type MindSense,
} from "../shared/bots/arbiter.js";
import { FLEE_TUNING, costInPlaces, pickFleePoint, type FleeCentre, type FleeVec } from "../shared/bots/flee.js";
import { plan, type Action } from "../shared/bots/goap.js";
import { reach } from "../shared/bots/goals.js";
import type { BotSenseReader } from "../shared/bots/sense.js";
import { buildWorldState } from "../shared/bots/state.js";
import { hasLineOfSight, losGate } from "../shared/hitscan.js";
import { MAX_HP, type PawnHealth } from "../shared/health.js";
import { createNavCache } from "../shared/nav/legs.js";
import type { BakedRegionsFile } from "../shared/nav/regions.js";
import { createRoadCache, routePlaceCosts } from "../shared/nav/route.js";
import type { PickupPlacement } from "../shared/pickups.js";
import { placeAt, type SceneGraph, type Vec3 } from "../shared/scene-graph.js";
import type { DoorUseResult } from "./doors.js";
import { doorsOnRoute, planEscapeGoal, planWanderTarget, type WanderNav } from "./game.js";
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
/** Arrival or stuck while still in the fight. The next one corners the bot. */
const FLEE_REPICKS = 3;
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
  /** Defaults to {@link pickFleePoint}. */
  pickFlee?: typeof pickFleePoint;
  /**
   * Segment is clear. Defaults to {@link hasLineOfSight} against the nav boxes.
   * Evade calls it through `losGate(5)`, once per bot.
   */
  lineOfSight?: (from: FleeVec, to: FleeVec) => boolean;
  /**
   * Press use for a pawn on one door (`useDoorAs`). Absent: Escape never uses a
   * door and plans only through open ones.
   */
  useDoor?: (pawnId: number, doorId: string) => DoorUseResult;
};

/** Goal claims for unowned wander bots. In memory, lost on restart. */
export type HostBotBrain = {
  /**
   * Once per host tick, after the sensor. A bot is replanned when its sense tick
   * changes, when a leg ends, or when its hp fell since the last tick.
   * A claimed door press still runs. May set `agent.override` or wound the bot. Swallows errors.
   */
  update(): void;
  /** Last goal stored for this bot. An unknown id is undefined and does not create a slot. */
  goalOf(id: number): GoalId | undefined;
  /** True while Evade holds and the threat can see this bot. */
  seenOf(id: number): boolean;
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
  /** `sense.at - ageMs` of the damage note last seen. */
  seenHitAt?: number;
  /** `SensedDamage.seq` last seen. A change is a new hit even when `seenHitAt` matches. */
  seenSeq?: number;
  /** Feet when that note appeared. The threat position when the attacker is unknown. */
  hitPos?: FleeVec;
  /** Arrival or stuck re-picks during this Evade. The initial pick does not count. */
  rePicks: number;
  /** Arrived somewhere the threat cannot see. Further arrivals here do not re-pick. */
  settled: boolean;
  /** Last line-of-sight answer. Held between `losGate` openings. */
  threatSeen: boolean;
  losDue: () => boolean;
  /** The cornered line was logged for this hurt memory. */
  cornerLogged: boolean;
  /** Hp at the previous tick. A lower value forces Evade. Respawn sets it back to full. */
  lastHp: number;
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
      rePicks: 0,
      settled: false,
      threatSeen: false,
      losDue: losGate(5, now),
      cornerLogged: false,
      lastHp: MAX_HP,
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

  const centres: FleeCentre[] = [];
  for (const place of opts.nav.regions.places) {
    for (const region of place.regions) {
      centres.push({
        placeId: place.placeId,
        x: (region.minX + region.maxX) / 2,
        y: region.y,
        z: (region.minZ + region.maxZ) / 2,
      });
    }
  }
  const roads = createRoadCache(opts.nav.sceneGraph);
  const choose = opts.pickFlee ?? pickFleePoint;

  function doorOpen(id: string): boolean {
    let open = false;
    let known = false;
    for (let i = 0; i < opts.nav.doors.length; i += 1) {
      const door = opts.nav.doors[i]!;
      if (door.id !== id) continue;
      open = door.open === true;
      known = true;
      break;
    }
    const live = opts.nav.liveDoors?.();
    if (live) {
      for (let i = 0; i < live.length; i += 1) {
        const door = live[i]!;
        if (door.id !== id) continue;
        open = door.open === true;
        known = true;
        break;
      }
    }
    return known ? open : true;
  }

  function feet(id: number): FleeVec | undefined {
    const view = opts.world.store.view(id);
    if (!view) return undefined;
    return { x: view.position.x, y: view.position.y, z: view.position.z };
  }

  function threatPoint(slot: Slot, attacker: number | undefined, me: FleeVec): FleeVec {
    if (attacker !== undefined) {
      const foe = feet(attacker);
      if (foe) return foe;
    }
    return slot.hitPos ?? me;
  }

  function markCornered(slot: Slot): void {
    slot.mind.cornered = true;
    if (slot.cornerLogged) return;
    slot.cornerLogged = true;
    opts.log?.(`[live] brain ${slot.agent.id} cornered`);
  }

  /** Evade claim. No `openDoors`, so the walk treats shut doors as walls. Run, not a coin-flip gait. */
  function claimFlee(slot: Slot, to: FleeVec): void {
    const claim = { goal: { x: to.x, y: to.y, z: to.z }, gait: "run" as const };
    slot.claim = claim;
    slot.agent.override = claim;
    slot.settled = false;
  }

  const ray = opts.lineOfSight ?? ((from: FleeVec, to: FleeVec) => hasLineOfSight(from, to, opts.nav.aabbs));

  function raised(at: FleeVec, metres: number): FleeVec {
    return { x: at.x, y: at.y + metres, z: at.z };
  }

  function chooseFlee(me: FleeVec, threat: FleeVec): { x: number; y: number; z: number } | undefined {
    const graph = opts.nav.sceneGraph;
    const myPlace = placeAt(graph, me.x, me.y, me.z).id;
    const threatPlace = placeAt(graph, threat.x, threat.y, threat.z).id;
    const net = roads.net((portal) => {
      if (portal.kind !== "door") return "open";
      const id = portal.door ?? portal.id;
      return doorOpen(id) ? "open" : "unusable";
    });
    const fromMe = routePlaceCosts(graph, me, net);
    const fromThreat = routePlaceCosts(graph, threat, net);
    return choose({
      me,
      myPlace,
      threat,
      threatPlace,
      centres,
      costFromMe: (centre) => costInPlaces(me, myPlace, fromMe, centre.placeId, centre),
      costFromThreat: (centre) => costInPlaces(threat, threatPlace, fromThreat, centre.placeId, centre),
      occluded(from, to) {
        return !ray(raised(from, FLEE_TUNING.threatEyeM), raised(to, FLEE_TUNING.chestM));
      },
    });
  }

  /** Reachable centres, farthest from the threat first. The flee picker already refused these. */
  function centresByThreat(me: FleeVec, threat: FleeVec): FleeCentre[] {
    const graph = opts.nav.sceneGraph;
    const myPlace = placeAt(graph, me.x, me.y, me.z).id;
    const threatPlace = placeAt(graph, threat.x, threat.y, threat.z).id;
    const net = roads.net((portal) => {
      if (portal.kind !== "door") return "open";
      const id = portal.door ?? portal.id;
      return doorOpen(id) ? "open" : "unusable";
    });
    const fromMe = routePlaceCosts(graph, me, net);
    const fromThreat = routePlaceCosts(graph, threat, net);
    const ranked: Array<{ centre: FleeCentre; threatM: number; mineM: number }> = [];
    for (let i = 0; i < centres.length; i += 1) {
      const centre = centres[i]!;
      const mine = costInPlaces(me, myPlace, fromMe, centre.placeId, centre);
      if (mine === undefined || !Number.isFinite(mine)) continue;
      const raw = costInPlaces(threat, threatPlace, fromThreat, centre.placeId, centre);
      const threatM = raw === undefined || !Number.isFinite(raw) ? Number.POSITIVE_INFINITY : raw;
      ranked.push({ centre, threatM, mineM: mine });
    }
    ranked.sort((a, b) => {
      if (a.threatM !== b.threatM) return b.threatM - a.threatM;
      if (a.mineM !== b.mineM) return a.mineM - b.mineM;
      if (a.centre.placeId !== b.centre.placeId) return a.centre.placeId < b.centre.placeId ? -1 : 1;
      if (a.centre.x !== b.centre.x) return a.centre.x - b.centre.x;
      return a.centre.z - b.centre.z;
    });
    return ranked.map((row) => row.centre);
  }

  /** Yaw that faces away from the threat. Yaw 0 is +Z. A threat on my feet keeps the heading I had. */
  function awayYaw(slot: Slot, me: FleeVec, threat: FleeVec): number {
    const dx = me.x - threat.x;
    const dz = me.z - threat.z;
    if (dx * dx + dz * dz <= 1e-8) return slot.agent.heading;
    return Math.atan2(dx, dz);
  }

  /** A goal on the bot's feet arrives at once and the follower idles. */
  function moves(me: FleeVec, to: FleeVec): boolean {
    return Math.hypot(to.x - me.x, to.z - me.z) >= 1;
  }

  /**
   * Where to run. `pickFleePoint` first, then the farthest reachable centre,
   * then a point straight away from the threat. That last point is claimed
   * even when the planner cannot walk it: the steer keeps the heading and runs.
   */

  function fleeTo(slot: Slot, me: FleeVec, threat: FleeVec): FleeVec {
    const picked = chooseFlee(me, threat);
    if (picked && moves(me, picked) && planWanderTarget(opts.world, slot.agent, opts.nav, cache, picked)) return picked;
    const ranked = centresByThreat(me, threat);
    for (let i = 0; i < ranked.length; i += 1) {
      const centre = ranked[i]!;
      if (!moves(me, centre)) continue;
      if (planWanderTarget(opts.world, slot.agent, opts.nav, cache, centre)) return centre;
    }
    const yaw = awayYaw(slot, me, threat);
    const dx = Math.sin(yaw);
    const dz = Math.cos(yaw);
    const distances = [FLEE_TUNING.minRunM, 6, 3, 1.5];
    for (let i = 0; i < distances.length; i += 1) {
      const dist = distances[i]!;
      const goal = { x: me.x + dx * dist, y: me.y, z: me.z + dz * dist };
      if (planWanderTarget(opts.world, slot.agent, opts.nav, cache, goal)) return goal;
    }
    return { x: me.x + dx * FLEE_TUNING.minRunM, y: me.y, z: me.z + dz * FLEE_TUNING.minRunM };
  }

  function startFlee(slot: Slot, me: FleeVec, threat: FleeVec): void {
    const to = fleeTo(slot, me, threat);
    const dx = to.x - me.x;
    const dz = to.z - me.z;
    slot.agent.heading = dx * dx + dz * dz > 1e-8 ? Math.atan2(dx, dz) : awayYaw(slot, me, threat);
    slot.agent.path = undefined;
    slot.agent.goal = undefined;
    claimFlee(slot, to);
  }

  function takeFlee(slot: Slot, me: FleeVec | undefined, threat: FleeVec | undefined, verdict: ReturnType<typeof judge>): ReturnType<typeof judge> {
    if (me && threat) startFlee(slot, me, threat);
    else slot.agent.gait = "run";
    return { ...verdict, goal: "evade" };
  }

  /** Latest wound. The sense note is only a stand-in when health has not recorded one. */
  function attackerOf(id: number, senseAttacker: number | undefined): number | undefined {
    const note = opts.health.lastDamage(id);
    return note ? note.attacker : senseAttacker;
  }

  function step(slot: Slot): void {
    const sense = opts.sense.get(slot.agent.id);
    if (!sense) return;
    const end = slot.agent.followEnd;
    const senseNew = sense.tick !== slot.seen;
    const vital = opts.health.get(slot.agent.id);
    if (!sense.alive) {
      if (senseNew) slot.seen = sense.tick;
      if (end) slot.agent.followEnd = undefined;
      resetMind(slot.mind);
      standDown(slot);
      slot.goal = "wander";
      slot.dying = false;
      slot.seenHitAt = undefined;
      slot.seenSeq = undefined;
      slot.hitPos = undefined;
      slot.rePicks = 0;
      slot.settled = false;
      slot.threatSeen = false;
      slot.cornerLogged = false;
      slot.lastHp = MAX_HP;
      return;
    }
    // A killing shot is not Evade. The self-respawn keeps its goal until sense agrees.
    if (vital.dead || slot.dying) {
      slot.lastHp = MAX_HP;
      if (vital.dead && !slot.dying) {
        standDown(slot);
        slot.goal = "wander";
      }
      return;
    }
    // Every tick, not only a sense change or a leg ending.
    const dropped = vital.hp < slot.lastHp;
    if (!senseNew && !end && !dropped) {
      slot.lastHp = vital.hp;
      return;
    }
    if (senseNew) slot.seen = sense.tick;
    if (end) slot.agent.followEnd = undefined;
    const at = now();
    const me = feet(slot.agent.id);
    let newHit = false;
    let hitAt: number | undefined;
    if (sense.damage) {
      const sensedAt = Number.isFinite(sense.at) ? sense.at : at;
      hitAt = sensedAt - sense.damage.ageMs;
      const seq = sense.damage.seq;
      const seqNew = seq !== undefined && seq !== slot.seenSeq;
      if (hitAt !== slot.seenHitAt || seqNew) {
        newHit = true;
        slot.seenHitAt = hitAt;
        if (me) slot.hitPos = { x: me.x, y: me.y, z: me.z };
      }
      if (seq !== undefined) slot.seenSeq = seq;
    }
    if (dropped && me) slot.hitPos = { x: me.x, y: me.y, z: me.z };
    const attacker = attackerOf(slot.agent.id, sense.damage?.attacker);
    let threatDist: number | undefined;
    let threatPlace: string | undefined;
    let threat: FleeVec | undefined;
    if (me && (sense.damage !== undefined || dropped || slot.goal === "evade" || slot.mind.evadeSince !== undefined)) {
      threat = threatPoint(slot, attacker, me);
      threatDist = Math.hypot(me.x - threat.x, me.z - threat.z);
      threatPlace = placeAt(opts.nav.sceneGraph, threat.x, threat.y, threat.z).id;
      if (slot.losDue()) slot.threatSeen = ray(raised(threat, FLEE_TUNING.threatEyeM), raised(me, FLEE_TUNING.chestM));
    }
    const sensed: MindSense = {
      alive: sense.alive,
      place: sense.place,
      msNoProgress: sense.msNoProgress,
      routeOut: sense.routeOut,
      damage: sense.damage,
      hpFrac: sense.hpFrac,
      threatDist,
      threatPlace,
      damageAt: hitAt,
      damageSeq: sense.damage?.seq,
      threatSeen: threat ? slot.threatSeen : undefined,
    };
    let verdict = judge(slot.mind, sensed, at, tuning);
    if (verdict.respawn && !dropped) {
      // The normal death path: the host beams it out and back in at a spawn.
      slot.goal = verdict.goal;
      standDown(slot);
      slot.dying = true;
      opts.health.wound(slot.agent.id, undefined, MAX_HP);
      slot.lastHp = MAX_HP;
      return;
    }
    const prev = slot.goal;
    const wasCornered = slot.mind.cornered === true;
    if (dropped) {
      // Cool-down and cornered belong to one Evade. A new hp loss starts another.
      slot.mind.cornered = undefined;
      slot.cornerLogged = false;
      slot.mind.evadeSince = at;
      slot.mind.safeSince = undefined;
      verdict = { ...verdict, goal: "evade" };
    }
    let picked = false;
    if (verdict.goal === "evade" && (prev !== "evade" || newHit || dropped)) {
      if (prev !== "evade" || wasCornered) slot.rePicks = 0;
      picked = true;
      verdict = takeFlee(slot, me, threat, verdict);
    }
    if (!picked && verdict.goal === "evade") {
      const visible = slot.threatSeen;
      const arrivedHidden = end === "arrived" && !visible;
      const mustLeave = end === "stuck" || (end === "arrived" && visible) || (slot.settled && visible && !end);
      if (arrivedHidden) slot.settled = true;
      else if (mustLeave) {
        if (slot.rePicks >= FLEE_REPICKS) {
          markCornered(slot);
          verdict = judge(slot.mind, sensed, at, tuning);
        } else {
          slot.rePicks += 1;
          verdict = takeFlee(slot, me, threat, verdict);
        }
      }
    }
    slot.goal = verdict.goal;
    slot.lastHp = vital.hp;
    if (slot.mind.cornered !== true) slot.cornerLogged = false;
    if (verdict.goal !== "evade") {
      slot.rePicks = 0;
      slot.settled = false;
    }
    if (verdict.goal === "evade") return;
    if (verdict.goal === "wander") {
      standDown(slot);
      return;
    }
    if (prev === "evade") {
      release(slot);
      slot.planAt = -Infinity;
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
    seenOf(id) {
      const slot = byId.get(id);
      return slot?.goal === "evade" && slot.threatSeen === true;
    },
  };
}
