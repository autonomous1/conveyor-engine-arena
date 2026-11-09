import { decodeFrame, encodeFrame, EngineWsServer } from "conveyor-engine-transport-ws";
import type { TransportSocket } from "conveyor-engine-transport-ws";
import { createAudit } from "../shared/audit.js";
import { createPawnHealth, type SpawnPick } from "../shared/health.js";
import { helloModel, parseModelFrame } from "../shared/model-choice.js";
import { createPawnKit, createPickupHost } from "../shared/pickups.js";
import { decodeMoveButtons } from "../shared/movements.js";
import { canonicalJson, sceneGraphPayload, sha256Hex } from "../shared/scene-graph.js";
import { spawnFrame } from "../shared/spawn-frame.js";
import { createArenaDoors, createDoorBlockers } from "./doors.js";
import { createArenaElevators } from "./elevators.js";
import { createArenaFire } from "./fire.js";
import { applyPawnModel, claimClearSpawn, createHeldInputs, placePawn, startPropAnimation, startWanderLoop, teleportBlockReason } from "./game.js";
import { createArenaGrenades } from "./grenade.js";
import { createHostSocketPaths } from "./host-path.js";
import { pawnBodies, releasePickupObstacle } from "./pickups.js";
import type { LoadedArena } from "./world-loader.js";

/**
 * Verified access claims. Same fields as `Claims` in `auth/tokens.ts`.
 * Declared here so this module does not import the Node token signer.
 */
export type HostClaims = {
  sub: string;
  role: string;
  scope: readonly string[];
  jti: string;
  iat: number;
  exp: number;
};

/** A duplex the host can attach. The Node wrapper adapts `ws`. Solo adapts `memoryPair`. */
export type HostConn = {
  send(text: string): void;
  close(): void;
  onText(handler: (text: string) => void): void;
  onClose(handler: () => void): void;
  isOpen(): boolean;
  /** Verified hello claims. The Node gate sets this. Solo leaves it unset. */
  claims?: HostClaims;
};

export type ArenaHostOptions = {
  holdNpcs?: boolean;
  /**
   * In-tab solo passes true. There is no JWT. `build:solo` copies `web/game`
   * into `dist/solo/game`, so `scene-graph.json` is public next to the page.
   * Secrecy applies to the hosted build: that build sends the frame only when
   * verified claims include the `scene-graph` scope.
   */
  grantSceneGraph?: boolean;
};

export type ArenaSession = {
  arenaJson: string;
  /** Canonical scene-graph JSON. Absent when the manifest has no graph. */
  sceneGraphJson?: string;
  /** Hex SHA-256 of {@link sceneGraphJson}. Set when {@link sceneGraphReady} resolves. */
  sceneGraphHash?: string;
  /** Canonical baked regions JSON. Absent when the manifest has no regions file. */
  regionsJson?: string;
  /** Hex SHA-256 of {@link regionsJson}. Set when {@link sceneGraphReady} resolves. */
  regionsHash?: string;
  sceneGraphReady: Promise<void>;
  attach(conn: HostConn): void;
  stop(): void;
};

/**
 * Authoritative arena host with no Node imports. `main.ts` serves it over HTTP.
 * The solo page attaches a `memoryPair` server socket instead.
 */
export function createArenaHost(loaded: LoadedArena, opts: ArenaHostOptions = {}): ArenaSession {
  const holdNpcs = opts.holdNpcs ?? false;
  const grantSceneGraph = opts.grantSceneGraph === true;
  const sceneGraphJson = loaded.sceneGraph ? canonicalJson(sceneGraphPayload(loaded.sceneGraph)) : undefined;
  const regionsJson = loaded.regions ? canonicalJson(loaded.regions) : undefined;
  let sceneGraphHash: string | undefined;
  let regionsHash: string | undefined;
  const privilegedWaiters: HostConn[] = [];
  const held = createHeldInputs();
  /** Last deny log per client. One line per minute, not an audit counter. */
  const teleportDeniedAt = new Map<number, number>();
  /** Last qaSnapshot deny log per client. One line per minute, not an audit counter. */
  const qaSnapshotDeniedAt = new Map<number, number>();
  /** One remote shutter in flight per requester. The PNG is not logged or stored. */
  const snapByRequester = new Map<number, SnapJob>();
  const snapById = new Map<string, SnapJob>();
  let snapSeq = 0;
  /** Pads chosen since the last commit. The next hello treats them as occupied. */
  const reservedPads = new Map<number, SpawnPick>();
  const health = createPawnHealth();
  const kit = createPawnKit();
  const pickupHost = createPickupHost(loaded.view.pickups ?? []);
  const audit = createAudit();
  for (const agent of loaded.agents) health.note(agent.id);
  const attachPickupWelcome = (text: string, claims?: HostClaims): string => {
    if (!mayBeWelcome(text)) return text;
    let frame: unknown;
    try {
      frame = JSON.parse(text);
    } catch {
      return text;
    }
    if (!frame || typeof frame !== "object" || Array.isArray(frame)) return text;
    const welcome = frame as Record<string, unknown>;
    if (welcome.type !== "welcome") return text;
    welcome.pickups = pickupHost.remainingIds();
    welcome.doors = doorHost.snapshot();
    const elevators = elevatorHost.snapshot();
    if (elevators.length > 0) welcome.elevators = elevators;
    const owned = welcome.ownedEntityId;
    if (typeof owned === "number") {
      const weapon = kit.weaponOf(owned);
      const ammo = kit.ammoOf(owned);
      if (weapon) welcome.weapon = weapon;
      if (ammo > 0) welcome.ammo = ammo;
      welcome.keys = pickupHost.getHeldItems(owned);
    }
    if (claims) {
      welcome.role = claims.role;
      welcome.scope = [...claims.scope];
    }
    return JSON.stringify(welcome);
  };
  const pushPrivileged = (conn: HostConn): void => {
    if (!conn.isOpen()) return;
    const allowed = grantSceneGraph || conn.claims?.scope.includes("scene-graph") === true;
    if (!allowed) return;
    if ((sceneGraphJson && !sceneGraphHash) || (regionsJson && !regionsHash)) {
      privilegedWaiters.push(conn);
      return;
    }
    if (sceneGraphJson && sceneGraphHash) {
      conn.send(encodeFrame({
        t: "sceneGraph",
        v: 1,
        hash: sceneGraphHash,
        graph: JSON.parse(sceneGraphJson),
      }));
    }
    if (regionsJson && regionsHash) {
      conn.send(encodeFrame({
        t: "regions",
        v: 1,
        hash: regionsHash,
        regions: JSON.parse(regionsJson),
      }));
    }
  };
  const sceneGraphReady: Promise<void> = Promise.all([
    sceneGraphJson ? sha256Hex(sceneGraphJson).then((hex) => { sceneGraphHash = hex; }) : Promise.resolve(),
    regionsJson ? sha256Hex(regionsJson).then((hex) => { regionsHash = hex; }) : Promise.resolve(),
  ]).then(() => {
    const pending = privilegedWaiters.splice(0);
    for (const conn of pending) pushPrivileged(conn);
  });
  const refused = new Set<number>();
  const engine: EngineWsServer = new EngineWsServer({
    compatibility: { protocol: 1, world: loaded.view.world },
    bundle: { bundleId: loaded.view.bundleId, authoritativeHash: loaded.view.authoritativeHash },
    onHello: (session, hello): number | undefined => {
      // A spectator watches. They do not take a seat and are not a full server.
      if (spectateHello(hello)) return undefined;
      const used = new Set<number>();
      for (const clientId of engine.connected) {
        if (clientId === session.clientId) continue;
        const record = engine.gateway.get(clientId);
        if (record?.connected && record.ownedEntity !== undefined) used.add(record.ownedEntity);
      }
      const previous = engine.gateway.get(session.clientId);
      const reused = previous?.connected && previous.ownedEntity !== undefined && !used.has(previous.ownedEntity)
        ? previous.ownedEntity
        : undefined;
      const seats = loaded.agents.filter((agent) => agent.role === "player");
      const owned = reused ?? seats.find((agent) => !used.has(agent.id))?.id;
      if (owned === undefined) {
        refused.add(session.clientId);
        return undefined;
      }
      if (reused === undefined) {
        const pad = claimClearSpawn(loaded.world, owned, loaded.playerSpawns, reservedPads);
        if (pad) {
          placePawn(loaded.world, owned, pad);
          const agent = loaded.agents.find((item) => item.id === owned);
          if (agent) agent.heading = pad.yaw;
          reservedPads.set(owned, pad);
          // One frame to everyone: this pawn just appeared on the pad (a client beams it in).
          const joined = encodeFrame(spawnFrame(owned, pad.x, pad.y, pad.z));
          for (const clientId of engine.connected) engine.session(clientId)?.socket.send(joined);
        }
      }
      applyPawnModel(loaded.world, owned, helloModel(hello), loaded.view.modelChoices);
      return owned;
    },
    onAdmit: (input) => {
      const owned = engine.gateway.get(input.clientId)?.ownedEntity;
      if (owned === undefined) return;
      const fly = decodeMoveButtons(input.buttons);
      held.admit(owned, {
        moveX: input.moveX,
        moveZ: input.moveZ,
        yaw: input.yaw,
        seq: input.seq,
        noclip: fly.noclip,
        ascend: fly.ascend,
      });
    },
  });
  const doorHost = createArenaDoors({
    doors: loaded.view.doors,
    pawnOf(pawnId) {
      return pawnBodies(loaded.world, health).find((pawn) => pawn.id === pawnId);
    },
    keys: pickupHost,
    sendAll(frame) {
      const text = encodeFrame(frame);
      for (const clientId of engine.connected) {
        engine.session(clientId)?.socket.send(text);
      }
    },
    ownedPawn(clientId) {
      return engine.replicator.get(clientId)?.ownedEntity;
    },
    sessionId(clientId) {
      return engine.session(clientId)?.sessionId;
    },
    alive(pawnId) {
      return !health.isDead(pawnId);
    },
    blockers: createDoorBlockers(loaded.world),
    log: (line) => console.log(line),
  });
  const elevatorHost = createArenaElevators({
    elevators: loaded.view.elevators ?? [],
    aabbs: loaded.view.aabbs,
    doors: doorHost,
    doorIds: loaded.view.doors.map((door) => door.id),
    world: loaded.world,
    pawns: () => pawnBodies(loaded.world, health),
    ownedPawn(clientId) {
      return engine.replicator.get(clientId)?.ownedEntity;
    },
    alive(pawnId) {
      return !health.isDead(pawnId);
    },
    sendAll(frame) {
      const text = encodeFrame(frame);
      for (const clientId of engine.connected) {
        engine.session(clientId)?.socket.send(text);
      }
    },
    log: (line) => console.log(line),
  });
  const grenades = createArenaGrenades({
    world: loaded.world,
    server: engine,
    health,
    // The rendered floor, or the bottom of the world when there is none.
    floorY: loaded.view.floor?.y ?? loaded.view.bounds.minY,
    send(clientId, frame) {
      engine.session(clientId)?.socket.send(encodeFrame(frame));
    },
  });
  const stopLoop = startWanderLoop(loaded.world, loaded.agents, engine, held, (line) => console.error(line), health, audit, () => {
    reservedPads.clear();
    const grants = pickupHost.take(pawnBodies(loaded.world, health), health, kit);
    for (const grant of grants) {
      releasePickupObstacle(loaded.world, loaded.view.aabbs, grant.id);
      const gone = encodeFrame(grant.gone);
      for (const clientId of engine.connected) {
        engine.session(clientId)?.socket.send(gone);
      }
      if (grant.kind === "key") sendInventory(grant.pawnId);
      if (!grant.loadout) continue;
      const loadout = encodeFrame(grant.loadout);
      for (const clientId of engine.connected) {
        if (engine.replicator.get(clientId)?.ownedEntity !== grant.pawnId) continue;
        engine.session(clientId)?.socket.send(loadout);
      }
    }
    grenades.tick();
  }, loaded.view.noclip === true, loaded.playerSpawns, holdNpcs, elevatorHost, {
    sceneGraph: loaded.sceneGraph,
    regions: loaded.regions,
    aabbs: loaded.view.aabbs,
    doors: loaded.view.doors,
    pawnRadius: loaded.view.pawnRadius,
    pawnHeight: loaded.view.pawnHeight,
    liveDoors: () => doorHost.snapshot(),
  });
  const propClips = startPropAnimation(loaded.view.props);
  const fire = createArenaFire({
    world: loaded.world,
    server: engine,
    health,
    audit,
    send(clientId, frame) {
      engine.session(clientId)?.socket.send(encodeFrame(frame));
    },
  });
  const arenaJson = JSON.stringify({ ...loaded.view, propClips });

  function sendClient(clientId: number, frame: object): void {
    engine.session(clientId)?.socket.send(encodeFrame(frame));
  }

  function nextSnapId(clientId: number): string {
    snapSeq += 1;
    return `snap-${clientId}-${snapSeq}`;
  }

  function sendInventory(pawnId: number): void {
    // Keys survive respawn today. Death dropping keys is later, so this list is not cleared.
    const frame = encodeFrame({ t: "inventory", keys: pickupHost.getHeldItems(pawnId) });
    for (const clientId of engine.connected) {
      if (engine.replicator.get(clientId)?.ownedEntity !== pawnId) continue;
      engine.session(clientId)?.socket.send(frame);
    }
  }

  return {
    arenaJson,
    sceneGraphJson,
    get sceneGraphHash() {
      return sceneGraphHash;
    },
    regionsJson,
    get regionsHash() {
      return regionsHash;
    },
    sceneGraphReady,
    attach(conn) {
      const denyTeleport = (clientId: number): void => {
        const now = Date.now();
        const prev = teleportDeniedAt.get(clientId) ?? 0;
        if (now - prev < 60_000) return;
        teleportDeniedAt.set(clientId, now);
        console.log(`[teleport] denied client=${clientId} sub=${conn.claims?.sub ?? ""}`);
      };
      const denyQaSnapshot = (clientId: number): void => {
        const now = Date.now();
        const prev = qaSnapshotDeniedAt.get(clientId) ?? 0;
        if (now - prev < 60_000) return;
        qaSnapshotDeniedAt.set(clientId, now);
        console.log(`[qaSnapshot] denied client=${clientId} sub=${conn.claims?.sub ?? ""}`);
      };
      const socket = socketFromConn(conn, refused, (clientId) => engine.disconnect(clientId), (sock, frame) => {
        const clientId = clientIdFor(engine, sock);
        if (clientId === undefined) return;
        if (isTeleportFrame(frame)) {
          const pawnId = engine.replicator.get(clientId)?.ownedEntity;
          if (pawnId === undefined || conn.claims?.scope.includes("teleport") !== true) {
            denyTeleport(clientId);
            return;
          }
          const landing = finiteTeleport(frame);
          if (!landing) {
            conn.send(encodeFrame({ t: "teleportResult", ok: false, reason: "invalid" }));
            return;
          }
          const reason = teleportBlockReason(loaded.world, loaded.view.bounds, pawnId, landing.x, landing.y, landing.z);
          if (reason) {
            conn.send(encodeFrame({ t: "teleportResult", ok: false, reason }));
            return;
          }
          held.drop(pawnId);
          const agent = loaded.agents.find((item) => item.id === pawnId);
          if (agent) agent.heading = landing.yaw;
          placePawn(loaded.world, pawnId, landing);
          // The wander tick enqueues its own setTransform from the store pose.
          // Commit first so that step starts at the landing instead of the old feet.
          loaded.world.commit(loaded.world.currentTick);
          conn.send(encodeFrame({ t: "teleportResult", ok: true }));
          return;
        }
        if (isQaSnapshotFrame(frame)) {
          if (conn.claims?.scope.includes("qa") !== true) {
            denyQaSnapshot(clientId);
            return;
          }
          const parsed = parseQaSnapshotAsk(frame);
          const id = (parsed.ok ? parsed.ask.id : parsed.id) ?? nextSnapId(clientId);
          if (!parsed.ok) {
            sendClient(clientId, { t: "snapshotResult", ok: false, id, reason: "invalid" });
            return;
          }
          if (snapByRequester.has(clientId) || snapById.has(id)) {
            sendClient(clientId, { t: "snapshotResult", ok: false, id, reason: "busy" });
            return;
          }
          const ask = parsed.ask;
          const capture = {
            t: "qaCapture" as const,
            id,
            ...(ask.lookFrom ? { lookFrom: ask.lookFrom } : {}),
            ...(ask.follow ? { follow: ask.follow } : {}),
            ...(ask.waitFrames !== undefined ? { waitFrames: ask.waitFrames } : {}),
          };
          const job: SnapJob = {
            id,
            requesterId: clientId,
            timer: setTimeout(() => {
              const current = snapById.get(id);
              if (!current) return;
              snapById.delete(id);
              snapByRequester.delete(current.requesterId);
              sendClient(current.requesterId, { t: "snapshotResult", ok: false, id, reason: "noRenderer" });
            }, SNAP_TIMEOUT_MS),
          };
          snapByRequester.set(clientId, job);
          snapById.set(id, job);
          const text = encodeFrame(capture);
          for (const otherId of engine.connected) {
            if (otherId === clientId) continue;
            engine.session(otherId)?.socket.send(text);
          }
          return;
        }
        if (isQaSnapshotDataFrame(frame)) {
          const data = readQaSnapshotData(frame);
          if (data) {
            const job = snapById.get(data.id);
            if (job) {
              clearTimeout(job.timer);
              snapById.delete(job.id);
              snapByRequester.delete(job.requesterId);
              sendClient(job.requesterId, { t: "snapshotResult", ok: true, id: job.id, png: data.png });
            }
          }
          return;
        }
        const chosen = parseModelFrame(frame);
        if (chosen) {
          const pawnId = engine.replicator.get(clientId)?.ownedEntity;
          if (pawnId !== undefined) applyPawnModel(loaded.world, pawnId, chosen, loaded.view.modelChoices);
          return;
        }
        try {
          fire.onFrame(clientId, frame);
        } catch (err) {
          console.error("fire threw", err);
        }
        try {
          grenades.onFrame(clientId, frame);
        } catch (err) {
          console.error("grenade threw", err);
        }
        try {
          elevatorHost.onFrame(clientId, frame);
        } catch (err) {
          console.error("elevator threw", err);
        }
        try {
          if (doorHost.onFrame(clientId, frame) === false) {
            const pawnId = engine.replicator.get(clientId)?.ownedEntity;
            if (pawnId !== undefined) elevatorHost.onUse(pawnId);
          }
        } catch (err) {
          console.error("door threw", err);
        }
      }, (text) => attachPickupWelcome(text, conn.claims), () => pushPrivileged(conn));
      socket.onClose(() => {
        const clientId = clientIdFor(engine, socket);
        if (clientId !== undefined) doorHost.drop(clientId);
      });
      engine.attach(socket);
    },
    stop() {
      for (const job of snapById.values()) clearTimeout(job.timer);
      snapById.clear();
      snapByRequester.clear();
      stopLoop();
    },
  };
}

export function socketFromConn(
  conn: HostConn,
  refused: Set<number>,
  drop: (clientId: number) => void,
  onArena: (socket: TransportSocket, frame: unknown) => void,
  stamp: (text: string) => string,
  afterWelcome?: () => void,
): TransportSocket {
  const messages: Array<(text: string) => void> = [];
  const closes: Array<() => void> = [];
  let self: TransportSocket | undefined;
  const paths = createHostSocketPaths({
    writeWire(text) {
      if (!conn.isOpen()) return;
      const clientId = refusedWelcome(text, refused);
      if (clientId === undefined) {
        conn.send(stamp(text));
        if (afterWelcome && isWelcomeText(text)) afterWelcome();
        return;
      }
      refused.delete(clientId);
      conn.send(encodeFrame({ v: 1, type: "reject", reason: "no free pawn", code: "SERVER_FULL" }));
      drop(clientId);
    },
    onEngineText(text) {
      for (const handler of messages) handler(text);
    },
    onArenaFrame(frame) {
      if (self) onArena(self, frame);
    },
  });
  conn.onText((text) => {
    paths.deliverEncoded(text);
  });
  conn.onClose(() => {
    paths.close();
    for (const handler of closes) handler();
  });
  self = {
    send(text) {
      paths.sendEncoded(text);
    },
    close() {
      paths.close();
      conn.close();
    },
    onMessage(handler) {
      messages.push(handler);
    },
    onClose(handler) {
      closes.push(handler);
    },
  };
  return self;
}

function spectateHello(hello: object): boolean {
  return (hello as { spectate?: unknown }).spectate === true;
}

const SNAP_TIMEOUT_MS = 3_000;
const PNG_PREFIX = "data:image/png;base64,";
const PNG_MAX_CHARS = 4_000_000;
const SNAP_ID_MAX = 64;

type SnapJob = {
  id: string;
  requesterId: number;
  timer: ReturnType<typeof setTimeout>;
};

type SnapVec = { x: number; y: number; z: number };

type SnapLook = { eye: SnapVec; target: SnapVec; fovDeg: number };

type SnapFollow = { entityId: number; back: number; up: number };

type SnapAsk = {
  id?: string;
  lookFrom?: SnapLook;
  follow?: SnapFollow;
  waitFrames?: number;
};

function isQaSnapshotFrame(frame: unknown): frame is { t: "qaSnapshot" } {
  return !!frame && typeof frame === "object" && !Array.isArray(frame) && (frame as { t?: unknown }).t === "qaSnapshot";
}

function isQaSnapshotDataFrame(frame: unknown): frame is { t: "qaSnapshotData" } {
  return !!frame && typeof frame === "object" && !Array.isArray(frame) && (frame as { t?: unknown }).t === "qaSnapshotData";
}

function parseQaSnapshotAsk(frame: { t: "qaSnapshot" }): { ok: true; ask: SnapAsk } | { ok: false; id?: string } {
  const rec = frame as { id?: unknown; lookFrom?: unknown; follow?: unknown; waitFrames?: unknown };
  let id: string | undefined;
  if (rec.id !== undefined) {
    if (typeof rec.id !== "string" || rec.id.length === 0 || rec.id.length > SNAP_ID_MAX) return { ok: false };
    id = rec.id;
  }
  let lookFrom: SnapLook | undefined;
  if (rec.lookFrom !== undefined) {
    const parsed = parseSnapLook(rec.lookFrom);
    if (!parsed) return { ok: false, id };
    lookFrom = parsed;
  }
  let follow: SnapFollow | undefined;
  if (rec.follow !== undefined) {
    const parsed = parseSnapFollow(rec.follow);
    if (!parsed) return { ok: false, id };
    follow = parsed;
  }
  let waitFrames: number | undefined;
  if (rec.waitFrames !== undefined) {
    if (typeof rec.waitFrames !== "number" || !Number.isInteger(rec.waitFrames)) return { ok: false, id };
    waitFrames = Math.min(30, Math.max(0, rec.waitFrames));
  }
  const ask: SnapAsk = {};
  if (id) ask.id = id;
  if (lookFrom) ask.lookFrom = lookFrom;
  if (follow) ask.follow = follow;
  if (waitFrames !== undefined) ask.waitFrames = waitFrames;
  return { ok: true, ask };
}

function parseSnapLook(value: unknown): SnapLook | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const rec = value as { eye?: unknown; target?: unknown; fovDeg?: unknown };
  const eye = parseSnapVec(rec.eye);
  const target = parseSnapVec(rec.target);
  if (!eye || !target) return undefined;
  if (rec.fovDeg === undefined) return { eye, target, fovDeg: 55 };
  if (typeof rec.fovDeg !== "number" || !Number.isFinite(rec.fovDeg)) return undefined;
  return { eye, target, fovDeg: rec.fovDeg };
}

function parseSnapFollow(value: unknown): SnapFollow | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const rec = value as { entityId?: unknown; back?: unknown; up?: unknown };
  if (typeof rec.entityId !== "number" || !Number.isInteger(rec.entityId)) return undefined;
  let back = 3;
  let up = 1.6;
  if (rec.back !== undefined) {
    if (typeof rec.back !== "number" || !Number.isFinite(rec.back)) return undefined;
    back = rec.back;
  }
  if (rec.up !== undefined) {
    if (typeof rec.up !== "number" || !Number.isFinite(rec.up)) return undefined;
    up = rec.up;
  }
  return { entityId: rec.entityId, back, up };
}

function parseSnapVec(value: unknown): SnapVec | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const rec = value as { x?: unknown; y?: unknown; z?: unknown };
  if (typeof rec.x !== "number" || typeof rec.y !== "number" || typeof rec.z !== "number") return undefined;
  if (!Number.isFinite(rec.x) || !Number.isFinite(rec.y) || !Number.isFinite(rec.z)) return undefined;
  return { x: rec.x, y: rec.y, z: rec.z };
}

function readQaSnapshotData(frame: { t: "qaSnapshotData" }): { id: string; png: string } | undefined {
  const rec = frame as { id?: unknown; png?: unknown };
  if (typeof rec.id !== "string" || rec.id.length === 0) return undefined;
  if (typeof rec.png !== "string" || !rec.png.startsWith(PNG_PREFIX) || rec.png.length > PNG_MAX_CHARS) return undefined;
  return { id: rec.id, png: rec.png };
}

function isTeleportFrame(frame: unknown): frame is { t: "teleport" } {
  return !!frame && typeof frame === "object" && !Array.isArray(frame) && (frame as { t?: unknown }).t === "teleport";
}

function finiteTeleport(frame: { t: "teleport" }): { x: number; y: number; z: number; yaw: number } | undefined {
  const rec = frame as { x?: unknown; y?: unknown; z?: unknown; yaw?: unknown };
  if (typeof rec.x !== "number" || typeof rec.y !== "number" || typeof rec.z !== "number" || typeof rec.yaw !== "number") {
    return undefined;
  }
  if (!Number.isFinite(rec.x) || !Number.isFinite(rec.y) || !Number.isFinite(rec.z) || !Number.isFinite(rec.yaw)) {
    return undefined;
  }
  return { x: rec.x, y: rec.y, z: rec.z, yaw: rec.yaw };
}

function clientIdFor(engine: EngineWsServer, socket: TransportSocket): number | undefined {
  for (const clientId of engine.connected) {
    if (engine.session(clientId)?.socket === socket) return clientId;
  }
  return undefined;
}

/**
 * Cheap pre-check before parsing an outbound frame. Every frame on this path is
 * produced by JSON.stringify (encodeFrame), so a welcome always contains this
 * exact token. False positives fall through to the full parse; there are no
 * false negatives for stringify output.
 */
export function mayBeWelcome(text: string): boolean {
  return text.includes('"type":"welcome"');
}

function isWelcomeText(text: string): boolean {
  if (!mayBeWelcome(text)) return false;
  try {
    const frame = JSON.parse(text) as { type?: unknown };
    return !!frame && typeof frame === "object" && frame.type === "welcome";
  } catch {
    return false;
  }
}

function refusedWelcome(text: string, refused: Set<number>): number | undefined {
  if (refused.size === 0 || !mayBeWelcome(text)) return undefined;
  try {
    const frame = decodeFrame(text) as { type?: string; clientId?: number };
    if (frame.type === "welcome" && typeof frame.clientId === "number" && refused.has(frame.clientId)) return frame.clientId;
  } catch {
    return undefined;
  }
  return undefined;
}
