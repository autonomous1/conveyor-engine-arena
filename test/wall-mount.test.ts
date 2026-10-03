import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import * as arenaScene from "../src/client/arena-scene.ts";
import type { ArenaView } from "../src/shared/arena-view.ts";

const { placeBuildingModel, placeWallModel } = arenaScene;

const bounds: ArenaView["bounds"] = { minX: -24, maxX: 24, minY: -2, maxY: 12, minZ: -24, maxZ: 24 };

function wall(partial: Partial<ArenaView["walls"][number]> = {}): ArenaView["walls"][number] {
  return {
    face: "south",
    minX: -24,
    maxX: 24,
    minZ: -24,
    maxZ: -22,
    height: 12,
    model: "/assets/models/box.glb",
    ...partial,
  };
}

/** 1 m cube centered on the origin. World size is this cube times the manifest scale. */
function boxTemplate(): THREE.Mesh {
  return new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
}

test("a manifest scale of 2 is applied and the facade is not fit to the wall span", () => {
  const template = boxTemplate();
  const group = placeWallModel(template, wall({ scale: 2, position: [8, 0, -8], yaw: 0 }), bounds);
  const model = group.children[0]!;
  assert.equal(model.scale.x, 2);
  assert.equal(model.scale.y, 2);
  assert.equal(model.scale.z, 2);
  assert.deepEqual([model.position.x, model.position.y, model.position.z], [0, 0, 0]);
  assert.equal(template.scale.x, 1);
  group.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(group);
  const size = box.getSize(new THREE.Vector3());
  assert.ok(Math.abs(size.x - 2) < 1e-6, `width ${size.x}`);
  assert.ok(Math.abs(size.y - 2) < 1e-6, `height ${size.y}`);
  assert.ok(Math.abs(size.z - 2) < 1e-6, `depth ${size.z}`);
  const center = box.getCenter(new THREE.Vector3());
  assert.ok(center.distanceTo(new THREE.Vector3(8, 0, -8)) < 1e-6, `center ${center.x},${center.y},${center.z}`);
  assert.equal(Object.hasOwn(arenaScene, "facadeFit"), false);
});

test("an omitted scale is 1 and an omitted pose uses the south anchor", () => {
  const group = placeWallModel(boxTemplate(), wall(), bounds);
  const model = group.children[0]!;
  assert.equal(model.scale.x, 1);
  assert.equal(model.scale.y, 1);
  assert.equal(model.scale.z, 1);
  assert.deepEqual([group.position.x, group.position.y, group.position.z], [0, 0, -22]);
  assert.equal(group.rotation.y, 0);
  group.updateMatrixWorld(true);
  const size = new THREE.Box3().setFromObject(group).getSize(new THREE.Vector3());
  assert.ok(Math.abs(size.x - 1) < 1e-6, `width ${size.x}`);
});

test("a baked building uses its own scale and yaw 270 sends local +X to world +Z", () => {
  const template = boxTemplate();
  const group = placeBuildingModel(template, {
    id: "brutalist-urban-1",
    model: "/assets/models/brutalist-urban-1.glb",
    position: [40.449, 0, -217.69447],
    yaw: 270,
    scale: 100,
  });
  const model = group.children[0]!;
  assert.equal(model.scale.x, 100);
  assert.equal(template.scale.x, 1);
  assert.ok(Math.abs(group.rotation.y + Math.PI / 2) < 1e-9);
  group.updateMatrixWorld(true);
  const origin = new THREE.Vector3(0, 0, 0).applyMatrix4(model.matrixWorld);
  const tip = new THREE.Vector3(1, 0, 0).applyMatrix4(model.matrixWorld);
  const dir = tip.sub(origin);
  assert.ok(Math.abs(dir.x) < 1e-6, `x ${dir.x}`);
  assert.ok(Math.abs(dir.z - 100) < 1e-4, `z ${dir.z}`);
  assert.ok(origin.distanceTo(new THREE.Vector3(40.449, 0, -217.69447)) < 1e-6);
});

test("yaw 90 sends local +X to world -Z", () => {
  const group = placeWallModel(boxTemplate(), wall({ yaw: 90, position: [0, 0, 0], scale: 1 }), bounds);
  assert.ok(Math.abs(group.rotation.y - Math.PI / 2) < 1e-9, `rotation.y ${group.rotation.y}`);
  group.updateMatrixWorld(true);
  const model = group.children[0]!;
  const origin = new THREE.Vector3(0, 0, 0).applyMatrix4(model.matrixWorld);
  const tip = new THREE.Vector3(1, 0, 0).applyMatrix4(model.matrixWorld);
  const dir = tip.sub(origin);
  assert.ok(Math.abs(dir.x) < 1e-6, `x ${dir.x}`);
  assert.ok(Math.abs(dir.y) < 1e-6, `y ${dir.y}`);
  assert.ok(Math.abs(dir.z + 1) < 1e-6, `z ${dir.z}`);
});
