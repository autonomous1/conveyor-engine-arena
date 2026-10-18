/**
 * World XZ to map pixels. +X is right and +Z is up, matching the plan toolbar.
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
    originY + (bounds.maxZ - z) * scale,
  ];
  const toWorld = (px: number, py: number): [number, number] => [
    bounds.minX + (px - originX) / scale,
    bounds.maxZ - (py - originY) / scale,
  ];
  return {
    width,
    height,
    scale,
    originX,
    originY,
    viewMinX: bounds.minX - originX / scale,
    viewMaxX: bounds.minX + (width - originX) / scale,
    viewMaxZ: bounds.maxZ + originY / scale,
    viewMinZ: bounds.maxZ - (height - originY) / scale,
    toPixel,
    toWorld,
  };
}
