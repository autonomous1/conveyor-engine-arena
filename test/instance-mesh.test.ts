import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import {
  doorSwingRadians,
  placeBuildingModel,
  placeDoorModel,
  placeStaticDoorFrames,
  placeStaticInstances,
  placeWallModel,
  propInstancePose,
  wallInstancePose,
  type InstancePose,
} from "../src/client/arena-scene.ts";
import type { ArenaView } from "../src/shared/arena-view.ts";

const bounds: ArenaView["bounds"] = { minX: -24, maxX: 24, minY: -2, maxY: 12, minZ: -24, maxZ: 24 };

/**
 * One draw per mesh. An InstancedMesh is one draw for every copy.
 * A material array is one draw per material, still not one draw per copy.
 */
function drawCalls(object: THREE.Object3D): number {
  let calls = 0;
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh || mesh.visible === false) return;
    calls += Array.isArray(mesh.material) ? mesh.material.length : 1;
  });
  return calls;
}

function matrixClose(actual: THREE.Matrix4, expected: THREE.Matrix4, label: string) {
  const a = actual.elements;
  const b = expected.elements;
  for (let index = 0; index < 16; index += 1) {
    assert.ok(Math.abs(a[index]! - b[index]!) < 1e-4, `${label} element ${index}: ${a[index]} vs ${b[index]}`);
  }
}

function instanceMatrix(mesh: THREE.InstancedMesh, index: number): THREE.Matrix4 {
  const matrix = new THREE.Matrix4();
  mesh.getMatrixAt(index, matrix);
  return matrix;
}

function clonedMeshMatrix(group: THREE.Object3D): THREE.Matrix4 {
  group.updateMatrixWorld(true);
  let found: THREE.Mesh | undefined;
  group.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!found && mesh.isMesh) found = mesh;
  });
  if (!found) throw new Error("clone has no mesh");
  return found.matrixWorld.clone();
}

test("two placements of the same crate produce one InstancedMesh with count 2", () => {
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const material = new THREE.MeshStandardMaterial({ color: 0x886644 });
  const crate = new THREE.Mesh(geometry, material);
  crate.name = "crate";
  const poses: InstancePose[] = [
    { position: [1, 0, 2], yaw: 0, scale: 1 },
    { position: [4, 0, -3], yaw: 90, scale: 2 },
  ];
  const placed = placeStaticInstances(crate, poses);
  assert.equal(placed.length, 1);
  const instanced = placed[0]!;
  assert.equal(instanced.isInstancedMesh, true);
  assert.equal(instanced.count, 2);
  assert.equal(instanced.geometry, geometry);
  assert.equal(instanced.material, material);
  assert.ok(instanced.boundingSphere);
  assert.equal(instanced.boundingSphere.containsPoint(new THREE.Vector3(1, 0, 2)), true);
  assert.equal(instanced.boundingSphere.containsPoint(new THREE.Vector3(4, 0, -3)), true);
  assert.equal(crate.position.x, 0);
  assert.equal(crate.scale.x, 1);

  const first = new THREE.Vector3().applyMatrix4(instanceMatrix(instanced, 0));
  assert.ok(first.distanceTo(new THREE.Vector3(1, 0, 2)) < 1e-4, first.toArray().join(","));
  // Yaw 90 sends local +X to world −Z. Scale 2 makes that step length 2.
  const tip = new THREE.Vector3(1, 0, 0).applyMatrix4(instanceMatrix(instanced, 1));
  assert.ok(tip.distanceTo(new THREE.Vector3(4, 0, -5)) < 1e-4, tip.toArray().join(","));
});

test("different materials stay different instances, and a shared material is still one mesh each", () => {
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const red = new THREE.MeshStandardMaterial({ color: 0xff0000 });
  const blue = new THREE.MeshStandardMaterial({ color: 0x0000ff });
  const root = new THREE.Group();
  const body = new THREE.Mesh(geometry, red);
  const stripe = new THREE.Mesh(geometry, red);
  stripe.position.set(0, 2, 0);
  const lid = new THREE.Mesh(new THREE.BoxGeometry(1, 0.2, 1), blue);
  lid.position.set(0, 3, 0);
  root.add(body, stripe, lid);
  const placed = placeStaticInstances(root, [
    { position: [0, 0, 0], yaw: 0, scale: 1 },
    { position: [5, 0, 0], yaw: 0, scale: 1 },
  ]);
  assert.equal(placed.length, 3);
  assert.equal(placed[0]!.material, red);
  assert.equal(placed[1]!.material, red);
  assert.notEqual(placed[0], placed[1]);
  assert.equal(placed[2]!.material, blue);
  assert.equal(placed[0]!.geometry, geometry);
  assert.equal(placed[1]!.geometry, geometry);
  for (const mesh of placed) assert.equal(mesh.count, 2);
});

test("eight copies of a building do not multiply calls by eight", async () => {
  const template = await loadGlb("brutalist-building-1-a.glb");
  const sourceMeshes = staticMeshCount(template);
  assert.equal(sourceMeshes, 1);
  const poses: InstancePose[] = Array.from({ length: 8 }, (_, index) => ({
    position: [index * 10, 0, -4],
    yaw: [0, 90, 180, 270][index % 4]!,
    scale: 30,
  }));
  const batch = new THREE.Group();
  for (const mesh of placeStaticInstances(template, poses)) batch.add(mesh);
  assert.equal(batch.children.length, 1);
  assert.equal((batch.children[0] as THREE.InstancedMesh).count, 8);
  assert.equal(drawCalls(batch), sourceMeshes);

  const clones = new THREE.Group();
  for (const pose of poses) {
    clones.add(placeBuildingModel(template, {
      id: "building",
      model: "/assets/models/brutalist-building-1-a.glb",
      position: pose.position,
      yaw: pose.yaw,
      scale: pose.scale as number,
    }));
  }
  assert.equal(drawCalls(clones), sourceMeshes * 8);

  const turned = { id: "building", model: "m", position: [40.449, 0, -217.69447] as [number, number, number], yaw: 270, scale: 100 };
  const clone = placeBuildingModel(template, turned);
  const instanced = placeStaticInstances(template, [{ position: turned.position, yaw: 270, scale: 100 }]);
  matrixClose(instanceMatrix(instanced[0]!, 0), clonedMeshMatrix(clone), "yaw 270");
  const origin = new THREE.Vector3().applyMatrix4(instanceMatrix(instanced[0]!, 0));
  const tip = new THREE.Vector3(1, 0, 0).applyMatrix4(instanceMatrix(instanced[0]!, 0));
  assert.ok(origin.distanceTo(new THREE.Vector3(40.449, 0, -217.69447)) < 1e-3, origin.toArray().join(","));
  // Yaw 270 sends local +X to world +Z, and the scale is 100.
  assert.ok(tip.sub(origin).distanceTo(new THREE.Vector3(0, 0, 100)) < 1e-2, tip.toArray().join(","));
});

test("a copied building keeps the glb root rotation and drops its root position", () => {
  const root = new THREE.Group();
  root.position.set(5, 0, 0);
  root.rotation.y = 0.3;
  root.scale.setScalar(2);
  const child = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
  child.position.set(0, 1, 0);
  root.add(child);
  const building = {
    id: "offset",
    model: "m",
    position: [10, 0, -4] as [number, number, number],
    yaw: 90,
    scale: 4,
  };
  const clone = placeBuildingModel(root, building);
  const placed = placeStaticInstances(root, [{ position: building.position, yaw: building.yaw, scale: building.scale }]);
  assert.equal(placed.length, 1);
  matrixClose(instanceMatrix(placed[0]!, 0), clonedMeshMatrix(clone), "offset child");
  assert.equal(root.position.x, 5);
  assert.equal(root.scale.x, 2);
});

test("a wall pose and a prop pose match the clone placement", () => {
  const template = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
  const east = {
    face: "east" as const,
    minX: -24,
    maxX: 24,
    minZ: -24,
    maxZ: -22,
    height: 12,
    model: "/assets/models/box.glb",
  };
  const pose = wallInstancePose(east, bounds);
  assert.equal(pose.yaw, 270);
  assert.deepEqual(pose.position, [-24, 0, 0]);
  const clone = placeWallModel(template, east, bounds);
  const placed = placeStaticInstances(template, [pose]);
  matrixClose(instanceMatrix(placed[0]!, 0), clonedMeshMatrix(clone), "east wall");

  const prop: ArenaView["props"][number] = {
    id: "crate",
    model: "/assets/models/ammo-crate.glb",
    minX: 0,
    maxX: 2,
    minY: 1,
    maxY: 4,
    minZ: -1,
    maxZ: 1,
  };
  const propPose = propInstancePose(prop);
  assert.deepEqual(propPose.position, [1, 1, 0]);
  assert.deepEqual(propPose.scale, [2, 3, 2]);
  const manual = template.clone(true);
  manual.scale.set(2, 3, 2);
  manual.position.set(1, 1, 0);
  manual.updateMatrixWorld(true);
  const instanced = placeStaticInstances(template, [propPose]);
  matrixClose(instanceMatrix(instanced[0]!, 0), manual.matrixWorld, "prop");
});

test("a skinned mesh is not instanced", () => {
  const root = new THREE.Group();
  const skinned = new THREE.SkinnedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
  const solid = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
  solid.position.set(2, 0, 0);
  root.add(skinned, solid);
  const onlySkin = placeStaticInstances(skinned, [{ position: [0, 0, 0], yaw: 0, scale: 1 }]);
  assert.equal(onlySkin.length, 0);
  const mixed = placeStaticInstances(root, [{ position: [0, 0, 0], yaw: 0, scale: 1 }]);
  assert.equal(mixed.length, 1);
  assert.equal(mixed[0]!.geometry, solid.geometry);
});

test("two med-kit placements keep one InstancedMesh per mesh", async () => {
  const template = await loadGlb("med-kit.glb");
  const count = staticMeshCount(template);
  assert.ok(count > 1);
  const poses: InstancePose[] = [
    { position: [0, 0, 0], yaw: 0, scale: 1 },
    { position: [3, 0, 1], yaw: 90, scale: 1 },
  ];
  const placed = placeStaticInstances(template, poses);
  assert.equal(placed.length, count);
  const materials = new Set(placed.map((mesh) => mesh.material));
  assert.ok(materials.size > 1);
  for (const mesh of placed) {
    assert.equal(mesh.count, 2);
    assert.equal(mesh.isInstancedMesh, true);
  }
  assert.equal(drawCalls(groupOf(placed)), count);
  const clones = new THREE.Group();
  for (const pose of poses) {
    clones.add(placeBuildingModel(template, {
      id: "med-kit",
      model: "/assets/models/med-kit.glb",
      position: pose.position,
      yaw: pose.yaw,
      scale: 1,
    }));
  }
  assert.equal(drawCalls(clones), count * 2);
});

test("a door leaf is still a clone", async () => {
  const template = await loadGlb("door1.glb");
  const doors: ArenaView["doors"] = [
    {
      id: "shut",
      model: "/assets/models/door1.glb",
      position: [10, 0, 10.5],
      yaw: 0,
      hinge: "left",
      size: [2, 2.1, 0.08],
      open: false,
    },
    {
      id: "open",
      model: "/assets/models/door1.glb",
      position: [0, 0, -16],
      yaw: 90,
      hinge: "left",
      size: [2, 2.1, 0.08],
      open: true,
    },
  ];
  const frames = placeStaticDoorFrames(template, doors);
  const doorGeometries = new Set<THREE.BufferGeometry>();
  template.getObjectByName("door")!.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh) doorGeometries.add(mesh.geometry);
  });
  assert.ok(frames.length > 0);
  for (const frame of frames) {
    assert.equal(frame.count, 2);
    assert.equal(doorGeometries.has(frame.geometry), false, frame.name);
  }
  assert.equal(drawCalls(groupOf(frames)), frames.length);

  const leaves = doors.map((door) => placeDoorModel(template, door, { frameMeshes: false }));
  for (const leaf of leaves) {
    const panel = leaf.getObjectByName("door");
    const hinge = leaf.getObjectByName("hinge");
    const frame = leaf.getObjectByName("frame");
    if (!panel || !hinge || !frame) throw new Error("missing door hinge");
    assert.equal(panel.parent, hinge);
    assert.equal(hinge.parent, frame);
    assert.deepEqual(frame.children, [hinge]);
    let meshes = 0;
    panel.traverse((object) => {
      const mesh = object as THREE.InstancedMesh;
      if (!(mesh as THREE.Mesh).isMesh) return;
      meshes += 1;
      assert.notEqual(mesh.isInstancedMesh, true);
    });
    assert.ok(meshes > 0);
  }
  assert.equal(leaves[0]!.getObjectByName("hinge")!.rotation.y, 0);
  assert.ok(Math.abs(leaves[1]!.getObjectByName("hinge")!.rotation.y - doorSwingRadians("left", true)) < 1e-6);

  const fullShut = placeDoorModel(template, doors[0]!);
  const fullOpen = placeDoorModel(template, doors[1]!);
  fullShut.updateMatrixWorld(true);
  fullOpen.updateMatrixWorld(true);
  const named = frames.find((mesh) => mesh.name === "frame-left_1");
  if (!named) throw new Error("missing frame-left_1");
  const shutFrame = fullShut.getObjectByName("frame-left_1") as THREE.Mesh;
  const openFrame = fullOpen.getObjectByName("frame-left_1") as THREE.Mesh;
  matrixClose(instanceMatrix(named, 0), shutFrame.matrixWorld, "shut frame");
  matrixClose(instanceMatrix(named, 1), openFrame.matrixWorld, "open frame");

  const latchX = doorMaxX(template.getObjectByName("door")!);
  const opened = placeDoorModel(template, { ...doors[0]!, open: true }, { frameMeshes: false });
  opened.updateMatrixWorld(true);
  leaves[0]!.updateMatrixWorld(true);
  const leafLatch = new THREE.Vector3(latchX, 0, 0).applyMatrix4(opened.getObjectByName("hinge")!.matrixWorld);
  const fullLatch = new THREE.Vector3(latchX, 0, 0).applyMatrix4(fullOpenAt(doors[0]!).matrixWorld);
  assert.ok(leafLatch.distanceTo(fullLatch) < 1e-4, leafLatch.toArray().join(","));
  const shutLatch = new THREE.Vector3(latchX, 0, 0).applyMatrix4(leaves[0]!.getObjectByName("hinge")!.matrixWorld);
  const travel = leafLatch.clone().sub(shutLatch);
  assert.ok(travel.z < -0.9 * latchX, `latch moved ${travel.toArray().join(",")}`);

  function fullOpenAt(door: ArenaView["doors"][number]): THREE.Object3D {
    const group = placeDoorModel(template, { ...door, open: true });
    group.updateMatrixWorld(true);
    const hinge = group.getObjectByName("hinge");
    if (!hinge) throw new Error("missing hinge");
    return hinge;
  }
});

function groupOf(meshes: THREE.Object3D[]): THREE.Group {
  const group = new THREE.Group();
  for (const mesh of meshes) group.add(mesh);
  return group;
}

function staticMeshCount(root: THREE.Object3D): number {
  let count = 0;
  root.traverse((object) => {
    const mesh = object as THREE.SkinnedMesh;
    if (mesh.isMesh && !mesh.isSkinnedMesh) count += 1;
  });
  return count;
}

function doorMaxX(root: THREE.Object3D): number {
  let maxX = -Infinity;
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    maxX = Math.max(maxX, mesh.geometry.boundingBox?.max.x ?? -Infinity);
  });
  return maxX;
}

function loadGlb(name: string): Promise<THREE.Object3D> {
  const selfHost = globalThis as { self?: unknown; createImageBitmap?: (blob: Blob) => Promise<unknown> };
  selfHost.self ??= globalThis;
  selfHost.createImageBitmap ??= async (blob: Blob) => {
    const data = new Uint8Array(await blob.arrayBuffer());
    return { width: 1, height: 1, data, close() {} };
  };
  const file = path.join(import.meta.dirname, "..", "web", "assets", "models", name);
  const bytes = readFileSync(file);
  const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const loader = new GLTFLoader();
  return new Promise((resolve, reject) => {
    loader.parse(data, "", (gltf) => resolve(gltf.scene), (err) => reject(err instanceof Error ? err : new Error(String(err))));
  });
}
