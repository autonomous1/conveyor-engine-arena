/** Locomotion and emote names the wander loop and the character clips share. */
export const MOVEMENTS = ["idle", "walk", "run", "fall", "angry"] as const;

export type Movement = (typeof MOVEMENTS)[number];

/** Used when an animation entry omits speed. */
export const DEFAULT_MOVEMENT_SPEED: Record<Movement, number> = {
  idle: 0,
  walk: 1,
  run: 2,
  fall: 0,
  angry: 0,
};

/**
 * Move-input scale for one animation speed. The fastest movement in the set
 * is full input, and the others keep the same ratio, so walk:1 and run:2
 * make walk half as fast as run.
 */
/** Exact clip name, then a case-insensitive substring, matching the previous player. */
export function findClip<T extends { name: string }>(clips: readonly T[], wanted: string): T | undefined {
  const exact = clips.find((clip) => clip.name === wanted);
  if (exact) return exact;
  const needle = wanted.toLowerCase();
  if (!needle) return undefined;
  return clips.find((clip) => clip.name.toLowerCase().includes(needle));
}

export function movementIntent(speed: number, speeds: readonly number[]): number {
  let max = 0;
  for (const value of speeds) if (value > max) max = value;
  if (!(max > 0)) return 0;
  return speed / max;
}
