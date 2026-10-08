import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { AABB_DEBUG_COLOR, AABB_DEBUG_NAME, createAabbDebug, type WorldAabb } from "../src/client/aabb-debug.ts";
import {
  SHOW_COLLISION_STORAGE_KEY,
  createOptionsModel,
  loadShowCollision,
  type KeyValueStorage,
} from "../src/client/options.ts";

const fixture: WorldAabb = { min: [-1, 0, -1], max: [1, 3, 1] };

/**
 * WebGLRenderer.projectObject returns immediately when visible is false,
 * so a hidden group adds no draw call and its children are not walked.
 */
function drawCalls(object: THREE.Object3D): number {
  if (object.visible === false) return 0;
  const drawable = object as THREE.Mesh & { isLine?: boolean };
  let calls = drawable.isMesh || drawable.isLine ? 1 : 0;
  for (const child of object.children) calls += drawCalls(child);
  return calls;
}

function colorOf(object: THREE.Object3D): number {
  const material = (object as THREE.LineSegments).material as THREE.LineBasicMaterial;
  if (Array.isArray(material)) throw new Error("expected one material");
  return material.color.getHex();
}

function worldBox(object: THREE.Object3D): THREE.Box3 {
  object.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(object);
}

function assertNear(actual: number, expected: number, label: string) {
  assert.ok(Math.abs(actual - expected) < 1e-6, `${label}: ${actual} expected ${expected}`);
}

function memoryStorage(initial?: string): KeyValueStorage & { getItem(key: string): string | null } {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set(SHOW_COLLISION_STORAGE_KEY, initial);
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

test("a fixture obstacle becomes one wireframe box of that size", () => {
  const debug = createAabbDebug([
    { id: "gap", role: "door-gap", min: [10, 0, 10], max: [12, 2, 11] },
    { id: "leaf", hinge: "left", min: [4, 0, 4], max: [5, 2, 4.1] },
    fixture,
  ]);
  assert.equal(debug.group.name, AABB_DEBUG_NAME);
  assert.equal(debug.group.children.length, 1);
  const mesh = debug.group.children[0] as THREE.LineSegments;
  assert.equal(mesh.parent, debug.group);
  assert.equal(mesh.isLine, true);
  assert.equal(colorOf(mesh), AABB_DEBUG_COLOR);
  const box = worldBox(mesh);
  assertNear(box.min.x, -1, "minX");
  assertNear(box.min.y, 0, "minY");
  assertNear(box.min.z, -1, "minZ");
  assertNear(box.max.x, 1, "maxX");
  assertNear(box.max.y, 3, "maxY");
  assertNear(box.max.z, 1, "maxZ");
  const size = box.getSize(new THREE.Vector3());
  assertNear(size.x, 2, "width");
  assertNear(size.y, 3, "height");
  assertNear(size.z, 2, "depth");
});

test("walls and building runs share one color, and a missing y is 0 to 3", () => {
  const debug = createAabbDebug([
    { id: 10, role: "wall", minX: -2, maxX: 2, minZ: 4, maxZ: 5 },
    { id: "house-wall-0", role: "building", kind: "aabb", min: [0, 1, 0], max: [1, 6, 2] },
  ]);
  assert.equal(debug.group.children.length, 2);
  const [wall, run] = debug.group.children as THREE.LineSegments[];
  assert.equal(colorOf(wall), AABB_DEBUG_COLOR);
  assert.equal(colorOf(run), AABB_DEBUG_COLOR);
  const wallBox = worldBox(wall);
  assertNear(wallBox.min.y, 0, "wall minY");
  assertNear(wallBox.max.y, 3, "wall maxY");
  assertNear(wallBox.min.x, -2, "wall minX");
  assertNear(wallBox.max.z, 5, "wall maxZ");
  const runBox = worldBox(run);
  assertNear(runBox.min.y, 1, "run minY");
  assertNear(runBox.max.y, 6, "run maxY");
});

test("the switch defaults off and adds a draw call only when enabled", () => {
  const scene = new THREE.Scene();
  const room = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  scene.add(room);
  const debug = createAabbDebug([fixture]);
  scene.add(debug.group);
  const seen: boolean[] = [];
  const model = createOptionsModel(memoryStorage(), (on) => {
    seen.push(on);
    debug.setVisible(on);
  });
  assert.deepEqual(seen, [false]);
  assert.equal(model.showCollision, false);
  assert.equal(model.open, false);
  assert.equal(debug.group.visible, false);
  assert.equal(drawCalls(debug.group), 0);
  assert.equal(drawCalls(scene), 1);

  assert.equal(model.onKey("Escape"), false);
  assert.equal(model.onKey("F10"), false);
  assert.equal(model.onKey("KeyW"), false);
  assert.equal(model.open, false);
  assert.equal(drawCalls(scene), 1);

  assert.equal(model.onKey("F2"), true);
  assert.equal(model.open, true);
  assert.equal(debug.group.visible, false);
  assert.equal(drawCalls(scene), 1);

  const mesh = debug.group.children[0] as THREE.Mesh;
  model.toggleShowCollision();
  assert.equal(model.showCollision, true);
  assert.equal(debug.group.visible, true);
  assert.equal(debug.group.children[0], mesh);
  assert.equal(drawCalls(scene), 2);

  model.toggleShowCollision();
  assert.equal(debug.group.visible, false);
  assert.equal(debug.group.children[0], mesh);
  assert.equal(drawCalls(scene), 1);
});

test("rebuild replaces meshes and setVisible does not", () => {
  const debug = createAabbDebug([fixture]);
  const first = debug.group.children[0] as THREE.LineSegments;
  const uuid = first.geometry.uuid;
  debug.setVisible(true);
  assert.equal((debug.group.children[0] as THREE.LineSegments).geometry.uuid, uuid);
  assert.equal(debug.group.visible, true);
  debug.rebuild([{ min: [0, 0, 0], max: [2, 2, 2] }]);
  const next = debug.group.children[0] as THREE.LineSegments;
  assert.notEqual(next.geometry.uuid, uuid);
  assert.equal(debug.group.visible, true);
  assert.equal(debug.group.name, AABB_DEBUG_NAME);
  const box = worldBox(next);
  assertNear(box.max.x - box.min.x, 2, "rebuilt width");
  assertNear(box.max.y - box.min.y, 2, "rebuilt height");
});

test("the debug mesh is not a raycast hit", () => {
  const debug = createAabbDebug([fixture]);
  debug.setVisible(true);
  const mesh = debug.group.children[0] as THREE.LineSegments;
  const control = new THREE.Mesh(new THREE.BoxGeometry(2, 3, 2), new THREE.MeshBasicMaterial());
  control.position.copy(mesh.position);
  control.updateMatrixWorld(true);
  mesh.updateMatrixWorld(true);
  const raycaster = new THREE.Raycaster(new THREE.Vector3(0, 1.5, 5), new THREE.Vector3(0, 0, -1));
  assert.ok(raycaster.intersectObject(control, false).length >= 1);
  assert.equal(raycaster.intersectObject(debug.group, true).length, 0);
});

test("show collision persists only the on value and defaults off", () => {
  assert.equal(loadShowCollision(null), false);
  assert.equal(loadShowCollision(memoryStorage()), false);
  assert.equal(loadShowCollision(memoryStorage("off")), false);
  assert.equal(loadShowCollision(memoryStorage("true")), false);
  assert.equal(loadShowCollision(memoryStorage("on")), true);

  const storage = memoryStorage();
  const first = createOptionsModel(storage, () => {});
  assert.equal(storage.getItem(SHOW_COLLISION_STORAGE_KEY), null);
  first.toggleShowCollision();
  assert.equal(storage.getItem(SHOW_COLLISION_STORAGE_KEY), "on");
  const restored: boolean[] = [];
  createOptionsModel(storage, (on) => restored.push(on));
  assert.deepEqual(restored, [true]);

  const denied: KeyValueStorage = {
    getItem() {
      throw new Error("denied");
    },
    setItem() {
      throw new Error("denied");
    },
  };
  assert.equal(loadShowCollision(denied), false);
  const seen: boolean[] = [];
  const model = createOptionsModel(denied, (on) => seen.push(on));
  model.toggleShowCollision();
  assert.deepEqual(seen, [false, true]);
  assert.equal(model.showCollision, true);
});
