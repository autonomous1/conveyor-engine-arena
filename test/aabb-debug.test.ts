import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { AABB_DEBUG_COLOR, AABB_DEBUG_MESH_MARGIN, AABB_DEBUG_NAME, AABB_DEBUG_RENDER_ORDER, createAabbDebug, type WorldAabb } from "../src/client/aabb-debug.ts";
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

test("a prop mesh box is drawn slightly outside the obstacle, and a wall run is not", () => {
  const debug = createAabbDebug([
    { mesh: true, min: [-0.3, 0, -0.25], max: [0.3, 0.5, 0.25] },
    { minX: -4, maxX: 4, minZ: 0, maxZ: 1, minY: 0, maxY: 3 },
  ]);
  const [prop, run] = debug.group.children as THREE.LineSegments[];
  const margin = AABB_DEBUG_MESH_MARGIN;
  const propBox = worldBox(prop);
  assertNear(propBox.min.x, -0.3 - margin, "prop minX");
  assertNear(propBox.max.x, 0.3 + margin, "prop maxX");
  assertNear(propBox.min.y, 0 - margin, "prop minY");
  assertNear(propBox.max.y, 0.5 + margin, "prop maxY");
  assertNear(propBox.min.z, -0.25 - margin, "prop minZ");
  assertNear(propBox.max.z, 0.25 + margin, "prop maxZ");
  const runBox = worldBox(run);
  assertNear(runBox.min.x, -4, "run minX");
  assertNear(runBox.max.x, 4, "run maxX");
  assertNear(runBox.min.y, 0, "run minY");
  assertNear(runBox.max.y, 3, "run maxY");
  assertNear(runBox.min.z, 0, "run minZ");
  assertNear(runBox.max.z, 1, "run maxZ");
});

test("a box inside a building is hidden by the wall and visible through the gap", () => {
  // Footprint is x −3..3, z −3..3. The debug box is centered inside it.
  // The near wall sits at z ≈ 3 with a gap from x −0.4 to 0.4.
  const inside: WorldAabb = { min: [-1, 0, -1], max: [1, 2, 1] };
  const debug = createAabbDebug([inside]);
  debug.setVisible(true);
  const lines = debug.group.children[0] as THREE.LineSegments;
  const material = lines.material as THREE.LineBasicMaterial;
  assert.equal(Array.isArray(material), false);
  assert.equal(material.depthTest, true);
  assert.equal(material.depthWrite, false);
  assert.equal(material.transparent, true);
  assert.equal(debug.group.renderOrder, AABB_DEBUG_RENDER_ORDER);
  assert.ok(debug.group.renderOrder > 0);
  assert.equal(lines.isLine, true);

  const wallMaterial = new THREE.MeshStandardMaterial({ color: 0x886655 });
  assert.equal(wallMaterial.depthTest, true);
  assert.equal(wallMaterial.depthWrite, true);
  const wall = (x: number) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(2.6, 4, 0.4), wallMaterial);
    mesh.position.set(x, 2, 3);
    mesh.renderOrder = 0;
    return mesh;
  };
  const walls = [wall(-1.7), wall(1.7)];
  const scene = new THREE.Scene();
  scene.add(walls[0], walls[1], debug.group);
  scene.updateMatrixWorld(true);

  const center = new THREE.Vector3(0, 1, 0);
  const footprint = new THREE.Box3(new THREE.Vector3(-3, 0, -3), new THREE.Vector3(3, 4, 3.2));
  assert.ok(footprint.containsPoint(center));
  const drawn = worldBox(lines);
  assertNear(drawn.min.x, -1, "box minX");
  assertNear(drawn.max.x, 1, "box maxX");
  assertNear(drawn.min.y, 0, "box minY");
  assertNear(drawn.max.y, 2, "box maxY");
  assertNear(drawn.min.z, -1, "box minZ");
  assertNear(drawn.max.z, 1, "box maxZ");

  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 40);
  camera.position.set(0, 1.2, 8);
  camera.lookAt(0, 1, 0);
  camera.updateMatrixWorld(true);

  const frontTop = segmentWhere(lines, (a, b) => close(a.y, 2) && close(b.y, 2) && close(a.z, 1) && close(b.z, 1));
  const throughGap = frontTop[0].clone().lerp(frontTop[1], 0.5);
  const behindWall = frontTop[0].clone().lerp(frontTop[1], 0.85);
  assert.ok(Math.abs(throughGap.x) < 0.4, `gap sample x ${throughGap.x}`);
  assert.ok(Math.abs(behindWall.x) > 0.4, `wall sample x ${behindWall.x}`);
  for (const point of [throughGap, behindWall]) {
    const ndc = point.clone().project(camera);
    assert.ok(Math.abs(ndc.x) < 1 && Math.abs(ndc.y) < 1, "sample is inside the camera view");
  }

  assert.equal(fragmentShows(material, debug.group, camera, walls, throughGap), true);
  assert.equal(fragmentShows(material, debug.group, camera, walls, behindWall), false);
});

/** A debug fragment shows when the group is drawn after the scene and the depth test passes. */
function fragmentShows(
  material: THREE.LineBasicMaterial,
  group: THREE.Group,
  camera: THREE.PerspectiveCamera,
  walls: readonly THREE.Object3D[],
  point: THREE.Vector3,
): boolean {
  if (!(group.renderOrder > 0 && material.transparent === true && material.depthWrite === false)) return false;
  if (material.depthTest === false) return true;
  const direction = point.clone().sub(camera.position);
  const reach = direction.length();
  direction.multiplyScalar(1 / reach);
  const raycaster = new THREE.Raycaster(camera.position.clone(), direction, 0, reach - 1e-3);
  return raycaster.intersectObjects(walls, false).length === 0;
}

function close(actual: number, expected: number): boolean {
  return Math.abs(actual - expected) < 1e-6;
}

function segmentWhere(
  mesh: THREE.LineSegments,
  match: (a: THREE.Vector3, b: THREE.Vector3) => boolean,
): [THREE.Vector3, THREE.Vector3] {
  mesh.updateWorldMatrix(true, false);
  const position = mesh.geometry.getAttribute("position");
  for (let i = 0; i < position.count; i += 2) {
    const a = new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld);
    const b = new THREE.Vector3().fromBufferAttribute(position, i + 1).applyMatrix4(mesh.matrixWorld);
    if (match(a, b) || match(b, a)) return [a, b];
  }
  throw new Error("missing edge");
}
