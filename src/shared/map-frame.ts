/**
 * World XZ to map pixels. +X is right and −Z is up: the true top-down
 * view seen from above in game and in Blender's top view.
 * The panel uses a fixed 18px pad. A bake at another resolution scales that pad
 * by `size / SCENE_MAP_SIZE` so the image and the panel show the same window.
 */

export const MAP_PAD = 18;

/** Lower-right panel. 1.5× the previous 240px map. */
export const SCENE_MAP_SIZE = 360;

/** Square bake. Downscaled into the panel, so the picture stays sharp. */
export const MAP_BAKE_PX = 2048;

/** URL the client loads. The file is `web/assets/map-bake.png`. */
export const MAP_BAKE_URL = "/assets/map-bake.png";

/** Bake clear colour. Written with alpha 0, so the panel's translucent background shows through. */
export const MAP_BAKE_BACKGROUND = 0x1b1f24;

/** Bake metadata: the world XZ bounds the PNG was framed on (from the SVG `bounds` layer). */
export const MAP_BAKE_META_URL = "/assets/map-bake.json";
export const MAP_BAKE_META_PATH = "web/assets/map-bake.json";

/** Design SVG whose `bounds` layer rect sets the bake extents. */
export const MAP_DESIGN_SVG = "dev/scenes/arena-1/designs/arena-1.svg";

export const MAP_BAKE_PATH = "web/assets/map-bake.png";

export type MapBounds = { minX: number; maxX: number; minZ: number; maxZ: number };

export type MapFrame = {
  width: number;
  height: number;
  scale: number;
  originX: number;
  originY: number;
  /** World window of the whole image, including the margin. */
  viewMinX: number;
  viewMaxX: number;
  viewMinZ: number;
  viewMaxZ: number;
  toPixel(x: number, z: number): [number, number];
  toWorld(px: number, py: number): [number, number];
};

export function mapFrame(
  bounds: MapBounds,
  width: number,
  height: number,
  padX = MAP_PAD,
  padY = padX,
): MapFrame | undefined {
  const worldW = bounds.maxX - bounds.minX;
  const worldD = bounds.maxZ - bounds.minZ;
  if (!(worldW > 0) || !(worldD > 0) || !(width > padX * 2) || !(height > padY * 2)) return undefined;
  const scale = Math.min((width - padX * 2) / worldW, (height - padY * 2) / worldD);
  const originX = (width - worldW * scale) / 2;
  const originY = (height - worldD * scale) / 2;
  const toPixel = (x: number, z: number): [number, number] => [
    originX + (x - bounds.minX) * scale,
    originY + (z - bounds.minZ) * scale,
  ];
  const toWorld = (px: number, py: number): [number, number] => [
    bounds.minX + (px - originX) / scale,
    bounds.minZ + (py - originY) / scale,
  ];
  return {
    width,
    height,
    scale,
    originX,
    originY,
    viewMinX: bounds.minX - originX / scale,
    viewMaxX: bounds.minX + (width - originX) / scale,
    viewMinZ: bounds.minZ - originY / scale,
    viewMaxZ: bounds.minZ + (height - originY) / scale,
    toPixel,
    toWorld,
  };
}
