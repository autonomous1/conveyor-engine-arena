/** Cheap hard maps, filtered maps, then variance maps at high resolution. */
export const SHADOW_QUALITIES = ["off", "basic", "soft", "realistic"] as const;

export type ShadowQuality = (typeof SHADOW_QUALITIES)[number];

export type ShadowAlgorithm = "basic" | "pcf" | "vsm";

export type ShadowSettings = {
  enabled: boolean;
  algorithm: ShadowAlgorithm;
  mapSize: number;
  radius: number;
  bias: number;
  normalBias: number;
};

const SETTINGS: Record<ShadowQuality, ShadowSettings> = {
  off: { enabled: false, algorithm: "basic", mapSize: 256, radius: 1, bias: 0, normalBias: 0 },
  basic: { enabled: true, algorithm: "basic", mapSize: 512, radius: 1, bias: -0.0004, normalBias: 0.02 },
  soft: { enabled: true, algorithm: "pcf", mapSize: 2048, radius: 3, bias: -0.00025, normalBias: 0.03 },
  // VSM blur passes at 4096 are the heaviest built-in shadow path.
  realistic: { enabled: true, algorithm: "vsm", mapSize: 4096, radius: 12, bias: 0, normalBias: 0.05 },
};

export function shadowSettings(quality: ShadowQuality): ShadowSettings {
  return SETTINGS[quality];
}
