import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DOOR_OPEN_DEGREES, doorSwingRadians, placeDoorModel, placeDoorPlacements } from "../src/client/arena-scene.ts";
import { interpretPlacements } from "../src/server/placements-file.ts";
import type { ArenaView } from "../src/shared/arena-view.ts";

const doorGlb = path.join(import.meta.dirname, "..", "web", "assets", "models", "door1.glb");

function door(partial: Partial<ArenaView["doors"][number]> = {}): ArenaView["doors"][number] {
  return {
    id: "front",
    model: "/assets/models/door1.glb",
    position: [10, 0, 10.5],
    yaw: 0,
    hinge: "left",
    size: [2, 2.1, 0.08],
    open: false,
    ...partial,
  };
}

test("yaw 0 keeps the GLB front and the frame yaw, and a shut hinge is identity", async () => {
  const template = await loadDoorTemplate();
  const sourceDoor = template.getObjectByName("door");
  const sourceFrame = template.getObjectByName("frame");
  if (!sourceDoor || !sourceFrame) throw new Error("door1.glb is missing frame or door");
  const sourcePanel = texturedMesh(sourceDoor);
  const localFront = new THREE.Vector3().fromBufferAttribute(sourcePanel.geometry.getAttribute("normal"), 0);
  const sourceMap = doorMap(sourcePanel);
  assert.ok(sourceMap, "door1.glb door mesh has no texture");

  const closed = placeDoorModel(template, door({ position: [0, 0, 0], yaw: 0 }));
  closed.updateMatrixWorld(true);
  const frame = closed.getObjectByName("frame");
  const hinge = closed.getObjectByName("hinge");
  const panel = closed.getObjectByName("door");
  if (!frame || !hinge || !panel) throw new Error("missing frame, hinge, or door");
  assert.equal(frame.parent, closed);
  assert.equal(panel.parent, hinge);
  assert.equal(hinge.parent, frame);
  const placedPanel = texturedMesh(panel);
  const worldFront = localFront.clone().transformDirection(placedPanel.matrixWorld);
  assert.ok(worldFront.dot(localFront) > 0.99, `front ${worldFront.toArray()}`);
  const placedMap = doorMap(placedPanel);
  assert.ok(placedMap, "placed door has no texture");
  assert.equal(placedMap.colorSpace, THREE.SRGBColorSpace);
  assert.equal(placedMap.image, sourceMap.image);
  const bottom = new THREE.Box3().setFromObject(frame).min.y;
  assert.ok(Math.abs(bottom) < 1e-3, `frame bottom ${bottom}`);
  assertQuaternion(frame, 0);
  assert.ok(hinge.quaternion.angleTo(new THREE.Quaternion()) < 1e-6, "shut hinge is not identity");
  const sourceSize = objectWorldSize(sourceFrame);
  const placedSize = objectWorldSize(frame);
  assert.ok(placedSize.distanceTo(sourceSize) < 1e-3, `scaled ${placedSize.toArray()}`);

  const turned = placeDoorModel(template, door({ position: [10.5, 0, 10], yaw: 90 }));
  const turnedFrame = turned.getObjectByName("frame");
  const turnedHinge = turned.getObjectByName("hinge");
  if (!turnedFrame || !turnedHinge) throw new Error("missing turned frame");
  assertQuaternion(turnedFrame, 90);
  assert.ok(turnedHinge.quaternion.angleTo(new THREE.Quaternion()) < 1e-6);

  const open = placeDoorModel(template, door({ position: [0, 0, 0], yaw: 0, open: true }));
  open.updateMatrixWorld(true);
  const openFrame = open.getObjectByName("frame");
  const openHinge = open.getObjectByName("hinge");
  if (!openFrame || !openHinge) throw new Error("missing open frame");
  assert.ok(openFrame.quaternion.angleTo(frame.quaternion) < 1e-6, "frame yaw changed when the door opened");
  assert.ok(Math.abs(openHinge.rotation.y - DOOR_OPEN_DEGREES * Math.PI / 180) < 1e-6);
  const latchX = doorMaxX(sourceDoor);
  assert.ok(latchX > 1, `latch ${latchX}`);
  const shutLatch = new THREE.Vector3(latchX, 0, 0).applyMatrix4(hinge.matrixWorld);
  const openLatch = new THREE.Vector3(latchX, 0, 0).applyMatrix4(openHinge.matrixWorld);
  const travel = openLatch.clone().sub(shutLatch);
  assert.ok(travel.dot(localFront) < -0.9 * latchX, `latch moved ${travel.toArray()} along front ${localFront.toArray()}`);
  assert.equal(doorSwingRadians("left", true) > 0, true);
  assert.equal(doorSwingRadians("right", true) < 0, true);
});

function loadDoorTemplate(): Promise<THREE.Object3D> {
  // GLTFLoader decodes embedded images with createImageBitmap, which Node does not provide.
  // The stand-in bitmap keeps the embedded PNG bytes on the texture so the placement test can see the map.
  const selfHost = globalThis as { self?: unknown; createImageBitmap?: (blob: Blob) => Promise<unknown> };
  selfHost.self ??= globalThis;
  selfHost.createImageBitmap ??= async (blob: Blob) => {
    const data = new Uint8Array(await blob.arrayBuffer());
    return { width: 1, height: 1, data, close() {} };
  };
  const bytes = readFileSync(doorGlb);
  const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const loader = new GLTFLoader();
  return new Promise((resolve, reject) => {
    loader.parse(data, "", (gltf) => resolve(gltf.scene), (err) => reject(err instanceof Error ? err : new Error(String(err))));
  });
}

function texturedMesh(root: THREE.Object3D): THREE.Mesh {
  let found: THREE.Mesh | undefined;
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (found || !mesh.isMesh || !doorMap(mesh)) return;
    found = mesh;
  });
  if (!found) throw new Error("door mesh has no texture");
  return found;
}

function doorMaxX(root: THREE.Object3D): number {
  let maxX = -Infinity;
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    maxX = Math.max(maxX, mesh.geometry.boundingBox?.max.x ?? -Infinity);
  });
  return maxX;
}

function doorMap(mesh: THREE.Mesh): THREE.Texture | null {
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  for (const material of materials) {
    if ("map" in material && (material as THREE.MeshStandardMaterial).map) {
      return (material as THREE.MeshStandardMaterial).map;
    }
  }
  return null;
}

function assertQuaternion(object: THREE.Object3D, yawDegrees: number): void {
  const expected = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yawDegrees * Math.PI / 180);
  const angle = object.quaternion.angleTo(expected);
  assert.ok(angle < 1e-6, `quaternion off by ${angle} from yaw ${yawDegrees}`);
}

function objectWorldSize(root: THREE.Object3D): THREE.Vector3 {
  root.updateWorldMatrix(true, true);
  const box = new THREE.Box3();
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    const part = mesh.geometry.boundingBox;
    if (!part) return;
    box.union(part.clone().applyMatrix4(mesh.matrixWorld));
  });
  return box.getSize(new THREE.Vector3());
}

test("a door placement adds no obstacle", () => {
  const baked = interpretPlacements({
    formatVersion: 1,
    units: "meters",
    placements: [{
      id: "front",
      model: "door-1",
      position: [10, 0, 10.5],
      yaw: 0,
      hinge: "left",
      size: [2, 2.1, 0.08],
      open: false,
    }],
    obstacles: [],
  }, new Set(["hall", "door-1"]), new Set());
  assert.deepEqual(baked.issues, []);
  assert.equal(baked.buildings.length, 0);
  assert.equal(baked.boxes.length, 0);
  assert.equal(baked.doors.length, 1);
  assert.equal(baked.doors[0]?.model, "door-1");
  assert.equal(baked.doors[0]?.open, false);
  assert.deepEqual(baked.doors[0]?.size, [2, 2.1, 0.08]);

  const unknown = interpretPlacements({
    formatVersion: 1,
    units: "meters",
    placements: [{
      id: "front",
      model: "door",
      position: [10, 0, 10.5],
      yaw: 0,
      hinge: "left",
      size: [2, 2.1, 0.08],
      open: false,
    }],
    obstacles: [],
  }, new Set(["door-1", "door-2"]), new Set());
  assert.equal(unknown.doors.length, 0);
  assert.ok(unknown.issues.some((issue) => issue.message === "unknown asset door"));
});

test("two door placements load two urls and do not reuse the first clone", async () => {
  const urls: string[] = [];
  const first = markedDoor("door-1");
  const second = markedDoor("door-2");
  const byUrl = new Map<string, THREE.Object3D>([
    ["/assets/models/door1.glb", first],
    ["/assets/models/door2.glb", second],
  ]);
  const groups = await placeDoorPlacements([
    door({ id: "door-north", model: "/assets/models/door1.glb" }),
    door({ id: "door-south", model: "/assets/models/door2.glb", position: [0, 0, -16] }),
  ], async (url) => {
    urls.push(url);
    return byUrl.get(url);
  });
  assert.deepEqual(urls, ["/assets/models/door1.glb", "/assets/models/door2.glb"]);
  assert.equal(groups[0]?.getObjectByName("door")?.userData.source, "door-1");
  assert.equal(groups[1]?.getObjectByName("door")?.userData.source, "door-2");
  assert.notEqual(groups[0]?.getObjectByName("door"), groups[1]?.getObjectByName("door"));
  assert.equal(groups[0]?.getObjectByName("hinge")?.rotation.y, 0);
  assert.equal(groups[1]?.getObjectByName("hinge")?.rotation.y, 0);
});

function markedDoor(source: string): THREE.Group {
  const root = new THREE.Group();
  const frame = new THREE.Group();
  frame.name = "frame";
  const panel = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 0.08));
  panel.name = "door";
  panel.userData.source = source;
  frame.add(panel);
  root.add(frame);
  return root;
}
