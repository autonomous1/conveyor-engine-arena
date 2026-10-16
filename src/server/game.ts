import type { AuthoritativeWorld } from "conveyor-engine-world";
import type { EngineWsServer } from "conveyor-engine-transport-ws";
import type { Audit } from "../shared/audit.js";
import { pickRespawnSpawn, type PawnHealth } from "../shared/health.js";
import { moveIntent, yawFromQuat } from "../shared/look.js";
import { approachYaw, enqueueOwnedMove, MOVE_DT, MOVEMENTS, movementIntent, yawQuaternion } from "../shared/movements.js";
import { deliverAuditFrame } from "./audit.js";
import { deliverHealthFrames } from "./health.js";
import { dispatchHostFrame, hostSnapPath } from "./host-path.js";
import type { WanderAgent } from "./world-loader.js";
import { propClipName, type Prop } from "../shared/arena-view.js";

/** 20 Hz. Measured later; not a competitive tick rate. */
export const TICK_MS = 50;

if (MOVE_DT !== TICK_MS / 1000) {
  throw new Error(`MOVE_DT ${MOVE_DT} is not the ${TICK_MS} ms host tick`);
}

/**
 * Kernel default interest is 48. The authored floor's opposite corners are
 * about 168 m apart. This host override covers that diagonal.
 */
export const ARENA_INTEREST_RADIUS = 192;

export type HeldInput = {
  moveX: number;
  moveZ: number;
  yaw: number;
  seq: number;
};

export function createHeldInputs() {
  const latest = new Map<number, HeldInput>();
  return {
    admit(entity: number, cmd: HeldInput) {
      latest.set(entity, cmd);
    },
    get(entity: number) {
      return latest.get(entity);
    },
    drop(entity: number) {
      latest.delete(entity);
    },
    entities() {
      return [...latest.keys()];
    },
  };
}

export type HeldInputs = ReturnType<typeof createHeldInputs>;

export function noteArenaInterest(server: EngineWsServer): void {
  for (const clientId of server.connected) {
    const session = server.replicator.get(clientId);
    if (session) session.interestRadius = ARENA_INTEREST_RADIUS;
  }
}

function unit01(next: () => number): number {
  return next();
}

/** SplitMix64, local so the production host does not import the simulator. */
export function splitMix(seed: number): () => number {
  let state = BigInt(seed) & 0xffffffffffffffffn;
  if (state === 0n) state = 1n;
  return () => {
    state = (state + 0x9e3779b97f4a7c15n) & 0xffffffffffffffffn;
    let z = state;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & 0xffffffffffffffffn;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & 0xffffffffffffffffn;
    z = z ^ (z >> 31n);
    return Number(z >> 11n) / 2 ** 53;
  };
}

export type PropClip = { id: string; clip: string };

/**
 * Props are string ids, not entities. The clip name is `animations[animation].clip`.
 * The host does not enqueue a world command and does not run the mixer.
 */
export function startPropAnimation(props: readonly Prop[]): PropClip[] {
  const clips: PropClip[] = [];
  for (const prop of props) {
    const clip = propClipName(prop);
    if (!clip) continue;
    clips.push({ id: prop.id, clip });
  }
  return clips;
}

/**
 * One unowned wander or hostile step. `agent.heading` is the wished heading
 * and may jump. The body turns toward it by at most one `PAWN_YAW_STEP`.
 * The velocity wish uses that capped yaw, then eases. The clip follows planar
 * speed and carries no position. Player input does not call this.
 */
export function stepUnownedWander(world: AuthoritativeWorld, agent: WanderAgent) {
  const scale = movementIntent(agent.speeds[agent.gait] ?? 0, Object.values(agent.speeds));
  const view = world.store.view(agent.id);
  const facing = view ? yawFromQuat(view.rotation) : agent.heading;
  const yaw = approachYaw(facing, agent.heading);
  const wish = moveIntent(yaw, scale, 0);
  return enqueueOwnedMove(world, agent.id, wish.moveX, wish.moveZ, yaw, MOVE_DT);
}

export function startWanderLoop(
  world: AuthoritativeWorld,
  agents: WanderAgent[],
  server: EngineWsServer,
  held: HeldInputs,
  log: (line: string) => void = () => { },
  health?: PawnHealth,
  audit?: Audit,
  onTick?: () => void,
): () => void {
  const rng = splitMix(20260917);
  const snaps = hostSnapPath((clientId, envelope) => {
    server.sendSnapshot(clientId, envelope);
  });
  let tick = 0;
  let open = true;
  const timer = setInterval(() => {
    if (!open) return;
    tick += 1;
    const timedOut = new Set(server.gateway.drainTimeouts());
    for (const entity of timedOut) {
      world.clearInput(entity);
      held.drop(entity);
    }
    const owned = new Set<number>();
    for (const clientId of server.connected) {
      const record = server.gateway.get(clientId);
      if (record?.connected && record.ownedEntity !== undefined) owned.add(record.ownedEntity);
    }
    for (const entity of held.entities()) {
      if (!owned.has(entity)) held.drop(entity);
    }
    noteArenaInterest(server);
    for (const agent of agents) {
      if (timedOut.has(agent.id)) continue;
      if (health?.isDead(agent.id)) {
        if (agent.gait !== "fall") {
          agent.gait = "fall";
          // clearInput bumps the replication version. setClip alone does not,
          // so the fall clip would never leave this process.
          world.enqueue({ kind: "setClip", entity: agent.id, clip: "fall", speed: 0 });
          world.enqueue({ kind: "clearInput", entity: agent.id });
        }
        continue;
      }
      if (owned.has(agent.id)) {
        const cmd = held.get(agent.id);
        const moveX = cmd?.moveX ?? 0;
        const moveZ = cmd?.moveZ ?? 0;
        // Owned look is the input yaw on this tick. Bots turn in stepUnownedWander.
        const yaw = cmd?.yaw ?? agent.heading;
        if (cmd) agent.heading = yaw;
        const moved = enqueueOwnedMove(world, agent.id, moveX, moveZ, yaw, MOVE_DT);
        if (moved) agent.gait = moved.gait;
        continue;
      }
      if (tick >= agent.nextTurn) {
        agent.heading += (unit01(rng) - 0.5) * Math.PI;
        let gait = MOVEMENTS[Math.floor(unit01(rng) * MOVEMENTS.length)] ?? "idle";
        if (gait == "fall") gait = "idle";
        agent.gait = gait;
        // TODO: remove this log, it is spammy
        //console.log("agent:",agent.id,gait);
        //world.triggerAction(agent.id, gait);
        agent.nextTurn = tick + 20 + Math.floor(unit01(rng) * 30);
      }
      // The picked gait only scales the wish. The clip follows the eased speed.
      stepUnownedWander(world, agent);
    }
    if (health) {
      for (const id of health.takeRespawns()) respawnPawn(world, agents, id);
    }
    const snap = world.commit(BigInt(tick));
    try {
      onTick?.();
    } catch (err) {
      log(`[live] pickup ${err instanceof Error ? err.message : String(err)}`);
    }
    server.setTick(BigInt(tick));
    const envelopes = server.replicator.publish(world, snap);
    const healthFrames = health?.frames() ?? [];
    for (const clientId of server.connected) {
      const env = envelopes.get(clientId);
      if (!env) continue;
      dispatchHostFrame(snaps, { type: "snap", clientId, envelope: env }, { to: `client:${clientId}`, kind: "snap" });
      if (healthFrames.length > 0) deliverHealthFrames(server, [clientId], healthFrames);
    }
    if (audit) deliverAuditFrame(server, audit.frame());
    if (tick <= 3 || tick % 40 === 0) {
      log(`[live] ${JSON.stringify({
        t: tick,
        connected: server.connected,
        worldEntities: snap.entities.length,
      })}`);
    }
  }, TICK_MS);
  timer.unref();
  return () => {
    open = false;
    snaps.close();
    clearInterval(timer);
  };
}

/** Move a pawn that just became alive onto a free spawn. The shot itself does not write a transform. */
function respawnPawn(world: AuthoritativeWorld, agents: WanderAgent[], id: number): void {
  const view = world.store.view(id);
  const radius = view && view.radius > 0 ? view.radius : 0.5;
  const height = Number.isFinite(world.pawnHeight) ? world.pawnHeight : 1.8;
  const pawns = world.query().filter((entity) => entity.radius > 0).map((entity) => ({
    id: entity.id,
    x: entity.position.x,
    y: entity.position.y,
    z: entity.position.z,
    radius: entity.radius,
  }));
  const spawn = pickRespawnSpawn(world.listSpawnPoints(), {
    self: id,
    radius,
    height,
    aabbs: world.listObstacles(),
    pawns,
  });
  const agent = agents.find((item) => item.id === id);
  if (agent) agent.gait = "idle";
  if (!view || !spawn) {
    world.enqueue({ kind: "setClip", entity: id, clip: "idle", speed: 0 });
    return;
  }
  if (agent) agent.heading = spawn.yaw;
  world.enqueue({ kind: "clearInput", entity: id });
  world.enqueue({
    kind: "setTransform",
    entity: id,
    position: { x: spawn.x, y: spawn.y, z: spawn.z },
    rotation: yawQuaternion(spawn.yaw),
    scale: { x: view.scale.x, y: view.scale.y, z: view.scale.z },
  });
  world.enqueue({ kind: "setClip", entity: id, clip: "idle", speed: 0 });
}
