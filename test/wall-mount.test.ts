import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { facadeFit, wallAnchor } from "../src/client/arena-scene.ts";

const bounds = { minX: -24, maxX: 24, minY: -2, maxY: 12, minZ: -24, maxZ: 24 };
const walls = {
  south: { minX: -24, maxX: 24, minZ: -24, maxZ: -22 },
  north: { minX: -24, maxX: 24, minZ: 22, maxZ: 24 },
  east: { minX: 22, maxX: 24, minZ: -24, maxZ: 24 },
  west: { minX: -24, maxX: -22, minZ: -24, maxZ: 24 },
} as const;

const facade = { minX: -0.49, maxX: 0.49, minY: 0, maxY: 0.53, minZ: -0.18, maxZ: 0.18 };

function mounted(face: keyof typeof walls): THREE.Group {
  const wall = walls[face];
  const anchor = wallAnchor(face, wall, bounds);
  const fit = facadeFit(facade, anchor.span);
  const group = new THREE.Group();
  group.position.set(anchor.x, 0, anchor.z);
  group.rotation.y = anchor.yaw;
  const model = new THREE.Object3D();
  model.scale.setScalar(fit.scale);
  model.position.set(fit.x, fit.y, fit.z);
  group.add(model);
  group.updateMatrixWorld(true);
  return group;
}

test("each facade front sits on the inner wall and faces the room", () => {
  for (const face of ["south", "north", "east", "west"] as const) {
    const group = mounted(face);
    const model = group.children[0]!;
    const midX = (facade.minX + facade.maxX) / 2;
    const front = new THREE.Vector3(midX, facade.minY, facade.maxZ).applyMatrix4(model.matrixWorld);
    const back = new THREE.Vector3(midX, facade.minY, facade.minZ).applyMatrix4(model.matrixWorld);
    const edge = new THREE.Vector3(facade.maxX, facade.minY, facade.maxZ).applyMatrix4(model.matrixWorld);
    const anchor = wallAnchor(face, walls[face], bounds);
    assert.ok(front.distanceTo(new THREE.Vector3(anchor.x, 0, anchor.z)) < 1e-6, `${face} front center ${front.x},${front.z}`);
    const center = new THREE.Vector3();
    const inward = front.clone().sub(back);
    inward.y = 0;
    const toCenter = center.clone().sub(front);
    toCenter.y = 0;
    assert.ok(inward.dot(toCenter) > 0, `${face} depth points out of the room`);
    const width = edge.distanceTo(new THREE.Vector3(facade.minX, facade.minY, facade.maxZ).applyMatrix4(model.matrixWorld));
    assert.ok(Math.abs(width - anchor.span) < 1e-6, `${face} width ${width}`);
  }
});
