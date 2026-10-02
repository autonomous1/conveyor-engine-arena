/**
 * Half-second averages for the HUD. `fps` counts presented frames.
 * `tickPerSec` counts server-tick advance on frames that observed a snapshot.
 * A window with no snapshot leaves `tickPerSec` unset so the HUD can show
 * an em dash instead of 0 or the previous window.
 */

const EM = "\u2014";

export type RateSample = {
  fps: number | undefined;
  tickPerSec: number | undefined;
};

export function createRateWindow(windowMs = 500) {
  const sample: RateSample = { fps: undefined, tickPerSec: undefined };
  let origin = Number.NaN;
  let frames = 0;
  let tickAdvance = 0;
  let sawSnapshot = false;
  let lastTick: number | undefined;

  return {
    push(nowMs: number, observedTick?: number): RateSample {
      if (Number.isNaN(origin)) origin = nowMs;
      frames += 1;
      if (observedTick !== undefined && Number.isFinite(observedTick)) {
        sawSnapshot = true;
        if (lastTick !== undefined) {
          const delta = observedTick - lastTick;
          if (delta > 0) tickAdvance += delta;
        }
        lastTick = observedTick;
      }
      const elapsed = nowMs - origin;
      if (elapsed >= windowMs && elapsed > 0) {
        const seconds = elapsed / 1000;
        sample.fps = frames / seconds;
        sample.tickPerSec = sawSnapshot ? tickAdvance / seconds : undefined;
        frames = 0;
        tickAdvance = 0;
        sawSnapshot = false;
        origin = nowMs;
      }
      return sample;
    },
  };
}

export type OverlayStats = {
  fps: number | undefined;
  tickPerSec: number | undefined;
  tick: number | undefined;
  snaps: number;
  resyncs: number;
  seq: number | undefined;
  calls: number;
  tris: number;
  geoms: number;
  tex: number;
  shadows: "on" | "off" | undefined;
  shadowMap: number | undefined;
  tone: number | undefined;
  exposure: number | undefined;
  pawns: number;
  owned: number | undefined;
  positions: string;
};

function rateText(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return EM;
  return String(Math.round(value));
}

function countText(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return EM;
  return String(value);
}

function exposureText(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return String(Math.round(value * 100) / 100);
}

export function formatOverlay(stats: OverlayStats): string {
  const lines = [
    `fps ${rateText(stats.fps)}  tick/s ${rateText(stats.tickPerSec)}  tick ${countText(stats.tick)}`,
    `snaps ${stats.snaps}  resync ${stats.resyncs}  seq ${countText(stats.seq)}`,
    `calls ${stats.calls}  tris ${stats.tris}`,
    `geoms ${stats.geoms}  tex ${stats.tex}`,
  ];
  if (stats.shadows !== undefined || stats.tone !== undefined) {
    const parts: string[] = [];
    if (stats.shadows !== undefined) {
      parts.push(`shadows ${stats.shadows}`);
      if (stats.shadowMap !== undefined) parts.push(`map ${stats.shadowMap}`);
    }
    if (stats.tone !== undefined) parts.push(`tone ${stats.tone}`);
    if (stats.exposure !== undefined) parts.push(`exp ${exposureText(stats.exposure)}`);
    lines.push(parts.join("  "));
  }
  lines.push(`pawns ${stats.pawns}  owned ${countText(stats.owned)}`);
  if (stats.positions) lines.push(stats.positions);
  return lines.join("\n");
}
