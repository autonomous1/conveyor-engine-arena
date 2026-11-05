/**
 * 20 Hz executor. A GOAP plan becomes a route, a grid path, and world-space inputs.
 * Node-free: the same loop can run in the browser. The CLI owns sockets and argv.
 */
import type { BotCtx } from "../../../src/shared/bots/actions.js";
import { createBotContext, estimateSeconds, groundActions } from "../../../src/shared/bots/actions.js";
import type { Goal, Plan, PlanOptions, WorldState } from "../../../src/shared/bots/goap.js";
import { chooseGoal } from "../../../src/shared/bots/goap.js";
import { buildWorldState, type WorldSnapshot } from "../../../src/shared/bots/state.js";
import { reach } from "../../../src/shared/bots/goals.js";
import { INPUT_HZ } from "../../../src/shared/look.js";
import type { FloorBox } from "../../../src/shared/movements.js";
import { createFollower, doorStand, wishTo, type FollowInput, type FollowPawn, type Pose } from "../../../src/shared/nav/follow.js";
import { buildGrid, findLocalPath, navBoxes, type Grid } from "../../../src/shared/nav/grid.js";
import { createNavCache, planLegs } from "../../../src/shared/nav/legs.js";
import { planRoute, type Gate } from "../../../src/shared/nav/route.js";
import { capsuleOverlapsAabb, pickupBoxSource, type PickupPlacement } from "../../../src/shared/pickups.js";
import { placeAt, type SceneGraph, type ScenePortal } from "../../../src/shared/scene-graph.js";
import type { BotSession } from "./connection.js";
import type { Mission } from "./missions.js";
import { createMotionPredictor } from "./predict.js";

const STEP_MS = 1000 / INPUT_HZ;
const REPLAN_MS = 5_000;
const GRAPH_WAIT_MS = 1_500;
const USE_WAIT_MS = 1_000;
const PICKUP_WAIT_MS = 2_000;
const NO_GRAPH = "no scene graph (token lacks scene-graph scope?)";

export type BrainOptions = {
  timeoutMs?: number;
  /** Integrate inputs locally. Default on. The browser client stays as it is. */
  predictOwned?: boolean;
  log?: (line: string) => void;
  error?: (line: string) => void;
  onTick?: () => void;
  /** Passed to `plan`. A huge expand budget still stops at `timeoutMs`. */
  maxExpand?: number;
  maxEvaluations?: number;
};

type TickStatus = "running" | "done" | "failed" | "stuck";

type Triple = [number, number, number];

type Running = {
  id: string;
  moving: boolean;
  started: number;
  tick(pose: Pose, tick: number, now: number): TickStatus;
  onDone?: () => void;
};

type Walk = {
  points: Triple[];
  grid: Grid;
  doorId?: string;
};

type UseState = {
  started: number;
  sent: boolean;
  second: boolean;
  secondAt: number;
};

/** Run one goal, or loop a patrol until the timeout. Exit 0 met, 2 no plan, 3 timeout. */
export async function runMission(session: BotSession, mission: Mission, opts: BrainOptions = {}): Promise<number> {
  if (mission.kind === "goal") return runBrain(session, mission.goal, opts);
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const deadline = Date.now() + timeoutMs;
  let index = 0;
  while (Date.now() < deadline) {
    const goal = reach(mission.places[index]!);
    const code = await runBrain(session, goal, { ...opts, timeoutMs: deadline - Date.now() });
    if (code !== 0) return code;
    index = (index + 1) % mission.places.length;
  }
  return 3;
}

export async function runBrain(session: BotSession, goal: Goal, opts: BrainOptions = {}): Promise<number> {
  const log = opts.log ?? (() => {});
  const error = opts.error ?? (() => {});
  const deadline = Date.now() + (opts.timeoutMs ?? 300_000);
  const startedAt = Date.now();
  const secs = () => ((Date.now() - startedAt) / 1000).toFixed(2);
  if (!(await waitForGraph(session, deadline, error))) return 2;

  const predictor = createMotionPredictor(opts.predictOwned !== false);
  const cache = createNavCache();
  const collected = new Set<string>();
  let sticky: string | undefined;
  let actions: ReturnType<typeof groundActions> = [];
  let ctx: BotCtx | undefined;
  let placements: ReturnType<BotSession["world"]["pickupPlacements"]> = [];
  let grounded = "";
  let plan: Plan | undefined;
  let exec: Running | undefined;
  let pending = "";
  let watchDoors = "";
  let watchPickups = "";
  let planAt = 0;
  let tick = 0;
  let stuckCount = 0;
  let failStreak = 0;
  let lastCmd: FollowInput | undefined;
  let lastReason = "initial";

  const ensureGround = (): boolean => {
    const graph = session.world.sceneGraph();
    if (!graph) return false;
    const hash = session.world.sceneGraphHash() ?? "local";
    if (ctx && hash === grounded) return true;
    placements = session.world.pickupPlacements();
    actions = groundActions(graph, placements, [goal]);
    ctx = createBotContext(graph, placements);
    grounded = hash;
    return true;
  };

  const here = (): string | undefined => {
    const self = session.world.self();
    if (!self) return undefined;
    return session.world.placeOf(self)?.id;
  };

  const snapshot = (moving: boolean): WorldSnapshot => {
    const place = here();
    const at = moving ? (place ?? "outside") : (sticky ?? place ?? "outside");
    const held = new Set<string>(session.world.keys());
    for (const id of collected) held.add(id);
    return {
      at,
      pickups: session.world.pickups(),
      heldKeys: [...held],
      doors: session.world.doors(),
      weapon: session.world.weapon(),
      ammo: session.world.ammo(),
    };
  };

  const send = (command: FollowInput): void => {
    // `createFollower` / `wishTo` already ran `moveIntent`. These axes are world-space.
    lastCmd = command;
    session.input.sendInput(command);
  };

  const gate = (portal: ScenePortal): Gate => {
    if (portal.kind !== "door") return "open";
    const id = portal.door ?? portal.id;
    const door = session.world.door(id);
    if (!door) return portal.locked === true ? "locked" : "closed-unlocked";
    if (door.open) return "open";
    if (door.locked) return "locked";
    return "closed-unlocked";
  };

  const poseNow = (): Pose | undefined => {
    const auth = session.world.self();
    const steered = predictor.advance(auth, lastCmd, floorBoxes(session), session.world.pawnRadius);
    const src = steered ?? auth;
    if (!src) return undefined;
    return {
      x: src.x,
      y: src.y,
      z: src.z,
      vx: steered?.vx ?? 0,
      vz: steered?.vz ?? 0,
      yaw: src.yaw,
    };
  };

  const finish = (row: Running, failed = false): void => {
    const dt = ((Date.now() - row.started) / 1000).toFixed(2);
    log(`finish ${row.id} t=${secs()}s dt=${dt}s${failed ? " failed" : ""}`);
  };

  const begin = (id: string, pose: Pose): Running | undefined => {
    const cut = id.indexOf(":");
    const kind = cut < 0 ? id : id.slice(0, cut);
    const arg = cut < 0 ? "" : id.slice(cut + 1);
    if (kind === "goTo") return beginGoTo(id, arg, pose);
    if (kind === "goToDoor") return beginDoor(id, arg, pose);
    if (kind === "unlock") return beginUnlock(id, arg, pose);
    if (kind === "pickup") return beginPickup(id, arg, pose);
    return undefined;
  };

  const beginGoTo = (id: string, place: string, pose: Pose): Running | undefined => {
    const walked = walkToPlace(place, pose);
    if (!walked) return undefined;
    let phase: "walk" | "use" = "walk";
    let use: UseState | undefined;
    const follow = makeFollow(walked);
    return {
      id,
      moving: phase === "walk",
      started: Date.now(),
      onDone() {
        sticky = undefined;
      },
      tick(current, nowTick, now) {
        if (phase === "walk" && !walked.doorId && here() === place) return "done";
        if (phase === "use" && walked.doorId && use) {
          this.moving = false;
          return pressDoor(session, walked.doorId, use, current, now, send, false);
        }
        const step = follow.step(current, otherPawns(session), nowTick);
        send(step.input);
        if (step.status === "stuck") return "stuck";
        if (step.status === "arrived") {
          if (walked.doorId) {
            phase = "use";
            this.moving = false;
            use = { started: now, sent: false, second: false, secondAt: 0 };
            return "running";
          }
          return here() === place ? "done" : "failed";
        }
        return "running";
      },
    };
  };

  const beginDoor = (id: string, doorId: string, pose: Pose): Running | undefined => {
    const stand = chooseStand(doorId, undefined, pose);
    if (!stand) return undefined;
    const walked = walkToPoint(pose, stand, new Set());
    if (!walked) return undefined;
    const follow = makeFollow(walked);
    return {
      id,
      moving: true,
      started: Date.now(),
      onDone() {
        sticky = `door:${doorId}`;
      },
      tick(current, nowTick) {
        const self = session.world.self();
        if (self && Math.hypot(self.x - stand.x, self.z - stand.z) <= 0.3) return "done";
        const step = follow.step(current, otherPawns(session), nowTick);
        send(step.input);
        if (step.status === "stuck") return "stuck";
        if (step.status === "arrived") return "done";
        return "running";
      },
    };
  };

  const beginUnlock = (id: string, doorId: string, pose: Pose): Running | undefined => {
    const body = session.world.doorBody(doorId);
    if (!body) return undefined;
    const stand = chooseStand(doorId, undefined, pose);
    const face = stand ?? { x: body.position[0], y: pose.y, z: body.position[2] };
    const use: UseState = { started: Date.now(), sent: false, second: false, secondAt: 0 };
    let armed = false;
    return {
      id,
      moving: false,
      started: Date.now(),
      tick(current, _tick, now) {
        const self = session.world.self();
        const near = !!self && Math.hypot(self.x - face.x, self.z - face.z) <= 0.35;
        if (!near) {
          send(wishTo(current, face, 1));
          if (now - use.started > 8_000) return "failed";
          return "running";
        }
        if (!armed) {
          armed = true;
          use.started = now;
        }
        return pressDoor(session, doorId, use, current, now, send, true);
      },
    };
  };

  const beginPickup = (id: string, pickupId: string, pose: Pose): Running | undefined => {
    const item = session.world.pickupPlacements().find((row) => row.id === pickupId);
    if (!item) return undefined;
    const center = {
      x: (item.minX + item.maxX) / 2,
      y: pose.y,
      z: (item.minZ + item.maxZ) / 2,
    };
    const omit = new Set([pickupBoxSource(pickupId), pickupId]);
    const walked = walkToPoint(pose, center, omit);
    if (!walked) return undefined;
    const follow = makeFollow(walked);
    let waitStart = 0;
    return {
      id,
      moving: true,
      started: Date.now(),
      onDone() {
        collected.add(pickupId);
        sticky = `pickup:${pickupId}`;
      },
      tick(current, nowTick, now) {
        if (pickupTaken(session, item)) return "done";
        const self = session.world.self();
        const touching = !!self && capsuleOverlapsAabb(
          self.x, self.y, self.z, session.world.pawnRadius, session.world.pawnHeight, item,
        );
        const step = follow.step(current, otherPawns(session), nowTick);
        if (step.status === "arrived" || touching) {
          if (waitStart === 0) waitStart = now;
          send(wishTo(current, center, touching ? 0.35 : 1));
          if (now - waitStart > PICKUP_WAIT_MS) return "failed";
          return step.status === "stuck" ? "stuck" : "running";
        }
        send(step.input);
        if (step.status === "stuck") return "stuck";
        return "running";
      },
    };
  };

  const walkToPlace = (place: string, pose: Pose): Walk | undefined => {
    const graph = session.world.sceneGraph();
    if (!graph) return undefined;
    const route = planRoute(graph, pose, place, gate);
    if (!route.ok) return undefined;
    if (route.steps.length > 0 && route.steps.every((step) => step.portal.kind === "elevator")) return undefined;
    const cut = route.steps.findIndex((step) => step.portal.kind === "door" && gate(step.portal) === "closed-unlocked");
    if (cut >= 0) {
      const step = route.steps[cut]!;
      const doorId = step.portal.door ?? step.portal.id;
      const stand = chooseStand(doorId, { x: step.enter[0], z: step.enter[2] }, pose);
      if (!stand) return undefined;
      const walked = walkToPoint(pose, stand, new Set());
      if (!walked) return undefined;
      return { ...walked, doorId };
    }
    if (route.steps.length === 0) {
      if (here() === place) {
        const points: Triple[] = [[pose.x, pose.y, pose.z]];
        return { points, grid: gridFor(session, graph, points, new Set(), placeY(graph, pose)) };
      }
      return undefined;
    }
    const legs = planLegs(graph, navView(session, new Set()), route, pose, { cache });
    if (!legs.ok) return undefined;
    const points = legs.points.map(triple);
    return { points, grid: gridFor(session, graph, points, new Set(), placeY(graph, pose)) };
  };

  const walkToPoint = (
    pose: Pose,
    target: { x: number; y: number; z: number },
    omit: ReadonlySet<string>,
  ): Walk | undefined => {
    const graph = session.world.sceneGraph();
    if (!graph) return undefined;
    const place = placeAt(graph, target.x, target.y, target.z).id;
    const fromPlace = placeAt(graph, pose.x, pose.y, pose.z).id;
    let points: Triple[] = [[pose.x, pose.y, pose.z]];
    if (fromPlace !== place) {
      const route = planRoute(graph, pose, place, gate);
      if (!route.ok) return undefined;
      if (route.steps.length > 0 && route.steps.every((step) => step.portal.kind === "elevator")) return undefined;
      if (route.steps.some((step) => step.portal.kind === "door" && gate(step.portal) !== "open")) return undefined;
      const legs = planLegs(graph, navView(session, omit), route, pose, { cache });
      if (!legs.ok) return undefined;
      points = legs.points.map(triple);
    }
    const end = points[points.length - 1] ?? [pose.x, pose.y, pose.z];
    if (Math.hypot(end[0] - target.x, end[2] - target.z) > 0.25) {
      const probe = gridFor(session, graph, [...points, [target.x, target.y, target.z]], omit, placeY(graph, pose));
      const local = findLocalPath(probe, { x: end[0], z: end[2] }, { x: target.x, z: target.z });
      if (!local) return undefined;
      for (const point of local) pushPoint(points, point);
    }
    return { points, grid: gridFor(session, graph, points, omit, placeY(graph, pose)) };
  };

  const chooseStand = (
    doorId: string,
    hint: { x: number; z: number } | undefined,
    pose: Pose,
  ): { x: number; y: number; z: number } | undefined => {
    const body = session.world.doorBody(doorId);
    const graph = session.world.sceneGraph();
    if (!body || !graph) return undefined;
    let best: { x: number; y: number; z: number } | undefined;
    let bestScore = Infinity;
    for (const side of ["in", "out"] as const) {
      const stand = doorStand(body, side);
      const place = placeAt(graph, stand.x, stand.y, stand.z).id;
      const route = planRoute(graph, pose, place, gate);
      if (!route.ok) continue;
      if (route.steps.some((step) => step.portal.kind === "door" && gate(step.portal) !== "open")) continue;
      const score = hint
        ? Math.hypot(stand.x - hint.x, stand.z - hint.z)
        : route.cost + Math.hypot(stand.x - pose.x, stand.z - pose.z);
      if (score < bestScore) {
        bestScore = score;
        best = { x: stand.x, y: stand.y, z: stand.z };
      }
    }
    return best;
  };

  while (Date.now() < deadline) {
    const loopStart = Date.now();
    if (!session.world.self() || !ensureGround() || !ctx) {
      await sleepRest(loopStart);
      continue;
    }
    const activePickup = exec && exec.id.startsWith("pickup:") ? exec.id.slice("pickup:".length) : undefined;
    if (exec && activePickup && pickupGone(session, activePickup)) {
      const item = session.world.pickupPlacements().find((row) => row.id === activePickup);
      if (item && pickupTaken(session, item)) {
        exec.onDone?.();
        finish(exec);
        pending = `${exec.id} finished`;
        exec = undefined;
        plan = undefined;
      }
    }
    const pose = poseNow();
    if (!pose) {
      await sleepRest(loopStart);
      continue;
    }
    const state = buildWorldState(snapshot(exec?.moving === true));
    if (satisfies(state, goal.want)) return 0;

    const parts = watchParts(session);
    let reason = "";
    if (!plan) reason = pending || "initial";
    else if (Date.now() - planAt >= REPLAN_MS) reason = "safety";
    else if (parts.doors !== watchDoors) reason = "door";
    else if (parts.pickups !== watchPickups && !activePickup) reason = "pickup";

    if (reason) {
      const groundedCtx = ctx;
      if (!groundedCtx) return 2;
      // A macrotask between replans so the timeout and the socket can run.
      await delay(0);
      if (Date.now() >= deadline) return 3;
      if (reason !== "initial") log(`replan ${reason} t=${secs()}s`);
      const planOpts: PlanOptions = {
        minCost: groundedCtx.minActionS,
        heuristic: estimateSeconds(goal, groundedCtx, placements),
        deadlineMs: deadline,
        now: () => Date.now(),
        ...(opts.maxExpand !== undefined ? { maxExpand: opts.maxExpand } : {}),
        ...(opts.maxEvaluations !== undefined ? { maxEvaluations: opts.maxEvaluations } : {}),
      };
      log("plan start");
      const planStarted = Date.now();
      plan = chooseGoal(state, [goal], actions, groundedCtx, planOpts);
      const planMs = Date.now() - planStarted;
      log(`plan done ${planMs}ms steps=${plan?.steps.length ?? 0} expanded=${plan?.expanded ?? 0}`);
      exec = undefined;
      stuckCount = 0;
      watchDoors = parts.doors;
      watchPickups = parts.pickups;
      planAt = Date.now();
      pending = "";
      lastReason = reason;
      if (!plan) return satisfies(buildWorldState(snapshot(false)), goal.want) ? 0 : 2;
    } else {
      watchPickups = parts.pickups;
    }

    const id = plan?.steps[0];
    if (!plan || !id) {
      pending = "plan exhausted";
      plan = undefined;
      opts.onTick?.();
      await sleepRest(loopStart);
      continue;
    }
    if (!exec || exec.id !== id) {
      const created = begin(id, pose);
      if (!created) {
        failStreak += 1;
        log(`start ${id} t=${secs()}s reason=${lastReason}`);
        log(`finish ${id} t=${secs()}s dt=0.00s failed`);
        if (failStreak >= 2) return 2;
        pending = `${id} failed`;
        plan = undefined;
        exec = undefined;
        opts.onTick?.();
        await sleepRest(loopStart);
        continue;
      }
      failStreak = 0;
      exec = created;
      log(`start ${id} t=${secs()}s reason=${lastReason}`);
      lastReason = "plan";
    }
    const result = exec.tick(pose, tick, Date.now());
    tick += 1;
    if (result === "done") {
      exec.onDone?.();
      finish(exec);
      pending = `${exec.id} finished`;
      plan = undefined;
      exec = undefined;
      stuckCount = 0;
    } else if (result === "failed") {
      finish(exec, true);
      pending = `${exec.id} failed`;
      plan = undefined;
      exec = undefined;
      stuckCount = 0;
    } else if (result === "stuck") {
      stuckCount += 1;
      if (stuckCount >= 2) {
        pending = "stuck";
        plan = undefined;
        exec = undefined;
        stuckCount = 0;
      }
    } else {
      stuckCount = 0;
    }
    opts.onTick?.();
    await sleepRest(loopStart);
  }
  return 3;

  function makeFollow(walked: Walk): { step(pose: Pose, others: readonly FollowPawn[], nowTick: number): ReturnType<ReturnType<typeof createFollower>["step"]> } {
    return createFollower(walked.points, walked.grid, { radius: session.world.pawnRadius });
  }
}

async function waitForGraph(session: BotSession, deadline: number, error: (line: string) => void): Promise<boolean> {
  const giveUp = Math.min(deadline, Date.now() + GRAPH_WAIT_MS);
  while (!session.world.sceneGraph()) {
    const scope = session.world.scope();
    if (scope && !scope.includes("scene-graph")) {
      error(NO_GRAPH);
      return false;
    }
    if (Date.now() >= giveUp) {
      error(NO_GRAPH);
      return false;
    }
    await delay(STEP_MS);
  }
  return true;
}

/** Face the leaf with `wishTo` (scale 0 holds) and press use. The host opens a lock in one press; a shut unlocked leaf gets a second press. */
function pressDoor(
  session: BotSession,
  doorId: string,
  use: UseState,
  pose: Pose,
  now: number,
  send: (command: FollowInput) => void,
  unlock: boolean,
): TickStatus {
  const body = session.world.doorBody(doorId);
  const door = session.world.door(doorId);
  if (!body || !door) return "failed";
  send(wishTo(pose, { x: body.position[0], z: body.position[2] }, 0));
  const press = (): boolean => session.input.use();
  if (unlock) {
    if (!door.locked && door.open) return "done";
    if (door.locked) {
      if (!use.sent) {
        if (press()) use.sent = true;
        else if (now - use.started > USE_WAIT_MS) return "failed";
        return "running";
      }
      if (now - use.started > USE_WAIT_MS) return "failed";
      return "running";
    }
    if (door.open) return "done";
    if (!use.second) {
      if (press()) {
        use.second = true;
        use.secondAt = now;
      } else if (now - use.started > USE_WAIT_MS) return "failed";
      return "running";
    }
    if (now - use.secondAt > USE_WAIT_MS) return "failed";
    return "running";
  }
  if (door.open) return "done";
  if (!use.sent) {
    if (press()) use.sent = true;
    else if (now - use.started > USE_WAIT_MS) return "failed";
    return "running";
  }
  if (now - use.started > USE_WAIT_MS) return "failed";
  return "running";
}

function watchParts(session: BotSession): { doors: string; pickups: string } {
  return {
    doors: session.world.doors().map((door) => `${door.id}:${door.open ? 1 : 0}:${door.locked ? 1 : 0}`).join(","),
    pickups: [...session.world.pickups()].sort().join(","),
  };
}

function pickupGone(session: BotSession, id: string): boolean {
  return !session.world.pickups().includes(id);
}

function pickupTaken(session: BotSession, item: PickupPlacement): boolean {
  if (session.world.pickups().includes(item.id)) return false;
  if (item.kind === "key" && !session.world.keys().includes(item.id)) return false;
  return true;
}

function otherPawns(session: BotSession): FollowPawn[] {
  const radius = session.world.pawnRadius;
  return session.world.others().map((pawn) => ({ x: pawn.x, z: pawn.z, radius }));
}

function floorBoxes(session: BotSession): FloorBox[] {
  return session.world.aabbs.map((box) => ({
    minX: box.minX,
    maxX: box.maxX,
    minZ: box.minZ,
    maxZ: box.maxZ,
    ...(box.minY !== undefined ? { minY: box.minY } : {}),
    ...(box.maxY !== undefined ? { maxY: box.maxY } : {}),
  }));
}

function navView(session: BotSession, omit: ReadonlySet<string>) {
  const bodies = session.world.doors();
  const byId = new Map(bodies.map((door) => [door.id, door]));
  return {
    aabbs: session.world.aabbs.filter((box) => !box.source || !omit.has(box.source)),
    doors: doorList(session).map((door) => {
      const live = byId.get(door.id);
      return live ? { ...door, open: live.open, locked: live.locked } : door;
    }),
    pawnRadius: session.world.pawnRadius,
    pawnHeight: session.world.pawnHeight,
  };
}

function doorList(session: BotSession): Array<{
  id: string;
  model: string;
  position: [number, number, number];
  yaw: number;
  hinge: "left" | "right";
  size: [number, number, number];
  open: boolean;
  locked: boolean;
  key?: string;
}> {
  const out = [];
  for (const state of session.world.doors()) {
    const body = session.world.doorBody(state.id);
    if (!body) continue;
    out.push({
      ...body,
      open: state.open,
      locked: state.locked,
    });
  }
  if (out.length > 0) return out;
  return [];
}

function gridFor(
  session: BotSession,
  graph: SceneGraph,
  points: readonly Triple[],
  omit: ReadonlySet<string>,
  baseY: number,
): Grid {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const point of points) {
    if (point[0] < minX) minX = point[0];
    if (point[0] > maxX) maxX = point[0];
    if (point[2] < minZ) minZ = point[2];
    if (point[2] > maxZ) maxZ = point[2];
  }
  if (!Number.isFinite(minX)) {
    minX = 0;
    maxX = 1;
    minZ = 0;
    maxZ = 1;
  }
  const pad = 3;
  const area = { minX: minX - pad, maxX: maxX + pad, minZ: minZ - pad, maxZ: maxZ + pad };
  const view = navView(session, omit);
  const shut = new Set<string>();
  for (const door of view.doors) if (!door.open) shut.add(door.id);
  return buildGrid(area, navBoxes(view, graph, shut), {
    cell: 0.25,
    radius: view.pawnRadius,
    height: view.pawnHeight,
    baseY,
  });
}

function placeY(graph: SceneGraph, pose: Pose): number {
  const place = placeAt(graph, pose.x, pose.y, pose.z);
  return place.kind === "outside" ? 0 : place.y;
}

function triple(point: Triple | { x: number; y: number; z: number }): Triple {
  if (Array.isArray(point)) return [point[0], point[1], point[2]];
  return [point.x, point.y, point.z];
}

function pushPoint(out: Triple[], point: Triple): void {
  const last = out[out.length - 1];
  if (last && Math.abs(last[0] - point[0]) < 1e-3 && Math.abs(last[2] - point[2]) < 1e-3) return;
  out.push([point[0], point[1], point[2]]);
}

function satisfies(state: WorldState, want: WorldState): boolean {
  for (const key in want) if ((state[key] ?? false) !== want[key]) return false;
  return true;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sleepRest(started: number): Promise<void> {
  const left = STEP_MS - (Date.now() - started);
  if (left > 0) await delay(left);
}
