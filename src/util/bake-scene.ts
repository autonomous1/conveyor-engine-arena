/**
 * Static arena for the map bake. Placements go through the same helpers as
 * the live scene (`placeBuildingModel`, `placeStaticInstances`, door frames).
 * Sky and cityscape are omitted: from above they cover the room. Pawns are
 * omitted so the picture stays a background.
 */

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { ArenaView } from "../shared/arena-view.ts";
import { propClipName } from "../shared/arena-view.ts";
import {
  placeBuildingModel,
  placeDoorModel,
  placeStaticDoorFrames,
  placeStaticInstances,
  placeWallModel,
  propInstancePose,
  wallInstancePose,
  type InstancePose,
} from "../client/arena-scene.ts";

export async function buildMapScene(view: ArenaView): Promise<THREE.Scene> {
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xc8d8ff, 0x3a3228, 1.3));
  const key = new THREE.DirectionalLight(0xfff2d6, 2.3);
  key.position.set(120, 180, 80);
  key.target.position.set(0, 0, 0);
  scene.add(key.target);
  scene.add(key);

  if (view.floor) {
    const floorMap = await loadTexture(view.floor.texture);
    floorMap.repeat.set(12, 12);
    const width = view.bounds.maxX - view.bounds.minX;
    const depth = view.bounds.maxZ - view.bounds.minZ;
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(width * 2, depth * 2, 1, 1),
      new THREE.MeshStandardMaterial({ map: floorMap, color: 0xffffff, roughness: 0.95 }),
    );
    floor.name = "floor";
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = view.floor.y;
    scene.add(floor);
  }

  const content = new THREE.Group();
  content.name = "map-content";
  scene.add(content);
  const loader = new GLTFLoader();
  const cache = new Map<string, THREE.Object3D>();
  async function model(url: string): Promise<THREE.Object3D> {
    const cached = cache.get(url);
    if (cached) return cached;
    console.log("load", url);
    try {
      const gltf = await loader.loadAsync(url);
      cache.set(url, gltf.scene);
      return gltf.scene;
    } catch (err) {
      throw new Error(`failed to load ${url}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const staticUris = new Set(view.staticModels ?? []);
  await placeWalls(view, staticUris, model, content);
  await placeBuildings(view, staticUris, model, content);
  await placeDoors(view, staticUris, model, content);
  await placeProps(view, staticUris, model, content);
  return scene;
}

async function loadTexture(url: string): Promise<THREE.Texture> {
  try {
    const map = await new THREE.TextureLoader().loadAsync(url);
    map.colorSpace = THREE.SRGBColorSpace;
    map.wrapS = THREE.RepeatWrapping;
    map.wrapT = THREE.RepeatWrapping;
    return map;
  } catch (err) {
    throw new Error(`failed to load ${url}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function placeWalls(
  view: ArenaView,
  staticUris: ReadonlySet<string>,
  model: (url: string) => Promise<THREE.Object3D>,
  content: THREE.Object3D,
): Promise<void> {
  const batches = new Map<string, ArenaView["walls"]>();
  const clones: ArenaView["walls"] = [];
  for (const wall of view.walls ?? []) {
    if (!staticUris.has(wall.model)) {
      clones.push(wall);
      continue;
    }
    const list = batches.get(wall.model) ?? [];
    list.push(wall);
    batches.set(wall.model, list);
  }
  for (const [url, walls] of batches) {
    const template = await model(url);
    const poses = walls.map((wall) => wallInstancePose(wall, view.bounds));
    if (!addInstances(content, template, poses)) {
      for (const wall of walls) content.add(placeWallModel(template, wall, view.bounds));
    }
  }
  for (const wall of clones) {
    const template = await model(wall.model);
    content.add(placeWallModel(template, wall, view.bounds));
  }
}

async function placeBuildings(
  view: ArenaView,
  staticUris: ReadonlySet<string>,
  model: (url: string) => Promise<THREE.Object3D>,
  content: THREE.Object3D,
): Promise<void> {
  const batches = new Map<string, ArenaView["buildings"]>();
  const clones: ArenaView["buildings"] = [];
  for (const building of view.buildings ?? []) {
    if (!staticUris.has(building.model)) {
      clones.push(building);
      continue;
    }
    const list = batches.get(building.model) ?? [];
    list.push(building);
    batches.set(building.model, list);
  }
  for (const [url, buildings] of batches) {
    const template = await model(url);
    const poses = buildings.map((building) => ({
      position: building.position,
      yaw: building.yaw,
      scale: building.scale,
    }));
    if (!addInstances(content, template, poses)) {
      for (const building of buildings) content.add(placeBuildingModel(template, building));
    }
  }
  for (const building of clones) {
    content.add(placeBuildingModel(await model(building.model), building));
  }
}

async function placeDoors(
  view: ArenaView,
  staticUris: ReadonlySet<string>,
  model: (url: string) => Promise<THREE.Object3D>,
  content: THREE.Object3D,
): Promise<void> {
  const batches = new Map<string, ArenaView["doors"]>();
  const clones: ArenaView["doors"] = [];
  for (const door of view.doors ?? []) {
    if (!staticUris.has(door.model)) {
      clones.push(door);
      continue;
    }
    const list = batches.get(door.model) ?? [];
    list.push(door);
    batches.set(door.model, list);
  }
  for (const [url, doors] of batches) {
    const template = await model(url);
    const frames = placeStaticDoorFrames(template, doors);
    for (const frame of frames) content.add(frame);
    for (const door of doors) {
      content.add(placeDoorModel(template, door, frames.length === 0 ? undefined : { frameMeshes: false }));
    }
  }
  for (const door of clones) {
    content.add(placeDoorModel(await model(door.model), door));
  }
}

async function placeProps(
  view: ArenaView,
  staticUris: ReadonlySet<string>,
  model: (url: string) => Promise<THREE.Object3D>,
  content: THREE.Object3D,
): Promise<void> {
  const batches = new Map<string, ArenaView["props"]>();
  const clones: ArenaView["props"] = [];
  for (const prop of view.props ?? []) {
    // A clip needs its own clone. The bake keeps the rest pose.
    if (propClipName(prop) || !staticUris.has(prop.model)) {
      clones.push(prop);
      continue;
    }
    const list = batches.get(prop.model) ?? [];
    list.push(prop);
    batches.set(prop.model, list);
  }
  for (const [url, props] of batches) {
    const template = await model(url);
    if (!addInstances(content, template, props.map(propInstancePose))) {
      for (const prop of props) content.add(propObject(template, prop));
    }
  }
  for (const prop of clones) content.add(propObject(await model(prop.model), prop));
}

function addInstances(content: THREE.Object3D, template: THREE.Object3D, poses: readonly InstancePose[]): boolean {
  const meshes = placeStaticInstances(template, poses);
  if (meshes.length === 0) return false;
  for (const mesh of meshes) content.add(mesh);
  return true;
}

/** Same mount as a building when the prop has a placement pose. Otherwise fit the AABB. */
function propObject(template: THREE.Object3D, prop: ArenaView["props"][number]): THREE.Object3D {
  if (prop.position && typeof prop.scale === "number") {
    return placeBuildingModel(template, {
      id: prop.id,
      model: prop.model,
      position: prop.position,
      yaw: prop.yaw ?? 0,
      scale: prop.scale,
    });
  }
  const w = Math.max(0.1, prop.maxX - prop.minX);
  const h = Math.max(0.1, prop.maxY - prop.minY);
  const d = Math.max(0.1, prop.maxZ - prop.minZ);
  const mesh = template.clone(true);
  mesh.scale.set(w, h, d);
  mesh.position.set((prop.minX + prop.maxX) / 2, prop.minY, (prop.minZ + prop.maxZ) / 2);
  return mesh;
}
