import type { EngineWsServer } from "conveyor-engine-transport-ws";
import type { AuthoritativeWorld } from "conveyor-engine-world";
import { aimDirection, clampPitch, EYE_HEIGHT } from "../shared/look.js";
import { healthFrame, type PawnHealth } from "../shared/health.js";
import { MOVE_DT } from "../shared/movements.js";
import {
  admitGrenade,
  freshGrenadeGate,
  GRENADE_DAMAGE,
  GRENADE_SPEED,
  grenadePose,
  launchGrenade,
  parseGrenade,
  stepGrenade,
  type GrenadeBody,
  type GrenadeGate,
  type GrenadeImpact,
  type GrenadePose,
} from "../shared/grenade.js";
import type { TraceCapsule } from "../shared/hitscan.js";
import { clientSeesPawn, deliverHealthFrames } from "./health.js";

/**
 * One grenade is a point and a velocity on the host tick. It is not a world
 * entity. Gravity here does not change pawn steps. Clients receive the point.
 */
export function createArenaGrenades(opts: {
  world: AuthoritativeWorld;
  server: EngineWsServer;
  now?: () => number;
  send: (clientId: number, frame: GrenadePose) => void;
  health?: PawnHealth;
  /** Ground plane. A grenade bounces on it, then stops, like any other surface. */
  floorY?: number;
  /**
   * First-contact mode for the bound launcher. Default `"explode"`.
   * Pass `"bounce"` for a toss (one bounce, then a stop).
   */
  impact?: GrenadeImpact;
  /** Direct pawn hit. Default {@link GRENADE_DAMAGE}. */
  damage?: number;
}) {
  const now = opts.now ?? Date.now;
  const gates = new Map<number, { sessionId: number; gate: GrenadeGate }>();
  let bodies: GrenadeBody[] = [];
  let nextId = 1;

  function broadcast(owner: number, frame: GrenadePose) {
    for (const id of opts.server.connected) {
      if (!clientSeesPawn(opts.server, id, owner)) continue;
      opts.send(id, frame);
    }
  }

  function wound(hitId: number, attacker: number) {
    if (!opts.health) return;
    const next = opts.health.wound(hitId, attacker, opts.damage ?? GRENADE_DAMAGE);
    if (!next) return;
    deliverHealthFrames(opts.server, opts.server.connected, [healthFrame(hitId, next.hp, next.dead)]);
  }

  return {
    onFrame(clientId: number, frame: unknown) {
      const thrown = parseGrenade(frame);
      if (!thrown) return;
      const session = opts.server.session(clientId);
      if (!session) return;
      const owned = opts.server.replicator.get(clientId)?.ownedEntity;
      if (owned === undefined) return;
      let row = gates.get(clientId);
      if (!row || row.sessionId !== session.sessionId) {
        row = { sessionId: session.sessionId, gate: freshGrenadeGate() };
        gates.set(clientId, row);
      }
      if (admitGrenade(row.gate, thrown.seq, now()) !== "accept") return;
      if (opts.health?.isDead(owned)) return;
      const pawn = opts.world.store.view(owned);
      if (!pawn) return;
      const origin = { x: pawn.position.x, y: pawn.position.y + EYE_HEIGHT, z: pawn.position.z };
      const body = launchGrenade(
        nextId,
        owned,
        origin,
        aimDirection(thrown.yaw, clampPitch(thrown.pitch)),
        GRENADE_SPEED,
        thrown.yaw,
        opts.impact ?? "explode",
      );
      nextId += 1;
      if (!finiteBody(body)) return;
      bodies.push(body);
      console.log(`grenade shooter=${owned} id=${body.id} eye=${origin.x.toFixed(3)},${origin.y.toFixed(3)},${origin.z.toFixed(3)}`);
      broadcast(owned, grenadePose(body.id, origin, body.yaw));
    },
    /** One host tick. Fixed {@link MOVE_DT}, matching the wander interval. */
    tick(dt = MOVE_DT) {
      if (bodies.length === 0) return;
      const boxes = opts.world.listObstacles();
      const kept: GrenadeBody[] = [];
      for (const body of bodies) {
        const step = stepGrenade(body, dt, boxes, pawnCapsules(opts.world), opts.floorY);
        const point = step.kind === "fly"
          ? { x: step.body.x, y: step.body.y, z: step.body.z }
          : step.kind === "bounce"
            ? { x: step.body.x, y: step.body.y, z: step.body.z }
            : step.hit.point;
        if (!finitePoint(point)) continue;
        if (step.kind === "stop") {
          broadcast(body.owner, grenadePose(body.id, point, body.yaw, true));
          if (step.hit.pawn && step.hit.id !== undefined) wound(step.hit.id, body.owner);
          continue;
        }
        broadcast(body.owner, grenadePose(body.id, point, body.yaw));
        kept.push(step.body);
      }
      bodies = kept;
    },
  };
}

function finiteBody(body: GrenadeBody): boolean {
  return [body.x, body.y, body.z, body.vx, body.vy, body.vz].every((n) => Number.isFinite(n));
}

function finitePoint(p: { x: number; y: number; z: number }): boolean {
  return Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);
}

/** Every living pawn, including the owner. {@link stepGrenade} ignores the owner until it is armed. */
function pawnCapsules(world: AuthoritativeWorld): TraceCapsule[] {
  const height = world.pawnHeight;
  if (!Number.isFinite(height)) return [];
  const out: TraceCapsule[] = [];
  for (const entity of world.query()) {
    if (entity.lifecycle !== "alive" || !(entity.radius > 0)) continue;
    out.push({
      id: entity.id,
      x: entity.position.x,
      y: entity.position.y,
      z: entity.position.z,
      radius: entity.radius,
      height,
    });
  }
  return out;
}
