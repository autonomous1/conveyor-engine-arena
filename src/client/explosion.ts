import * as THREE from "three";

/**
 * Animated sprite explosions from one atlas. The default sheet is 30 frames of 256×256
 * in 6 columns × 5 rows (1536×1280), row 0 at the top of the image, played at 30 fps.
 * The manifest asset `grenade-explosion` (`view.explosion`) can override every number.
 *
 * The atlas loads once. Each pooled sprite gets `atlas.clone()`, which shares the atlas
 * `Source`. three r186 keys its WebGL texture on that Source plus the sampler settings,
 * so every clone binds the same GPU texture. There is one upload, and each clone keeps
 * its own offset/repeat. `clone()` itself sets `needsUpdate`, which bumps
 * `source.version` and would re-upload the whole atlas for every new sprite, so the
 * Source version is restored after the clone and the clone is marked ready with
 * `version` only.
 *
 * Sprites are pooled up to a cap and reused. When the pool is full, the oldest is
 * restarted. One draw call per active explosion; inactive sprites are hidden.
 * Nothing is allocated per frame.
 */

export const EXPLOSION_COLUMNS = 6;
export const EXPLOSION_ROWS = 5;
export const EXPLOSION_FRAMES = 30;
export const EXPLOSION_FPS = 30;
export const EXPLOSION_SIZE = 4;
export const EXPLOSION_POOL_CAP = 8;
/** Longest step one update takes, in seconds. A long frame doesn't skip the whole blast. */
export const EXPLOSION_MAX_DT = 0.1;

export type ExplosionBlending = "normal" | "additive";

/** Sheet layout and playback. Missing fields use the defaults above. */
export type ExplosionSheet = {
  columns?: number;
  rows?: number;
  frameCount?: number;
  fps?: number;
  size?: number;
  blending?: ExplosionBlending;
  /** Frame pixels. Only the ratio is used, for the sprite aspect. The loaded image wins. */
  frameWidth?: number;
  frameHeight?: number;
  /** Optional rotation in degrees, applied as SpriteMaterial.rotation in radians. */
  rotation?: number;
};

/** `aspect` is frame width over height. `size` is the sprite height; width is `size * aspect`. */
type Layout = { columns: number; rows: number; frameCount: number; aspect: number };

/** UV offset of `frame` in the atlas. Row 0 is the image top, so v counts down from 1. */
export function explosionFrameOffset(
  frame: number,
  columns = EXPLOSION_COLUMNS,
  rows = EXPLOSION_ROWS,
  out: { x: number; y: number } = { x: 0, y: 0 },
): { x: number; y: number } {
  const column = frame % columns;
  const row = Math.floor(frame / columns);
  out.x = column / columns;
  out.y = 1 - (row + 1) / rows;
  return out;
}

function blendingOf(mode: ExplosionBlending): THREE.Blending {
  return mode === "additive" ? THREE.AdditiveBlending : THREE.NormalBlending;
}

function createExplosion(parent: THREE.Object3D, atlas: THREE.Texture, blending: ExplosionBlending, layout: Layout, rotationRad: number) {
  // r186 `Texture.copy` (inside clone) sets `needsUpdate`, which bumps the shared
  // `source.version` and would re-upload the full atlas once per new sprite. Undo that
  // bump and mark the clone ready through its own `version` only.
  const sourceVersion = atlas.source.version;
  const map = atlas.clone();
  atlas.source.version = sourceVersion;
  map.version = Math.max(1, atlas.version);
  map.repeat.set(1 / layout.columns, 1 / layout.rows);
  const material = new THREE.SpriteMaterial({
    map,
    transparent: true,
    depthWrite: false,
    blending: blendingOf(blending),
    rotation: rotationRad,
  });
  const sprite = new THREE.Sprite(material);
  sprite.name = "explosion";
  sprite.visible = false;
  sprite.castShadow = false;
  sprite.receiveShadow = false;
  sprite.raycast = () => {};
  parent.add(sprite);
  let active = false;
  let age = 0;
  let fps = EXPLOSION_FPS;
  let lastFrame = -1;
  let disposed = false;

  function setFrame(frame: number) {
    explosionFrameOffset(frame, layout.columns, layout.rows, map.offset);
    lastFrame = frame;
  }

  function stop() {
    active = false;
    sprite.visible = false;
  }

  return {
    sprite,
    map,
    material,
    get active() {
      return active;
    },
    get age() {
      return age;
    },
    start(x: number, y: number, z: number, size: number, rate: number) {
      sprite.position.set(x, y, z);
      sprite.scale.set(size * layout.aspect, size, 1);
      age = 0;
      fps = rate;
      setFrame(0);
      active = true;
      sprite.visible = true;
    },
    update(dt: number): boolean {
      if (!active) return false;
      age += dt;
      const frame = Math.floor(age * fps);
      if (frame >= layout.frameCount) {
        stop();
        return false;
      }
      if (frame !== lastFrame) setFrame(frame);
      return true;
    },
    setBlending(mode: ExplosionBlending) {
      material.blending = blendingOf(mode);
      material.needsUpdate = true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stop();
      sprite.removeFromParent();
      material.dispose();
      map.dispose();
    },
  };
}

type Slot = ReturnType<typeof createExplosion>;

export function createExplosionFx(
  parent: THREE.Object3D,
  opts: {
    cap?: number;
    sheet?: ExplosionSheet;
    /** Called once when the atlas fails to load. Explosions stay off after that. */
    onLoadError?: (err: unknown) => void;
  } = {},
) {
  if ((parent as { isCamera?: boolean }).isCamera) {
    throw new Error("explosions must not be parented to the camera");
  }
  const cap = Math.max(1, Math.floor(opts.cap ?? EXPLOSION_POOL_CAP));
  const sheet = opts.sheet ?? {};
  const whole = (value: number | undefined, fallback: number) =>
    typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
  const positive = (value: number | undefined, fallback: number) =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
  const columns = whole(sheet.columns, EXPLOSION_COLUMNS);
  const rows = whole(sheet.rows, EXPLOSION_ROWS);
  const layout: Layout = {
    columns,
    rows,
    frameCount: Math.min(whole(sheet.frameCount, EXPLOSION_FRAMES), columns * rows),
    aspect: positive(sheet.frameWidth, 1) / positive(sheet.frameHeight, 1),
  };
  const defaultFps = positive(sheet.fps, EXPLOSION_FPS);
  const defaultSize = positive(sheet.size, EXPLOSION_SIZE);
  let blending: ExplosionBlending = sheet.blending === "additive" ? "additive" : "normal";
  // Degrees in the sheet (manifest); SpriteMaterial wants radians.
  const rotationRad = typeof sheet.rotation === "number" && Number.isFinite(sheet.rotation)
    ? (sheet.rotation * Math.PI) / 180
    : 0;
  const group = new THREE.Group();
  group.name = "explosions";
  parent.add(group);
  const slots: Slot[] = [];
  let atlas: THREE.Texture | undefined;
  let disabled = false;
  let running = 0;

  function fail(err: unknown) {
    if (disabled) return;
    disabled = true;
    atlas = undefined;
    try {
      opts.onLoadError?.(err);
    } catch {
      // The reporter must not break the frame.
    }
  }

  function useAtlas(texture: THREE.Texture, renderer?: { initTexture(texture: THREE.Texture): void }) {
    if (disabled) return;
    texture.colorSpace = THREE.SRGBColorSpace;
    // Frames need not be square (a 1356x1280 sheet of 6 x 5 is 226x256). The image decides.
    const image = texture.image as { width?: number; height?: number } | undefined;
    const width = Number(image?.width);
    const height = Number(image?.height);
    if (width > 0 && height > 0) layout.aspect = (width / columns) / (height / rows);
    atlas = texture;
    if (slots.length === 0) slots.push(createExplosion(group, texture, blending, layout, rotationRad));
    // Upload the shared atlas now, not on the first blast.
    try {
      renderer?.initTexture(slots[0]!.map);
    } catch (err) {
      console.warn("explosion prewarm", err);
    }
  }

  return {
    group,
    /** Load once. A failure is reported once and turns explosions off; it never throws. */
    async load(
      fetchAtlas: () => Promise<THREE.Texture>,
      renderer?: { initTexture(texture: THREE.Texture): void },
    ): Promise<boolean> {
      if (atlas || disabled) return atlas !== undefined;
      try {
        const texture = await fetchAtlas();
        const image = texture.image as { width?: number; height?: number } | undefined;
        if (!image || !(Number(image.width) > 0) || !(Number(image.height) > 0)) throw new Error("explosion atlas has no image");
        useAtlas(texture, renderer);
        return true;
      } catch (err) {
        fail(err);
        return false;
      }
    },
    /** Tests and callers that already hold the texture. */
    setAtlas(texture: THREE.Texture) {
      useAtlas(texture);
    },
    get enabled() {
      return atlas !== undefined && !disabled;
    },
    get poolSize() {
      return slots.length;
    },
    get activeCount() {
      return running;
    },
    /** Start one blast. False when the atlas isn't ready or failed, or the point isn't finite. */
    /** Default sprite height in metres. */
    get size() {
      return defaultSize;
    },
    get layout(): Readonly<Layout> {
      return layout;
    },
    /** Seconds one blast lasts at `fps`. */
    duration(fps = defaultFps): number {
      return layout.frameCount / fps;
    },
    spawn(x: number, y: number, z: number, size = defaultSize, fps = defaultFps): boolean {
      if (!atlas || disabled) return false;
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return false;
      if (!(size > 0) || !(fps > 0)) return false;
      let slot = slots.find((item) => !item.active);
      if (!slot && slots.length < cap) {
        slot = createExplosion(group, atlas, blending, layout, rotationRad);
        slots.push(slot);
      }
      if (!slot) {
        // Full: restart the oldest.
        slot = slots[0]!;
        for (const item of slots) if (item.age > slot.age) slot = item;
      } else {
        running += 1;
      }
      slot.start(x, y, z, size, fps);
      return true;
    },
    /** Render-loop delta in seconds. Returns at once when nothing is playing. */
    update(dt: number) {
      if (running === 0) return;
      const step = Number.isFinite(dt) ? Math.min(Math.max(dt, 0), EXPLOSION_MAX_DT) : 0;
      for (let i = 0; i < slots.length; i++) {
        const slot = slots[i]!;
        if (slot.active && !slot.update(step)) running -= 1;
      }
    },
    setBlending(mode: ExplosionBlending) {
      blending = mode;
      for (const slot of slots) slot.setBlending(mode);
    },
    get blending() {
      return blending;
    },
    /** Sheet rotation in radians (0 when unset). */
    get rotation() {
      return rotationRad;
    },
    /** Hide every blast; the pool stays for reuse. */
    clear() {
      for (const slot of slots) if (slot.active) slot.update(Infinity);
      running = 0;
    },
    dispose() {
      for (const slot of slots) slot.dispose();
      slots.length = 0;
      running = 0;
      group.removeFromParent();
    },
  };
}

export type ExplosionFx = ReturnType<typeof createExplosionFx>;

/** Default world size of a laser hit, in metres, when the sheet does not say otherwise. */
export const LASER_IMPACT_SIZE = 0.8;
/**
 * Playback rate used when laser hits fall back to the grenade-explosion sheet.
 * A dedicated `laser-impact` sheet plays at its own `fps` (30 in the manifest).
 */
export const LASER_IMPACT_FALLBACK_FPS = 60;

export type LaserImpactSheet = ExplosionSheet & { texture: string; laserImpactSize?: number };

/** The `laser-impact` asset, or the grenade sheet when that optional file is missing. */
export function resolveLaserImpactSheet(
  laserImpact?: LaserImpactSheet,
  explosion?: LaserImpactSheet,
): { sheet: LaserImpactSheet; fallback: boolean } | undefined {
  if (laserImpact) return { sheet: laserImpact, fallback: false };
  if (explosion) return { sheet: explosion, fallback: true };
  return undefined;
}

export type LaserImpactSource = NonNullable<ReturnType<typeof resolveLaserImpactSheet>>;

/** World size of a laser hit. Prefers `laserImpactSize`, then the dedicated sheet's `size`, then 0.8. */
export function laserImpactWorldSize(source: LaserImpactSource | undefined, fallback = LASER_IMPACT_SIZE): number {
  const impact = source?.sheet.laserImpactSize;
  if (typeof impact === "number" && Number.isFinite(impact) && impact > 0) return impact;
  if (source && !source.fallback) {
    const size = source.sheet.size;
    if (typeof size === "number" && Number.isFinite(size) && size > 0) return size;
  }
  return fallback;
}

/** Playback fps. The dedicated sheet uses its own `fps`; a grenade-sheet fallback stays at 60. */
export function laserImpactPlaybackFps(source: LaserImpactSource | undefined, fallback = LASER_IMPACT_FALLBACK_FPS): number {
  if (source && !source.fallback) {
    const fps = source.sheet.fps;
    if (typeof fps === "number" && Number.isFinite(fps) && fps > 0) return fps;
  }
  return fallback;
}
