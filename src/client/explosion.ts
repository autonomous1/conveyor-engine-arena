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
/**
 * Longest step one update takes, in seconds.
 * @why A long frame doesn't skip the whole blast.
 */
export const EXPLOSION_MAX_DT = 0.1;
/**
 * @why A tiny push along the surface normal, so the billboard does not z-fight
 *      the face.
 */
export const SURFACE_BLAST_STANDOFF = 0.02;
/**
 * @why If the surface normal projected into the camera plane is shorter than
 *      this, the view is nearly along the normal (looking down at a floor, or
 *      head-on at a wall). Then the sprite is centred and pushed out along the
 *      normal so the art's ground line (`anchorY`) is on the surface, so the
 *      blast stays a facing quad.
 */
export const SURFACE_BLAST_DEGENERATE = 0.08;

export type ExplosionBlending = "normal" | "additive";

export type SurfaceBlastLook = {
  position: { x: number; y: number; z: number };
  right: { x: number; y: number; z: number };
  up: { x: number; y: number; z: number };
  forward: { x: number; y: number; z: number };
};

export type SurfaceBlastPose = {
  x: number;
  y: number;
  z: number;
  centerX: number;
  centerY: number;
  rotation: number;
  degenerate: boolean;
};

export type ExplosionCamera = {
  updateMatrixWorld?: () => void;
  matrixWorld: { elements: ArrayLike<number> };
};

function unit3(v: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  const len = Math.hypot(v.x, v.y, v.z);
  if (!(len > 1e-8)) return { x: 0, y: 0, z: 0 };
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

/** Camera basis from `matrixWorld`: right, up, and look (-Z). */
export function lookFromCamera(camera: ExplosionCamera): SurfaceBlastLook {
  camera.updateMatrixWorld?.();
  const m = camera.matrixWorld.elements;
  return {
    position: { x: m[12]!, y: m[13]!, z: m[14]! },
    right: { x: m[0]!, y: m[1]!, z: m[2]! },
    up: { x: m[4]!, y: m[5]!, z: m[6]! },
    forward: { x: -m[8]!, y: -m[9]!, z: -m[10]! },
  };
}

/**
 * The art's ground line (`anchorY`, fraction of frame height from the bottom)
 * at the impact point (plus a tiny standoff), texture up aligned with the
 * surface normal in screen space. Degenerate views (see
 * {@link SURFACE_BLAST_DEGENERATE}) push the centre out by size × (0.5 − anchorY)
 * along the normal, keep a centred anchor, and leave the sheet's base rotation.
 */
export function surfaceBlastPose(
  impact: { x: number; y: number; z: number },
  normal: { x: number; y: number; z: number },
  look: SurfaceBlastLook,
  size: number,
  baseRotation = 0,
  standoff = SURFACE_BLAST_STANDOFF,
  anchorY = 0,
): SurfaceBlastPose {
  const n = unit3(normal);
  const forward = unit3(look.forward);
  const right = unit3(look.right);
  const up = unit3(look.up);
  const nScreenX = n.x - forward.x * (n.x * forward.x + n.y * forward.y + n.z * forward.z);
  const nScreenY = n.y - forward.y * (n.x * forward.x + n.y * forward.y + n.z * forward.z);
  const nScreenZ = n.z - forward.z * (n.x * forward.x + n.y * forward.y + n.z * forward.z);
  const projected = Math.hypot(nScreenX, nScreenY, nScreenZ);
  if (!(projected >= SURFACE_BLAST_DEGENERATE) || !(size > 0)) {
    const lift = (size > 0 ? size * (0.5 - anchorY) : 0) + standoff;
    return {
      x: impact.x + n.x * lift,
      y: impact.y + n.y * lift,
      z: impact.z + n.z * lift,
      centerX: 0.5,
      centerY: 0.5,
      rotation: baseRotation,
      degenerate: true,
    };
  }
  const sx = nScreenX * right.x + nScreenY * right.y + nScreenZ * right.z;
  const sy = nScreenX * up.x + nScreenY * up.y + nScreenZ * up.z;
  return {
    x: impact.x + n.x * standoff,
    y: impact.y + n.y * standoff,
    z: impact.z + n.z * standoff,
    centerX: 0.5,
    centerY: anchorY,
    // SpriteMaterial.rotation turns counter-clockwise, so texture up lands on
    // (-sin r, cos r). Solve for the projected normal (sx, sy).
    rotation: Math.atan2(-sx, sy) + baseRotation,
    degenerate: false,
  };
}

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
  /** Surface blasts: ground line of the art as a fraction of frame height from the bottom. Default 0. */
  anchorY?: number;
};

/** `aspect` is frame width over height. `size` is the sprite height; width is `size * aspect`. */
type Layout = { columns: number; rows: number; frameCount: number; aspect: number; anchorY: number };

/**
 * UV offset of `frame` in the atlas.
 * @post Row 0 is the image top, so v counts down from 1.
 */
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
  let surface: { ix: number; iy: number; iz: number; nx: number; ny: number; nz: number; size: number } | undefined;

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
    start(x: number, y: number, z: number, size: number, rate: number, normal?: { x: number; y: number; z: number }) {
      sprite.scale.set(size * layout.aspect, size, 1);
      age = 0;
      fps = rate;
      setFrame(0);
      active = true;
      sprite.visible = true;
      if (normal) {
        surface = { ix: x, iy: y, iz: z, nx: normal.x, ny: normal.y, nz: normal.z, size };
        sprite.center.set(0.5, layout.anchorY);
        sprite.position.set(
          x + normal.x * SURFACE_BLAST_STANDOFF,
          y + normal.y * SURFACE_BLAST_STANDOFF,
          z + normal.z * SURFACE_BLAST_STANDOFF,
        );
      } else {
        surface = undefined;
        sprite.center.set(0.5, 0.5);
        sprite.position.set(x, y, z);
      }
      material.rotation = rotationRad;
    },
    update(dt: number, look?: SurfaceBlastLook): boolean {
      if (!active) return false;
      age += dt;
      const frame = Math.floor(age * fps);
      if (frame >= layout.frameCount) {
        stop();
        return false;
      }
      if (frame !== lastFrame) setFrame(frame);
      if (surface && look) {
        const pose = surfaceBlastPose(
          { x: surface.ix, y: surface.iy, z: surface.iz },
          { x: surface.nx, y: surface.ny, z: surface.nz },
          look,
          surface.size,
          rotationRad,
          SURFACE_BLAST_STANDOFF,
          layout.anchorY,
        );
        sprite.position.set(pose.x, pose.y, pose.z);
        sprite.center.set(pose.centerX, pose.centerY);
        material.rotation = pose.rotation;
      }
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

/**
 * Pooled sprites in a group on `parent`. dispose frees each slot's material and
 * cloned map.
 * @pre A camera parent throws.
 */
export interface ExplosionFx {
  /** Group added to `parent`. Sprites live here. */
  group: THREE.Group;
  /** Load once. A failure is reported once and turns blasts off. Never throws. */
  load(
    fetchAtlas: () => Promise<THREE.Texture>,
    renderer?: { initTexture(texture: THREE.Texture): void },
  ): Promise<boolean>;
  /** Install a texture the caller holds. A load that already failed stays off. */
  setAtlas(texture: THREE.Texture): void;
  /** True when an atlas is installed and load has not failed. */
  readonly enabled: boolean;
  /** Sprites created so far, at most the cap. */
  readonly poolSize: number;
  /** Blasts currently playing. */
  readonly activeCount: number;
  /** Default sprite height in metres. */
  readonly size: number;
  /** Live sheet. `aspect` can change when the image loads. Not a copy. */
  readonly layout: Readonly<{
    columns: number;
    rows: number;
    frameCount: number;
    aspect: number;
    anchorY: number;
  }>;
  /** Seconds one blast lasts at `fps`. Omitted fps is the sheet's. */
  duration(fps?: number): number;
  /** Start one blast, in metres. False when off or the point is not finite. A full pool restarts the oldest. */
  spawn(x: number, y: number, z: number, size?: number, fps?: number): boolean;
  /**
   * Surface blast: the bottom edge sits on the point, texture up along the normal.
   * Needs update with the camera. False for a bad normal, or when spawn would be false.
   */
  spawnSurface(
    x: number,
    y: number,
    z: number,
    normal: { x: number; y: number; z: number },
    size?: number,
    fps?: number,
  ): boolean;
  /**
   * Once per frame. `dt` is seconds, clamped to 0..EXPLOSION_MAX_DT. No-op when nothing plays.
   * With a camera, allocates one look basis and one pose per surface blast.
   */
  update(dt: number, camera?: ExplosionCamera): void;
  /** Apply to the pool and every sprite. Later spawns use it too. */
  setBlending(mode: ExplosionBlending): void;
  readonly blending: ExplosionBlending;
  /** Sheet rotation in radians. Zero when the sheet omitted it. Fixed for this pool. */
  readonly rotation: number;
  /** Hide every blast. The pool stays for reuse. */
  clear(): void;
  /** Remove the group. Free each slot's material and cloned map. The source atlas stays. */
  dispose(): void;
}

export function createExplosionFx(
  parent: THREE.Object3D,
  opts: {
    cap?: number;
    sheet?: ExplosionSheet;
    /** Called once when the atlas fails to load. Explosions stay off after that. */
    onLoadError?: (err: unknown) => void;
  } = {},
): ExplosionFx {
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
    anchorY: typeof sheet.anchorY === "number" && sheet.anchorY >= 0 && sheet.anchorY < 1 ? sheet.anchorY : 0,
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

  function begin(
    x: number,
    y: number,
    z: number,
    size: number,
    fps: number,
    normal?: { x: number; y: number; z: number },
  ): boolean {
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
    slot.start(x, y, z, size, fps, normal);
    return true;
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
    /** Start one blast. False when the atlas isn't ready or failed, or the point isn't finite. */
    spawn(x: number, y: number, z: number, size = defaultSize, fps = defaultFps): boolean {
      return begin(x, y, z, size, fps);
    },
    /**
     * Surface blast: bottom edge on the impact point, texture up along the
     * surface normal in screen space. Needs {@link update} with the camera.
     */
    spawnSurface(
      x: number,
      y: number,
      z: number,
      normal: { x: number; y: number; z: number },
      size = defaultSize,
      fps = defaultFps,
    ): boolean {
      const len = Math.hypot(normal.x, normal.y, normal.z);
      if (!(len > 1e-8) || !Number.isFinite(len)) return false;
      return begin(x, y, z, size, fps, { x: normal.x / len, y: normal.y / len, z: normal.z / len });
    },
    /** Render-loop delta in seconds. Pass the camera so surface blasts can reorient. */
    update(dt: number, camera?: ExplosionCamera) {
      if (running === 0) return;
      const step = Number.isFinite(dt) ? Math.min(Math.max(dt, 0), EXPLOSION_MAX_DT) : 0;
      const look = camera ? lookFromCamera(camera) : undefined;
      for (let i = 0; i < slots.length; i++) {
        const slot = slots[i]!;
        if (slot.active && !slot.update(step, look)) running -= 1;
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

/** Default world size of a laser hit, in metres, when the sheet does not say otherwise. */
export const LASER_IMPACT_SIZE = 0.8;
/**
 * Playback rate used when laser hits fall back to the grenade-explosion sheet.
 * A dedicated `laser-impact` sheet plays at its own `fps` (30 in the manifest).
 */
export const LASER_IMPACT_FALLBACK_FPS = 60;

export type LaserImpactSheet = ExplosionSheet & { texture: string; laserImpactSize?: number };

/**
 * @post The `laser-impact` asset, or the grenade sheet when that optional file
 *       is missing.
 */
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
export type SurfaceExplosionSheet = ExplosionSheet & { texture: string };

/**
 * @post The `grenade-surface-explosion` asset, or the grenade sheet when that
 *       optional file is missing.
 */
export function resolveSurfaceExplosionSheet(
  surfaceExplosion?: SurfaceExplosionSheet,
  explosion?: SurfaceExplosionSheet,
): { sheet: SurfaceExplosionSheet; fallback: boolean } | undefined {
  if (surfaceExplosion) return { sheet: surfaceExplosion, fallback: false };
  if (explosion) return { sheet: explosion, fallback: true };
  return undefined;
}

export type SurfaceExplosionSource = NonNullable<ReturnType<typeof resolveSurfaceExplosionSheet>>;

/** World size of a surface blast. Uses the chosen sheet's `size`, else the grenade default. */
export function surfaceExplosionWorldSize(source: SurfaceExplosionSource | undefined, fallback = EXPLOSION_SIZE): number {
  const size = source?.sheet.size;
  if (typeof size === "number" && Number.isFinite(size) && size > 0) return size;
  return fallback;
}

/** Playback fps of a surface blast. The chosen sheet's `fps`, else the grenade default. */
export function surfaceExplosionPlaybackFps(source: SurfaceExplosionSource | undefined, fallback = EXPLOSION_FPS): number {
  const fps = source?.sheet.fps;
  if (typeof fps === "number" && Number.isFinite(fps) && fps > 0) return fps;
  return fallback;
}
