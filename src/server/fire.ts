import type { EngineWsServer } from "conveyor-engine-transport-ws";
import type { AuthoritativeWorld } from "conveyor-engine-world";
import { aimDirection, clampPitch, EYE_HEIGHT } from "../shared/look.js";
import { createFireDebugLog, fireDebugErrorLine, fireDebugLine, fireFrameWantsDebug } from "../shared/fire-debug.js";
import { createAudit, type Audit } from "../shared/audit.js";
import { healthFrame, type PawnHealth } from "../shared/health.js";
import {
  admitFire,
  freshFireGate,
  LASER_MS,
  parseFire,
  traceHitscan,
  type FireGate,
  type LaserFrame,
  type TraceCapsule,
} from "../shared/hitscan.js";
import { deliverAuditFrame } from "./audit.js";
import { clientSeesPawn, deliverHealthFrames } from "./health.js";

/**
 * Hitscan for one owned pawn. The eye is inside that pawn's capsule, so the
 * shooter is left out of the capsule list. Pitch is clamped to the same limit
 * as the client camera. `until` is the host clock plus {@link LASER_MS}.
 */
export function createArenaFire(opts: {
  world: AuthoritativeWorld;
  server: EngineWsServer;
  now?: () => number;
  send: (clientId: number, frame: LaserFrame) => void;
  /** Arena-owned pawn health. Absent in tests that only trace. */
  health?: PawnHealth;
  /** Shared with the wander tick so a later client still receives the totals. */
  audit?: Audit;
}) {
  const now = opts.now ?? Date.now;
  const gates = new Map<number, { sessionId: number; gate: FireGate }>();
  const watched = watchPawnWrites(opts.world.store);
  const audit = opts.audit ?? createAudit();

  return {
    get counters() {
      return audit.counts;
    },
    onFrame(clientId: number, frame: unknown) {
      const debug = fireFrameWantsDebug(frame);
      const log = createFireDebugLog(() => debug);
      let noted = false;
      try {
        const fire = parseFire(frame);
        log.receive(fire ? `client=${clientId} seq=${fire.seq}` : `client=${clientId} unparsed`);
        if (!fire) return;
        const session = opts.server.session(clientId);
        if (!session) {
          log.dedupe("no-session");
          return;
        }
        const owned = opts.server.replicator.get(clientId)?.ownedEntity;
        if (owned === undefined) {
          log.dedupe("no-pawn");
          return;
        }
        if (debug) watched.add(owned);
        else watched.delete(owned);
        let row = gates.get(clientId);
        if (!row || row.sessionId !== session.sessionId) {
          row = { sessionId: session.sessionId, gate: freshFireGate() };
          gates.set(clientId, row);
        }
        const admitted = admitFire(row.gate, fire.seq, now());
        log.dedupe(`${admitted} seq=${fire.seq}`);
        audit.gate(admitted);
        noted = true;
        if (admitted !== "accept") return;
        if (opts.health?.isDead(owned)) {
          log.trace("dead");
          return;
        }
        const pawn = opts.world.store.view(owned);
        if (!pawn) {
          log.trace("no-pawn");
          return;
        }
        const origin = { x: pawn.position.x, y: pawn.position.y + EYE_HEIGHT, z: pawn.position.z };
        const capsules = pawnCapsules(opts.world, owned);
        const shot = traceHitscan(origin, aimDirection(fire.yaw, clampPitch(fire.pitch)), opts.world.listObstacles(), capsules);
        const hit = shot.hitId === undefined ? "none" : String(shot.hitId);
        log.trace(`hit=${hit} dist=${shot.distance.toFixed(3)}`);
        console.log(`shot shooter=${owned} eye=${origin.x.toFixed(3)},${origin.y.toFixed(3)},${origin.z.toFixed(3)} hit=${hit} dist=${shot.distance.toFixed(3)}`);
        if (!finitePoint(shot.from) || !finitePoint(shot.to)) {
          console.error("laser skipped non-finite");
          return;
        }
        const laser: LaserFrame = {
          t: "laser",
          shooter: owned,
          from: shot.from,
          to: shot.to,
          until: now() + LASER_MS,
        };
        for (const id of opts.server.connected) {
          if (!clientSeesPawn(opts.server, id, owned)) continue;
          opts.send(id, laser);
        }
        const hitId = shot.hitId;
        if (hitId !== undefined && hitId !== owned && capsules.some((cap) => cap.id === hitId)) {
          let killed = false;
          if (opts.health) {
            const next = opts.health.wound(hitId);
            if (next) {
              log.writePawn(`health pawn=${hitId} ${next.hp}`);
              deliverHealthFrames(opts.server, opts.server.connected, [healthFrame(hitId, next.hp, next.dead)]);
              killed = next.hp === 0;
            }
          }
          audit.pawnHit(killed);
        }
      } catch (err) {
        log.thrown("fire", err);
        throw err;
      } finally {
        if (noted) publishAudit(opts.server, audit);
      }
    },
  };
}

function publishAudit(server: EngineWsServer, audit: Audit): void {
  try {
    deliverAuditFrame(server, audit.frame());
  } catch (err) {
    console.error("audit send failed", err);
  }
}

const WATCH = Symbol.for("arena.fireDebug.watch");

function reportWrite(step: string): void {
  try {
    console.log(fireDebugLine(step));
  } catch (err) {
    try {
      console.error(fireDebugErrorLine("write", err));
    } catch {
      // The logger does not destroy or respawn.
    }
  }
}

function fmtPos(p: unknown): string {
  if (!p || typeof p !== "object") return String(p);
  const v = p as { x?: unknown; y?: unknown; z?: unknown };
  const n = (x: unknown) => (typeof x === "number" ? x.toFixed(3) : String(x));
  return `${n(v.x)},${n(v.y)},${n(v.z)}`;
}

/** Later writes to a pawn that fired with debug on. The wrapper only logs. */
function watchPawnWrites(store: object): Set<number> {
  const host = store as Record<PropertyKey, unknown> & { [WATCH]?: Set<number> };
  const existing = host[WATCH];
  if (existing) return existing;
  const ids = new Set<number>();
  host[WATCH] = ids;
  const positionAfter = (id: number) => {
    const view = typeof host.view === "function" ? (host.view as (pawn: number) => { position?: unknown } | undefined)(id) : undefined;
    reportWrite(`write position pawn=${id} ${fmtPos(view?.position)}`);
  };
  const wrap = (name: string, after: (id: number, args: unknown[]) => void) => {
    const current = host[name];
    if (typeof current !== "function") return;
    const orig = (current as (...args: unknown[]) => unknown).bind(host);
    host[name] = (...args: unknown[]) => {
      const result = orig(...args);
      const id = args[0];
      if (result !== false && typeof id === "number" && ids.has(id)) {
        try {
          after(id, args);
        } catch (err) {
          try {
            console.error(fireDebugErrorLine("write", err));
          } catch {
            // The logger does not destroy or respawn.
          }
        }
      }
      return result;
    };
  };
  wrap("setTransform", (id, args) => reportWrite(`write position pawn=${id} ${fmtPos(args[1])}`));
  wrap("applyMove", positionAfter);
  wrap("integrate", positionAfter);
  wrap("setLifecycle", (id) => reportWrite(`write life pawn=${id} lifecycle`));
  wrap("destroy", (id) => reportWrite(`write life pawn=${id} destroyed`));
  wrap("setHealth", (id, args) => reportWrite(`write health pawn=${id} ${String(args[1])}`));
  return ids;
}

function finitePoint(p: { x: number; y: number; z: number }): boolean {
  return Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);
}

function pawnCapsules(world: AuthoritativeWorld, shooter: number): TraceCapsule[] {
  const height = world.pawnHeight;
  if (!Number.isFinite(height)) return [];
  const out: TraceCapsule[] = [];
  for (const entity of world.query()) {
    if (entity.id === shooter || entity.lifecycle !== "alive" || !(entity.radius > 0)) continue;
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


