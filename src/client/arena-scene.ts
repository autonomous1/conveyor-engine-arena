import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { clone as cloneWithSkeleton } from "three/addons/utils/SkeletonUtils.js";
import type { ArenaView, BackdropShape } from "../shared/arena-view.js";
import type { Movement } from "../shared/movements.js";
import { shadowSettings, type ShadowQuality } from "../shared/shadows.ts";

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

/** Quarter-turns match `yawConvention: "y-up-90"`. 90° sends model +X to world −Z. */
function yawToRadians(degrees: number): number {
  const wrapped = ((degrees % 360) + 360) % 360;
  if (wrapped < 1e-6 || wrapped > 360 - 1e-6) return 0;
  if (Math.abs(wrapped - 90) < 1e-6) return Math.PI / 2;
  if (Math.abs(wrapped - 180) < 1e-6) return Math.PI;
  if (Math.abs(wrapped - 270) < 1e-6) return -Math.PI / 2;
  return degrees * (Math.PI / 180);
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
    if (floorMap) floorMap.repeat.set(12, 12);
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

  for (const wall of view.walls) {
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

  for (const building of view.buildings ?? []) {
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

  for (const prop of view.props) {
    const template = (await model(prop.model))?.scene;
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
      continue;
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
    // Scale the spawned copy from the asset's scale. The cached scene stays at 1.
    // Drop position tracks so a clip cannot carry the pawn away from the snapshot.
    const template = cloneWithSkeleton(source.scene);
    template.scale.multiplyScalar(character.scale);
    markShadowCasters(template, castsShadow);
    const clips = source.clips.map((clip) => new THREE.AnimationClip(
      clip.name,
      clip.duration,
      clip.tracks.filter((track) => !track.name.endsWith(".position")),
    ));
    templates.set(character.id, { object: template, clips, animations: character.animations });
  }
  return { templates, fallbacks };
}
