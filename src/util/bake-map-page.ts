/**
 * Headless page opened by `bake-map.ts`. Renders one top-down frame and
 * posts the PNG back to that process. Not part of the game client.
 */

import * as THREE from "three";
import type { ArenaView } from "../shared/arena-view.ts";
import { MAP_BAKE_BACKGROUND, MAP_BAKE_PX } from "../shared/map-frame.ts";
import { buildMapScene } from "./bake-scene.ts";
import { topDownCamera } from "./map-camera.ts";

declare global {
  var __mapBakeStatus: string | undefined;
}

const status = (text: string) => {
  globalThis.__mapBakeStatus = text;
};

globalThis.addEventListener("error", (ev) => {
  status(`error: ${ev.message}`);
});
globalThis.addEventListener("unhandledrejection", (ev) => {
  const reason = ev.reason;
  status(`error: ${reason instanceof Error ? reason.message : String(reason)}`);
});

status("start");

try {
  const res = await fetch("/view.json");
  if (!res.ok) throw new Error(`view.json ${res.status}`);
  const view = await res.json() as ArenaView;
  status("scene");
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, premultipliedAlpha: false, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(MAP_BAKE_PX, MAP_BAKE_PX, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  // Alpha 0: the PNG background is transparent so the panel shows through.
  renderer.setClearColor(MAP_BAKE_BACKGROUND, 0);
  const scene = await buildMapScene(view, renderer);
  const camera = topDownCamera(view.bounds, MAP_BAKE_PX, MAP_BAKE_PX);
  if (!camera) throw new Error("scene bounds are empty");
  document.body.appendChild(renderer.domElement);
  const gl = renderer.getContext();
  console.log("webgl", gl.getParameter(gl.VERSION));
  scene.updateMatrixWorld(true);
  renderer.compile(scene, camera);
  renderer.render(scene, camera);
  renderer.render(scene, camera);
  gl.finish();
  const contrast = sampleContrast(gl);
  console.log("contrast", contrast);
  if (contrast < 24) throw new Error(`flat image, contrast ${contrast}`);
  let meshes = 0;
  scene.traverse((object) => {
    if ((object as THREE.Mesh).isMesh) meshes += 1;
  });
  console.log("meshes", meshes);
  if (meshes < 2) throw new Error(`scene has ${meshes} meshes`);
  status("upload");
  // No flip. The camera's up is world −Z, so the canvas already shows the true
  // top-down view: world −Z at the top, +X right, matching mapImagePixel.
  const blob = await canvasPng(renderer.domElement);
  if (!blob) throw new Error("png encode failed");
  const posted = await fetch("/png", { method: "POST", body: blob });
  if (!posted.ok) throw new Error(`png post ${posted.status}`);
  status("done");
} catch (err) {
  status(`error: ${err instanceof Error ? err.message : String(err)}`);
  console.error(err);
}

function canvasPng(glCanvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => glCanvas.toBlob((blob) => resolve(blob), "image/png"));
}

function sampleContrast(gl: WebGLRenderingContext | WebGL2RenderingContext): number {
  const width = gl.drawingBufferWidth;
  const height = gl.drawingBufferHeight;
  const pixel = new Uint8Array(4);
  let min = 255 * 3;
  let max = 0;
  const step = Math.max(1, Math.floor(Math.min(width, height) / 48));
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      const luma = (pixel[0] ?? 0) + (pixel[1] ?? 0) + (pixel[2] ?? 0);
      if (luma < min) min = luma;
      if (luma > max) max = luma;
    }
  }
  return max - min;
}
