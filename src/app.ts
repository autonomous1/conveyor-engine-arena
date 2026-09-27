import { EngineClient, type IncomingSnapshot } from "conveyor-engine-client";
import type { ClientId, EntityId, Tick } from "conveyor-engine-core";
import { InputGateway, Replicator, type SnapshotEnvelope } from "conveyor-engine-replication";
import {
  MemoryBytesSource,
  MockTemplateParser,
  PresentationRuntime,
  RendererCache,
  ThreeProjector,
  memoryScene,
  type SceneAdapter,
} from "conveyor-engine-three";
import { EngineWsClient, EngineWsServer, memoryPair } from "conveyor-engine-transport-ws";
import { AuthoritativeWorld, applyStaticWorldDefinition } from "conveyor-engine-world";
import { resolvePresentation, visualAssetFromManifest } from "conveyor-engine-assets";
import { arenaStaticWorld, arenaVisualGlb } from "./arena-assets.js";

export type ExampleClient = {
  id: ClientId;
  pawn: EntityId;
  ws: EngineWsClient;
  pred: EngineClient;
  three: ThreeProjector;
  snapshots: SnapshotEnvelope[];
  presentation?: PresentationRuntime;
};

export type ExampleDiagnostics = {
  tick: Tick;
  entityCount: number;
  clientCount: number;
  inputs: number;
  invalidInputs: number;
  snapshots: number;
  hash: string;
  bundleId?: string;
  authoritativeHash?: string;
  spawnCount?: number;
  aabbCount?: number;
  presentation?: string;
};

/**
 * Two-pawn shared plane: server world + WS adapter + predicted clients + mock Three.
 */
export class ExampleApp {
  readonly world: AuthoritativeWorld;
  readonly gateway: InputGateway;
  readonly replicator: Replicator;
  readonly server: EngineWsServer;
  readonly clients = new Map<ClientId, ExampleClient>();
  tick: Tick = 0n;
  readonly radius: number;

  readonly bundleId?: string;
  readonly authoritativeHash?: string;
  presentationMode: "ready" | "missing" | "malformed" | "skipped";

  constructor(opts: { radius?: number; worldVersion?: string; useArena?: boolean; presentation?: "ready" | "missing" | "malformed" | "skipped" } = {}) {
    this.radius = opts.radius ?? 48;
    this.presentationMode = opts.presentation ?? "skipped";
    this.world = new AuthoritativeWorld({ worldVersion: opts.worldVersion ?? "example-v1" });
    let bundleId: string | undefined;
    let authoritativeHash: string | undefined;
    if (opts.useArena) {
      const arena = arenaStaticWorld();
      authoritativeHash = applyStaticWorldDefinition(this.world, arena.definition);
      bundleId = arena.definition.bundleId;
      this.bundleId = bundleId;
      this.authoritativeHash = authoritativeHash;
    }
    this.gateway = new InputGateway();
    this.replicator = new Replicator();
    this.server = new EngineWsServer({
      compatibility: { protocol: 1, world: this.world.worldVersion },
      bundle: bundleId || authoritativeHash ? { bundleId, authoritativeHash } : undefined,
      gateway: this.gateway,
      replicator: this.replicator,
      onHello: (session) => this.#spawnPawn(session.clientId),
      onAdmit: (input) => {
        this.gateway.enqueueMovement(this.world, input);
      },
    });
  }

  static arena(opts: { radius?: number; presentation?: "ready" | "missing" | "malformed" | "skipped" } = {}): ExampleApp {
    return new ExampleApp({ ...opts, useArena: true, worldVersion: "example-v1" });
  }

  #spawnPawn(clientId: ClientId): EntityId {
    const existing = this.clients.get(clientId)?.pawn;
    if (existing && this.world.exists(existing)) return existing;
    const spawn = this.world.listSpawnPoints().length
      ? this.world.selectSpawn(clientId)
      : { id: "default", x: clientId === 1 ? 0 : 8 * (clientId - 1), y: 0, z: 0, yaw: 0 };
    const pawn = this.world.createEntity(this.tick, { type: "pawn", shape: "capsule", color: 0x33aa66 + clientId }, clientId);
    this.world.enqueue({
      kind: "setTransform",
      entity: pawn,
      position: { x: spawn.x, y: spawn.y, z: spawn.z },
      rotation: { x: 0, y: Math.sin(spawn.yaw / 2), z: 0, w: Math.cos(spawn.yaw / 2) },
      scale: { x: 1, y: 1, z: 1 },
    });
    this.world.enqueue({ kind: "setBounds", entity: pawn, radius: 0.5 });
    return pawn;
  }

  addCrate(x: number, z: number): EntityId {
    const id = this.world.createEntity(this.tick, { type: "crate", shape: "box", color: 0x886644 });
    this.world.enqueue({
      kind: "setTransform",
      entity: id,
      position: { x, y: 0, z },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 1, y: 1, z: 1 },
    });
    return id;
  }

  connectClient(scene?: SceneAdapter): ExampleClient {
    const pair = memoryPair();
    this.server.attach(pair.server);
    const snapshots: SnapshotEnvelope[] = [];
    const pred = new EngineClient(1);
    const three = new ThreeProjector(scene ?? memoryScene());
    const slot: ExampleClient = {
      id: 0 as ClientId,
      pawn: 0 as EntityId,
      ws: undefined as unknown as EngineWsClient,
      pred,
      three,
      snapshots,
    };
    const ws = new EngineWsClient(pair.client, {
      compatibility: { protocol: 1, world: this.world.worldVersion },
      bundleId: this.bundleId,
      authoritativeHash: this.authoritativeHash,
      onWelcome: (msg) => {
        const pawn = this.gateway.get(msg.clientId)?.ownedEntity;
        pred.connect(pawn, msg.clientId);
        slot.id = msg.clientId;
        slot.pawn = pawn ?? slot.pawn;
        const rep = this.replicator.get(msg.clientId);
        if (rep) rep.interestRadius = this.radius;
        pred.acceptWorld(msg.bundleId ?? this.bundleId, msg.authoritativeHash ?? this.authoritativeHash);
        const arena = this.bundleId ? arenaStaticWorld() : undefined;
        const visual = arena ? visualAssetFromManifest(arena.manifest) : undefined;
        const load =
          this.presentationMode === "skipped"
            ? "skipped"
            : this.presentationMode === "ready"
              ? "ready"
              : this.presentationMode === "missing"
                ? "missing"
                : "decode-failed";
        const pres = resolvePresentation(visual, load);
        pred.setVisualStatus(pres.state, { assetId: pres.assetId, fallbackAssetId: pres.fallbackAssetId });
        if (arena && visual) {
          const source = new MemoryBytesSource().put(
            visual.id,
            arenaVisualGlb(),
            visual.contentHash,
          );
          source.put("primitive/box", new Uint8Array([1]), "sha256:box");
          if (this.presentationMode === "missing" || this.presentationMode === "malformed") {
            source.missing.add(visual.id);
          }
          const runtime = new PresentationRuntime(scene ?? memoryScene(), new RendererCache(new MockTemplateParser()), source);
          slot.presentation = runtime;
          void runtime.attachWorld({
            assetId: visual.id,
            contentHash: visual.contentHash,
            fallbackAssetId: visual.runtimePolicy?.fallbackAssetId,
          });
        }
        this.clients.set(msg.clientId, slot);
      },
      onSnapshot: (envelope) => {
        snapshots.push(envelope);
        pred.applySnapshot(toIncoming(envelope));
        three.apply(pred.renderSnapshot());
        ws.ack(envelope.seq);
      },
    });
    slot.ws = ws;
    ws.hello();
    return slot;
  }

  step(moves?: Map<ClientId, { moveX: number; moveZ: number }>): void {
    this.tick += 1n;
    this.server.setTick(this.tick);
    for (const entity of this.gateway.drainTimeouts()) {
      this.world.clearInput(entity);
    }
    if (moves) {
      for (const [clientId, move] of moves) {
        const c = this.clients.get(clientId);
        if (!c) continue;
        const cmd = c.pred.collectInput({ moveX: move.moveX, moveZ: move.moveZ, yaw: 0, buttons: 0 });
        c.ws.sendInput({ seq: cmd.seq, moveX: cmd.moveX, moveZ: cmd.moveZ, yaw: cmd.yaw, entity: c.pawn });
      }
    }
    const snap = this.world.commit(this.tick);
    const envs = this.replicator.publish(this.world, snap);
    for (const [clientId, env] of envs) {
      this.server.sendSnapshot(clientId, env);
    }
  }

  disconnect(clientId: ClientId): void {
    const c = this.clients.get(clientId);
    c?.ws.close();
    this.clients.delete(clientId);
  }

  diagnostics(): ExampleDiagnostics {
    return {
      tick: this.tick,
      entityCount: this.world.store.entityCount,
      clientCount: this.server.connected.length,
      inputs: this.gateway.metrics.accepted,
      invalidInputs: this.gateway.metrics.rejected,
      snapshots: this.server.metrics.snapshots,
      hash: this.world.canonicalJson(),
      bundleId: this.world.bundleId,
      authoritativeHash: this.world.assetsCompatHash,
      spawnCount: this.world.listSpawnPoints().length,
      aabbCount: this.world.listObstacles().length,
      presentation: [...this.clients.values()].map((c) => c.pred.visualStatus).join(",") || this.presentationMode,
    };
  }
}

function toIncoming(env: SnapshotEnvelope): IncomingSnapshot {
  return {
    kind: env.kind,
    seq: env.seq,
    tick: env.tick,
    lastProcessedInput: env.lastProcessedInput,
    spawns: env.spawns.map((s) => ({ entity: s.entity, view: s.view })),
    updates: env.updates.map((u) => ({ entity: u.entity, view: u.view })),
    despawns: env.despawns.map((d) => ({ entity: d.entity })),
  };
}
