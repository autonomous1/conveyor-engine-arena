/**
 * FightBack aim. Pure: the caller passes the rng and the clock.
 * Nothing here reads Date or Math.random.
 */
// ARCHITECTURE: Aim error sampling, turn-toward, and the burst scheduler.
// Wiring: server/bot-brain.ts uses all three.
import { BOT_TUNING } from "./bot-tuning.js";

const DEG = Math.PI / 180;
const TAU = Math.PI * 2;

export type AimPoint = { readonly x: number; readonly y: number; readonly z: number };

/** Standard deviation, in radians, of the yaw error and of the pitch error. */
export function aimSigma(range: number, targetSpeed: number): number {
  const metres = Number.isFinite(range) && range > 0 ? range : 0;
  const speed = Number.isFinite(targetSpeed) && targetSpeed > 0 ? targetSpeed : 0;
  const deg =
    BOT_TUNING.aimBaseDeg +
    BOT_TUNING.aimDegPerM * metres +
    BOT_TUNING.aimSpeedDeg * (speed / BOT_TUNING.aimSpeedMps);
  return deg * DEG;
}

/**
 * Yaw and pitch from `eye` to `targetPoint`, each plus an independent
 * normal error of {@link aimSigma}. Yaw 0 is +Z. Positive pitch looks up.
 */
export function sampleAim(
  rng: () => number,
  eye: AimPoint,
  targetPoint: AimPoint,
  range: number,
  targetSpeed: number,
): { yaw: number; pitch: number } {
  const dx = targetPoint.x - eye.x;
  const dy = targetPoint.y - eye.y;
  const dz = targetPoint.z - eye.z;
  const sigma = aimSigma(range, targetSpeed);
  return {
    yaw: Math.atan2(dx, dz) + gauss(rng) * sigma,
    pitch: Math.atan2(dy, Math.hypot(dx, dz)) + gauss(rng) * sigma,
  };
}

/**
 * Turn toward `wantYaw` by at most the tuning rate times `dtMs`.
 * @post A gap inside the step lands on `wantYaw`; the short arc wins.
 */
export function turnToward(currentYaw: number, wantYaw: number, dtMs: number): number {
  if (!Number.isFinite(currentYaw)) return Number.isFinite(wantYaw) ? wantYaw : 0;
  if (!Number.isFinite(wantYaw)) return currentYaw;
  const dt = Number.isFinite(dtMs) && dtMs > 0 ? dtMs / 1000 : 0;
  const max = BOT_TUNING.turnDegPerS * DEG * dt;
  const delta = wrap(wantYaw - currentYaw);
  if (Math.abs(delta) <= max) return wantYaw;
  return currentYaw + Math.sign(delta) * max;
}

/**
 * Bursts of 2–4 shots at {@link BOT_TUNING.burstHz}, then a pause.
 * @post The first call is due. A true result consumes that shot.
 */
export function burstScheduler(rng: () => number): { due(now: number): boolean } {
  const gap = 1000 / BOT_TUNING.burstHz;
  let shotsLeft = 0;
  let nextAt = Number.NEGATIVE_INFINITY;
  let started = false;

  function rollBurst(): void {
    const span = BOT_TUNING.burstMax - BOT_TUNING.burstMin + 1;
    const u = unit(rng);
    shotsLeft = BOT_TUNING.burstMin + Math.floor(u * span);
  }

  function rollPause(): number {
    // 0 and 1 stay on the ends. The Box-Muller clamp would push a 0 just past 1200 ms.
    const u = rng();
    const t = !Number.isFinite(u) || u <= 0 ? 0 : u >= 1 ? 1 : u;
    return BOT_TUNING.pauseMinMs + t * (BOT_TUNING.pauseMaxMs - BOT_TUNING.pauseMinMs);
  }

  return {
    due(now: number): boolean {
      if (!Number.isFinite(now)) return false;
      if (!started) {
        started = true;
        rollBurst();
        nextAt = now;
      }
      if (now < nextAt) return false;
      shotsLeft -= 1;
      if (shotsLeft > 0) nextAt = now + gap;
      else {
        nextAt = now + rollPause();
        rollBurst();
      }
      return true;
    },
  };
}

function wrap(angle: number): number {
  const wrapped = angle % TAU;
  if (wrapped <= -Math.PI) return wrapped + TAU;
  if (wrapped > Math.PI) return wrapped - TAU;
  return wrapped;
}

/** (0, 1). A 0 or a 1 would make the Box-Muller log infinite. */
function unit(rng: () => number): number {
  const u = rng();
  if (!Number.isFinite(u) || u <= 0) return 1e-9;
  if (u >= 1) return 1 - 1e-9;
  return u;
}

function gauss(rng: () => number): number {
  const u = unit(rng);
  const v = unit(rng);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v);
}
