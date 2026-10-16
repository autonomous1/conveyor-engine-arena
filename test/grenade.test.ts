import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import test from "node:test";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { attachPlayInput } from "../src/client/input.ts";
import { createGrenadeProps, GRENADE_DRAW_MS } from "../src/client/grenade.ts";
import { aimDirection, EYE_HEIGHT } from "../src/shared/look.ts";
import { createPawnHealth, HIT_DAMAGE } from "../src/shared/health.ts";
import { sweepSegment, traceHitscan, type TraceAabb, type TraceCapsule } from "../src/shared/hitscan.ts";
import { startArenaServer } from "../dist/server/main.js";
import { loadArena } from "../dist/server/world-loader.js";

// Server and shared modules import siblings as `.js`. Strip-types loads this
// test from source, so those specifiers resolve to the `.ts` files.
register(
  "data:text/javascript," +
    encodeURIComponent(`
      import { existsSync } from "node:fs";
      import { fileURLToPath } from "node:url";
      export async function resolve(specifier, context, nextResolve) {
        const parent = context.parentURL ?? "";
        if ((specifier.startsWith("./") || specifier.startsWith("../")) && specifier.endsWith(".js") && parent.includes("/src/")) {
          const ts = specifier.slice(0, -3) + ".ts";
          if (existsSync(fileURLToPath(new URL(ts, parent)))) return nextResolve(ts, context);
        }
        return nextResolve(specifier, context);
      }
    `),
);

const grenade = await import("../src/shared/grenade.ts");
const { createArenaGrenades } = await import("../src/server/grenade.ts");

const DT = 0.05;

test("a grenade aimed at a wall hits the same face as the laser, then stops on the next hit", () => {
  const wall: TraceAabb = { id: 10, minX: -2, maxX: 2, minY: 0, maxY: 3, minZ: 4, maxZ: 4.4 };
  const floor: TraceAabb = { id: 11, minX: -8, maxX: 8, minY: -0.2, maxY: 0, minZ: -4, maxZ: 8 };
  const origin = { x: 0, y: EYE_HEIGHT, z: 0 };
  const dir = aimDirection(0, 0);
  const laser = traceHitscan(origin, dir, [wall, floor], []);
  assert.equal(laser.hitId, wall.id);
  assert.ok(Math.abs(laser.to.z - wall.minZ) < 1e-4, `laser z ${laser.to.z}`);

  const straight = sweepSegment(origin, { x: origin.x + dir.x * 8, y: origin.y, z: origin.z + dir.z * 8 }, [wall, floor], []);
  assert.equal(straight?.id, laser.hitId);
  assert.ok(straight);
  assert.ok(Math.abs(straight.point.z - laser.to.z) < 1e-4, `sweep z ${straight.point.z}`);
  assert.ok(Math.abs(straight.normal.z + 1) < 1e-6, `normal ${straight.normal.z}`);

  let body = grenade.launchGrenade(1, 7, origin, dir);
  assert.ok(Math.hypot(body.vx, body.vy, body.vz) < 100, "slower than a hitscan crossing");
  assert.equal(body.bounced, false);
  let bounces = 0;
  let stopped: grenade.GrenadeHit | undefined;
  for (let i = 0; i < 80 && !stopped; i++) {
    const before = { x: body.vx, y: body.vy, z: body.vz };
    const step = grenade.stepGrenade(body, DT, [wall, floor], []);
    body = step.body;
    if (step.kind === "fly") {
      assert.ok(step.body.vy < before.y, "gravity pulls Y down");
      continue;
    }
    if (step.kind === "bounce") {
      bounces += 1;
      assert.equal(step.hit.id, laser.hitId);
      assert.ok(Math.abs(step.hit.point.z - laser.to.z) < 1e-3, `contact z ${step.hit.point.z}`);
      assert.ok(step.hit.point.y > wall.minY && step.hit.point.y < wall.maxY);
      const incoming = before.z + 0 * grenade.GRENADE_GRAVITY;
      assert.ok(step.body.vz < 0, `bounce keeps going forward ${step.body.vz}`);
      assert.ok(Math.abs(step.body.vz) < Math.abs(incoming) - 1, `restitution ${step.body.vz} from ${incoming}`);
      assert.ok(Math.abs(step.body.z - (step.hit.point.z + step.hit.normal.z * grenade.GRENADE_SKIN)) < 1e-6);
      continue;
    }
    stopped = step.hit;
  }
  assert.equal(bounces, 1);
  assert.ok(stopped);
  assert.equal(stopped.pawn, false);
  assert.equal(stopped.id, floor.id);
  assert.notEqual(stopped.id, laser.hitId);
});

test("two grenades in flight pass through each other", () => {
  const a0 = grenade.launchGrenade(1, 1, { x: 0, y: 6, z: 0 }, { x: 1, y: 0, z: 0 });
  const b0 = grenade.launchGrenade(2, 2, { x: 2, y: 6, z: -2 }, { x: 0, y: 0, z: 1 });
  let a = a0;
  let b = b0;
  let crossed = false;
  for (let i = 0; i < 20; i++) {
    const aloneA = grenade.stepGrenade(a, DT, [], []);
    const aloneB = grenade.stepGrenade(b, DT, [], []);
    const withA = grenade.stepGrenade(a, DT, [], []);
    const withB = grenade.stepGrenade(b, DT, [], []);
    assert.equal(aloneA.kind, "fly");
    assert.equal(aloneB.kind, "fly");
    assert.equal(withA.kind, "fly");
    assert.equal(withB.kind, "fly");
    assert.ok(Math.abs(withA.body.x - aloneA.body.x) < 1e-9);
    assert.ok(Math.abs(withB.body.z - aloneB.body.z) < 1e-9);
    a = withA.body;
    b = withB.body;
    if (a.x > 2 && b.z > 0) crossed = true;
  }
  assert.equal(crossed, true);
  assert.equal(a.bounced, false);
  assert.equal(b.bounced, false);
});

test("a pawn hit applies the existing damage and a grenade frame is not a laser", () => {
  const health = createPawnHealth(() => 0);
  health.note(1);
  health.note(2);
  const boxes: TraceAabb[] = [];
  const pawns = [
    { id: 1, position: { x: 0, y: 0, z: 0 }, lifecycle: "alive" as const, radius: 0.5 },
    { id: 2, position: { x: 0, y: 0.7, z: 4 }, lifecycle: "alive" as const, radius: 0.5 },
  ];
  const world = {
    store: { view: (id: number) => pawns.find((pawn) => pawn.id === id) },
    pawnHeight: 1.8,
    listObstacles: () => boxes,
    query: () => pawns,
  };
  const sent: grenade.GrenadePose[] = [];
  let now = 0;
  const host = createArenaGrenades({
    world: world as never,
    server: {
      session: () => ({ sessionId: 1 }),
      replicator: { get: () => ({ ownedEntity: 1, connected: true, known: new Set<number>([1]) }) },
      connected: [1],
    } as never,
    now: () => now,
    health,
    send(_clientId, frame) {
      sent.push(frame);
    },
  });
  host.onFrame(1, { t: "fire", v: 1, seq: 1, yaw: 0, pitch: 0 });
  host.tick();
  assert.equal(sent.length, 0);
  host.onFrame(1, grenade.grenadeFrame(1, 0, 0));
  host.onFrame(1, grenade.grenadeFrame(1, 0, 0));
  const spawned = sent.length;
  assert.equal(spawned, 1);
  assert.equal(sent[0]?.t, "grenade");
  assert.equal(sent[0]?.yaw, 0);
  assert.equal(sent[0]?.stop, undefined);
  now = grenade.GRENADE_INTERVAL_MS - 1;
  host.onFrame(1, grenade.grenadeFrame(2, 0, 0));
  assert.equal(sent.length, spawned);
  let stopped = false;
  for (let i = 0; i < 40 && !stopped; i++) {
    host.tick();
    stopped = sent.some((frame) => frame.stop === true);
  }
  assert.equal(stopped, true);
  assert.equal(sent.every((frame) => frame.t === "grenade"), true);
  assert.equal(health.get(2).hp, 100 - HIT_DAMAGE);
  assert.equal(health.get(1).hp, 100);
});

test("P throws on its own clock and does not fire", () => {
  const rig = installDom();
  const input = attachPlayInput(rig.dom, rig.storage);
  rig.click();
  input.update(1 / 60);
  rig.key("keydown", "KeyP");
  rig.key("keyup", "KeyP");
  const sample = input.sample();
  assert.equal(sample.grenade, true);
  assert.equal(sample.firing, false);
  assert.equal(input.sample().grenade, false);
  assert.equal(input.sample().firing, false);

  rig.key("keydown", "KeyF");
  rig.key("keyup", "KeyF");
  const fired = input.sample();
  assert.equal(fired.firing, true);
  assert.equal(fired.grenade, false);

  const held = installDom();
  const hold = attachPlayInput(held.dom, held.storage);
  held.click();
  hold.update(1 / 60);
  held.key("keydown", "KeyP");
  let nextAt = 0;
  let seq = 0;
  const times: number[] = [];
  for (let i = 0; i < 90; i++) {
    const now = (i * 1000) / 30;
    hold.update(1 / 60);
    held.key("keydown", "KeyP", true);
    const sampled = hold.sample();
    assert.equal(sampled.firing, false);
    const clock = grenade.advanceGrenadeClock(sampled.grenade, now, nextAt);
    nextAt = clock.nextAt;
    if (!clock.due) continue;
    const frame = grenade.grenadeFrame(++seq, sampled.yaw, sampled.pitch);
    assert.deepEqual(grenade.parseGrenade(frame), frame);
    assert.equal(grenade.parseGrenade({ t: "fire", v: 1, seq: 1, yaw: 0, pitch: 0 }), undefined);
    times.push(now);
  }
  assert.equal(times.length, 3);
  assert.equal(times[0], 0);
  assert.ok(times[1]! >= grenade.GRENADE_INTERVAL_MS - 1e-6);
  const gate = grenade.freshGrenadeGate();
  assert.equal(grenade.admitGrenade(gate, 1, 0), "accept");
  assert.equal(grenade.admitGrenade(gate, 1, 5000), "repeat");
  assert.equal(grenade.admitGrenade(gate, 2, grenade.GRENADE_INTERVAL_MS - 1), "fast");
  assert.equal(grenade.admitGrenade(gate, 3, grenade.GRENADE_INTERVAL_MS), "accept");
});

test("the client places the grenade and does not simulate it", async () => {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  scene.add(camera);
  assert.throws(() => createGrenadeProps(camera), /camera/);
  let loaded = false;
  const props = createGrenadeProps(scene, async () => {
    loaded = true;
    const asset = new THREE.Group();
    asset.name = "grenade-asset";
    asset.add(new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.2, 0.1)));
    return asset;
  });
  props.place({ id: 4, x: 1, y: 2, z: 3, yaw: 0 }, 0);
  props.place({ id: 5, x: 0, y: 2, z: 0, yaw: 0 }, 0);
  const group = scene.getObjectByName("grenades");
  assert.ok(group);
  assert.equal(group.children.length, 2);
  assert.equal(camera.children.length, 0);
  const first = group.children[0] as THREE.Object3D;
  const second = group.children[1] as THREE.Object3D;
  props.expire(50);
  assert.ok(Math.abs(first.position.y - 2) < 1e-9, "client gravity moved the grenade");
  assert.ok(Math.abs(second.position.y - 2) < 1e-9);
  props.place({ id: 4, x: 1.5, y: 1.8, z: 3.2, yaw: 1.4 }, 100);
  assert.ok(Math.abs(first.position.x - 1.5) < 1e-9);
  assert.ok(Math.abs(first.position.y - 1.8) < 1e-9);
  assert.equal(first.rotation.y, 0);
  props.place({ id: 4, x: 2, y: 1.2, z: 4, yaw: 1.4, stop: true }, 200);
  assert.ok(Math.abs(first.position.y - 1.2) < 1e-9);
  props.expire(200 + GRENADE_DRAW_MS - 1);
  assert.equal(first.parent, group);
  props.expire(200 + GRENADE_DRAW_MS);
  assert.equal(first.parent, null);
  assert.equal(second.parent, group);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(loaded, true);
  const resting = group.children[0] as THREE.Object3D;
  assert.equal(resting.userData.asset, true);
  assert.ok(Math.abs(resting.position.y - 2) < 1e-9);
  props.drop();
  assert.equal(group.children.length, 0);
});

test("the grenade mesh is the GLB and yaws once to the launch yaw", async () => {
  const template = await loadGrenadeGlb();
  const source = template.getObjectByName("Cylinder") as THREE.Mesh;
  assert.ok(source?.isMesh, "grenade GLB has no Cylinder mesh");
  assert.equal(source.geometry.type, "BufferGeometry");
  assert.equal((source.material as THREE.Material).name, "Material.001");
  const nose = noseVertex(template);
  const noseLocal = new THREE.Vector3().fromBufferAttribute(source.geometry.attributes.position as THREE.BufferAttribute, nose);
  noseLocal.applyMatrix4(source.matrixWorld);
  assert.ok(noseLocal.x > 0.1, "nose is not the measured +X tip");
  assert.ok(Math.abs(noseLocal.y) < 1e-4 && Math.abs(noseLocal.z) < 1e-4);

  const scene = new THREE.Scene();
  let loaded = false;
  const props = createGrenadeProps(scene, async () => {
    loaded = true;
    return template;
  });
  const yaw = 1.15;
  props.place({ id: 1, x: 2, y: 3, z: -4, yaw }, 0);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(loaded, true);
  const root = scene.getObjectByName("grenade") as THREE.Object3D;
  assert.ok(root);
  assert.equal(root.userData.asset, true);
  assert.equal(root.getObjectByName("grenade-fallback"), undefined);
  const drawn = root.getObjectByName("Cylinder") as THREE.Mesh;
  assert.ok(drawn?.isMesh);
  assert.equal(drawn.material, source.material);
  assert.equal(drawn.geometry, source.geometry);
  assert.ok(drawn.quaternion.angleTo(source.quaternion) < 1e-6, "GLB pitch was overwritten");
  assert.equal(root.rotation.y, yaw);
  assert.equal(root.rotation.x, 0);
  assert.equal(root.rotation.z, 0);
  assertNose(root, nose, yaw);

  props.place({ id: 1, x: 2.4, y: 2.2, z: -3.5, yaw: yaw + 1.7 }, 50);
  assert.equal(root.rotation.y, yaw);
  assert.ok(Math.abs(root.position.y - 2.2) < 1e-9);
  assertNose(root, nose, yaw);

  props.place({ id: 2, x: 0, y: 1, z: 0, yaw: Math.PI / 2 }, 50);
  const second = scene.getObjectByName("grenades")!.children[1] as THREE.Object3D;
  assert.equal(second.rotation.y, Math.PI / 2);
  assertNose(second, nose, Math.PI / 2);
});

test("replicated yaw stays the launch yaw after the arc bends", () => {
  const yaw = 1.2;
  const wall: TraceAabb = { id: 10, minX: 4, maxX: 4.4, minY: -1, maxY: 8, minZ: -4, maxZ: 4 };
  const pawns = [
    { id: 1, position: { x: 0, y: 0, z: 0 }, lifecycle: "alive" as const, radius: 0.5 },
  ];
  const world = {
    store: { view: (id: number) => pawns.find((pawn) => pawn.id === id) },
    pawnHeight: 1.8,
    listObstacles: () => [wall],
    query: () => pawns,
  };
  const sent: grenade.GrenadePose[] = [];
  const host = createArenaGrenades({
    world: world as never,
    server: {
      session: () => ({ sessionId: 1 }),
      replicator: { get: () => ({ ownedEntity: 1, connected: true, known: new Set<number>([1]) }) },
      connected: [1],
    } as never,
    now: () => 0,
    send(_clientId, frame) {
      sent.push(frame);
    },
  });
  host.onFrame(1, grenade.grenadeFrame(1, yaw, 0.2));
  for (let i = 0; i < 40; i++) host.tick();
  assert.ok(sent.length > 3);
  assert.equal(grenade.parseGrenadePose({ t: "grenade", id: 1, x: 0, y: 0, z: 0 }), undefined);
  for (const pose of sent) assert.equal(pose.yaw, yaw);
  const xs = sent.map((pose) => pose.x);
  const peak = Math.max(...xs);
  const last = xs[xs.length - 1]!;
  assert.ok(peak > 1, `peak x ${peak}`);
  assert.ok(last < peak - 0.2, `grenade did not come back off the wall (last ${last}, peak ${peak})`);
});

test("grenade code does not use Rapier or a kernel body", () => {
  for (const file of ["src/shared/grenade.ts", "src/server/grenade.ts", "src/client/grenade.ts"]) {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    assert.equal(/rapier/i.test(text), false, file);
    assert.equal(/\benqueue\b|\bsetTransform\b|\bapplyInput\b|\bsetHealth\b/.test(text), false, file);
  }
  const draw = readFileSync(new URL("../src/client/grenade.ts", import.meta.url), "utf8");
  assert.equal(draw.includes("CylinderGeometry"), false);
});

test("the other client sees the grenade travel and P does not send a laser", async () => {
  const host = await startArenaServer(0);
  const opened: ReturnType<typeof openClient>[] = [];
  try {
    const view = await (await fetch(host.url + "/arena.json")).json() as {
      world: string;
      bundleId: string;
      authoritativeHash: string;
      grenade?: string;
      pawnRadius: number;
      pawnHeight: number;
      aabbs: TraceAabb[];
    };
    assert.equal(view.grenade, "/assets/models/grenade-launched.glb");
    // Own every pawn before the throw. A wanderer at 5 m/s can step into a 10 m arc.
    const seats = loadArena().agents.length;
    for (let n = 0; n < seats; n++) opened.push(openClient(host.url, view));
    const welcomes = await Promise.all(opened.map((client) => client.welcome));
    const owned: Array<{ client: ReturnType<typeof openClient>; id: number }> = [];
    for (let i = 0; i < opened.length; i++) {
      const id = welcomes[i]!.ownedEntityId;
      const client = opened[i]!;
      if (!Number.isFinite(id)) {
        client.ws.close();
        continue;
      }
      owned.push({ client, id });
      client.ws.send(JSON.stringify({
        v: 1,
        type: "input",
        seq: 1,
        moveX: 0,
        moveZ: 0,
        yaw: 0,
        buttons: 0,
        entity: id,
      }));
    }
    assert.ok(owned.length >= 2, `owned ${owned.length}`);
    const a = owned[0]!.client;
    const b = owned[1]!.client;
    const shooter = owned[0]!.id;
    assert.notEqual(shooter, owned[1]!.id);
    await waitFor(2000, () => {
      if (a.poses.size < owned.length || !b.poses.get(shooter)) return undefined;
      return a.poses.get(shooter);
    });
    await delay(400);
    const settled = a.poses.get(shooter);
    assert.ok(settled, "shooter pose");
    const origin = { x: settled.x, y: settled.y + EYE_HEIGHT, z: settled.z };
    const others: TraceCapsule[] = [];
    for (const [id, pawn] of a.poses) {
      if (id === shooter) continue;
      others.push({ id, x: pawn.x, y: pawn.y, z: pawn.z, radius: view.pawnRadius, height: view.pawnHeight });
    }
    const aim = sharedWall(origin, view.aabbs, others);
    const before = b.grenades.length;
    assert.equal(a.lasers.length, 0);
    assert.equal(b.lasers.length, 0);
    a.ws.send(JSON.stringify(grenade.grenadeFrame(1, aim.yaw, aim.pitch)));
    a.ws.send(JSON.stringify(grenade.grenadeFrame(1, aim.yaw, aim.pitch)));
    const seen = await waitFor(2500, () => {
      const mine = b.grenades.slice(before);
      if (mine.length < 2) return undefined;
      const id = mine[0]!.id;
      const flight = mine.filter((pose) => pose.id === id);
      let nearest = Number.POSITIVE_INFINITY;
      for (const point of flight) {
        nearest = Math.min(nearest, Math.hypot(point.x - aim.contact.x, point.y - aim.contact.y, point.z - aim.contact.z));
      }
      if (nearest < 0.25) return flight;
      return undefined;
    });
    assert.equal(a.lasers.length, 0);
    assert.equal(b.lasers.length, 0);
    const ids = new Set(b.grenades.slice(before).map((pose) => pose.id));
    assert.equal(ids.size, 1);
    let nearest = Number.POSITIVE_INFINITY;
    for (const point of seen) {
      nearest = Math.min(nearest, Math.hypot(point.x - aim.contact.x, point.y - aim.contact.y, point.z - aim.contact.z));
    }
    assert.ok(nearest < 0.25, `nearest ${nearest} to contact ${aim.contact.x},${aim.contact.y},${aim.contact.z}`);
    assert.ok(seen.every((pose) => Math.abs(pose.yaw - aim.yaw) < 1e-6), "launch yaw changed along the arc");
    assert.equal(a.errors.length, 0);
    assert.equal(b.errors.length, 0);
  } finally {
    for (const client of opened) client.ws.close();
    await host.close();
  }
});

function loadGrenadeGlb(): Promise<THREE.Object3D> {
  const selfHost = globalThis as { self?: unknown };
  selfHost.self ??= globalThis;
  const bytes = readFileSync(new URL("../web/assets/models/grenade-launched.glb", import.meta.url));
  const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const loader = new GLTFLoader();
  return new Promise((resolve, reject) => {
    loader.parse(
      data,
      "",
      (gltf) => resolve(gltf.scene),
      (err) => reject(err instanceof Error ? err : new Error(String(err))),
    );
  });
}

/** Tip vertex of the unyawed GLB. The cue is max world X, not the mount quaternion. */
function noseVertex(template: THREE.Object3D): number {
  template.updateWorldMatrix(true, true);
  const mesh = template.getObjectByName("Cylinder") as THREE.Mesh;
  const pos = mesh.geometry.attributes.position as THREE.BufferAttribute;
  const point = new THREE.Vector3();
  let best = -Infinity;
  let index = 0;
  for (let i = 0; i < pos.count; i++) {
    point.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
    if (point.x > best) {
      best = point.x;
      index = i;
    }
  }
  return index;
}

function assertNose(root: THREE.Object3D, index: number, yaw: number) {
  root.updateWorldMatrix(true, true);
  const mesh = root.getObjectByName("Cylinder") as THREE.Mesh;
  const pos = mesh.geometry.attributes.position as THREE.BufferAttribute;
  const tip = new THREE.Vector3().fromBufferAttribute(pos, index).applyMatrix4(mesh.matrixWorld);
  const offset = tip.sub(root.getWorldPosition(new THREE.Vector3()));
  const aim = aimDirection(yaw, 0);
  const along = offset.x * aim.x + offset.y * aim.y + offset.z * aim.z;
  const len = offset.length();
  assert.ok(len > 0.1, "nose collapsed");
  assert.ok(along / len > 0.99, `nose ${offset.toArray()} off aim ${aim.x},${aim.y},${aim.z}`);
  assert.ok(Math.abs(offset.y) < 1e-4, `pitch followed the arc (${offset.y})`);
}

function sharedWall(
  origin: { x: number; y: number; z: number },
  aabbs: readonly TraceAabb[],
  capsules: readonly TraceCapsule[],
) {
  for (let i = 0; i < 36; i++) {
    const yaw = (i / 36) * Math.PI * 2;
    const dir = aimDirection(yaw, 0);
    const blocks = traceHitscan(origin, dir, aabbs, []);
    const bodies = traceHitscan(origin, dir, aabbs, capsules);
    // The first spawn's walls sit near 10 m. Past 12 m the drop leaves the face band.
    if (blocks.hitId === undefined || blocks.distance < 2 || blocks.distance > 12) continue;
    if (Math.abs(blocks.distance - bodies.distance) > 1e-3) continue;
    const box = aabbs.find((item) => item.id === blocks.hitId);
    if (!box) continue;
    let body = grenade.launchGrenade(1, 0, origin, dir);
    for (let n = 0; n < 40; n++) {
      const step = grenade.stepGrenade(body, DT, aabbs, capsules);
      body = step.body;
      if (step.kind === "fly") continue;
      if (step.hit.pawn || !sameFace(box, blocks.to, step.hit.point)) break;
      return { yaw, pitch: 0, laser: blocks.to, contact: step.hit.point };
    }
  }
  throw new Error("no wall the grenade and the laser share");
}

/** The grenade contact sits on the laser face. A lower cell of that wall still counts. */
function sameFace(
  box: TraceAabb,
  laser: { x: number; y: number; z: number },
  contact: { x: number; y: number; z: number },
): boolean {
  const axes = [
    ["x", box.minX, box.maxX],
    ["y", box.minY, box.maxY],
    ["z", box.minZ, box.maxZ],
  ] as const;
  for (const [axis, min, max] of axes) {
    if (typeof min !== "number" || typeof max !== "number") continue;
    const at = laser[axis];
    if (Math.abs(at - min) > 1e-2 && Math.abs(at - max) > 1e-2) continue;
    if (Math.abs(contact[axis] - at) > 0.05) continue;
    // Gravity drops about a meter over a 10 m throw. A coplanar lower cell still counts.
    const near = (["x", "y", "z"] as const).every((other) => other === axis || Math.abs(contact[other] - laser[other]) < 1.35);
    if (near) return true;
  }
  return false;
}

type Pose = { x: number; y: number; z: number };
type LaserMsg = { shooter: number; from: Pose; to: Pose; until: number };

function openClient(url: string, view: { world: string; bundleId: string; authoritativeHash: string }) {
  const lasers: LaserMsg[] = [];
  const grenades: grenade.GrenadePose[] = [];
  const errors: string[] = [];
  const poses = new Map<number, Pose>();
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
        id?: number;
        x?: number;
        y?: number;
        z?: number;
        stop?: boolean;
        envelope?: { spawns?: unknown[]; updates?: unknown[]; despawns?: unknown[] };
        shooter?: number;
        from?: Pose;
        to?: Pose;
        until?: number;
      };
      const pose = grenade.parseGrenadePose(msg);
      if (pose) {
        grenades.push(pose);
        return;
      }
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
  return { ws, welcome, lasers, grenades, errors, poses };
}

function absorb(poses: Map<number, Pose>, envelope: { spawns?: unknown[]; updates?: unknown[]; despawns?: unknown[] }) {
  const rows = [...(envelope.spawns ?? []), ...(envelope.updates ?? [])] as Array<{ entity?: number; view?: { position?: Pose } }>;
  for (const row of rows) {
    const id = Number(row.entity);
    const position = row.view?.position;
    if (Number.isFinite(id) && position) poses.set(id, { x: position.x, y: position.y, z: position.z });
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

type Listener = (ev: Record<string, unknown>) => void;

function createTarget() {
  const listeners = new Map<string, Set<Listener>>();
  return {
    addEventListener(type: string, fn: Listener) {
      let set = listeners.get(type);
      if (!set) {
        set = new Set();
        listeners.set(type, set);
      }
      set.add(fn);
    },
    removeEventListener(type: string, fn: Listener) {
      listeners.get(type)?.delete(fn);
    },
    dispatch(type: string, ev: Record<string, unknown>) {
      const event = { preventDefault() {}, stopPropagation() {}, repeat: false, button: 0, ...ev };
      for (const fn of [...(listeners.get(type) ?? [])]) fn(event);
    },
  };
}

function installDom() {
  const windowTarget = createTarget();
  const documentTarget = createTarget();
  let pointerLockElement: object | null = null;
  const dom = Object.assign(createTarget(), {
    requestPointerLock() {
      pointerLockElement = dom;
      documentTarget.dispatch("pointerlockchange", {});
      return Promise.resolve();
    },
  });
  const document = {
    addEventListener: documentTarget.addEventListener.bind(documentTarget),
    removeEventListener: documentTarget.removeEventListener.bind(documentTarget),
    get pointerLockElement() {
      return pointerLockElement;
    },
    body: { style: { cursor: "default" } },
  };
  const root = globalThis as { window: unknown; document: unknown };
  root.window = windowTarget;
  root.document = document;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    writable: true,
    value: { getGamepads: () => [] },
  });
  const values = new Map<string, string>();
  return {
    dom: dom as unknown as HTMLElement,
    storage: {
      getItem(key: string) {
        return values.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        values.set(key, value);
      },
    },
    click() {
      dom.dispatch("mousedown", { button: 0 });
    },
    key(type: "keydown" | "keyup", code: string, repeat = false) {
      windowTarget.dispatch(type, { code, repeat });
    },
  };
}
