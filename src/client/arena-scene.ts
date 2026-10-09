import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { clone as cloneWithSkeleton } from "three/addons/utils/SkeletonUtils.js";
import type { ArenaView, BackdropShape } from "../shared/arena-view.js";
import type { Movement } from "../shared/movements.js";
import { shadowSettings, type ShadowQuality } from "../shared/shadows.ts";
import { prepareCharacter } from "./pawn-feet.ts";

export type ArenaScene = {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  content: THREE.Group;
  resize: () => void;
};

export type CharacterVisual = {
  object: THREE.Object3D;
  clips: THREE.AnimationClip[];
  animations: Record<Movement, { clip: string; speed: number }>;
};

export type CharacterTemplates = Map<string, CharacterVisual>;

const SHADOW_ALGORITHM = {
  basic: THREE.BasicShadowMap,
  pcf: THREE.PCFShadowMap,
  vsm: THREE.VSMShadowMap,
} as const;

export function createArenaScene(quality: ShadowQuality): ArenaScene {
  const shadows = shadowSettings(quality);
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  renderer.setClearColor(0x8eb8d4);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = shadows.enabled;
  renderer.shadowMap.type = SHADOW_ALGORITHM[shadows.algorithm];
  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xc8d8ff, 0x3a3228, 0.85));
  const key = new THREE.DirectionalLight(0xfff2d6, 1.6);
  key.position.set(12, 18, 8);
  key.castShadow = shadows.enabled;
  if (shadows.enabled) {
    key.shadow.mapSize.set(shadows.mapSize, shadows.mapSize);
    key.shadow.radius = shadows.radius;
    key.shadow.bias = shadows.bias;
    key.shadow.normalBias = shadows.normalBias;
    const camera = key.shadow.camera;
    camera.near = 1;
    camera.far = 90;
    camera.left = camera.bottom = -60;
    camera.right = camera.top = 60;
    camera.updateProjectionMatrix();
    scene.add(key.target);
  }
  scene.add(key);

  const content = new THREE.Group();
  scene.add(content);
  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 400);
  camera.position.set(16, 10, 16);
  camera.lookAt(0, 1, 0);

  const resize = () => {
    camera.aspect = innerWidth / Math.max(1, innerHeight);
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight, false);
  };
  resize();
  addEventListener("resize", resize);
  return { renderer, scene, camera, content, resize };
}

/**
 * The supplied panorama bakes a light checkerboard into RGB instead of storing alpha.
 * Those pixels become transparent so the sky dome shows through.
 */
function cityscapeTexture(url: string): Promise<THREE.CanvasTexture | undefined> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) {
        resolve(undefined);
        return;
      }
      ctx.drawImage(image, 0, 0);
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = pixels.data;
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i] ?? 0;
        const g = data[i + 1] ?? 0;
        const b = data[i + 2] ?? 0;
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        // Checker squares are near-gray, from about 160 up through white. Teal facade pixels stay.
        if (max - min <= 22 && max >= 160) data[i + 3] = 0;
      }
      ctx.putImageData(pixels, 0, 0);
      const map = new THREE.CanvasTexture(canvas);
      map.colorSpace = THREE.SRGBColorSpace;
      map.wrapS = THREE.ClampToEdgeWrapping;
      map.wrapT = THREE.ClampToEdgeWrapping;
      map.needsUpdate = true;
      resolve(map);
    };
    image.onerror = () => resolve(undefined);
    image.src = url;
  });
}

function markShadowCasters(root: THREE.Object3D, enabled: boolean): void {
  if (!enabled) return;
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
  });
}

function backdropMesh(map: THREE.Texture | undefined, shape: BackdropShape, radius: number, height: number, material: THREE.Material): THREE.Mesh {
  const geometry = shape === "cylinder"
    ? new THREE.CylinderGeometry(radius, radius, height, 64, 1, true)
    : new THREE.SphereGeometry(radius, 32, 16);
  const mesh = new THREE.Mesh(geometry, material);
  if (shape === "cylinder") mesh.position.y = height / 2;
  else mesh.scale.y = height / (2 * radius);
  if (map) (material as THREE.MeshBasicMaterial).map = map;
  return mesh;
}

async function texture(url: string): Promise<THREE.Texture | undefined> {
  try {
    const map = await new THREE.TextureLoader().loadAsync(url);
    map.colorSpace = THREE.SRGBColorSpace;
    map.wrapS = THREE.RepeatWrapping;
    map.wrapT = THREE.RepeatWrapping;
    return map;
  } catch {
    return undefined;
  }
}

type WallFace = ArenaView["walls"][number]["face"];
type Bounds2 = { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number };

/** Inner-face anchor. Yaw turns a local +Z facade front into the room. */
export function wallAnchor(face: WallFace, wall: Pick<Bounds2, "minX" | "maxX" | "minZ" | "maxZ">, bounds: ArenaView["bounds"]): { x: number; z: number; yaw: number; span: number } {
  const span = face === "east" || face === "west" ? bounds.maxZ - bounds.minZ : bounds.maxX - bounds.minX;
  const midX = (bounds.minX + bounds.maxX) / 2;
  const midZ = (bounds.minZ + bounds.maxZ) / 2;
  if (face === "south") return { x: midX, z: wall.maxZ, yaw: 0, span };
  if (face === "north") return { x: midX, z: wall.minZ, yaw: Math.PI, span };
  if (face === "east") return { x: wall.minX, z: midZ, yaw: -Math.PI / 2, span };
  return { x: wall.maxX, z: midZ, yaw: Math.PI / 2, span };
}

/**
 * Closed is yaw 0 on the hinge. Open is about 100° so the panel clears the
 * doorway. Sliding is not a door motion. The swing is not a GLB clip.
 */
export const DOOR_OPEN_DEGREES = 100;

/**
 * Left hinge, panel along +X: +100° sends the latch toward local −Z.
 * Right hinge, panel along −X: −100° sends that latch toward local −Z too.
 * The door GLB's outward normal is local +Z, so local −Z is into the building
 * when the placement yaw has turned +Z to the outside of the wall.
 */
export function doorSwingRadians(hinge: "left" | "right", open: boolean): number {
  if (!open) return 0;
  const radians = DOOR_OPEN_DEGREES * Math.PI / 180;
  return hinge === "left" ? radians : -radians;
}

/**
 * Mount one door GLB. The default clones the frame and the leaf. Pass
 * `{ frameMeshes: false }` when the frame is drawn with InstancedMesh: the
 * frame node stays as the yaw pivot, and the leaf is still its own clone.
 * Each opening gets its own leaf. A second opening is not that clone.
 *
 * Placement position and yaw are applied once. The file already faces out:
 * front normals are +Z and the hinge is the mesh origin on the left edge.
 * No extra quarter turn.
 *
 * `frame` carries the placement yaw and does not swing. The door mesh is a
 * child of `hinge` at that mesh origin. `open` yaws only the hinge.
 * The frame bottom sits on the placement's y. The building scale is not applied.
 *
 * Check: yaw 0, position (0, 0, 0). A source normal (0, 0, 1) stays world +Z,
 * the frame quaternion is identity, and the hinge quaternion is identity.
 * Yaw 90 sets the frame quaternion to +90° about Y, which sends local +Z to world +X.
 */
export function placeDoorModel(
  template: THREE.Object3D,
  door: ArenaView["doors"][number],
  options?: { frameMeshes?: boolean },
): THREE.Group {
  const frameSrc = template.getObjectByName("frame");
  const doorSrc = template.getObjectByName("door");
  if (!frameSrc || !doorSrc) throw new Error("door GLB is missing frame or door");
  const frame = options?.frameMeshes === false ? new THREE.Group() : cloneDoorPiece(frameSrc);
  if (options?.frameMeshes === false) frame.scale.copy(frameSrc.scale);
  const panel = cloneDoorPiece(doorSrc);
  frame.name = "frame";
  panel.name = "door";
  const group = new THREE.Group();
  group.name = door.id;
  group.position.set(door.position[0], door.position[1], door.position[2]);
  orientDoorFrame(frame, door.yaw, meshMinY(frameSrc));
  const hinge = new THREE.Group();
  hinge.name = "hinge";
  hinge.rotation.y = doorSwingRadians(door.hinge, door.open);
  hinge.add(panel);
  frame.add(hinge);
  group.add(frame);
  return group;
}

/**
 * Load each door from `door.model` and clone that scene. Two models are two
 * loads. A second placement is not a clone of the first placement's group.
 */
export async function placeDoorPlacements(
  doors: readonly ArenaView["doors"][number][],
  load: (url: string) => Promise<THREE.Object3D | undefined>,
): Promise<THREE.Group[]> {
  const groups: THREE.Group[] = [];
  for (const door of doors) {
    const template = await load(door.model);
    if (!template) continue;
    groups.push(placeDoorModel(template, door));
  }
  return groups;
}

/** Share the loaded material. A clone that dropped its map gets the source material back. */
function cloneDoorPiece(source: THREE.Object3D): THREE.Object3D {
  const clone = source.clone(true);
  const sources: THREE.Mesh[] = [];
  const clones: THREE.Mesh[] = [];
  source.traverse((obj) => { if ((obj as THREE.Mesh).isMesh) sources.push(obj as THREE.Mesh); });
  clone.traverse((obj) => { if ((obj as THREE.Mesh).isMesh) clones.push(obj as THREE.Mesh); });
  clones.forEach((mesh, index) => keepDoorMap(mesh, sources[index]));
  return clone;
}

function keepDoorMap(clone: THREE.Mesh, source: THREE.Mesh | undefined): void {
  const cloned = materialList(clone.material);
  const loaded = source ? materialList(source.material) : [];
  const next = cloned.map((material, index) => {
    const from = loaded[index] ?? loaded[0];
    const map = textureMap(material) ?? (from ? textureMap(from) : null);
    if (!map) return material;
    map.colorSpace = THREE.SRGBColorSpace;
    if (textureMap(material)) return material;
    return from ?? material;
  });
  clone.material = Array.isArray(clone.material) ? next : next[0]!;
}

function materialList(material: THREE.Material | THREE.Material[]): THREE.Material[] {
  return Array.isArray(material) ? material : [material];
}

function textureMap(material: THREE.Material): THREE.Texture | null {
  if (!("map" in material)) return null;
  return (material as THREE.MeshStandardMaterial).map;
}

function meshMinY(object: THREE.Object3D): number {
  let minY = Infinity;
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    const geometry = mesh.geometry;
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    const box = geometry.boundingBox;
    if (!box) return;
    minY = Math.min(minY, box.min.y);
  });
  if (!Number.isFinite(minY)) throw new Error("door frame has no vertices");
  return minY;
}

/** Quarter-turns match `yawConvention: "y-up-90"`. 90° sends model +X to world −Z. */
function yawToRadians(degrees: number): number {
  const wrapped = ((degrees % 360) + 360) % 360;
  if (wrapped < 1e-6 || wrapped > 360 - 1e-6) return 0;
  if (Math.abs(wrapped - 90) < 1e-6) return Math.PI / 2;
  if (Math.abs(wrapped - 180) < 1e-6) return Math.PI;
  if (Math.abs(wrapped - 270) < 1e-6) return -Math.PI / 2;
  return degrees * (Math.PI / 180);
}

const UP = new THREE.Vector3(0, 1, 0);

/**
 * One placement of a static model. `yaw` is degrees about +Y, the same number
 * a baked placement stores. `scale` is uniform, or the prop's width, height, and depth.
 */
export type InstancePose = {
  position: [number, number, number];
  yaw: number;
  scale: number | [number, number, number];
};

/**
 * One InstancedMesh per non-skinned mesh. Geometry and material are the loaded
 * objects, not copies. Meshes are not merged, so two materials stay two draws.
 * The matrix matches `placeBuildingModel`: yaw on the parent, scale on the model,
 * and the GLB root position is dropped while its rotation is kept.
 */
export function placeStaticInstances(template: THREE.Object3D, poses: readonly InstancePose[]): THREE.InstancedMesh[] {
  if (poses.length === 0) return [];
  const meshes = staticMeshes(template, false);
  if (meshes.length === 0) return [];
  template.updateMatrixWorld(true);
  const rootInverse = new THREE.Matrix4().copy(template.matrixWorld).invert();
  const relatives = meshes.map((mesh) => new THREE.Matrix4().multiplyMatrices(rootInverse, mesh.matrixWorld));
  const rootQuaternion = template.quaternion.clone();
  return meshes.map((mesh, index) => instanceMesh(mesh, poses.length, (pose, target) => {
    target.copy(modelMatrix(pose, rootQuaternion)).multiply(relatives[index]!);
  }, poses));
}

/**
 * Frame pieces of a static door. The `door` node is not included: that leaf
 * stays a clone under a hinge. One InstancedMesh per frame mesh, count equal
 * to the openings. The matrix is the same frame yaw and floor offset as
 * `placeDoorModel`.
 */
export function placeStaticDoorFrames(
  template: THREE.Object3D,
  doors: readonly ArenaView["doors"][number][],
): THREE.InstancedMesh[] {
  if (doors.length === 0) return [];
  const frameSrc = template.getObjectByName("frame");
  if (!frameSrc) return [];
  const meshes = staticMeshes(frameSrc, true);
  if (meshes.length === 0) return [];
  frameSrc.updateWorldMatrix(true, true);
  const frameInverse = new THREE.Matrix4().copy(frameSrc.matrixWorld).invert();
  const relatives = meshes.map((mesh) => new THREE.Matrix4().multiplyMatrices(frameInverse, mesh.matrixWorld));
  const frameScale = frameSrc.scale.clone();
  const minY = meshMinY(frameSrc);
  return meshes.map((mesh, index) => instanceMesh(mesh, doors.length, (door, target) => {
    target.copy(doorFrameMatrix(door, frameScale, minY)).multiply(relatives[index]!);
  }, doors));
}

/** Degrees for a wall that omitted yaw. These are the four `wallAnchor` results, not a new turn. */
export function wallInstancePose(wall: ArenaView["walls"][number], bounds: ArenaView["bounds"]): InstancePose {
  const anchor = wallAnchor(wall.face, wall, bounds);
  const position: [number, number, number] = wall.position ?? [anchor.x, 0, anchor.z];
  return {
    position,
    yaw: wall.yaw === undefined ? anchorDegrees(anchor.yaw) : wall.yaw,
    scale: wall.scale ?? 1,
  };
}

/** A prop sits on its AABB bottom. Yaw is 0. Scale is the box size, not a uniform asset scale. */
export function propInstancePose(prop: ArenaView["props"][number]): InstancePose {
  const w = Math.max(0.1, prop.maxX - prop.minX);
  const h = Math.max(0.1, prop.maxY - prop.minY);
  const d = Math.max(0.1, prop.maxZ - prop.minZ);
  return {
    position: [(prop.minX + prop.maxX) / 2, prop.minY, (prop.minZ + prop.maxZ) / 2],
    yaw: 0,
    scale: [w, h, d],
  };
}

function anchorDegrees(radians: number): number {
  if (Math.abs(radians) < 1e-6) return 0;
  if (Math.abs(radians - Math.PI) < 1e-6) return 180;
  if (Math.abs(radians + Math.PI / 2) < 1e-6) return 270;
  if (Math.abs(radians - Math.PI / 2) < 1e-6) return 90;
  return radians * (180 / Math.PI);
}

function orientDoorFrame(frame: THREE.Object3D, yawDegrees: number, minY: number): void {
  frame.quaternion.setFromAxisAngle(UP, yawToRadians(yawDegrees));
  frame.position.set(0, -minY, 0);
}

function doorFrameMatrix(door: ArenaView["doors"][number], frameScale: THREE.Vector3, minY: number): THREE.Matrix4 {
  const group = new THREE.Group();
  group.position.set(door.position[0], door.position[1], door.position[2]);
  const frame = new THREE.Group();
  frame.scale.copy(frameScale);
  orientDoorFrame(frame, door.yaw, minY);
  group.add(frame);
  group.updateMatrixWorld(true);
  return frame.matrixWorld.clone();
}

/**
 * `T * R(yaw) * R(glb root) * S`. Same parent yaw and child scale as
 * `placeBuildingModel`. The root translation in the file is not reapplied.
 */
function modelMatrix(pose: InstancePose, rootQuaternion: THREE.Quaternion): THREE.Matrix4 {
  const group = new THREE.Group();
  group.position.set(pose.position[0], pose.position[1], pose.position[2]);
  group.rotation.y = yawToRadians(pose.yaw);
  const model = new THREE.Group();
  model.quaternion.copy(rootQuaternion);
  const scale = pose.scale;
  if (typeof scale === "number") model.scale.setScalar(scale);
  else model.scale.set(scale[0], scale[1], scale[2]);
  group.add(model);
  group.updateMatrixWorld(true);
  return model.matrixWorld.clone();
}

function instanceMesh<T>(
  source: THREE.Mesh,
  count: number,
  matrixAt: (item: T, target: THREE.Matrix4) => void,
  items: readonly T[],
): THREE.InstancedMesh {
  const instanced = new THREE.InstancedMesh(source.geometry, source.material, count);
  instanced.name = source.name;
  const matrix = new THREE.Matrix4();
  for (let index = 0; index < count; index += 1) {
    matrixAt(items[index]!, matrix);
    instanced.setMatrixAt(index, matrix);
  }
  instanced.instanceMatrix.needsUpdate = true;
  instanced.computeBoundingSphere();
  return instanced;
}

function staticMeshes(root: THREE.Object3D, skipDoor: boolean): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = [];
  root.traverse((object) => {
    const mesh = object as THREE.SkinnedMesh;
    if (!mesh.isMesh || mesh.isSkinnedMesh) return;
    if (skipDoor && underNamed(mesh, "door")) return;
    meshes.push(mesh);
  });
  return meshes;
}

function underNamed(object: THREE.Object3D, name: string): boolean {
  let current: THREE.Object3D | null = object;
  while (current) {
    if (current.name === name) return true;
    current = current.parent;
  }
  return false;
}

/**
 * Place the model at the manifest position, yaw, and scale. The origin stays
 * the GLB origin, so the mesh matches the baked AABBs. Scale defaults to 1.
 */
/** Place a baked building at its manifest position, yaw, and scale. The origin stays the GLB origin. */
export function placeBuildingModel(template: THREE.Object3D, building: ArenaView["buildings"][number]): THREE.Group {
  const group = new THREE.Group();
  group.position.set(building.position[0], building.position[1], building.position[2]);
  group.rotation.y = yawToRadians(building.yaw);
  const model = template.clone(true);
  model.scale.setScalar(building.scale);
  model.position.set(0, 0, 0);
  group.add(model);
  return group;
}

export function placeWallModel(template: THREE.Object3D, wall: ArenaView["walls"][number], bounds: ArenaView["bounds"]): THREE.Group {
  const anchor = wallAnchor(wall.face, wall, bounds);
  const scale = wall.scale ?? 1;
  const group = new THREE.Group();
  if (wall.position) group.position.set(wall.position[0], wall.position[1], wall.position[2]);
  else group.position.set(anchor.x, 0, anchor.z);
  group.rotation.y = wall.yaw === undefined ? anchor.yaw : yawToRadians(wall.yaw);
  const model = template.clone(true);
  model.scale.setScalar(scale);
  model.position.set(0, 0, 0);
  group.add(model);
  return group;
}

export async function loadArenaVisuals(view: ArenaView, arena: ArenaScene): Promise<{ templates: CharacterTemplates; fallbacks: number }> {
  let fallbacks = 0;
  const castsShadow = view.shadows !== undefined && view.shadows.quality !== "off";
  if (view.floor) {
    const floorMap = await texture(view.floor.texture);
    if (!floorMap) fallbacks += 1;
    if (floorMap) floorMap.repeat.set(36, 36);
    const width = view.bounds.maxX - view.bounds.minX;
    const depth = view.bounds.maxZ - view.bounds.minZ;
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(width*2, depth*2, 1, 1),
      new THREE.MeshStandardMaterial({ map: floorMap, color: floorMap ? 0xffffff : 0x2a303a, roughness: 0.95 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = view.floor.y;
    floor.receiveShadow = castsShadow;
    arena.scene.add(floor);
  }

  const loader = new GLTFLoader();
  const modelCache = new Map<string, { scene: THREE.Object3D; clips: THREE.AnimationClip[] } | undefined>();
  async function model(url: string): Promise<{ scene: THREE.Object3D; clips: THREE.AnimationClip[] } | undefined> {
    if (modelCache.has(url)) return modelCache.get(url);
    try {
      const gltf = await loader.loadAsync(url);
      const loaded = { scene: gltf.scene, clips: gltf.animations ?? [] };
      modelCache.set(url, loaded);
      return loaded;
    } catch(e) {
      console.warn(`Failed to load model ${url}:`, e);
      modelCache.set(url, undefined);
      return undefined;
    }
  }

  const staticUris = new Set(view.staticModels ?? []);
  // World-space batches. Walls and buildings share a parent, so one model is one InstancedMesh.
  const sceneBatches = new Map<string, Array<{ pose: InstancePose; clone: (template: THREE.Object3D) => void }>>();
  function pushScene(url: string, pose: InstancePose, clone: (template: THREE.Object3D) => void) {
    const list = sceneBatches.get(url) ?? [];
    list.push({ pose, clone });
    sceneBatches.set(url, list);
  }

  const cloneWalls: ArenaView["walls"] = [];
  for (const wall of view.walls) {
    if (!staticUris.has(wall.model)) {
      cloneWalls.push(wall);
      continue;
    }
    pushScene(wall.model, wallInstancePose(wall, view.bounds), (template) => {
      const facade = placeWallModel(template, wall, view.bounds);
      markShadowCasters(facade, castsShadow);
      arena.scene.add(facade);
    });
  }

  const cloneBuildings: ArenaView["buildings"] = [];
  for (const building of view.buildings ?? []) {
    if (!staticUris.has(building.model)) {
      cloneBuildings.push(building);
      continue;
    }
    pushScene(building.model, {
      position: building.position,
      yaw: building.yaw,
      scale: building.scale,
    }, (template) => {
      const mesh = placeBuildingModel(template, building);
      markShadowCasters(mesh, castsShadow);
      arena.scene.add(mesh);
    });
  }

  for (const [url, entries] of sceneBatches) {
    const template = (await model(url))?.scene;
    if (!template) {
      fallbacks += entries.length;
      continue;
    }
    const meshes = placeStaticInstances(template, entries.map((entry) => entry.pose));
    if (meshes.length === 0) {
      for (const entry of entries) entry.clone(template);
      continue;
    }
    for (const mesh of meshes) {
      markShadowCasters(mesh, castsShadow);
      arena.scene.add(mesh);
    }
  }

  for (const wall of cloneWalls) {
    const loaded = await model(wall.model);
    const template = loaded?.scene;
    if (!template) {
      fallbacks += 1;
      continue;
    }
    // Facade front is local +Z (mesh normals). Same yaw the panel planes used.
    const facade = placeWallModel(template, wall, view.bounds);
    markShadowCasters(facade, castsShadow);
    arena.scene.add(facade);
  }

  for (const building of cloneBuildings) {
    const loaded = await model(building.model);
    const template = loaded?.scene;
    if (!template) {
      fallbacks += 1;
      continue;
    }
    const mesh = placeBuildingModel(template, building);
    markShadowCasters(mesh, castsShadow);
    arena.scene.add(mesh);
  }

  if (view.sky) {
    const skyMap = await texture(view.sky.texture);
    if (!skyMap) fallbacks += 1;
    arena.scene.add(backdropMesh(
      skyMap,
      view.sky.shape,
      view.sky.radius,
      view.sky.height,
      new THREE.MeshBasicMaterial({ color: skyMap ? 0xffffff : 0x8eb8d4, side: THREE.BackSide, depthWrite: false }),
    ));
  }

  if (view.cityscape) {
    const cityMap = await cityscapeTexture(view.cityscape.texture);
    if (!cityMap) fallbacks += 1;
    else arena.scene.add(backdropMesh(
      cityMap,
      view.cityscape.shape,
      view.cityscape.radius,
      view.cityscape.height,
      new THREE.MeshBasicMaterial({ side: THREE.BackSide, alphaTest: 0.5 }),
    ));
  }

  const doorList = view.doors ?? [];
  const staticDoors = new Map<string, ArenaView["doors"]>();
  const cloneDoors: ArenaView["doors"] = [];
  for (const door of doorList) {
    if (!staticUris.has(door.model)) {
      cloneDoors.push(door);
      continue;
    }
    const list = staticDoors.get(door.model) ?? [];
    list.push(door);
    staticDoors.set(door.model, list);
  }
  for (const [url, doors] of staticDoors) {
    const template = (await model(url))?.scene;
    if (!template) {
      fallbacks += doors.length;
      continue;
    }
    const frames = placeStaticDoorFrames(template, doors);
    for (const frame of frames) {
      markShadowCasters(frame, castsShadow);
      arena.content.add(frame);
    }
    for (const door of doors) {
      // No static frame meshes (a skinned file): clone the whole door.
      // Otherwise the leaf is the only clone. The frame draw is the InstancedMesh above.
      const group = placeDoorModel(template, door, frames.length === 0 ? undefined : { frameMeshes: false });
      markShadowCasters(group, castsShadow);
      arena.content.add(group);
    }
  }
  const doorGroups = await placeDoorPlacements(cloneDoors, async (url) => (await model(url))?.scene);
  fallbacks += cloneDoors.length - doorGroups.length;
  for (const panel of doorGroups) {
    markShadowCasters(panel, castsShadow);
    arena.content.add(panel);
  }

  const cloneProps: ArenaView["props"] = [];
  const propBatches = new Map<string, ArenaView["props"]>();
  for (const prop of view.props) {
    if (!staticUris.has(prop.model)) {
      cloneProps.push(prop);
      continue;
    }
    const list = propBatches.get(prop.model) ?? [];
    list.push(prop);
    propBatches.set(prop.model, list);
  }
  for (const [url, props] of propBatches) {
    const template = (await model(url))?.scene;
    if (!template) {
      for (const prop of props) addProp(undefined, prop);
      continue;
    }
    const meshes = placeStaticInstances(template, props.map(propInstancePose));
    if (meshes.length === 0) {
      for (const prop of props) addProp(template, prop);
      continue;
    }
    for (const mesh of meshes) {
      markShadowCasters(mesh, castsShadow);
      arena.content.add(mesh);
    }
  }
  for (const prop of cloneProps) addProp((await model(prop.model))?.scene, prop);

  function addProp(template: THREE.Object3D | undefined, prop: ArenaView["props"][number]) {
    const w = Math.max(0.1, prop.maxX - prop.minX);
    const h = Math.max(0.1, prop.maxY - prop.minY);
    const d = Math.max(0.1, prop.maxZ - prop.minZ);
    if (!template) {
      fallbacks += 1;
      const box = new THREE.Mesh(
        new THREE.BoxGeometry(w, h, d),
        new THREE.MeshStandardMaterial({ color: 0x6b7380, roughness: 0.7 }),
      );
      box.position.set((prop.minX + prop.maxX) / 2, prop.minY + h / 2, (prop.minZ + prop.maxZ) / 2);
      markShadowCasters(box, castsShadow);
      arena.content.add(box);
      return;
    }
    const mesh = template.clone(true);
    mesh.scale.set(w, h, d);
    mesh.position.set((prop.minX + prop.maxX) / 2, prop.minY, (prop.minZ + prop.maxZ) / 2);
    markShadowCasters(mesh, castsShadow);
    arena.content.add(mesh);
  }

  const templates: CharacterTemplates = new Map();
  for (const character of view.characters) {
    const source = await model(character.model);
    if (!source) {
      fallbacks += 1;
      continue;
    }
    // Skinned pawns are cloned per spawn. `"instance": "static"` does not apply.
    // Scale, the idle foot drop, and fall root motion live on this copy.
    // The cached scene stays at 1 and is not retargeted.
    const prepared = prepareCharacter(source.scene, source.clips, character.scale, {
      idle: character.animations.idle.clip,
      fall: character.animations.fall.clip,
    });
    markShadowCasters(prepared.object, castsShadow);
    templates.set(character.id, {
      object: prepared.object,
      clips: prepared.clips,
      animations: character.animations,
    });
  }
  return { templates, fallbacks };
}
