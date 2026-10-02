import type { AuthoritativeWorld } from "conveyor-engine-world";
import type { EngineWsServer } from "conveyor-engine-transport-ws";
import { MOVEMENTS, movementIntent } from "../shared/movements.js";
import { dispatchHostFrame, hostSnapPath } from "./host-path.js";
import type { WanderAgent } from "./world-loader.js";

/** 20 Hz. Measured later; not a competitive tick rate. */
export const TICK_MS = 50;

/**
 * Floor is 48 m on a side, so opposite corners are about 68 m apart.
 * Kernel default interest is 48. This override stays in the arena host.
 */
export const ARENA_INTEREST_RADIUS = 96;

export type HeldInput = {
  moveX: number;
  moveZ: number;
  yaw: number;
  seq: number;
  clip: string;
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

export function startWanderLoop(
  world: AuthoritativeWorld,
  agents: WanderAgent[],
  server: EngineWsServer,
  held: HeldInputs,
  log: (line: string) => void = () => {},
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
      if (owned.has(agent.id)) {
        const cmd = held.get(agent.id);
        const moveX = cmd?.moveX ?? 0;
        const moveZ = cmd?.moveZ ?? 0;
        const yaw = cmd?.yaw ?? agent.heading;
        if (cmd) agent.heading = yaw;
        const speed = Math.hypot(moveX, moveZ);
        // TODO: fix
        //const gait = speed > 1 ? "run" : speed > 0.05 ? "walk" : "idle";
        const gait = cmd?.clip ?? (speed > 1 ? "run" : speed > 0.05 ? "walk" : "idle");
        if (agent.gait !== gait) {
          agent.gait = gait;
          world.enqueue({
            kind: "setClip",
            entity: agent.id,
            clip: gait,
            speed:speed
          });
        }
        world.enqueue({
          kind: "applyInput",
          entity: agent.id,
          seq: cmd?.seq ?? tick,
          moveX,
          moveZ,
          yaw
        });
        continue;
      }
      if (tick >= agent.nextTurn) {
        agent.heading += (unit01(rng) - 0.5) * Math.PI;
        const gait = MOVEMENTS[Math.floor(unit01(rng) * MOVEMENTS.length)] ?? "idle";
        if (agent.gait !== gait) {
          agent.gait = gait;
          world.enqueue({
            kind: "setClip",
            entity: agent.id,
            clip: gait,
            speed: agent.speeds[gait] ?? 0
          });
        }
        // TODO: remove this log, it is spammy
        //console.log("agent:",agent.id,gait);
        //world.triggerAction(agent.id, gait);
        agent.nextTurn = tick + 20 + Math.floor(unit01(rng) * 30);
      }
      const scale = movementIntent(agent.speeds[agent.gait] ?? 0, Object.values(agent.speeds));
      world.enqueue({
        kind: "applyInput",
        entity: agent.id,
        seq: tick,
        moveX: Math.sin(agent.heading) * scale,
        moveZ: Math.cos(agent.heading) * scale,
        yaw: agent.heading
      });
    }
    const snap = world.commit(BigInt(tick));
    server.setTick(BigInt(tick));
    const envelopes = server.replicator.publish(world, snap);
    for (const clientId of server.connected) {
      const env = envelopes.get(clientId);
      if (!env) continue;
      dispatchHostFrame(snaps, { type: "snap", clientId, envelope: env }, { to: `client:${clientId}`, kind: "snap" });
    }
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
