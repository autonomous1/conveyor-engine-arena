import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { MAP_BAKE_PX, MAP_PAD, SCENE_MAP_SIZE, mapFrame } from "../src/shared/map-frame.ts";
import { mapImagePixel, topDownCamera } from "../src/util/map-camera.ts";

const ROOM = { minX: -10, maxX: 30, minZ: -8, maxZ: 12 };

test("the top-down camera matches the panel: +X right, +Z up", () => {
  const frame = mapFrame(ROOM, SCENE_MAP_SIZE, SCENE_MAP_SIZE);
  const camera = topDownCamera(ROOM, SCENE_MAP_SIZE, SCENE_MAP_SIZE);
  assert.ok(frame);
  assert.ok(camera);
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  assert.ok(dir.y < -0.999, `look y ${dir.y}`);
  const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
  assert.ok(right.x > 0.999 && Math.abs(right.z) < 1e-3, `right ${right.x},${right.z}`);
  // Local +Y stays world −Z. The PNG flip, not the frustum, puts +Z on top.
  const localUp = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
  assert.ok(localUp.z < -0.999, `local up z ${localUp.z}`);
  assert.ok(camera.top > camera.bottom, "frustum keeps a positive winding");

  for (const [x, z] of [[ROOM.minX, ROOM.minZ], [ROOM.maxX, ROOM.maxZ], [0, 0], [12, -3]] as const) {
    const [px, py] = frame.toPixel(x, z);
    const [cx, cy] = mapImagePixel(camera, x, z, SCENE_MAP_SIZE, SCENE_MAP_SIZE);
    assert.ok(Math.abs(cx - px) < 1e-3, `${x},${z} px ${cx} vs ${px}`);
    assert.ok(Math.abs(cy - py) < 1e-3, `${x},${z} py ${cy} vs ${py}`);
    const ndc = new THREE.Vector3(x, 1, z).project(camera);
    assert.ok(Math.abs(ndc.z) < 1, `${x},${z} clipped z ${ndc.z}`);
  }
  const roof = new THREE.Vector3(0, 12, 0).project(camera);
  assert.ok(Math.abs(roof.z) < 1, `roof clipped ${roof.z}`);
});

test("the bake image uses the same window as the 360px panel", () => {
  const bounds = { minX: -20, maxX: 20, minZ: -20, maxZ: 20 };
  const panel = mapFrame(bounds, SCENE_MAP_SIZE, SCENE_MAP_SIZE);
  const camera = topDownCamera(bounds, MAP_BAKE_PX, MAP_BAKE_PX);
  assert.ok(panel);
  assert.ok(camera);
  const [px, py] = panel.toPixel(bounds.minX, bounds.maxZ);
  assert.ok(Math.abs(px - MAP_PAD) < 1e-6, `pad x ${px}`);
  assert.ok(Math.abs(py - MAP_PAD) < 1e-6, `pad y ${py}`);
  const [bx, by] = mapImagePixel(camera, bounds.minX, bounds.maxZ, MAP_BAKE_PX, MAP_BAKE_PX);
  const nx = bx / MAP_BAKE_PX;
  const ny = by / MAP_BAKE_PX;
  assert.ok(Math.abs(nx - px / SCENE_MAP_SIZE) < 1e-4, `norm x ${nx}`);
  assert.ok(Math.abs(ny - py / SCENE_MAP_SIZE) < 1e-4, `norm y ${ny}`);
  assert.equal(SCENE_MAP_SIZE, 360);
});
