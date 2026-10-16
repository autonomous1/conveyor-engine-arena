import * as THREE from "three";

/**
 * Draws host grenade points. It copies the position it is given and yaws the
 * mesh once, from the launch yaw. It does not add gravity, and it does not
 * turn the mesh to follow the arc. Pitch stays the rotation in the GLB.
 *
 * grenade-launched.glb keeps its node quaternion (a −90° roll about Z) and its
 * material. After that rotation the nose, the tip at about +0.166 m, lies on
 * local +X. Player yaw 0 looks down world +Z, so a fixed mount turns that +X
 * onto +Z. The root's `rotation.y` is then the launch yaw.
 * Check: yaw 0, the tip offset lands on (0, 0, 1).
 */

const NOSE = new THREE.Vector3(1, 0, 0);
const SHOT_FORWARD = new THREE.Vector3(0, 0, 1);
const NOSE_MOUNT = new THREE.Quaternion().setFromUnitVectors(NOSE, SHOT_FORWARD);

export const GRENADE_DRAW_MS = 400;

export type GrenadeDraw = {
  id: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  stop?: boolean;
};

export function createGrenadeProps(
  parent: THREE.Object3D,
  loadTemplate: () => Promise<THREE.Object3D | undefined> = async () => undefined,
) {
  if ((parent as { isCamera?: boolean }).isCamera) {
    throw new Error("grenade must not be parented to the camera");
  }
  const group = new THREE.Group();
  group.name = "grenades";
  parent.add(group);
  const fallback = new THREE.Mesh(
    new THREE.SphereGeometry(0.08, 10, 8),
    new THREE.MeshStandardMaterial({ color: 0x4a7c2f, roughness: 0.6 }),
  );
  fallback.name = "grenade-fallback";
  const props = new Map<number, THREE.Object3D>();
  let template: THREE.Object3D | undefined;
  let asked = false;

  function mute(object: THREE.Object3D) {
    object.traverse((node) => {
      node.frustumCulled = false;
      node.castShadow = false;
      node.receiveShadow = false;
      node.raycast = () => {};
    });
  }

  function mountVisual(root: THREE.Object3D, source: THREE.Object3D) {
    let mount = root.children[0];
    if (!mount) {
      mount = new THREE.Group();
      mount.name = "grenade-mount";
      mount.quaternion.copy(NOSE_MOUNT);
      root.add(mount);
    }
    while (mount.children.length > 0) {
      const child = mount.children[0];
      if (!child) break;
      mount.remove(child);
    }
    const visual = source.clone(true);
    mute(visual);
    mount.add(visual);
  }

  function spawn(id: number, yaw: number): THREE.Object3D {
    const root = new THREE.Group();
    root.name = "grenade";
    root.rotation.y = yaw;
    root.userData.launchYaw = yaw;
    root.userData.asset = template !== undefined;
    mountVisual(root, template ?? fallback);
    group.add(root);
    props.set(id, root);
    return root;
  }

  function adopt(next: THREE.Object3D) {
    template = next;
    for (const root of props.values()) {
      mountVisual(root, next);
      root.userData.asset = true;
    }
  }

  function ensureTemplate() {
    if (asked) return;
    asked = true;
    void loadTemplate().then((loaded) => {
      if (loaded) adopt(loaded);
    }).catch((err) => {
      console.warn("grenade", err);
    });
  }

  function place(pose: GrenadeDraw, now = 0) {
    if (!Number.isFinite(pose.id) || !Number.isFinite(pose.x) || !Number.isFinite(pose.y) || !Number.isFinite(pose.z)) return;
    if (!Number.isFinite(pose.yaw)) return;
    ensureTemplate();
    let mesh = props.get(pose.id);
    if (!mesh) mesh = spawn(pose.id, pose.yaw);
    mesh.position.set(pose.x, pose.y, pose.z);
    if (pose.stop === true && typeof mesh.userData.dropAt !== "number") {
      mesh.userData.dropAt = now + GRENADE_DRAW_MS;
    }
  }

  function expire(now: number) {
    for (const [id, mesh] of props) {
      const dropAt = mesh.userData.dropAt;
      if (typeof dropAt !== "number" || now < dropAt) continue;
      mesh.removeFromParent();
      props.delete(id);
    }
  }

  function drop() {
    for (const mesh of props.values()) mesh.removeFromParent();
    props.clear();
  }

  return { place, expire, drop };
}
