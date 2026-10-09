import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { AuthoritativeWorld } from "conveyor-engine-world";
import { createPawnLayer } from "../src/client/presentation.ts";
import type { CharacterTemplates } from "../src/client/arena-scene.ts";
import { createArenaFire } from "../dist/server/fire.js";
import { loadArena } from "../dist/server/world-loader.js";
import { startArenaServer } from "../dist/server/main.js";
import {
  clampHealth,
  createPawnHealth,
  MAX_HP,
  MIN_HP,
  parseHealth,
  pickRespawnSpawn,
  RESPAWN_MS,
  type BlockAabb,
  type BlockPawn,
  type HealthFrame,
  type PawnHealth,
} from "../src/shared/health.ts";
import { aimDirection, EYE_HEIGHT } from "../src/shared/look.ts";
import { FIRE_INTERVAL_MS, traceHitscan, type TraceAabb, type TraceCapsule } from "../src/shared/hitscan.ts";

test("health stays inside 0 to 100", () => {
  assert.equal(clampHealth(-10), MIN_HP);
  assert.equal(clampHealth(0), MIN_HP);
  assert.equal(clampHealth(40), 40);
  assert.equal(clampHealth(MAX_HP), MAX_HP);
  assert.equal(clampHealth(140), MAX_HP);
  assert.equal(clampHealth(Number.NaN), MIN_HP);
  assert.equal(clampHealth(Number.POSITIVE_INFINITY), MIN_HP);
  let now = 0;
  const health = createPawnHealth(() => now);
  health.note(4);
  for (let i = 0; i < 10; i++) {
    const next = health.wound(4);
    if (next) {
      assert.ok(next.hp >= MIN_HP && next.hp <= MAX_HP);
      assert.equal(next.dead, next.hp === 0);
    }
  }
  const done = health.get(4);
  assert.deepEqual(done, { hp: 0, dead: true });
  assert.equal(health.wound(4), undefined);
  assert.deepEqual(health.takeRespawns(), []);
  now = RESPAWN_MS;
  assert.deepEqual(health.takeRespawns(), [4]);
  assert.deepEqual(health.get(4), { hp: MAX_HP, dead: false });
  assert.equal(parseHealth({ t: "laser", shooter: 1 }), undefined);
  assert.deepEqual(parseHealth({ t: "health", entity: 4, hp: 250, dead: false }), {
    t: "health",
    entity: 4,
    hp: MAX_HP,
    dead: false,
  });
  assert.equal(parseHealth({ t: "health", entity: 4, hp: Number.NaN, dead: true }), undefined);
});

test("a blocked spawn is skipped and a full block uses the first spawn", () => {
  const first = { x: 0, y: 0, z: 0, yaw: 0 };
  const second = { x: 10, y: 0, z: 0, yaw: 0.4 };
  const third = { x: 20, y: 0, z: 0, yaw: 1 };
  const ground: BlockAabb = { minX: -1, maxX: 1, minY: 0, maxY: 2, minZ: -1, maxZ: 1 };
  const high: BlockAabb = { minX: -1, maxX: 1, minY: 3, maxY: 5, minZ: -1, maxZ: 1 };
  const pawn: BlockPawn = { id: 2, x: 10, y: 0, z: 0, radius: 0.5 };
  const base = { self: 1, radius: 0.5, height: 1.8 };
  assert.equal(pickRespawnSpawn([first, second, third], { ...base, aabbs: [ground], pawns: [pawn] }), third);
  assert.equal(pickRespawnSpawn([first, second], { ...base, aabbs: [high], pawns: [] }), first);
  assert.equal(
    pickRespawnSpawn([first, second], { ...base, aabbs: [ground], pawns: [pawn] }),
    first,
  );
  const self: BlockPawn = { id: 1, x: 0, y: 0, z: 0, radius: 0.5 };
  assert.equal(pickRespawnSpawn([first, second], { ...base, aabbs: [], pawns: [self, pawn] }), first);
  assert.equal(pickRespawnSpawn([], { ...base, aabbs: [], pawns: [] }), undefined);
  const touching: BlockPawn = { id: 9, x: 1, y: 0, z: 0, radius: 0.5 };
  assert.equal(pickRespawnSpawn([first, third], { ...base, aabbs: [], pawns: [touching] }), first);
  const inside: BlockPawn = { id: 9, x: 0.99, y: 0, z: 0, radius: 0.5 };
  assert.equal(pickRespawnSpawn([first, third], { ...base, aabbs: [], pawns: [inside] }), third);
});

test("a pawn hit subtracts 25, a repeated seq does not, and a dead pawn cannot fire", () => {
  const { world, shooter, victim } = pawnWorld();
  const health = createPawnHealth();
  health.note(shooter);
  health.note(victim);
  const rig = hostFire(world, health, (clientId) => (clientId === 1 ? shooter : victim));
  const before = positions(world);
  const kinds: string[] = [];
  const enqueue = world.enqueue.bind(world);
  world.enqueue = ((cmd: { kind: string }) => {
    kinds.push(cmd.kind);
    enqueue(cmd);
  }) as typeof world.enqueue;
  rig.fire.onFrame(1, { t: "fire", v: 1, seq: 1, yaw: 0, pitch: 0 });
  rig.advance(FIRE_INTERVAL_MS + 10);
  rig.fire.onFrame(1, { t: "fire", v: 1, seq: 1, yaw: 0, pitch: 0 });
  assert.equal(health.get(victim).hp, 75);
  assert.equal(health.get(shooter).hp, MAX_HP);
  assert.equal(health.get(victim).dead, false);
  assert.equal(rig.lasers.length, 2);
  assert.ok(rig.healthFrames.some((frame) => frame.entity === victim && frame.hp === 75 && frame.dead === false));
  for (const seq of [2, 3, 4]) {
    rig.advance(FIRE_INTERVAL_MS + 10);
    rig.fire.onFrame(1, { t: "fire", v: 1, seq, yaw: 0, pitch: 0 });
  }
  assert.deepEqual(health.get(victim), { hp: 0, dead: true });
  assert.equal(health.get(shooter).hp, MAX_HP);
  const frames = rig.healthFrames.length;
  rig.advance(FIRE_INTERVAL_MS + 10);
  rig.fire.onFrame(1, { t: "fire", v: 1, seq: 5, yaw: 0, pitch: 0 });
  assert.equal(health.get(victim).hp, 0);
  assert.equal(rig.healthFrames.length, frames);
  const lasers = rig.lasers.length;
  rig.advance(FIRE_INTERVAL_MS + 10);
  rig.fire.onFrame(2, { t: "fire", v: 1, seq: 1, yaw: Math.PI, pitch: 0 });
  assert.equal(rig.lasers.length, lasers);
  assert.equal(health.get(shooter).hp, MAX_HP);
  assert.equal(health.isDead(victim), true);
  assert.deepEqual(positions(world), before);
  assert.deepEqual(kinds, []);
  assert.equal(Object.prototype.hasOwnProperty.call(world.store.view(victim), "health"), false);
  for (const frame of rig.healthFrames) {
    assert.ok(frame.hp >= MIN_HP && frame.hp <= MAX_HP);
    assert.equal(frame.t, "health");
  }
});

test("a hit on obstacle 188 does not damage a pawn", () => {
  const { world, shooter, victim } = pawnWorld();
  world.addObstacle({ id: 188, minX: -1, maxX: 1, minY: 0, maxY: 2, minZ: 3, maxZ: 4 });
  const health = createPawnHealth();
  health.note(shooter);
  health.note(victim);
  const rig = hostFire(world, health, () => shooter);
  const before = positions(world);
  const logs: string[] = [];
  const previous = console.log;
  console.log = (line?: unknown, ...rest: unknown[]) => {
    logs.push([line, ...rest].map((part) => String(part)).join(" "));
  };
  try {
    rig.fire.onFrame(1, { t: "fire", v: 1, seq: 1, yaw: 0, pitch: 0 });
  } finally {
    console.log = previous;
  }
  assert.match(logs[0] ?? "", /hit=188/);
  assert.equal(health.get(shooter).hp, MAX_HP);
  assert.equal(health.get(victim).hp, MAX_HP);
  assert.equal(rig.healthFrames.length, 0);
  assert.equal(rig.lasers.length, 2);
  assert.deepEqual(positions(world), before);
  assert.equal(Object.prototype.hasOwnProperty.call(world.store.view(shooter), "health"), false);
});

test("the baked obstacle 188 does not damage the shooter", () => {
  const loaded = loadArena();
  const box = loaded.world.listObstacles().find((obstacle) => obstacle.id === 188);
  assert.ok(box, "obstacle 188 is missing");
  const shot = shotInto(box, loaded.world.listObstacles());
  assert.ok(shot, "no clear ray into obstacle 188");
  const shooter = loaded.agents[0]!.id;
  loaded.world.enqueue({
    kind: "setTransform",
    entity: shooter,
    position: { x: shot.x, y: 0, z: shot.z },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    scale: { x: 1, y: 1, z: 1 },
  });
  loaded.world.commit(1n);
  const health = createPawnHealth();
  for (const agent of loaded.agents) health.note(agent.id);
  const rig = hostFire(loaded.world, health, () => shooter);
  const stood = position(loaded.world, shooter);
  const logs: string[] = [];
  const previous = console.log;
  console.log = (line?: unknown, ...rest: unknown[]) => {
    logs.push([line, ...rest].map((part) => String(part)).join(" "));
  };
  try {
    rig.fire.onFrame(1, { t: "fire", v: 1, seq: 1, yaw: shot.yaw, pitch: 0 });
  } finally {
    console.log = previous;
  }
  assert.match(logs[0] ?? "", /hit=188/);
  for (const agent of loaded.agents) assert.equal(health.get(agent.id).hp, MAX_HP);
  assert.equal(rig.healthFrames.length, 0);
  assert.deepEqual(position(loaded.world, shooter), stood);
});

test("fall plays once and does not loop", () => {
  const names = ["idle", "walk", "run", "fall", "angry"] as const;
  const clips = names.map((name) => new THREE.AnimationClip(name, 0.2, [
    new THREE.QuaternionKeyframeTrack(".quaternion", [0, 0.2], [0, 0, 0, 1, 0, 0, 0, 1]),
  ]));
  const animations = {
    idle: { clip: "idle", speed: 0 },
    walk: { clip: "walk", speed: 1 },
    run: { clip: "run", speed: 2 },
    fall: { clip: "fall", speed: 0 },
    angry: { clip: "angry", speed: 0 },
  };
  const templates: CharacterTemplates = new Map([
    ["pawn", { object: new THREE.Group(), clips, animations }],
  ]);
  const pawns = createPawnLayer(new THREE.Group(), templates, 1.8);
  const snap = (movement: string) => ({
    frame: 1,
    serverTick: 1n,
    snapshotSeq: 1,
    entities: [{
      id: 1,
      render: { assetKey: "pawn" },
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 1, y: 1, z: 1 },
      clip: movement,
      speed: 0,
      visible: true,
      lifecycle: "alive" as const,
      predicted: false,
    }],
  });
  pawns.apply(snap("fall"), 0.016, () => undefined);
  let report = animReport();
  assert.equal(report[0]?.movement, "fall");
  assert.equal(report[0]?.loop, THREE.LoopOnce);
  assert.equal(report[0]?.clamp, true);
  assert.equal(report[0]?.running, true);
  for (let i = 0; i < 30; i++) pawns.apply(snap("fall"), 0.05, () => undefined);
  report = animReport();
  assert.equal(report[0]?.movement, "fall");
  assert.equal(report[0]?.running, false);
  pawns.apply(snap("walk"), 0.016, () => undefined);
  for (let i = 0; i < 30; i++) pawns.apply(snap("walk"), 0.05, () => undefined);
  report = animReport();
  assert.equal(report[0]?.movement, "walk");
  assert.equal(report[0]?.loop, THREE.LoopRepeat);
  assert.equal(report[0]?.clamp, false);
  assert.equal(report[0]?.running, true);
});

test("two clients: a kill stops movement and respawn returns full health on a spawn", { timeout: 20_000 }, async () => {
  const host = await startArenaServer(0);
  let a: LiveClient | undefined;
  let b: LiveClient | undefined;
  try {
    const view = await (await fetch(host.url + "/arena.json")).json() as {
      world: string;
      bundleId: string;
      authoritativeHash: string;
      pawnRadius: number;
      pawnHeight: number;
      aabbs: TraceAabb[];
    };
    const spawns = JSON.parse(readFileSync(fileURLToPath(new URL("../web/game/spawn-points.json", import.meta.url)), "utf8")) as Array<{ x: number; y: number; z: number }>;
    a = openClient(host.url, view);
    b = openClient(host.url, view);
    const aw = await a.welcome;
    const bw = await b.welcome;
    assert.notEqual(aw.ownedEntityId, bw.ownedEntityId);
    await waitFor(2000, () => (a!.poses.has(aw.ownedEntityId) && b!.poses.has(bw.ownedEntityId) ? true : undefined));
    const origin = b.poses.get(bw.ownedEntityId)!;
    await holdMove(b.ws, bw.ownedEntityId, 0, 1, 0, 700);
    await holdMove(b.ws, bw.ownedEntityId, 0, 0, 0, 200);
    const walked = b.poses.get(bw.ownedEntityId)!;
    assert.ok(poseDistance(walked, origin) > 1.2, `never left spawn (${poseDistance(walked, origin).toFixed(2)})`);
    assert.ok(nearestSpawn(walked, spawns) > 1, `still on a spawn (${nearestSpawn(walked, spawns).toFixed(2)})`);
    const aim = await waitFor(2000, () => aimAtVictim(a!, aw.ownedEntityId, bw.ownedEntityId, view));
    a.ws.send(JSON.stringify({ t: "fire", v: 1, seq: 1, yaw: aim.yaw, pitch: aim.pitch }));
    await waitFor(2000, () => (b!.health.get(bw.ownedEntityId)?.hp === 75 ? true : undefined));
    a.ws.send(JSON.stringify({ t: "fire", v: 1, seq: 1, yaw: aim.yaw, pitch: aim.pitch }));
    await delay(FIRE_INTERVAL_MS + 40);
    assert.equal(b.health.get(bw.ownedEntityId)?.hp, 75);
    for (const seq of [2, 3, 4]) {
      await delay(FIRE_INTERVAL_MS + 40);
      const again = aimAtVictim(a, aw.ownedEntityId, bw.ownedEntityId, view) ?? aim;
      a.ws.send(JSON.stringify({ t: "fire", v: 1, seq, yaw: again.yaw, pitch: again.pitch }));
    }
    await waitFor(2000, () => (b.health.get(bw.ownedEntityId)?.hp === 0 ? true : undefined));
    assert.equal(b.health.get(bw.ownedEntityId)?.dead, true);
    await waitFor(1500, () => (a!.poses.get(bw.ownedEntityId)?.clip === "fall" ? true : undefined));
    const death = b.poses.get(bw.ownedEntityId)!;
    assert.ok(a.poses.has(bw.ownedEntityId));
    const lasers = a.lasers.filter((laser) => laser.shooter === bw.ownedEntityId).length;
    b.ws.send(JSON.stringify({ t: "fire", v: 1, seq: 1, yaw: aim.yaw + Math.PI, pitch: 0 }));
    await holdMove(b.ws, bw.ownedEntityId, 0, 1, 0, 500);
    const held = b.poses.get(bw.ownedEntityId)!;
    assert.ok(poseDistance(held, death) < 0.75, `dead pawn moved ${poseDistance(held, death).toFixed(2)}`);
    assert.equal(a.lasers.filter((laser) => laser.shooter === bw.ownedEntityId).length, lasers);
    assert.equal(a.health.get(aw.ownedEntityId)?.hp ?? MAX_HP, MAX_HP);
    assert.equal(b.health.get(bw.ownedEntityId)?.hp, 0);
    assert.ok(a.poses.has(bw.ownedEntityId));
    await holdMove(b.ws, bw.ownedEntityId, 0, 0, 0, 100);
    const back = await waitFor(5000, () => {
      const hp = b!.health.get(bw.ownedEntityId);
      const pose = b!.poses.get(bw.ownedEntityId);
      if (!hp || !pose || hp.hp !== MAX_HP || hp.dead) return undefined;
      if (nearestSpawn(pose, spawns) > 1.25) return undefined;
      return pose;
    });
    assert.ok(poseDistance(back, death) > 0.8, `respawn stayed at the body (${poseDistance(back, death).toFixed(2)})`);
    assert.ok(a.poses.has(bw.ownedEntityId));
    const steps = hpSteps(b.changes, bw.ownedEntityId);
    assert.deepEqual(steps, [MAX_HP, 75, 50, 25, 0, MAX_HP]);
    for (const row of b.changes) assert.ok(row.hp >= MIN_HP && row.hp <= MAX_HP);
    for (const row of a.changes) assert.ok(row.hp >= MIN_HP && row.hp <= MAX_HP);
  } finally {
    a?.ws.close();
    b?.ws.close();
    await host.close();
  }
});

type AnimRow = { movement?: string; running?: boolean; loop?: number; clamp?: boolean };

function animReport(): AnimRow[] {
  return (globalThis as { __pawnAnim?: AnimRow[] }).__pawnAnim ?? [];
}

function shotInto(
  box: { minX: number; maxX: number; minZ: number; maxZ: number },
  obstacles: readonly TraceAabb[],
): { x: number; z: number; yaw: number } | undefined {
  for (let i = 0; i <= 8; i++) {
    const u = box.minX + (box.maxX - box.minX) * (i / 8);
    const v = box.minZ + (box.maxZ - box.minZ) * (i / 8);
    const tries = [
      { x: box.maxX + 1.5, z: v, yaw: -Math.PI / 2 },
      { x: box.minX - 1.5, z: v, yaw: Math.PI / 2 },
      { x: u, z: box.maxZ + 1.5, yaw: Math.PI },
      { x: u, z: box.minZ - 1.5, yaw: 0 },
    ];
    for (const aim of tries) {
      const shot = traceHitscan({ x: aim.x, y: EYE_HEIGHT, z: aim.z }, aimDirection(aim.yaw, 0), obstacles, []);
      if (shot.hitId === 188) return aim;
    }
  }
  return undefined;
}

function pawnWorld() {
  const world = new AuthoritativeWorld({ worldVersion: "health-test" });
  world.pawnHeight = 1.8;
  const shooter = world.createEntity(0n, { type: "pawn", shape: "capsule" }, 1);
  const victim = world.createEntity(0n, { type: "pawn", shape: "capsule" }, 2);
  const place = (id: number, x: number, z: number) => {
    world.enqueue({
      kind: "setTransform",
      entity: id,
      position: { x, y: 0, z },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 1, y: 1, z: 1 },
    });
    world.enqueue({ kind: "setBounds", entity: id, radius: 0.5 });
  };
  place(shooter, 0, 0);
  place(victim, 0, 6);
  world.commit(0n);
  return { world, shooter, victim };
}

function hostFire(world: AuthoritativeWorld, health: PawnHealth, ownedOf: (clientId: number) => number) {
  const lasers: Array<{ shooter: number }> = [];
  const healthFrames: HealthFrame[] = [];
  let nowMs = 0;
  const ids = new Set<number>();
  for (const entity of world.query()) ids.add(entity.id);
  const fire = createArenaFire({
    world,
    health,
    now: () => nowMs,
    server: {
      session: () => ({
        sessionId: 3,
        socket: {
          send(text: string) {
            const frame = JSON.parse(text) as HealthFrame;
            if (frame.t === "health") healthFrames.push(frame);
          },
        },
      }),
      replicator: {
        get: (clientId: number) => ({
          ownedEntity: ownedOf(clientId),
          connected: true,
          known: ids,
        }),
      },
      connected: [1, 2],
    } as never,
    send(_id, frame) {
      lasers.push(frame);
    },
  });
  return {
    fire,
    lasers,
    healthFrames,
    advance(ms: number) {
      nowMs += ms;
    },
  };
}

function position(world: AuthoritativeWorld, id: number) {
  const view = world.store.view(id);
  assert.ok(view);
  return { x: view.position.x, y: view.position.y, z: view.position.z };
}

function positions(world: AuthoritativeWorld) {
  return world.query().map((entity) => ({
    id: entity.id,
    x: entity.position.x,
    y: entity.position.y,
    z: entity.position.z,
  }));
}

type Pose = { x: number; y: number; z: number; clip?: string };
type LaserMsg = { shooter: number };
type HealthRow = { entity: number; hp: number; dead: boolean };

type LiveClient = {
  ws: WebSocket;
  welcome: Promise<{ clientId: number; ownedEntityId: number }>;
  poses: Map<number, Pose>;
  lasers: LaserMsg[];
  health: Map<number, { hp: number; dead: boolean }>;
  changes: HealthRow[];
};

function openClient(url: string, view: { world: string; bundleId: string; authoritativeHash: string }): LiveClient {
  const lasers: LaserMsg[] = [];
  const poses = new Map<number, Pose>();
  const health = new Map<number, { hp: number; dead: boolean }>();
  const changes: HealthRow[] = [];
  const ws = new WebSocket(url.replace(/^http/, "ws"));
  const welcome = new Promise<{ clientId: number; ownedEntityId: number }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no welcome")), 3000);
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data)) as {
        t?: string;
        type?: string;
        reason?: string;
        clientId?: number;
        ownedEntityId?: number;
        envelope?: { seq?: number; spawns?: unknown[]; updates?: unknown[]; despawns?: unknown[] };
        shooter?: number;
        entity?: number;
        hp?: number;
        dead?: boolean;
      };
      if (msg.t === "laser" && msg.shooter !== undefined) {
        lasers.push({ shooter: msg.shooter });
        return;
      }
      if (msg.t === "health" && typeof msg.entity === "number" && typeof msg.hp === "number" && typeof msg.dead === "boolean") {
        const prev = health.get(msg.entity);
        health.set(msg.entity, { hp: msg.hp, dead: msg.dead });
        if (!prev || prev.hp !== msg.hp || prev.dead !== msg.dead) {
          changes.push({ entity: msg.entity, hp: msg.hp, dead: msg.dead });
        }
        return;
      }
      if (msg.type === "reject") {
        clearTimeout(timer);
        reject(new Error(msg.reason ?? "reject"));
      }
      if (msg.type === "welcome") {
        clearTimeout(timer);
        resolve({ clientId: Number(msg.clientId), ownedEntityId: Number(msg.ownedEntityId) });
      }
      if (msg.type === "snapshot" && msg.envelope) {
        absorb(poses, msg.envelope);
        if (typeof msg.envelope.seq === "number" && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ v: 1, type: "ack", snapshotSeq: msg.envelope.seq }));
        }
      }
    });
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({
        v: 1,
        type: "hello",
        protocol: 1,
        world: view.world,
        bundleId: view.bundleId,
        authoritativeHash: view.authoritativeHash,
      }));
    });
  });
  return { ws, welcome, poses, lasers, health, changes };
}

function absorb(poses: Map<number, Pose>, envelope: { spawns?: unknown[]; updates?: unknown[]; despawns?: unknown[] }) {
  const rows = [...(envelope.spawns ?? []), ...(envelope.updates ?? [])] as Array<{
    entity?: number;
    view?: { position?: Pose; clip?: string };
  }>;
  for (const row of rows) {
    const id = Number(row.entity);
    const position = row.view?.position;
    if (!Number.isFinite(id) || !position) continue;
    const prev = poses.get(id);
    poses.set(id, {
      x: position.x,
      y: position.y,
      z: position.z,
      clip: typeof row.view?.clip === "string" ? row.view.clip : prev?.clip,
    });
  }
  for (const row of envelope.despawns ?? []) {
    const id = Number((row as { entity?: number }).entity);
    if (Number.isFinite(id)) poses.delete(id);
  }
}

function aimAtVictim(
  shooter: LiveClient,
  shooterId: number,
  victimId: number,
  view: { pawnRadius: number; pawnHeight: number; aabbs: TraceAabb[] },
): { yaw: number; pitch: number } | undefined {
  const from = shooter.poses.get(shooterId);
  const target = shooter.poses.get(victimId);
  if (!from || !target) return undefined;
  const origin = { x: from.x, y: from.y + EYE_HEIGHT, z: from.z };
  const capsules: TraceCapsule[] = [];
  for (const [id, pose] of shooter.poses) {
    if (id === shooterId) continue;
    capsules.push({ id, x: pose.x, y: pose.y, z: pose.z, radius: view.pawnRadius, height: view.pawnHeight });
  }
  for (const aimY of [0.9, 1.2, 0.4, 1.6]) {
    const dx = target.x - origin.x;
    const dy = target.y + aimY - origin.y;
    const dz = target.z - origin.z;
    const yaw = Math.atan2(dx, dz);
    const pitch = Math.atan2(dy, Math.hypot(dx, dz));
    const shot = traceHitscan(origin, aimDirection(yaw, pitch), view.aabbs, capsules);
    if (shot.hitId === victimId) return { yaw, pitch };
  }
  return undefined;
}

function hpSteps(changes: HealthRow[], entity: number): number[] {
  const out: number[] = [];
  for (const row of changes) {
    if (row.entity !== entity) continue;
    if (out[out.length - 1] !== row.hp) out.push(row.hp);
  }
  return out;
}

function poseDistance(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function nearestSpawn(pose: { x: number; z: number }, spawns: Array<{ x: number; z: number }>): number {
  let best = Number.POSITIVE_INFINITY;
  for (const spawn of spawns) {
    const dist = Math.hypot(pose.x - spawn.x, pose.z - spawn.z);
    if (dist < best) best = dist;
  }
  return best;
}

const inputSeq = new WeakMap<WebSocket, number>();

function holdMove(ws: WebSocket, entity: number, moveX: number, moveZ: number, yaw: number, ms: number): Promise<void> {
  const started = Date.now();
  // The gateway drops seq <= the last one it accepted. A later hold has to continue.
  let seq = inputSeq.get(ws) ?? 1;
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ v: 1, type: "input", seq: seq++, moveX, moveZ, yaw, buttons: 0, entity }));
      }
      if (Date.now() - started >= ms) {
        clearInterval(timer);
        inputSeq.set(ws, seq);
        resolve();
      }
    }, 50);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitFor<T>(ms: number, read: () => T | undefined): Promise<T> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      const value = read();
      if (value !== undefined) {
        clearInterval(timer);
        resolve(value);
      } else if (Date.now() - started > ms) {
        clearInterval(timer);
        reject(new Error("timed out"));
      }
    }, 15);
  });
}
