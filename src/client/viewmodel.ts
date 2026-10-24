import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { attachKtx2Loader } from "./arena-scene.ts";

/**
 * alien-weapon-enh's longest bbox axis is local +X (about 1.12 m) and its thin
 * axis is Z. `rotation.y = π/2` sends local +X to (0, 0, −1), which is the
 * camera's forward. The clip is not played.
 */
const LONG_AXIS_TO_FORWARD = Math.PI / 2;
const VIEW_SCALE = 0.35;

/** Mount a weapon mesh on the viewmodel root. No mixer. */
export function mountWeaponMesh(root: THREE.Object3D, source: THREE.Object3D): THREE.Object3D {
  while (root.children.length > 0) {
    const child = root.children[0];
    if (!child) break;
    root.remove(child);
  }
  const mesh = source.clone(true);
  mesh.traverse((object) => {
    const part = object as THREE.Mesh;
    if (!part.isMesh) return;
    part.castShadow = false;
    part.receiveShadow = false;
    part.frustumCulled = false;
  });
  mesh.rotation.y = LONG_AXIS_TO_FORWARD;
  mesh.scale.setScalar(VIEW_SCALE);
  mesh.position.set(0.16, -0.28, -0.42);
  root.add(mesh);
  return mesh;
}

/**
 * First-person weapon, parented to this client's camera. Other clients do not
 * get this object. It is not a snapshot entity.
 */
export function createViewModel(camera: THREE.Camera, scene: THREE.Scene, renderer?: THREE.WebGLRenderer) {
  if (camera.parent !== scene) scene.add(camera);
  const root = new THREE.Group();
  root.name = "viewmodel";
  root.frustumCulled = false;
  camera.add(root);
  const loader = new GLTFLoader();
  if (renderer) attachKtx2Loader(loader, renderer);
  let shown: string | undefined;
  let ticket = 0;
  return {
    root,
    get weapon(): string | undefined {
      return shown;
    },
    clear() {
      ticket += 1;
      shown = undefined;
      while (root.children.length > 0) {
        const child = root.children[0];
        if (!child) break;
        root.remove(child);
      }
    },
    async show(weaponId: string, url: string) {
      if (shown === weaponId && root.children.length > 0) return;
      const mine = ++ticket;
      let sceneRoot: THREE.Object3D | undefined;
      try {
        const gltf = await loader.loadAsync(url);
        sceneRoot = gltf.scene;
      } catch (err) {
        console.warn("viewmodel", err);
        return;
      }
      if (mine !== ticket || !sceneRoot) return;
      mountWeaponMesh(root, sceneRoot);
      shown = weaponId;
    },
  };
}
