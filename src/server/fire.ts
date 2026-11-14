// ARCHITECTURE: Hitscan for owned pawns and bots: fire gates, traces, laser
//   frames, and wound application.
// Wiring: arena-host.ts builds it and hands `fireAsBot`/`forgetBot` to
//   bot-brain.ts; the inbound `fire` frames arrive through arena-host.ts.
// Invariants: A bot's seq is `lastSeq + 1` on its own gate, so bot shots do not
//   consume a client's fire gate.
import type { EngineWsServer } from "conveyor-engine-transport-ws";
import type { AuthoritativeWorld } from "conveyor-engine-world";
import { aimDirection, clampPitch, EYE_HEIGHT } from "../shared/look.js";
import { createFireDebugLog, fireDebugErrorLine, fireDebugLine, fireFrameWantsDebug } from "../shared/fire-debug.js";
import { createAudit, type Audit, type AuditCounters } from "../shared/audit.js";
import { healthFrame, type PawnHealth } from "../shared/health.js";
import {
  admitFire,
  freshFireGate,
  LASER_MS,
  parseFire,
  traceIndexed,
  type FireGate,
  type LaserFrame,
  type TraceCapsule,
} from "../shared/hitscan.js";
import { deliverAuditFrame } from "./audit.js";
import { clientSeesPawn, deliverHealthFrames } from "./health.js";

/** Hitscan for owned pawns. Sends lasers and may wound. Counters sit on the shared audit. */
export interface ArenaFire {
  /** Shallow copy of the six audit numbers. Mutating it does not change the counters. */
  readonly counters: AuditCounters;
  /**
   * Unparsed, sessionless, or pawnless frames return before the counters. Clock is `opts.now`, or `Date.now`.
   * A dead pawn's accepted shot is counted and not traced. May log, wound, send lasers, and publish the audit.
   */
  onFrame(clientId: number, frame: unknown): void;
  /**
   * One admitted shot. Dead, missing, and non-finite shots send nothing.
   * Counts a pawn hit. Does not admit a gate or publish the audit.
   * `debug` prints the same trace lines as a debug fire frame.
   */
  fireAs(entity: number, yaw: number, pitch: number, opts?: { debug?: boolean }): "dead" | "done";
  /**
   * Host shot for a pawn with no client. Each entity has its own seq and gate.
   * Publishes the audit. `dead` means the shot was admitted and the pawn is dead, so nothing is sent.
   */
  fireAsBot(entity: number, yaw: number, pitch: number): "accept" | "repeat" | "fast" | "dead";
  /** Drops that entity's gate so the next shot is not limited by the old one. */
  forgetBot(entity: number): void;
}

/**
 * Hitscan for one owned pawn. Pitch is clamped to the same limit as the client
 * camera. `until` is the host clock plus {@link LASER_MS}.
 * @why The eye is inside that pawn's capsule, so the shooter is left out of the
 *      capsule list.
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
}): ArenaFire {
  const now = opts.now ?? Date.now;
  const gates = new Map<number, { sessionId: number; gate: FireGate }>();
  /** Host pawns. Seq is `lastSeq + 1` on that gate, so bots do not share a counter. */
  const botGates = new Map<number, FireGate>();
  const watched = watchPawnWrites(opts.world.store);
  const audit = opts.audit ?? createAudit();

  function fireAs(entity: number, yaw: number, pitch: number, shot?: { debug?: boolean }): "dead" | "done" {
    const log = createFireDebugLog(() => shot?.debug === true);
    if (opts.health?.isDead(entity)) {
      log.trace("dead");
      return "dead";
    }
    const pawn = opts.world.store.view(entity);
    if (!pawn) {
      log.trace("no-pawn");
      return "done";
    }
    const origin = { x: pawn.position.x, y: pawn.position.y + EYE_HEIGHT, z: pawn.position.z };
    const capsules = pawnCapsules(opts.world, entity);
    const traced = traceIndexed(origin, aimDirection(yaw, clampPitch(pitch)), opts.world.listObstacles(), capsules);
    const hit = traced.hitId === undefined ? "none" : String(traced.hitId);
    log.trace(`hit=${hit} dist=${traced.distance.toFixed(3)}`);
    console.log(`shot shooter=${entity} eye=${origin.x.toFixed(3)},${origin.y.toFixed(3)},${origin.z.toFixed(3)} hit=${hit} dist=${traced.distance.toFixed(3)}`);
    if (!finitePoint(traced.from) || !finitePoint(traced.to)) {
      console.error("laser skipped non-finite");
      return "done";
    }
    const laser: LaserFrame = {
      t: "laser",
      shooter: entity,
      from: traced.from,
      to: traced.to,
      until: now() + LASER_MS,
    };
    for (const id of opts.server.connected) {
      if (!clientSeesPawn(opts.server, id, entity)) continue;
      opts.send(id, laser);
    }
    const hitId = traced.hitId;
    if (hitId !== undefined && hitId !== entity && capsules.some((cap) => cap.id === hitId)) {
      let killed = false;
      if (opts.health) {
        const next = opts.health.wound(hitId, entity, undefined, "laser");
        if (next) {
          log.writePawn(`health pawn=${hitId} ${next.hp}`);
          deliverHealthFrames(opts.server, opts.server.connected, [healthFrame(hitId, next.hp, next.dead, next.dead ? "laser" : undefined)]);
          killed = next.hp === 0;
        }
      }
      audit.pawnHit(killed);
    }
    return "done";
  }

  function fireAsBot(entity: number, yaw: number, pitch: number): "accept" | "repeat" | "fast" | "dead" {
    let gate = botGates.get(entity);
    if (!gate) {
      gate = freshFireGate();
      botGates.set(entity, gate);
    }
    const admitted = admitFire(gate, gate.lastSeq + 1, now());
    audit.gate(admitted);
    let result: "accept" | "repeat" | "fast" | "dead" = admitted;
    try {
      if (admitted === "accept" && fireAs(entity, yaw, pitch) === "dead") result = "dead";
      return result;
    } finally {
      publishAudit(opts.server, audit);
    }
  }

  function forgetBot(entity: number): void {
    botGates.delete(entity);
  }

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
        fireAs(owned, fire.yaw, fire.pitch, { debug });
      } catch (err) {
        log.thrown("fire", err);
        throw err;
      } finally {
        if (noted) publishAudit(opts.server, audit);
      }
    },
    fireAs,
    fireAsBot,
    forgetBot,
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


