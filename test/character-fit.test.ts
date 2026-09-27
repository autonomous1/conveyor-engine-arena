import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { clone as cloneWithSkeleton } from "three/addons/utils/SkeletonUtils.js";

test("skinned clone follows the pawn instead of staying at the origin", () => {
  const bone = new THREE.Bone();
  bone.position.set(0, 0.3, 0);
  const geometry = new THREE.BoxGeometry(0.2, 0.6, 0.2);
  geometry.translate(0, 0.3, 0);
  const count = geometry.attributes.position.count;
  const skinIndex = new THREE.Uint16BufferAttribute(new Uint16Array(count * 4), 4);
  const skinWeight = new THREE.Float32BufferAttribute(new Float32Array(count * 4), 4);
  for (let i = 0; i < count; i++) skinWeight.setXYZW(i, 1, 0, 0, 0);
  geometry.setAttribute("skinIndex", skinIndex);
  geometry.setAttribute("skinWeight", skinWeight);
  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial());
  const skeleton = new THREE.Skeleton([bone]);
  mesh.add(bone);
  mesh.bind(skeleton);
  const template = new THREE.Group();
  template.add(mesh);
  template.updateMatrixWorld(true);

  const pawn = new THREE.Group();
  pawn.position.set(-10, 0, 0);
  pawn.add(cloneWithSkeleton(template));
  pawn.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(pawn);
  const center = (box.min.x + box.max.x) / 2;
  assert.ok(Math.abs(center + 10) < 0.5, `skeleton clone center x ${center}`);

  const shared = new THREE.Group();
  shared.position.set(-10, 0, 0);
  shared.add(template.clone(true));
  shared.updateMatrixWorld(true);
  const stuck = new THREE.Box3().setFromObject(shared);
  const stuckCenter = (stuck.min.x + stuck.max.x) / 2;
  assert.ok(Math.abs(stuckCenter) < 1, `shared skeleton center x ${stuckCenter}`);
});
