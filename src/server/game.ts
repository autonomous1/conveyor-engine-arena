import type { AuthoritativeWorld } from "conveyor-engine-world";
import type { EngineWsServer } from "conveyor-engine-transport-ws";
import { MOVEMENTS, movementIntent } from "../shared/movements.js";
import type { WanderAgent } from "./world-loader.js";

/** 20 Hz. Measured later; not a competitive tick rate. */
export const TICK_MS = 50;

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
  log: (line: string) => void = () => {},
): () => void {
  const rng = splitMix(20260917);
  let tick = 0;
  let open = true;
  const timer = setInterval(() => {
    if (!open) return;
    tick += 1;
    for (const agent of agents) {
      if (tick >= agent.nextTurn) {
        agent.heading += (unit01(rng) - 0.5) * Math.PI;
        const gait = MOVEMENTS[Math.floor(unit01(rng) * MOVEMENTS.length)] ?? "idle";
        agent.gait = gait;
        world.triggerAction(agent.id, gait);
        agent.nextTurn = tick + 20 + Math.floor(unit01(rng) * 30);
      }
      const scale = movementIntent(agent.speeds[agent.gait] ?? 0, Object.values(agent.speeds));
      world.enqueue({
        kind: "applyInput",
        entity: agent.id,
        seq: tick,
        moveX: Math.sin(agent.heading) * scale,
        moveZ: Math.cos(agent.heading) * scale,
        yaw: agent.heading,
      });
    }
    const snap = world.commit(BigInt(tick));
    server.setTick(BigInt(tick));
    const envelopes = server.replicator.publish(world, snap);
    for (const clientId of server.connected) {
      const env = envelopes.get(clientId);
      if (env) server.sendSnapshot(clientId, env);
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
    clearInterval(timer);
  };
}
