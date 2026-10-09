import assert from "node:assert/strict";
import { test } from "node:test";
import * as THREE from "three";
import { createLaserBeams } from "../src/client/laser.ts";
import { createRateWindow } from "../src/client/rates.ts";
import { formatFireLog, presentShot } from "../src/client/shot-view.ts";
import { createHostSocketPaths } from "../src/server/host-path.ts";
import { aimDirection, EYE_HEIGHT, gamepadFireButton, PITCH_LIMIT } from "../src/shared/look.ts";
import {
  admitFire,
  FIRE_INTERVAL_MS,
  freshFireGate,
  LASER_MS,
  MIN_HIT_DISTANCE,
  parseFire,
  TRACE_RANGE,
  traceHitscan,
  type TraceAabb,
  type TraceCapsule,
} from "../src/shared/hitscan.ts";
import { createArenaFire } from "../dist/server/fire.js";
import { startArenaServer } from "../dist/server/main.js";
import { loadArena } from "../dist/server/world-loader.js";

const CRATE = { minX: -7.858424, maxX: -7.340151, minY: 0, maxY: 0.481728, minZ: 11.883036, maxZ: 12.364764 };
const WALL = { minX: -34.066729, maxX: -30.066729, minY: 0, maxY: 14.5, minZ: -41.21908, maxZ: -40.65492 };

test("a repeated seq is ignored and a faster repeat is dropped", () => {
  const gate = freshFireGate();
  assert.equal(admitFire(gate, 1, 0), "accept");
  assert.equal(admitFire(gate, 1, 0), "repeat");
  assert.equal(admitFire(gate, 1, 500), "repeat");
  assert.equal(admitFire(gate, 2, FIRE_INTERVAL_MS - 1), "fast");
  assert.equal(admitFire(gate, 2, FIRE_INTERVAL_MS + 10), "repeat");
  assert.equal(admitFire(gate, 3, FIRE_INTERVAL_MS), "accept");
  assert.equal(parseFire({ v: 1, type: "input", seq: 1, yaw: 0, pitch: 0 }), undefined);
  const fire = parseFire({ t: "fire", v: 1, seq: 4, yaw: 0.25, pitch: 4 });
  assert.equal(fire?.seq, 4);
  assert.equal(fire?.yaw, 0.25);
  assert.equal(fire?.pitch, 4);
  assert.equal(gamepadFireButton("standard"), undefined);
  assert.equal(gamepadFireButton("jumper-t"), undefined);
});

test("aim direction is the camera direction through the crosshair", () => {
  const pawn = { x: 2, y: 0, z: -3 };
  const yaw = 0.4;
  const pitch = -0.25;
  const aim = { position: { x: pawn.x, y: pawn.y + EYE_HEIGHT, z: pawn.z } };
  const dir = aimDirection(yaw, pitch);
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(aim.position.x, aim.position.y, aim.position.z);
  camera.up.set(0, 1, 0);
  camera.lookAt(aim.position.x + dir.x, aim.position.y + dir.y, aim.position.z + dir.z);
  const world = new THREE.Vector3();
  camera.getWorldDirection(world);
  const along = world.x * dir.x + world.y * dir.y + world.z * dir.z;
  assert.ok(along > 0.999, `camera diverges from aim (${along})`);
  assert.ok(Math.abs(aimDirection(0, 0).z - 1) < 1e-12);
  assert.ok(aimDirection(Math.PI / 2, 0).x > 0.999);
  assert.ok(aimDirection(0, 0.5).y > 0);
});

test("a pawn capsule stops the ray, and the first hit wins", () => {
  const origin = { x: 0, y: 1, z: 0 };
  const dir = { x: 0, y: 0, z: 1 };
  const cap: TraceCapsule = { id: 2, x: 0, y: 0, z: 6, radius: 0.5, height: 1.8 };
  const body = traceHitscan(origin, dir, [], [cap]);
  assert.equal(body.hitId, 2);
  assert.ok(Math.abs(body.to.z - 5.5) < 1e-6, `body ${body.to.z}`);
  const head = traceHitscan({ x: 0, y: 1.6, z: 0 }, dir, [], [{ id: 3, x: 0, y: 0, z: 5, radius: 0.5, height: 1.8 }]);
  assert.equal(head.hitId, 3);
  assert.ok(Math.abs(head.to.z - 4.6) < 1e-6, `head ${head.to.z}`);
  const box: TraceAabb = { id: 9, minX: -1, maxX: 1, minY: 0, maxY: 2, minZ: 3, maxZ: 4 };
  const first = traceHitscan(origin, dir, [box], [cap]);
  assert.equal(first.hitId, 9);
  assert.ok(Math.abs(first.to.z - 3) < 1e-6, `box ${first.to.z}`);
  const selfCap: TraceCapsule = { id: 4, x: 0, y: 0, z: 0, radius: 0.5, height: 1.8 };
  const self = traceHitscan({ x: 0, y: EYE_HEIGHT, z: 0 }, dir, [], [selfCap]);
  assert.notEqual(self.hitId, 4);
  assert.ok(self.distance >= MIN_HIT_DISTANCE, `self ${self.distance}`);
  const past = traceHitscan({ x: 0, y: EYE_HEIGHT, z: 0 }, dir, [box], [selfCap]);
  assert.equal(past.hitId, 9);
  assert.ok(past.distance > 1);
  const miss = traceHitscan({ x: 0, y: 40, z: 0 }, { x: 0, y: 1, z: 0 }, [], []);
  assert.equal(miss.hitId, undefined);
  assert.equal(miss.distance, TRACE_RANGE);
  assert.ok(Math.abs(miss.to.y - (40 + TRACE_RANGE)) < 1e-9);
});

test("a trace into a crate stops on the crate", () => {
  const obstacles = loadArena().world.listObstacles();
  const crate = obstacles.find((box) => near(box.minX, CRATE.minX) && near(box.minZ, CRATE.minZ) && near(box.maxY, CRATE.maxY));
  assert.ok(crate, "cover crate is missing from the loaded obstacles");
  const y = ((crate.minY ?? 0) + (crate.maxY ?? 0)) / 2;
  const z = (crate.minZ + crate.maxZ) / 2;
  const origin = { x: crate.minX - 3, y, z };
  const hit = traceHitscan(origin, { x: 1, y: 0, z: 0 }, obstacles, []);
  assert.ok(Math.abs(hit.to.x - crate.minX) < 1e-4, `stopped at x ${hit.to.x}, crate face ${crate.minX}`);
  assert.ok(Math.abs(hit.to.y - y) < 1e-4);
  assert.ok(Math.abs(hit.to.z - z) < 1e-4);
  assert.ok(hit.to.x < crate.maxX);
  assert.ok(hit.distance < TRACE_RANGE);
});

test("a wall stops the ray and a door gap does not", () => {
  const obstacles = loadArena().world.listObstacles();
  const wall = obstacles.find((box) =>
    near(box.minX, WALL.minX) && near(box.maxX, WALL.maxX) && near(box.minZ, WALL.minZ) && near(box.maxZ, WALL.maxZ));
  assert.ok(wall, "wall slab is missing");
  const face = wall.maxZ;
  const midX = (wall.minX + wall.maxX) / 2;
  const originZ = face + 2;
  const dir = { x: 0, y: 0, z: -1 };
  const into = traceHitscan({ x: midX, y: EYE_HEIGHT, z: originZ }, dir, obstacles, []);
  assert.ok(Math.abs(into.to.z - face) < 1e-4, `wall hit z ${into.to.z}`);
  assert.ok(Math.abs(into.distance - 2) < 1e-4);

  const left: TraceAabb = { ...wall, maxX: midX - 0.5 };
  const right: TraceAabb = { ...wall, minX: midX + 0.5 };
  const carved = obstacles.filter((box) => box !== wall).concat([left, right]);
  const gap = traceHitscan({ x: midX, y: EYE_HEIGHT, z: originZ }, dir, carved, []);
  assert.ok(gap.distance > into.distance + 4, `door gap stopped at ${gap.distance}`);
  const jamb = traceHitscan({ x: (wall.minX + left.maxX) / 2, y: EYE_HEIGHT, z: originZ }, dir, carved, []);
  assert.ok(Math.abs(jamb.to.z - face) < 1e-4, `jamb z ${jamb.to.z}`);
});

test("a fire frame stays off the kernel input path", () => {
  const inbound: unknown[] = [];
  const arena: unknown[] = [];
  const socket = createHostSocketPaths({
    writeWire() {},
    onEngineText(text) {
      inbound.push(JSON.parse(text));
    },
    onArenaFrame(frame) {
      arena.push(frame);
    },
  });
  socket.deliverEncoded(JSON.stringify({ t: "fire", v: 1, seq: 3, yaw: 0.2, pitch: -0.1 }));
  assert.equal(inbound.length, 0);
  assert.deepEqual(arena[0], { t: "fire", v: 1, seq: 3, yaw: 0.2, pitch: -0.1 });
  socket.deliverEncoded(JSON.stringify({ v: 1, type: "input", seq: 1, moveX: 0, moveZ: 0, yaw: 0 }));
  assert.equal(inbound.length, 1);
  assert.equal((inbound[0] as { type?: string }).type, "input");
  socket.close();
});

test("the client replaces a shooter's segment and drops it at until", () => {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  scene.add(camera);
  assert.throws(() => createLaserBeams(camera), /camera/);
  const beams = createLaserBeams(scene);
  beams.show(4, { x: 0, y: 1.6, z: 0 }, { x: 0, y: 1.6, z: 3 }, 500);
  const group = scene.getObjectByName("lasers");
  assert.ok(group);
  const line = group.children[0] as THREE.Line;
  const geometry = line.geometry;
  for (let i = 0; i < 30; i++) {
    beams.show(4, { x: 0, y: 1.6, z: 0 }, { x: 1, y: 1.6, z: 4 }, 800);
    beams.expire(500 + i);
  }
  assert.equal(group.children.length, 1);
  assert.equal(group.children[0], line);
  assert.equal(line.geometry, geometry);
  const attr = line.geometry.getAttribute("position") as THREE.BufferAttribute;
  assert.ok(Math.abs(attr.getX(1) - 1) < 1e-6);
  assert.ok(Math.abs(attr.getZ(1) - 4) < 1e-6);
  assert.equal(line.frustumCulled, false);
  assert.equal(line.visible, true);
  let node: THREE.Object3D | null = line;
  while (node) {
    assert.equal((node as { isCamera?: boolean }).isCamera, undefined);
    node = node.parent;
  }
  beams.expire(800);
  assert.equal(line.parent, null);
  assert.equal(group.children.length, 0);
  beams.show(4, { x: 0, y: 1.6, z: 0 }, { x: 2, y: 1.6, z: 5 }, 900);
  assert.equal(group.children.length, 1);
  assert.equal(group.children[0], line);
});

test("fps returns to the pre-fire number after the line expires", () => {
  const scene = new THREE.Scene();
  const beams = createLaserBeams(scene);
  const group = scene.getObjectByName("lasers")!;
  const rates = createRateWindow(500);
  const base = 1000 / 30;
  const extra = base / 2;
  let now = 0;
  const step = () => {
    now += base + group.children.length * extra;
    return rates.push(now);
  };
  let before = step();
  for (let i = 0; i < 40; i++) before = step();
  assert.ok(before.fps !== undefined && Math.abs(before.fps - 30) < 1, `before ${before.fps}`);
  const until = 1e12;
  beams.show(3, { x: 0, y: 1.6, z: 0 }, { x: 4, y: 1.6, z: 0 }, until);
  let during = step();
  for (let i = 0; i < 40; i++) during = step();
  assert.equal(group.children.length, 1);
  assert.ok(during.fps !== undefined && Math.abs(during.fps - 20) < 1, `during ${during.fps}`);
  beams.expire(until);
  assert.equal(group.children.length, 0);
  let after = step();
  for (let i = 0; i < 40; i++) after = step();
  assert.ok(after.fps !== undefined && Math.abs(after.fps - before.fps!) < 1, `after ${after.fps} before ${before.fps}`);
});

test("a shot with no pawn in front keeps pawn count and does not hit the shooter", () => {
  const loaded = loadArena();
  const world = loaded.world;
  const shooter = loaded.agents[0]!.id;
  const pawn = world.store.view(shooter);
  assert.ok(pawn);
  const origin = { x: pawn.position.x, y: pawn.position.y + EYE_HEIGHT, z: pawn.position.z };
  const others: TraceCapsule[] = [];
  for (const entity of world.query()) {
    if (entity.id === shooter) continue;
    others.push({
      id: entity.id,
      x: entity.position.x,
      y: entity.position.y,
      z: entity.position.z,
      radius: entity.radius,
      height: world.pawnHeight,
    });
  }
  const aim = clearAim(origin, world.listObstacles(), others);
  const before = pawnStamp(world);
  const kinds: string[] = [];
  const enqueue = world.enqueue.bind(world);
  world.enqueue = ((cmd: { kind: string }) => {
    kinds.push(cmd.kind);
    enqueue(cmd);
  }) as typeof world.enqueue;
  const logs: string[] = [];
  const previous = console.log;
  console.log = (line?: unknown, ...rest: unknown[]) => {
    logs.push([line, ...rest].map((part) => String(part)).join(" "));
  };
  const lasers: Array<{ shooter: number; from: { y: number }; to: { x: number; y: number; z: number } }> = [];
  try {
    const fire = createArenaFire({
      world,
      server: {
        session: () => ({ sessionId: 7 }),
        replicator: {
          get: () => ({ ownedEntity: shooter, connected: true, known: new Set<number>() }),
        },
        connected: [1],
      } as never,
      now: () => 5000,
      send(_id, frame) {
        lasers.push(frame);
      },
    });
    const frame = { t: "fire" as const, v: 1 as const, seq: 1, yaw: aim.yaw, pitch: aim.pitch };
    fire.onFrame(1, frame);
    fire.onFrame(1, frame);
  } finally {
    console.log = previous;
  }
  assert.deepEqual(pawnStamp(world), before);
  assert.deepEqual(kinds, []);
  assert.equal(before.length, world.query().length);
  assert.equal(lasers.length, 1);
  assert.equal(logs.length, 1);
  const line = logs[0] ?? "";
  assert.match(line, new RegExp(`^shot shooter=${shooter} eye=${origin.x.toFixed(3)},${origin.y.toFixed(3)},${origin.z.toFixed(3)} `));
  const hit = /hit=(\S+)/.exec(line)?.[1];
  const dist = Number(/dist=([0-9.]+)/.exec(line)?.[1]);
  assert.ok(hit, line);
  assert.notEqual(hit, String(shooter));
  assert.equal(before.some((row) => String(row.id) === hit), false);
  assert.ok(dist >= MIN_HIT_DISTANCE, line);
  assert.equal(before.every((row) => row.health === null && row.lifecycle === "alive"), true);
});

test("a second client receives the laser and the segment matches the host hit", async () => {
  const host = await startArenaServer(0);
  let a: ReturnType<typeof openClient> | undefined;
  let b: ReturnType<typeof openClient> | undefined;
  try {
    const view = await (await fetch(host.url + "/arena.json")).json() as {
      world: string;
      bundleId: string;
      authoritativeHash: string;
      pawnRadius: number;
      pawnHeight: number;
      aabbs: TraceAabb[];
    };
    a = openClient(host.url, view);
    const aw = await a.welcome;
    b = openClient(host.url, view);
    const bw = await b.welcome;
    assert.notEqual(aw.ownedEntityId, bw.ownedEntityId);
    const pose = await waitFor(2000, () => {
      const self = a.poses.get(aw.ownedEntityId);
      const seen = b.poses.get(aw.ownedEntityId);
      if (!self || !seen) return undefined;
      return self;
    });
    const origin = { x: pose.x, y: pose.y + EYE_HEIGHT, z: pose.z };
    const others: TraceCapsule[] = [];
    for (const [id, pawn] of a.poses) {
      if (id === aw.ownedEntityId) continue;
      others.push({ x: pawn.x, y: pawn.y, z: pawn.z, radius: view.pawnRadius, height: view.pawnHeight });
    }
    const aim = clearAim(origin, view.aabbs, others);
    const started = Date.now();
    const send = (seq: number) => {
      a.ws.send(JSON.stringify({ t: "fire", v: 1, seq, yaw: aim.yaw, pitch: aim.pitch }));
    };
    send(1);
    send(1);
    send(2);
    const first = await waitFor(2000, () => b.lasers[0]);
    await delay(40);
    assert.equal(b.lasers.length, 1, "repeated or fast seq produced another laser");
    assert.equal(a.lasers.length, 1);
    assert.equal(a.errors.length, 0);
    assert.equal(b.errors.length, 0);
    assert.equal(first.shooter, aw.ownedEntityId);
    assert.ok(first.until >= started + LASER_MS - 30 && first.until <= started + LASER_MS + 40, `until ${first.until - started}`);
    const expected = traceHitscan(origin, aimDirection(aim.yaw, aim.pitch), view.aabbs, others);
    assert.ok(expected.distance > 1, `self hit ${expected.distance}`);
    samePoint(first.from, expected.from);
    samePoint(first.to, expected.to);
    samePoint(a.lasers[0]!.from, first.from);
    samePoint(a.lasers[0]!.to, first.to);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();
    scene.add(camera);
    const drawn = createLaserBeams(scene);
    drawn.show(first.shooter, first.from, first.to, first.until);
    const group = scene.getObjectByName("lasers");
    assert.equal(group?.children.length, 1);
    assert.equal(camera.children.length, 0);
    drawn.show(first.shooter, first.from, first.to, first.until);
    assert.equal(group?.children.length, 1);
    drawn.expire(first.until);
    assert.equal(group?.children.length, 0);
    const left = FIRE_INTERVAL_MS - (Date.now() - started) + 20;
    if (left > 0) await delay(left);
    send(3);
    const second = await waitFor(2000, () => (b.lasers.length >= 2 ? b.lasers[1] : undefined));
    assert.equal(second.shooter, aw.ownedEntityId);
    assert.ok(aim.pitch <= PITCH_LIMIT);
  } finally {
    a?.ws.close();
    b?.ws.close();
    await host.close();
  }
});

test("a shot draws the line or nothing and leaves the pawn where it stood", () => {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(16, 10, 16);
  camera.lookAt(0, 1, 0);
  const pawn = new THREE.Object3D();
  pawn.name = "pawn";
  pawn.position.set(4, 0, -2);
  scene.add(pawn);
  const marker = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  marker.name = "marker";
  marker.position.set(9, 1, 9);
  scene.add(marker);
  const beams = createLaserBeams(scene);
  const stood = pawn.position.clone();
  const from = { x: 4, y: EYE_HEIGHT, z: -2 };
  const to = { x: 4, y: EYE_HEIGHT, z: -2 + TRACE_RANGE };
  let shown = 0;
  const drawn = presentShot({
    camera,
    pawn: { x: pawn.position.x, y: pawn.position.y, z: pawn.position.z },
    yaw: 0,
    pitch: 0,
    from,
    to,
    show(a, b) {
      shown += 1;
      beams.show(1, a, b, 1000);
    },
  });
  assert.equal(drawn.drew, true);
  assert.equal(shown, 1);
  assert.equal(scene.getObjectByName("lasers")?.children.length, 1);
  assert.equal(scene.getObjectByName("marker"), marker);
  assert.ok(pawn.position.distanceTo(stood) < 1e-9);
  assert.ok(Math.abs(camera.position.x - pawn.position.x) < 1e-6);
  assert.ok(Math.abs(camera.position.y - (pawn.position.y + EYE_HEIGHT)) < 1e-6);
  assert.ok(Math.abs(camera.position.z - pawn.position.z) < 1e-6);
  assert.ok(Math.hypot(camera.position.x - to.x, camera.position.y - to.y, camera.position.z - to.z) > 10);
  const worldDir = new THREE.Vector3();
  camera.getWorldDirection(worldDir);
  const aim = aimDirection(0, 0);
  const along = worldDir.x * aim.x + worldDir.y * aim.y + worldDir.z * aim.z;
  assert.ok(along > 0.999, `camera diverges from aim (${along})`);
  assert.match(
    formatFireLog({
      socketClosed: false,
      frameThrew: false,
      camBefore: drawn.camBefore,
      camAfter: drawn.camAfter,
    }),
    /^fire socket=open threw=no camBefore=16\.000,10\.000,16\.000 camAfter=4\.000,1\.600,-2\.000$/,
  );

  const skipped = presentShot({
    camera,
    pawn: { x: pawn.position.x, y: pawn.position.y, z: pawn.position.z },
    yaw: 0,
    pitch: 0,
    from,
    to: { x: Number.POSITIVE_INFINITY, y: EYE_HEIGHT, z: 0 },
    show() {
      shown += 1;
      throw new Error("non-finite endpoint was drawn");
    },
  });
  assert.equal(skipped.drew, false);
  assert.equal(shown, 1);
  assert.ok(pawn.position.distanceTo(stood) < 1e-9);
  assert.equal(scene.getObjectByName("marker"), marker);
  beams.drop();
  assert.equal(scene.getObjectByName("lasers")?.children.length, 0);
  assert.equal(marker.parent, scene);
  assert.equal(pawn.parent, scene);
  assert.ok(pawn.position.distanceTo(stood) < 1e-9);
  assert.match(
    formatFireLog({
      socketClosed: true,
      frameThrew: true,
      camBefore: { x: 1, y: 2, z: 3 },
      camAfter: { x: 4, y: 5, z: 6 },
    }),
    /^fire socket=closed threw=yes camBefore=1\.000,2\.000,3\.000 camAfter=4\.000,5\.000,6\.000$/,
  );
});

test("one fire with hit=none keeps the socket and the same pawn", async () => {
  const host = await startArenaServer(0);
  let client: ReturnType<typeof openClient> | undefined;
  const logs: string[] = [];
  const previous = console.log;
  console.log = (line?: unknown, ...rest: unknown[]) => {
    logs.push([line, ...rest].map((part) => String(part)).join(" "));
  };
  try {
    const view = await (await fetch(host.url + "/arena.json")).json() as {
      world: string;
      bundleId: string;
      authoritativeHash: string;
      pawnRadius: number;
      pawnHeight: number;
      aabbs: TraceAabb[];
    };
    client = openClient(host.url, view);
    const welcome = await client.welcome;
    const spawn = await waitFor(2000, () => client!.poses.get(welcome.ownedEntityId));
    client.ws.send(JSON.stringify({
      v: 1,
      type: "input",
      seq: 1,
      moveX: 0,
      moveZ: 1,
      yaw: 0,
      buttons: 0,
      entity: welcome.ownedEntityId,
    }));
    const walked = await waitFor(2500, () => {
      const pose = client!.poses.get(welcome.ownedEntityId);
      if (!pose || poseDistance(pose, spawn) <= 3) return undefined;
      return pose;
    });
    client.ws.send(JSON.stringify({
      v: 1,
      type: "input",
      seq: 2,
      moveX: 0,
      moveZ: 0,
      yaw: 0,
      buttons: 0,
      entity: welcome.ownedEntityId,
    }));
    await delay(200);
    const before = client.poses.get(welcome.ownedEntityId) ?? walked;
    assert.ok(poseDistance(before, spawn) > 3, `never left spawn (${poseDistance(before, spawn)})`);
    const origin = { x: before.x, y: before.y + EYE_HEIGHT, z: before.z };
    const others: TraceCapsule[] = [];
    for (const [id, pawn] of client.poses) {
      if (id === welcome.ownedEntityId) continue;
      others.push({ id, x: pawn.x, y: pawn.y, z: pawn.z, radius: view.pawnRadius, height: view.pawnHeight });
    }
    const aim = missAim(origin, view.aabbs, others);
    const mark = logs.length;
    client.ws.send(JSON.stringify({ t: "fire", v: 1, seq: 1, yaw: aim.yaw, pitch: aim.pitch }));
    const laser = await waitFor(2000, () => client!.lasers[0]);
    await delay(300);
    const after = client.poses.get(welcome.ownedEntityId);
    assert.ok(after, "owned pawn left the snapshot");
    const shot = logs.slice(mark).find((line) => line.startsWith("shot "));
    assert.ok(shot, `no shot log (${logs.slice(mark).join(" | ")})`);
    assert.match(shot, new RegExp(`^shot shooter=${welcome.ownedEntityId} `));
    assert.match(shot, /hit=none/);
    assert.equal(client.welcomes.length, 1);
    assert.equal(client.welcomes[0], welcome.ownedEntityId);
    assert.equal(client.closeCount(), 0);
    assert.equal(client.ws.readyState, WebSocket.OPEN);
    assert.equal(client.errors.length, 0);
    assert.equal(laser.shooter, welcome.ownedEntityId);
    assert.ok(Number.isFinite(laser.to.x) && Number.isFinite(laser.to.y) && Number.isFinite(laser.to.z));
    assert.ok(Math.abs(poseDistance(laser.from, laser.to) - TRACE_RANGE) < 1e-3, `range ${poseDistance(laser.from, laser.to)}`);
    assert.ok(poseDistance(after, before) < 2.5, `jumped ${poseDistance(after, before)}`);
    assert.ok(poseDistance(after, spawn) > 2, `back at spawn (${poseDistance(after, spawn)})`);
    assert.ok(poseDistance(after, laser.to) > 1, `pawn moved to the laser end`);
    const camera = new THREE.PerspectiveCamera();
    const pawn = new THREE.Object3D();
    pawn.position.set(after.x, after.y, after.z);
    const stood = pawn.position.clone();
    const presented = presentShot({
      camera,
      pawn: { x: after.x, y: after.y, z: after.z },
      yaw: aim.yaw,
      pitch: aim.pitch,
      from: laser.from,
      to: laser.to,
      show() {},
    });
    assert.equal(presented.drew, true);
    assert.ok(Math.abs(camera.position.x - after.x) < 1e-6);
    assert.ok(Math.abs(camera.position.y - (after.y + EYE_HEIGHT)) < 1e-6);
    assert.ok(Math.abs(camera.position.z - after.z) < 1e-6);
    assert.ok(pawn.position.distanceTo(stood) < 1e-9);
  } finally {
    console.log = previous;
    client?.ws.close();
    await host.close();
  }
});

function pawnStamp(world: { query: () => ReadonlyArray<{ id: number; lifecycle: string; position: { x: number; y: number; z: number } }> }) {
  return world.query().map((entity) => ({
    id: entity.id,
    lifecycle: entity.lifecycle,
    health: Object.prototype.hasOwnProperty.call(entity, "health") ? (entity as { health?: unknown }).health : null,
    x: entity.position.x,
    y: entity.position.y,
    z: entity.position.z,
  }));
}

function near(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-3;
}

function samePoint(actual: { x: number; y: number; z: number }, expected: { x: number; y: number; z: number }) {
  assert.ok(Math.abs(actual.x - expected.x) < 1e-4, `x ${actual.x} vs ${expected.x}`);
  assert.ok(Math.abs(actual.y - expected.y) < 1e-4, `y ${actual.y} vs ${expected.y}`);
  assert.ok(Math.abs(actual.z - expected.z) < 1e-4, `z ${actual.z} vs ${expected.z}`);
}

function missAim(origin: { x: number; y: number; z: number }, aabbs: readonly TraceAabb[], capsules: readonly TraceCapsule[]) {
  for (const pitch of [1.2, 1.0, 0.7, 0.3, 0, -0.4]) {
    for (let i = 0; i < 36; i++) {
      const yaw = (i / 36) * Math.PI * 2;
      const shot = traceHitscan(origin, aimDirection(yaw, pitch), aabbs, capsules);
      if (shot.hitId === undefined && shot.distance >= TRACE_RANGE - 1e-3) return { yaw, pitch };
    }
  }
  throw new Error("no miss");
}

function poseDistance(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function clearAim(origin: { x: number; y: number; z: number }, aabbs: readonly TraceAabb[], capsules: readonly TraceCapsule[]) {
  for (const pitch of [1.2, 1.0, 0.6, 0.2, 0]) {
    for (let i = 0; i < 24; i++) {
      const yaw = (i / 24) * Math.PI * 2;
      const dir = aimDirection(yaw, pitch);
      const blocks = traceHitscan(origin, dir, aabbs, []);
      const bodies = traceHitscan(origin, dir, aabbs, capsules);
      if (Math.abs(blocks.distance - bodies.distance) < 1e-3 && blocks.distance > 1) return { yaw, pitch };
    }
  }
  throw new Error("no aim clear of pawns");
}

type Pose = { x: number; y: number; z: number };
type LaserMsg = { shooter: number; from: Pose; to: Pose; until: number };

function openClient(url: string, view: { world: string; bundleId: string; authoritativeHash: string }) {
  const lasers: LaserMsg[] = [];
  const errors: string[] = [];
  const welcomes: number[] = [];
  const poses = new Map<number, Pose>();
  let closes = 0;
  const ws = new WebSocket(url.replace(/^http/, "ws"));
  ws.addEventListener("close", () => {
    closes += 1;
  });
  const welcome = new Promise<{ clientId: number; ownedEntityId: number }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no welcome")), 3000);
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data)) as {
        t?: string;
        type?: string;
        reason?: string;
        clientId?: number;
        ownedEntityId?: number;
        envelope?: { spawns?: unknown[]; updates?: unknown[]; despawns?: unknown[] };
        shooter?: number;
        from?: Pose;
        to?: Pose;
        until?: number;
      };
      if (msg.t === "laser" && msg.from && msg.to && msg.shooter !== undefined && msg.until !== undefined) {
        lasers.push({ shooter: msg.shooter, from: msg.from, to: msg.to, until: msg.until });
        return;
      }
      if (msg.type === "error") errors.push(String(msg.reason ?? ""));
      if (msg.type === "reject") {
        clearTimeout(timer);
        reject(new Error(msg.reason ?? "reject"));
      }
      if (msg.type === "welcome") {
        welcomes.push(Number(msg.ownedEntityId));
        clearTimeout(timer);
        resolve({ clientId: Number(msg.clientId), ownedEntityId: Number(msg.ownedEntityId) });
      }
      if (msg.type === "snapshot" && msg.envelope) absorb(poses, msg.envelope);
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
  return { ws, welcome, lasers, errors, poses, welcomes, closeCount: () => closes };
}

function absorb(poses: Map<number, Pose>, envelope: { spawns?: unknown[]; updates?: unknown[]; despawns?: unknown[] }) {
  const rows = [...(envelope.spawns ?? []), ...(envelope.updates ?? [])] as Array<{ entity?: number; view?: { position?: Pose } }>;
  for (const row of rows) {
    const id = Number(row.entity);
    const position = row.view?.position;
    if (Number.isFinite(id) && position) poses.set(id, { x: position.x, y: position.y, z: position.z });
  }
  for (const row of envelope.despawns ?? []) {
    const id = Number((row as { entity?: number }).entity);
    if (Number.isFinite(id)) poses.delete(id);
  }
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
