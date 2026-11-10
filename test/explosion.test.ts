import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import {
  createExplosionFx,
  EXPLOSION_FPS,
  EXPLOSION_MAX_DT,
  EXPLOSION_POOL_CAP,
  EXPLOSION_SIZE,
  explosionFrameOffset,
  LASER_IMPACT_FALLBACK_FPS,
  LASER_IMPACT_SIZE,
  laserImpactPlaybackFps,
  laserImpactWorldSize,
  resolveLaserImpactSheet,
  resolveSurfaceExplosionSheet,
  SURFACE_BLAST_STANDOFF,
  surfaceBlastPose,
  surfaceExplosionPlaybackFps,
  surfaceExplosionWorldSize,
} from "../src/client/explosion.ts";

const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} vs ${expected}`);

function atlas(): THREE.Texture {
  const texture = new THREE.Texture({ width: 1536, height: 1280 } as unknown as HTMLImageElement);
  texture.needsUpdate = true; // what TextureLoader does once on load
  return texture;
}

function sprites(fx: ReturnType<typeof createExplosionFx>): THREE.Sprite[] {
  return fx.group.children as THREE.Sprite[];
}

function mapOf(sprite: THREE.Sprite): THREE.Texture {
  return (sprite.material as THREE.SpriteMaterial).map!;
}

test("frame math: 6 × 5 atlas, row 0 at the top", () => {
  const f0 = explosionFrameOffset(0);
  close(f0.x, 0);
  close(f0.y, 0.8);
  const f6 = explosionFrameOffset(6);
  close(f6.x, 0);
  close(f6.y, 0.6);
  const f29 = explosionFrameOffset(29);
  close(f29.x, 5 / 6);
  close(f29.y, 0);
  const f5 = explosionFrameOffset(5);
  close(f5.x, 5 / 6);
  close(f5.y, 0.8);
});

test("one blast plays 30 frames at 30 fps, then hides and returns to the pool", () => {
  const scene = new THREE.Scene();
  const fx = createExplosionFx(scene);
  fx.setAtlas(atlas());
  assert.equal(fx.spawn(1, 2, 3), true);
  assert.equal(fx.activeCount, 1);
  const [sprite] = sprites(fx);
  assert.ok(sprite);
  assert.equal(sprite.visible, true);
  assert.deepEqual([sprite.position.x, sprite.position.y, sprite.position.z], [1, 2, 3]);
  assert.deepEqual([sprite.scale.x, sprite.scale.y], [4, 4]);
  const map = mapOf(sprite);
  close(map.repeat.x, 1 / 6);
  close(map.repeat.y, 1 / 5);
  close(map.offset.y, 0.8);

  fx.update(0.1);
  fx.update(0.1 + 1e-6); // frame 6 (each step is under the 0.1 s cap)
  close(map.offset.x, 0);
  close(map.offset.y, 0.6);
  for (let i = 0; i < 7; i++) fx.update(0.1); // 0.9 s
  fx.update(0.09); // 0.99 s
  assert.equal(fx.activeCount, 1, "still playing just before 1 s");
  fx.update(0.02); // 1.01 s
  assert.equal(fx.activeCount, 0, "done after 30 frames");
  assert.equal(sprite.visible, false);

  assert.equal(fx.spawn(0, 0, 0), true);
  assert.equal(fx.poolSize, 1, "the finished sprite is reused");
  close(map.offset.y, 0.8);
});

test("a long frame is capped, so a hitch does not skip the blast", () => {
  const fx = createExplosionFx(new THREE.Scene());
  fx.setAtlas(atlas());
  fx.spawn(0, 0, 0);
  fx.update(5);
  assert.equal(fx.activeCount, 1);
  close(mapOf(sprites(fx)[0]!).offset.x, Math.floor(EXPLOSION_MAX_DT * 30) / 6);
  fx.update(Number.NaN);
  assert.equal(fx.activeCount, 1);
});

test("pool caps at 8 and restarts the oldest; clones share one Source and never bump it", () => {
  const tex = atlas();
  const sourceVersion = tex.source.version;
  const fx = createExplosionFx(new THREE.Scene());
  fx.setAtlas(tex);
  for (let i = 0; i < EXPLOSION_POOL_CAP; i++) {
    fx.spawn(i, 0, 0);
    fx.update(0.01);
  }
  assert.equal(fx.poolSize, EXPLOSION_POOL_CAP);
  assert.equal(fx.activeCount, EXPLOSION_POOL_CAP);
  fx.spawn(99, 0, 0);
  fx.spawn(98, 0, 0);
  assert.equal(fx.poolSize, EXPLOSION_POOL_CAP, "no sprite past the cap");
  assert.equal(fx.activeCount, EXPLOSION_POOL_CAP);
  const xs = sprites(fx).map((sprite) => sprite.position.x).sort((a, b) => a - b);
  assert.deepEqual(xs, [2, 3, 4, 5, 6, 7, 98, 99], "the two oldest were restarted");
  for (const sprite of sprites(fx)) {
    const map = mapOf(sprite);
    assert.notEqual(map, tex, "own UV transform");
    assert.equal(map.source, tex.source, "shared Source: one GPU upload");
    assert.ok(map.version > 0, "clone is ready to bind");
  }
  assert.equal(tex.source.version, sourceVersion, "spawning never re-uploads the atlas");
  fx.clear();
  assert.equal(fx.activeCount, 0);
  fx.dispose();
  assert.equal(fx.poolSize, 0);
});

test("sheet options from the manifest: layout, fps, size, blending", () => {
  const fx = createExplosionFx(new THREE.Scene(), {
    sheet: { columns: 4, rows: 2, frameCount: 8, fps: 16, size: 2, blending: "additive" },
  });
  fx.setAtlas(atlas());
  fx.spawn(0, 0, 0);
  const sprite = sprites(fx)[0]!;
  assert.equal(sprite.scale.y, 2);
  close(sprite.scale.x, 2 * (1536 / 4) / (1280 / 2));
  assert.equal((sprite.material as THREE.SpriteMaterial).blending, THREE.AdditiveBlending);
  close(mapOf(sprite).offset.y, 0.5);
  assert.equal(fx.duration(), 0.5);
  fx.update(0.09);
  fx.update(0.09);
  fx.update(0.09);
  fx.update(0.09);
  fx.update(0.09);
  assert.equal(fx.activeCount, 1);
  fx.update(0.09);
  assert.equal(fx.activeCount, 0, "8 frames at 16 fps = 0.5 s");
  fx.setBlending("normal");
  assert.equal((sprite.material as THREE.SpriteMaterial).blending, THREE.NormalBlending);
});

test("a failed atlas load is reported once, turns explosions off, and never throws", async () => {
  const errors: unknown[] = [];
  const fx = createExplosionFx(new THREE.Scene(), { onLoadError: (err) => errors.push(err) });
  assert.equal(fx.spawn(0, 0, 0), false, "not loaded yet");
  assert.equal(await fx.load(async () => {
    throw new Error("404");
  }), false);
  assert.equal(await fx.load(async () => atlas()), false, "stays off");
  assert.equal(errors.length, 1);
  assert.equal(fx.enabled, false);
  assert.equal(fx.spawn(0, 0, 0), false);
  assert.doesNotThrow(() => fx.update(0.016));

  const empty = createExplosionFx(new THREE.Scene(), { onLoadError: (err) => errors.push(err) });
  assert.equal(await empty.load(async () => new THREE.Texture()), false, "no image is a failure");
  assert.equal(errors.length, 2);
});

test("load prewarms the shared texture once and rejects bad spawn points", async () => {
  const warmed: THREE.Texture[] = [];
  const fx = createExplosionFx(new THREE.Scene());
  const tex = atlas();
  assert.equal(await fx.load(async () => tex, { initTexture: (t) => void warmed.push(t) }), true);
  assert.equal(warmed.length, 1);
  assert.equal(warmed[0]!.source, tex.source);
  assert.equal(tex.colorSpace, THREE.SRGBColorSpace);
  assert.equal(fx.spawn(Number.NaN, 0, 0), false);
  assert.equal(fx.spawn(0, 0, 0, 0), false);
  assert.equal(fx.activeCount, 0);
});

test("non-square frames: the sprite width follows the image's frame aspect", () => {
  const fx = createExplosionFx(new THREE.Scene(), { sheet: { frameWidth: 256, frameHeight: 256 } });
  const tex = new THREE.Texture({ width: 1356, height: 1280 } as unknown as HTMLImageElement);
  tex.needsUpdate = true;
  fx.setAtlas(tex);
  assert.equal(fx.size, 4);
  fx.spawn(0, 0, 0);
  const sprite = sprites(fx)[0]!;
  close(sprite.scale.x, 4 * 226 / 256);
  assert.equal(sprite.scale.y, 4);
  close(fx.layout.aspect, 226 / 256);
  close(mapOf(sprite).repeat.x, 1 / 6);
  close(mapOf(sprite).repeat.y, 1 / 5);
});

test("sheet.rotation turns SpriteMaterial.rotation; 8×6 beam sheet plays 48 frames at 24 fps", () => {
  const scene = new THREE.Scene();
  const fx = createExplosionFx(scene, {
    sheet: { columns: 8, rows: 6, frameCount: 48, fps: 24, size: 1.8, frameWidth: 256, frameHeight: 256, blending: "additive", rotation: 90 },
  });
  const tex = new THREE.Texture({ width: 2048, height: 1536 } as unknown as HTMLImageElement);
  tex.needsUpdate = true;
  fx.setAtlas(tex);
  assert.equal(fx.rotation, Math.PI / 2);
  assert.equal(fx.duration(), 2);
  assert.deepEqual(fx.layout, { columns: 8, rows: 6, frameCount: 48, aspect: 1, anchorY: 0 });
  assert.equal(fx.spawn(0, 0.9, 0), true);
  const [sprite] = sprites(fx);
  assert.ok(sprite);
  const material = sprite.material as THREE.SpriteMaterial;
  close(material.rotation, Math.PI / 2);
  assert.equal(material.blending, THREE.AdditiveBlending);
  assert.deepEqual([sprite.scale.x, sprite.scale.y], [1.8, 1.8], "square frame → square sprite at pawn height");
  const map = mapOf(sprite);
  close(map.repeat.x, 1 / 8);
  close(map.repeat.y, 1 / 6);
  // 47/24 s still playing; one more frame ends it.
  for (let i = 0; i < 19; i++) fx.update(0.1); // 1.9 s
  assert.equal(fx.activeCount, 1);
  fx.update(0.1); // 2.0 s → frame 48, done
  assert.equal(fx.activeCount, 0);
  assert.equal(sprite.visible, false);
});

test("resolveLaserImpactSheet prefers the dedicated sheet and falls back to the grenade sheet", () => {
  const laser = { texture: "/assets/textures/laser-impact-sheet.png", fps: 30, size: 0.8, laserImpactSize: 0.8 };
  const grenade = { texture: "/assets/textures/grenade-explosion-sheet.png", fps: 30, size: 8, laserImpactSize: 0.8 };
  const dedicated = resolveLaserImpactSheet(laser, grenade);
  assert.deepEqual(dedicated, { sheet: laser, fallback: false });
  assert.equal(laserImpactWorldSize(dedicated), 0.8);
  assert.equal(laserImpactPlaybackFps(dedicated), 30);
  const fallback = resolveLaserImpactSheet(undefined, grenade);
  assert.deepEqual(fallback, { sheet: grenade, fallback: true });
  assert.equal(laserImpactWorldSize(fallback), 0.8, "fallback uses laserImpactSize, not the grenade blast size");
  assert.equal(laserImpactPlaybackFps(fallback), LASER_IMPACT_FALLBACK_FPS);
  const sizeOnly = resolveLaserImpactSheet({ texture: laser.texture, fps: 24, size: 1.1 });
  assert.equal(laserImpactWorldSize(sizeOnly), 1.1);
  assert.equal(laserImpactPlaybackFps(sizeOnly), 24);
  assert.equal(resolveLaserImpactSheet(undefined, undefined), undefined);
  assert.equal(laserImpactWorldSize(undefined), LASER_IMPACT_SIZE);
  assert.equal(laserImpactPlaybackFps(undefined), LASER_IMPACT_FALLBACK_FPS);
});

test("a 1536x1280 laser-impact sheet of 6 x 5 uses square 256x256 frames from the image", () => {
  const fx = createExplosionFx(new THREE.Scene(), { sheet: { columns: 6, rows: 5, frameCount: 30, frameWidth: 256, frameHeight: 256 } });
  const tex = new THREE.Texture({ width: 1536, height: 1280 } as unknown as HTMLImageElement);
  tex.needsUpdate = true;
  fx.setAtlas(tex);
  close(fx.layout.aspect, 1);
  assert.equal(fx.spawn(0, 0, 0, 0.8), true);
  const sprite = (fx.group.children as THREE.Sprite[])[0]!;
  close(sprite.scale.x, 0.8);
  close(sprite.scale.y, 0.8);
});

const sideLook = {
  position: { x: 0, y: 1.6, z: 6 },
  right: { x: 1, y: 0, z: 0 },
  up: { x: 0, y: 1, z: 0 },
  forward: { x: 0, y: 0, z: -1 },
};

test("surfaceBlastPose: floor is upright, wall points out, head-on is degenerate", () => {
  const impact = { x: 1, y: 2, z: 3 };
  const floor = surfaceBlastPose(impact, { x: 0, y: 1, z: 0 }, sideLook, 8);
  assert.equal(floor.degenerate, false);
  close(floor.x, 1);
  close(floor.y, 2 + SURFACE_BLAST_STANDOFF);
  close(floor.z, 3);
  close(floor.centerX, 0.5);
  close(floor.centerY, 0);
  close(floor.rotation, 0);

  const wall = surfaceBlastPose(impact, { x: 1, y: 0, z: 0 }, sideLook, 8);
  assert.equal(wall.degenerate, false);
  close(wall.x, 1 + SURFACE_BLAST_STANDOFF);
  close(wall.y, 2);
  close(wall.z, 3);
  close(wall.centerX, 0.5);
  close(wall.centerY, 0);
  close(wall.rotation, -Math.PI / 2);

  const back = surfaceBlastPose(impact, { x: -1, y: 0, z: 0 }, sideLook, 4, 0.3);
  assert.equal(back.degenerate, false);
  close(back.rotation, Math.PI / 2 + 0.3);

  // Looking along the floor normal: centre lifts by size/2, no screen-space rotation.
  const downLook = {
    position: { x: 1, y: 10, z: 3 },
    right: { x: 1, y: 0, z: 0 },
    up: { x: 0, y: 0, z: -1 },
    forward: { x: 0, y: -1, z: 0 },
  };
  const above = surfaceBlastPose(impact, { x: 0, y: 1, z: 0 }, downLook, 8, 0.1);
  assert.equal(above.degenerate, true);
  close(above.x, 1);
  close(above.y, 2 + 4 + SURFACE_BLAST_STANDOFF);
  close(above.z, 3);
  close(above.centerX, 0.5);
  close(above.centerY, 0.5);
  close(above.rotation, 0.1);

  const headOn = surfaceBlastPose(impact, { x: 0, y: 0, z: -1 }, sideLook, 8);
  assert.equal(headOn.degenerate, true);
  close(headOn.x, 1);
  close(headOn.y, 2);
  close(headOn.z, 3 - 4 - SURFACE_BLAST_STANDOFF);
  close(headOn.centerY, 0.5);
});

test("surface pool anchors the bottom on a wall and recentres when looking along the normal", () => {
  const scene = new THREE.Scene();
  const fx = createExplosionFx(scene, { sheet: { size: 8 } });
  fx.setAtlas(atlas());
  const impact = { x: 0, y: 1, z: 0 };
  assert.equal(fx.spawnSurface(impact.x, impact.y, impact.z, { x: 0, y: 1, z: 0 }, 8), true);
  const sprite = sprites(fx)[0]!;
  const material = sprite.material as THREE.SpriteMaterial;
  close(sprite.center.x, 0.5);
  close(sprite.center.y, 0);
  close(sprite.position.y, 1 + SURFACE_BLAST_STANDOFF);

  const side = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  side.position.set(0, 1.6, 6);
  side.up.set(0, 1, 0);
  side.lookAt(0, 1.6, 0);
  side.updateMatrixWorld();
  fx.update(0.01, side);
  close(sprite.center.y, 0);
  close(sprite.position.x, 0);
  close(sprite.position.y, 1 + SURFACE_BLAST_STANDOFF);
  close(sprite.position.z, 0);
  close(material.rotation, 0);

  const above = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  above.position.set(0, 10, 0);
  above.up.set(0, 0, -1);
  above.lookAt(0, 1, 0);
  above.updateMatrixWorld();
  fx.update(0.01, above);
  close(sprite.center.y, 0.5);
  close(sprite.position.x, 0);
  close(sprite.position.y, 1 + 4 + SURFACE_BLAST_STANDOFF);
  close(sprite.position.z, 0);
  close(material.rotation, 0);

  fx.clear();
  const wall = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  wall.position.set(0, 1, 6);
  wall.up.set(0, 1, 0);
  wall.lookAt(0, 1, 0);
  wall.updateMatrixWorld();
  assert.equal(fx.spawnSurface(0, 1, 0, { x: 1, y: 0, z: 0 }, 8), true, "reuse the slot");
  fx.update(0.01, wall);
  close(sprite.center.y, 0);
  close(sprite.position.x, SURFACE_BLAST_STANDOFF);
  close(sprite.position.y, 1);
  close(sprite.position.z, 0);
  close(material.rotation, -Math.PI / 2);

  fx.clear();
  assert.equal(fx.spawn(2, 3, 4), true, "air burst reuses the slot and recentres");
  close(sprite.center.x, 0.5);
  close(sprite.center.y, 0.5);
  assert.deepEqual([sprite.position.x, sprite.position.y, sprite.position.z], [2, 3, 4]);
  close(material.rotation, 0);
  assert.equal(fx.spawnSurface(0, 0, 0, { x: 0, y: 0, z: 0 }), false);
});

test("resolveSurfaceExplosionSheet prefers the dedicated sheet and falls back to the grenade size", () => {
  const surface = { texture: "/assets/textures/grenade-ground-blast-sheet.png", fps: 30, size: 8 };
  const grenade = { texture: "/assets/textures/grenade-explosion-sheet.png", fps: 30, size: 8 };
  const dedicated = resolveSurfaceExplosionSheet(surface, grenade);
  assert.deepEqual(dedicated, { sheet: surface, fallback: false });
  assert.equal(surfaceExplosionWorldSize(dedicated), 8);
  assert.equal(surfaceExplosionPlaybackFps(dedicated), 30);
  const fallback = resolveSurfaceExplosionSheet(undefined, grenade);
  assert.deepEqual(fallback, { sheet: grenade, fallback: true });
  assert.equal(surfaceExplosionWorldSize(fallback), 8, "fallback keeps the grenade blast size");
  assert.equal(surfaceExplosionPlaybackFps(fallback), 30);
  const custom = resolveSurfaceExplosionSheet({ texture: surface.texture, fps: 24, size: 6 });
  assert.equal(surfaceExplosionWorldSize(custom), 6);
  assert.equal(surfaceExplosionPlaybackFps(custom), 24);
  assert.equal(resolveSurfaceExplosionSheet(undefined, undefined), undefined);
  assert.equal(surfaceExplosionWorldSize(undefined), EXPLOSION_SIZE);
  assert.equal(surfaceExplosionPlaybackFps(undefined), EXPLOSION_FPS);
});

test("surfaceBlastPose: anchorY puts the art's ground line on the impact", () => {
  const impact = { x: 1, y: 2, z: 3 };
  const floor = surfaceBlastPose(impact, { x: 0, y: 1, z: 0 }, sideLook, 8, 0, SURFACE_BLAST_STANDOFF, 0.46);
  assert.equal(floor.degenerate, false);
  close(floor.y, 2 + SURFACE_BLAST_STANDOFF);
  close(floor.centerY, 0.46);
  close(floor.rotation, 0);
  const downLook = {
    position: { x: 1, y: 10, z: 3 },
    right: { x: 1, y: 0, z: 0 },
    up: { x: 0, y: 0, z: -1 },
    forward: { x: 0, y: -1, z: 0 },
  };
  const above = surfaceBlastPose(impact, { x: 0, y: 1, z: 0 }, downLook, 8, 0, SURFACE_BLAST_STANDOFF, 0.46);
  assert.equal(above.degenerate, true);
  close(above.y, 2 + 8 * 0.04 + SURFACE_BLAST_STANDOFF);
  close(above.centerY, 0.5);
});

test("explosion pool reads anchorY from the sheet for surface blasts only", () => {
  const scene = new THREE.Scene();
  const fx = createExplosionFx(scene, { sheet: { anchorY: 0.46 } });
  assert.equal(fx.layout.anchorY, 0.46);
  const bad = createExplosionFx(scene, { sheet: { anchorY: 1.5 } });
  assert.equal(bad.layout.anchorY, 0);
});
