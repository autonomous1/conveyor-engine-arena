import { decodeFrame, encodeFrame, EngineWsServer } from "conveyor-engine-transport-ws";
import type { TransportSocket } from "conveyor-engine-transport-ws";
import { createAudit } from "../shared/audit.js";
import { createPawnHealth, type SpawnPick } from "../shared/health.js";
import { helloModel, parseModelFrame } from "../shared/model-choice.js";
import { createPawnKit, createPickupHost } from "../shared/pickups.js";
import { decodeMoveButtons } from "../shared/movements.js";
import { createArenaDoors, createDoorBlockers } from "./doors.js";
import { createArenaElevators } from "./elevators.js";
import { createArenaFire } from "./fire.js";
import { applyPawnModel, claimClearSpawn, createHeldInputs, placePawn, startPropAnimation, startWanderLoop } from "./game.js";
import { createArenaGrenades } from "./grenade.js";
import { createHostSocketPaths } from "./host-path.js";
import { pawnBodies, releasePickupObstacle } from "./pickups.js";
import type { LoadedArena } from "./world-loader.js";

/** A duplex the host can attach. The Node wrapper adapts `ws`. Solo adapts `memoryPair`. */
export type HostConn = {
  send(text: string): void;
  close(): void;
  onText(handler: (text: string) => void): void;
  onClose(handler: () => void): void;
  isOpen(): boolean;
};

export type ArenaSession = {
  arenaJson: string;
  attach(conn: HostConn): void;
  stop(): void;
};

/**
 * Authoritative arena host with no Node imports. `main.ts` serves it over HTTP.
 * The solo page attaches a `memoryPair` server socket instead.
 */
export function createArenaHost(loaded: LoadedArena, opts: { holdNpcs?: boolean } = {}): ArenaSession {
  const holdNpcs = opts.holdNpcs ?? false;
  const held = createHeldInputs();
  /** Pads chosen since the last commit. The next hello treats them as occupied. */
  const reservedPads = new Map<number, SpawnPick>();
  const health = createPawnHealth();
  const kit = createPawnKit();
  const pickupHost = createPickupHost(loaded.view.pickups ?? []);
  const audit = createAudit();
  for (const agent of loaded.agents) health.note(agent.id);
  const attachPickupWelcome = (text: string): string => {
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
    }
    return JSON.stringify(welcome);
  };
  const refused = new Set<number>();
  const engine: EngineWsServer = new EngineWsServer({
    compatibility: { protocol: 1, world: loaded.view.world },
    bundle: { bundleId: loaded.view.bundleId, authoritativeHash: loaded.view.authoritativeHash },
    onHello: (session, hello): number | undefined => {
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
      if (!grant.loadout) continue;
      const loadout = encodeFrame(grant.loadout);
      for (const clientId of engine.connected) {
        if (engine.replicator.get(clientId)?.ownedEntity !== grant.pawnId) continue;
        engine.session(clientId)?.socket.send(loadout);
      }
    }
    grenades.tick();
  }, loaded.view.noclip === true, loaded.playerSpawns, holdNpcs, elevatorHost);
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

  return {
    arenaJson,
    attach(conn) {
      const socket = socketFromConn(conn, refused, (clientId) => engine.disconnect(clientId), (sock, frame) => {
        const clientId = clientIdFor(engine, sock);
        if (clientId === undefined) return;
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
      }, attachPickupWelcome);
      socket.onClose(() => {
        const clientId = clientIdFor(engine, socket);
        if (clientId !== undefined) doorHost.drop(clientId);
      });
      engine.attach(socket);
    },
    stop() {
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

function clientIdFor(engine: EngineWsServer, socket: TransportSocket): number | undefined {
  for (const clientId of engine.connected) {
    if (engine.session(clientId)?.socket === socket) return clientId;
  }
  return undefined;
}

function refusedWelcome(text: string, refused: Set<number>): number | undefined {
  try {
    const frame = decodeFrame(text) as { type?: string; clientId?: number };
    if (frame.type === "welcome" && typeof frame.clientId === "number" && refused.has(frame.clientId)) return frame.clientId;
  } catch {
    return undefined;
  }
  return undefined;
}
