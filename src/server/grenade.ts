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
  stopSurfaceNormal,
  type GrenadeBody,
  type GrenadeGate,
  type GrenadeImpact,
  type GrenadePose,
} from "../shared/grenade.js";
import type { TraceCapsule } from "../shared/hitscan.js";
import { clientSeesPawn, deliverHealthFrames } from "./health.js";

/** In-flight grenades. Not world entities. Poses go to clients who can see the owner. */
export interface ArenaGrenades {
  /**
   * One throw frame. A rejected, dead, or non-finite throw adds no body.
   * A finite accepted throw broadcasts the eye pose. Clock is `opts.now`, or `Date.now`.
   */
  onFrame(clientId: number, frame: unknown): void;
  /**
   * One host tick. `dt` is seconds and defaults to {@link MOVE_DT}. No-op when nothing is flying.
   * May wound and broadcast. A non-finite step is dropped without a pose.
   */
  tick(dt?: number): void;
  /**
   * One admitted throw. A dead, missing, or non-finite throw adds no body.
   * A finite throw broadcasts the eye pose.
   */
  throwAs(entity: number, yaw: number, pitch: number): "dead" | "done";
  /**
   * Host throw for a pawn with no client. Each entity has its own seq and gate.
   * `dead` means the throw was admitted and the pawn is dead, so nothing is spawned.
   */
  throwAsBot(entity: number, yaw: number, pitch: number): "accept" | "repeat" | "fast" | "dead";
}

/**
 * One grenade is a point and a velocity on the host tick. Clients receive the
 * point.
 * @why It is not a world entity: its gravity must not change pawn steps.
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
}): ArenaGrenades {
  const now = opts.now ?? Date.now;
  const gates = new Map<number, { sessionId: number; gate: GrenadeGate }>();
  /** Host pawns. Seq is `lastSeq + 1` on that gate, so bots do not share a counter. */
  const botGates = new Map<number, GrenadeGate>();
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
    const next = opts.health.wound(hitId, attacker, opts.damage ?? GRENADE_DAMAGE, "grenade");
    if (!next) return;
    deliverHealthFrames(opts.server, opts.server.connected, [healthFrame(hitId, next.hp, next.dead, next.dead ? "grenade" : undefined)]);
  }

  function throwAs(entity: number, yaw: number, pitch: number): "dead" | "done" {
    if (opts.health?.isDead(entity)) return "dead";
    const pawn = opts.world.store.view(entity);
    if (!pawn) return "done";
    const origin = { x: pawn.position.x, y: pawn.position.y + EYE_HEIGHT, z: pawn.position.z };
    const body = launchGrenade(
      nextId,
      entity,
      origin,
      aimDirection(yaw, clampPitch(pitch)),
      GRENADE_SPEED,
      yaw,
      opts.impact ?? "explode",
    );
    nextId += 1;
    if (!finiteBody(body)) return "done";
    bodies.push(body);
    console.log(`grenade shooter=${entity} id=${body.id} eye=${origin.x.toFixed(3)},${origin.y.toFixed(3)},${origin.z.toFixed(3)}`);
    broadcast(entity, grenadePose(body.id, origin, body.yaw));
    return "done";
  }

  function throwAsBot(entity: number, yaw: number, pitch: number): "accept" | "repeat" | "fast" | "dead" {
    let gate = botGates.get(entity);
    if (!gate) {
      gate = freshGrenadeGate();
      botGates.set(entity, gate);
    }
    const admitted = admitGrenade(gate, gate.lastSeq + 1, now());
    if (admitted !== "accept") return admitted;
    if (throwAs(entity, yaw, pitch) === "dead") return "dead";
    return "accept";
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
      throwAs(owned, thrown.yaw, thrown.pitch);
    },
    throwAs,
    throwAsBot,
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
          broadcast(body.owner, grenadePose(body.id, point, body.yaw, true, stopSurfaceNormal(step.hit)));
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
