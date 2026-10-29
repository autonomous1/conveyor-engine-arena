import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { allowKtx2 } from "./ktx2-stub.ts";
import { createPawnLayer } from "../src/client/presentation.ts";
import type { CharacterTemplates, CharacterVisual } from "../src/client/arena-scene.ts";
import { prepareCharacter, skinnedSoleGap } from "../src/client/pawn-feet.ts";
import { EYE_HEIGHT } from "../src/shared/look.ts";
import { findClip } from "../src/shared/movements.ts";

const manifest = JSON.parse(readFileSync(fileURLToPath(new URL("../web/game/arena.game.json", import.meta.url)), "utf8")) as {
  assets: Array<{ id: string; uri: string; scale?: number; animations?: Record<string, { clip: string; speed: number }> }>;
  player: { modelChoices: string[] };
};

test("idle and fallen pawns rest on the floor and the shot stays at eye height", async () => {
  assert.equal(EYE_HEIGHT, 1.6);
  for (const id of manifest.player.modelChoices) {
    const asset = manifest.assets.find((item) => item.id === id);
    assert.ok(asset?.animations, `${id} has no clips`);
    const gltf = await loadGltf(fileURLToPath(new URL(`../web${asset.uri}`, import.meta.url)));
    const prepared = prepareCharacter(gltf.scene, gltf.animations, asset.scale ?? 1, {
      idle: asset.animations.idle.clip,
      fall: asset.animations.fall.clip,
    });
    for (const clip of prepared.clips) {
      for (const track of clip.tracks) {
        assert.equal(track.name.endsWith(".position"), false, `${id} ${track.name} writes position`);
        assert.equal(track.name.includes("position[y]") || track.name.endsWith(".position.y"), false, track.name);
      }
    }
    const sourceFall = findClip(gltf.animations, asset.animations.fall.clip);
    assert.ok(sourceFall, `${id} fall clip`);
    const fall = findClip(prepared.clips, asset.animations.fall.clip);
    assert.ok(fall, `${id} fall clip`);
    // withoutRootMotionY keeps X and Z only when the source root's Y actually moves.
    const keepsRoot = rootYSpan(sourceFall) > 1e-4;
    if (keepsRoot) {
      assert.ok(fall.tracks.some((track) => track.name.endsWith(".position[x]")), `${id} fall keeps root x`);
      assert.ok(fall.tracks.some((track) => track.name.endsWith(".position[z]")), `${id} fall keeps root z`);
    } else {
      assert.equal(fall.tracks.some((track) => track.name.includes("position")), false, `${id} fall has no root motion to keep`);
    }

    const templates: CharacterTemplates = new Map([
      [id, { object: prepared.object, clips: prepared.clips, animations: asset.animations as CharacterVisual["animations"] }],
    ]);
    const parent = new THREE.Group();
    const pawns = createPawnLayer(parent, templates, 1.8);
    const idle = findClip(prepared.clips, asset.animations.idle.clip);
    // The first 0.15 s fades in from the bind pose. Measure the settled clip.
    pawns.apply(snap(id, "idle"), 0.2, () => undefined);
    const idleSteps = idle ? 8 : 1;
    const idleDt = idle ? idle.duration / idleSteps : 0.05;
    // The parent drop is a fixed 10 cm, and only when the lowest idle sole is
    // above 5 cm. A clip that bobs through the floor stays where it was authored.
    for (let i = 0; i < idleSteps; i++) {
      pawns.apply(snap(id, "idle"), idleDt, () => undefined);
      const gap = skinnedSoleGap(parent.children[0]!);
      assert.ok(Number.isFinite(gap), `${id} idle sole`);
      assertPawnStays(parent.children[0]!, id);
    }

    const rootTrack = fall.tracks.find((track) => track.name.endsWith(".position[x]"));
    const bone = rootTrack
      ? parent.children[0]!.getObjectByName(rootTrack.name.slice(0, -".position[x]".length))
      : undefined;
    if (rootTrack) assert.ok(bone, `${id} root bone`);
    const restY = bone?.position.y;
    pawns.apply(snap(id, "fall"), 0.05, () => undefined);
    if (bone) assert.equal(bone.position.y, restY, `${id} mixer wrote root position.y`);
    assert.equal(animReport()[0]?.loop, THREE.LoopOnce);
    assert.equal(animReport()[0]?.clamp, true);

    let guard = 0;
    while (animReport()[0]?.running && guard < 400) {
      pawns.apply(snap(id, "fall"), 0.05, () => undefined);
      guard += 1;
    }
    assert.equal(animReport()[0]?.running, false, `${id} fall kept looping`);
    const fallen = skinnedSoleGap(parent.children[0]!);
    assert.ok(Math.abs(fallen) < 0.02, `${id} fallen sole ${fallen.toFixed(3)} m off the floor`);
    for (let i = 0; i < 4; i++) pawns.apply(snap(id, "fall"), 0.1, () => undefined);
    const held = skinnedSoleGap(parent.children[0]!);
    assert.ok(Math.abs(held) < 0.02, `${id} held sole ${held.toFixed(3)} m`);
    assert.ok(Math.abs(held - fallen) < 0.005, `${id} held pose drifted`);
    assertPawnStays(parent.children[0]!, id);
    assert.equal(parent.children[0]!.position.y + EYE_HEIGHT, 1.6);
  }
});

/** Largest Y span on a vector position track. Matches the root-motion cutoff in pawn-feet. */
function rootYSpan(clip: THREE.AnimationClip): number {
  let best = 0;
  for (const track of clip.tracks) {
    if (!track.name.endsWith(".position") || track.getValueSize() < 2) continue;
    const size = track.getValueSize();
    let min = Infinity;
    let max = -Infinity;
    for (let i = 1; i < track.values.length; i += size) {
      const value = track.values[i] ?? 0;
      if (value < min) min = value;
      if (value > max) max = value;
    }
    if (max - min > best) best = max - min;
  }
  return best;
}

function assertPawnStays(root: THREE.Object3D, id: string): void {
  assert.deepEqual([root.position.x, root.position.y, root.position.z], [3, 0, 4], `${id} pawn transform moved`);
}

function snap(assetKey: string, movement: string) {
  return {
    frame: 1,
    serverTick: 1n,
    snapshotSeq: 1,
    entities: [{
      id: 1,
      render: { assetKey },
      position: { x: 3, y: 0, z: 4 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 1, y: 1, z: 1 },
      clip: movement,
      speed: 0,
      visible: true,
      lifecycle: "alive" as const,
      predicted: false,
    }],
  };
}

type AnimRow = { running?: boolean; loop?: number; clamp?: boolean };

function animReport(): AnimRow[] {
  return (globalThis as { __pawnAnim?: AnimRow[] }).__pawnAnim ?? [];
}

function loadGltf(path: string): Promise<{ scene: THREE.Group; animations: THREE.AnimationClip[] }> {
  const selfHost = globalThis as { self?: unknown; createImageBitmap?: (blob: Blob) => Promise<unknown> };
  selfHost.self ??= globalThis;
  selfHost.createImageBitmap ??= async (blob: Blob) => {
    const data = new Uint8Array(await blob.arrayBuffer());
    return { width: 1, height: 1, data, close() {} };
  };
  const bytes = readFileSync(path);
  const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const loader = new GLTFLoader();
  allowKtx2(loader);
  return new Promise((resolve, reject) => {
    loader.parse(
      data,
      "",
      (gltf) => resolve({ scene: gltf.scene, animations: gltf.animations ?? [] }),
      (err) => reject(err instanceof Error ? err : new Error(String(err))),
    );
  });
}
