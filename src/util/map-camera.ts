/**
 * Orthographic camera for the map bake.
 *
 * The camera looks down world −Y. `camera.up` is (0, 0, −1), so local +X is
 * world +X and local +Y is world −Z. The frustum keeps top above bottom.
 * Swapping them would reverse triangle winding and cull the floor and the
 * roofs. The PNG is flipped vertically after the render (`mapImagePixel`),
 * which puts world +Z at the top without touching winding.
 *
 * Check: world +X projects to +NDC x. Before the flip, world +Z is −NDC y.
 */

import * as THREE from "three";
import { MAP_BAKE_PX, MAP_PAD, SCENE_MAP_SIZE, mapFrame, type MapBounds } from "../shared/map-frame.ts";

export { MAP_BAKE_PX };

/** Above the roofs (`bounds.maxY` is about 12) and inside the 400 m far plane. */
const EYE_Y = 200;
const NEAR = 0.5;
const FAR = 400;

export function topDownCamera(bounds: MapBounds, width: number, height: number): THREE.OrthographicCamera | undefined {
  const padX = MAP_PAD * (width / SCENE_MAP_SIZE);
  const padY = MAP_PAD * (height / SCENE_MAP_SIZE);
  const frame = mapFrame(bounds, width, height, padX, padY);
  if (!frame) return undefined;
  const centerX = (frame.viewMinX + frame.viewMaxX) / 2;
  const centerZ = (frame.viewMinZ + frame.viewMaxZ) / 2;
  const halfW = (frame.viewMaxX - frame.viewMinX) / 2;
  const halfD = (frame.viewMaxZ - frame.viewMinZ) / 2;
  const camera = new THREE.OrthographicCamera(-halfW, halfW, halfD, -halfD, NEAR, FAR);
  camera.position.set(centerX, EYE_Y, centerZ);
  camera.up.set(0, 0, -1);
  camera.lookAt(centerX, 0, centerZ);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  return camera;
}

/**
 * Pixel in the written PNG. NDC +Y is the top of the framebuffer, which is
 * world −Z for this camera. The bake flips that image vertically, so world +Z
 * is the top of the file and matches `mapFrame`.
 */
export function mapImagePixel(
  camera: THREE.Camera,
  x: number,
  z: number,
  width: number,
  height: number,
): [number, number] {
  const ndc = new THREE.Vector3(x, 0, z).project(camera);
  return [(ndc.x * 0.5 + 0.5) * width, (ndc.y * 0.5 + 0.5) * height];
}
