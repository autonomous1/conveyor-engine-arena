import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { playPropClip } from "../src/client/arena-scene.ts";
import { startPropAnimation } from "../dist/server/game.js";
import { compileGame } from "../dist/server/game-manifest.js";
import { projectRoot, readManifestSources } from "../dist/server/load-game.js";
import { propClipName, type Prop } from "../src/shared/arena-view.ts";

test("alien-weapon-1 plays rotate and a still prop gets no mixer", async () => {
  const root = projectRoot();
  const doc = JSON.parse(readFileSync(path.join(root, "web/game/arena.game.json"), "utf8")) as {
    assets?: Array<{ uri?: unknown }>;
    scene: Record<string, unknown>;
  };
  const files = new Map<string, Uint8Array>();
  for (const asset of doc.assets ?? []) {
    if (typeof asset.uri !== "string") continue;
    files.set(asset.uri, new Uint8Array(readFileSync(path.join(root, "web", asset.uri))));
  }
  const scene = structuredClone(doc);
  scene.scene.placements = ["./web/game/props.placements.json"];
  scene.scene.bounds = { minX: -80, maxX: 80, minY: -2, maxY: 12, minZ: -80, maxZ: 80 };
  scene.scene.spawnPoints = [];
  const game = compileGame(scene, (uri) => files.get(uri), readManifestSources(root, scene));
  const weapon = game.view.props.find((prop) => prop.id === "alien-weapon-1");
  assert.ok(weapon);
  assert.equal(propClipName(weapon), "rotate");
  const still: Prop = {
    ...weapon,
    id: "still-box",
    animation: undefined,
    animations: undefined,
  };
  assert.equal(propClipName(still), undefined);
  assert.deepEqual(startPropAnimation([weapon, still]), [{ id: "alien-weapon-1", clip: "rotate" }]);
  assert.deepEqual(startPropAnimation([still]), []);

  const loaded = await loadGlb("alien-weapon-enh.glb");
  const clip = loaded.clips.find((item) => item.name === "rotate");
  assert.ok(clip);
  assert.ok(clip.tracks.some((track) => track.name.endsWith(".quaternion")));

  const spinning = loaded.scene.clone(true);
  const mixer = playPropClip(spinning, loaded.clips, propClipName(weapon));
  assert.ok(mixer);
  const action = mixer.existingAction(clip);
  assert.ok(action);
  assert.equal(action.getClip().name, "rotate");
  assert.equal(action.loop, THREE.LoopRepeat);
  assert.equal(action.repetitions, Infinity);
  assert.equal(action.clampWhenFinished, false);
  assert.equal(action.timeScale, 1);
  assert.equal(action.isRunning(), true);
  const posed = quaternions(loaded.scene);
  const before = quaternions(spinning);
  mixer.update(0.5);
  assert.equal(action.isRunning(), true);
  assert.ok(moved(before, quaternions(spinning)), "rotate clip turns the prop mesh");
  assert.equal(moved(posed, quaternions(loaded.scene)), false);
  mixer.update(clip.duration + 0.25);
  assert.equal(action.isRunning(), true);

  const quiet = loaded.scene.clone(true);
  const beforeQuiet = quaternions(quiet);
  assert.equal(playPropClip(quiet, loaded.clips, propClipName(still)), undefined);
  assert.equal(moved(beforeQuiet, quaternions(quiet)), false);

  const host = startPropAnimation.toString();
  assert.equal(/\benqueue\b|setClip|AuthoritativeWorld|worldEnqueue/.test(host), false);
  const main = readFileSync(path.join(root, "src/server/main.ts"), "utf8");
  assert.match(main, /startPropAnimation\(loaded\.view\.props\)/);
  assert.match(main, /JSON\.stringify\(\{ \.\.\.loaded\.view, propClips \}\)/);
  assert.equal(/startPropAnimation\([^)\n]*world/.test(main), false);
  assert.equal(/AnimationMixer|mixer\.update/.test(main), false);
  const client = readFileSync(path.join(root, "src/client/main.ts"), "utf8");
  assert.match(client, /for \(const mixer of visuals\.propMixers\) mixer\.update\(dt\)/);
});

function quaternions(root: THREE.Object3D): Map<string, THREE.Quaternion> {
  const out = new Map<string, THREE.Quaternion>();
  root.traverse((object) => {
    out.set(object.uuid, object.quaternion.clone());
  });
  return out;
}

function moved(before: Map<string, THREE.Quaternion>, after: Map<string, THREE.Quaternion>): boolean {
  for (const [id, quaternion] of before) {
    const next = after.get(id);
    if (!next) continue;
    if (Math.abs(quaternion.dot(next)) < 0.999) return true;
  }
  return false;
}

function loadGlb(name: string): Promise<{ scene: THREE.Object3D; clips: THREE.AnimationClip[] }> {
  const selfHost = globalThis as { self?: unknown; createImageBitmap?: (blob: Blob) => Promise<unknown> };
  selfHost.self ??= globalThis;
  selfHost.createImageBitmap ??= async (blob: Blob) => {
    const data = new Uint8Array(await blob.arrayBuffer());
    return { width: 1, height: 1, data, close() {} };
  };
  const file = path.join(import.meta.dirname, "..", "web", "assets", "models", name);
  const bytes = readFileSync(file);
  const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const loader = new GLTFLoader();
  return new Promise((resolve, reject) => {
    loader.parse(
      data,
      "",
      (gltf) => resolve({ scene: gltf.scene, clips: gltf.animations ?? [] }),
      (err) => reject(err instanceof Error ? err : new Error(String(err))),
    );
  });
}
