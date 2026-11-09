import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import type { RenderSnapshot } from "conveyor-engine-client";
import { createPawnLayer } from "../src/client/presentation.ts";
import type { CharacterTemplates } from "../src/client/arena-scene.ts";

const animation = { clip: "none", speed: 0 };

function templates(shared: THREE.Material): CharacterTemplates {
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.8, 0.5), shared);
  const group = new THREE.Group();
  group.add(body);
  const animations = { idle: animation, walk: animation, run: animation, fall: animation, angry: animation };
  return new Map([["hero", { object: group, clips: [], animations }]]);
}

function snapshot(ids: number[]): RenderSnapshot {
  return {
    frame: 1,
    serverTick: 1n,
    snapshotSeq: 1,
    entities: ids.map((id) => ({
      id,
      render: { assetKey: "hero" },
      position: { x: id, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 1, y: 1, z: 1 },
      clip: "idle",
      speed: 0,
      visible: true,
      lifecycle: "alive",
      predicted: false,
    })),
  } as unknown as RenderSnapshot;
}

function meshesOf(root: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  root.traverse((obj) => void ((obj as THREE.Mesh).isMesh && out.push(obj as THREE.Mesh)));
  return out;
}

test("a fade gives that pawn private materials; the shared one stays opaque; the end restores it", () => {
  const shared = new THREE.MeshStandardMaterial({ color: 0x336699 });
  const parent = new THREE.Group();
  const layer = createPawnLayer(parent, templates(shared), 1.8);
  const alpha = new Map<number, number>([[1, 0.4]]);
  const opacityOf = (id: number) => alpha.get(id) ?? 1;
  layer.apply(snapshot([1, 2]), 0.016, () => undefined, undefined, true, opacityOf);
  const [first, second] = parent.children as THREE.Group[];
  const fadedMesh = meshesOf(first!)[0]!;
  const plainMesh = meshesOf(second!)[0]!;
  assert.notEqual(fadedMesh.material, shared, "private clone");
  assert.equal((fadedMesh.material as THREE.Material).transparent, true);
  assert.equal((fadedMesh.material as THREE.Material).opacity, 0.4);
  assert.equal(plainMesh.material, shared, "another instance keeps the shared material");
  assert.equal(shared.transparent, false);
  assert.equal(shared.opacity, 1);
  assert.equal((fadedMesh.material as THREE.MeshStandardMaterial).color.getHex(), 0x336699);
  assert.equal(layer.fading, 1);

  const clone = fadedMesh.material;
  alpha.set(1, 0.9);
  layer.apply(snapshot([1, 2]), 0.016, () => undefined, undefined, true, opacityOf);
  assert.equal(fadedMesh.material, clone, "the same clone is reused while it fades");
  assert.equal((fadedMesh.material as THREE.Material).opacity, 0.9);

  alpha.delete(1);
  layer.apply(snapshot([1, 2]), 0.016, () => undefined, undefined, true, opacityOf);
  assert.equal(fadedMesh.material, shared, "the shared opaque material is back");
  assert.equal(layer.fading, 0);
  assert.equal(first!.visible, true);
});

test("opacity 0 hides the pawn without keeping clones; a pawn that leaves while faded restores first", () => {
  const shared = new THREE.MeshStandardMaterial();
  const parent = new THREE.Group();
  const layer = createPawnLayer(parent, templates(shared), 1.8);
  layer.apply(snapshot([1]), 0.016, () => undefined, undefined, true, () => 0);
  const root = parent.children[0]!;
  assert.equal(root.visible, false);
  assert.equal(meshesOf(root)[0]!.material, shared);
  assert.equal(layer.fading, 0);

  layer.apply(snapshot([1]), 0.016, () => undefined, undefined, true, () => 0.5);
  const mesh = meshesOf(root)[0]!;
  assert.equal(root.visible, true);
  assert.notEqual(mesh.material, shared);
  let disposed = 0;
  (mesh.material as THREE.Material).addEventListener("dispose", () => void (disposed += 1));
  layer.apply(snapshot([]), 0.016, () => undefined, undefined, true, () => 0.5);
  assert.equal(parent.children.length, 0);
  assert.equal(disposed, 1, "the clone was disposed, not the shared material");
  assert.equal(mesh.material, shared);
});

test("with no opacity callback pawns are plain, and the owned pawn stays hidden", () => {
  const shared = new THREE.MeshStandardMaterial();
  const parent = new THREE.Group();
  const layer = createPawnLayer(parent, templates(shared), 1.8);
  layer.apply(snapshot([1, 2]), 0.016, () => undefined, 2);
  assert.equal(parent.children[0]!.visible, true);
  assert.equal(parent.children[1]!.visible, false, "own pawn");
  assert.equal(layer.fading, 0);
  // A faded own pawn is still hidden.
  layer.apply(snapshot([1, 2]), 0.016, () => undefined, 2, true, () => 1);
  assert.equal(parent.children[1]!.visible, false);
});

test("the fallback capsule fades the same way", () => {
  const parent = new THREE.Group();
  const layer = createPawnLayer(parent, new Map(), 1.8);
  layer.apply(snapshot([3]), 0.016, () => undefined, undefined, true, () => 0.25);
  const capsule = meshesOf(parent.children[0]!)[0]!;
  assert.equal((capsule.material as THREE.Material).opacity, 0.25);
  layer.apply(snapshot([3]), 0.016, () => undefined, undefined, true, () => 1);
  assert.equal((capsule.material as THREE.Material).opacity, 1);
  assert.equal((capsule.material as THREE.Material).transparent, false);
});
