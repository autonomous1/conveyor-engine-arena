/**
 * Timelines for a character that spawns or despawns: when its sound and beam fire, and how opaque
 * the model is. No three.js here; the caller turns an opacity into materials.
 *
 * spawn(id, at, now):   sound and beam at once; opacity 0 to 1 over `fadeMs`; then the character is plain.
 * despawn(id, at, now, holdMs): the despawn sound fires `despawnSoundDelayMs` after the event, and the
 *   character stays fully visible and still for `despawnDelayMs`; then the beam starts and the opacity
 *   falls 1 to 0 over `fadeMs`; then it is gone (opacity 0, hidden) until the next spawn of that id.
 *   `holdMs` pushes the whole sequence back (a death waits for its own thump).
 * A spawn of an id that is leaving cancels the despawn at once: its pending sound and beam never fire.
 * A beam hook that already ran is not recalled here; the sheet animation (ExplosionFx) keeps playing
 * to the end so a respawn at RESPAWN_MS (3 s) while a 2 s despawn beam still has ~0.2 s left does not
 * cut the sprite mid-frame. The new spawn's own beam starts independently.
 * Nothing is allocated per frame. One small state object is made per character that has an effect.
 */

export type Point = { x: number; y: number; z: number };

export type CharacterFxConfig = {
  fadeMs: number;
  despawnDelayMs: number;
  despawnSoundDelayMs: number;
};

export type CharacterFxHooks = {
  /** The spawn or despawn sound. `at` is the character's feet; a copy is not made. */
  sound(kind: "spawn" | "despawn", id: number, at: Point): void;
  /** The beam sheet. Same `at`. */
  beam(kind: "spawn" | "despawn", id: number, at: Point): void;
};

type State = {
  kind: "spawn" | "despawn";
  at: Point;
  /** Event time, plus any hold. */
  t0: number;
  soundAt: number;
  soundDone: boolean;
  /** Spawn: the beam and the fade-in start. Despawn: the beam and the fade-out start. */
  visualAt: number;
  visualDone: boolean;
  /** Fade length for this timeline, ms. */
  fade: number;
};

/**
 * Per-despawn override of the configured delay and fade.
 * @why A grenade kill fades with its blast.
 */
export type DespawnTiming = { delayMs?: number; fadeMs?: number };

/**
 * Spawn and despawn timelines. One row per id that has an effect.
 * @why No scene objects.
 */
export interface CharacterFx {
  /** Feet position. Stores a copy of `at`. Cancels a despawn of this id. */
  spawn(id: number, at: Point, now: number): void;
  /**
   * Start a despawn at `now + holdMs`. Stores a copy of `at`. One already running is left as it is.
   * `timing` replaces the configured delay and fade for this despawn only. `now` is ms.
   */
  despawn(id: number, at: Point, now: number, holdMs?: number, timing?: DespawnTiming): void;
  /** Once per frame. `now` is ms. Fires what is due and drops a finished spawn fade. No allocation. */
  update(now: number): void;
  /** 1 plain, 0 gone, between while fading. An unknown id is 1. */
  opacity(id: number, now: number): number;
  /** True while a despawn is stored, including after it has faded. An unknown id is false. */
  leaving(id: number): boolean;
  /** True once this despawn has faded out. An unknown id is false. */
  gone(id: number, now: number): boolean;
  /** Configured delay plus fade, in ms. No hold, and not a per-call timing override. */
  readonly despawnMs: number;
  /** Drop one id. A pending sound or beam for it does not fire. */
  forget(id: number): void;
  /** Drop every id. Pending sounds and beams do not fire. */
  clear(): void;
  /** Rows still stored. A finished despawn stays until spawn, forget, or clear. */
  readonly active: number;
}

export function createCharacterFx(config: CharacterFxConfig, hooks: CharacterFxHooks): CharacterFx {
  const states = new Map<number, State>();
  const fade = Math.max(1, config.fadeMs);

  function fire(id: number, state: State, now: number) {
    if (!state.soundDone && now >= state.soundAt) {
      state.soundDone = true;
      hooks.sound(state.kind, id, state.at);
    }
    if (!state.visualDone && now >= state.visualAt) {
      state.visualDone = true;
      hooks.beam(state.kind, id, state.at);
    }
  }

  function opacityOf(state: State, now: number): number {
    if (state.kind === "spawn") {
      const t = (now - state.visualAt) / state.fade;
      return t <= 0 ? 0 : t >= 1 ? 1 : t;
    }
    const t = (now - state.visualAt) / state.fade;
    return t <= 0 ? 1 : t >= 1 ? 0 : 1 - t;
  }

  return {
    /** A character appeared at `at` (its feet). Cancels a despawn of the same id. */
    spawn(id: number, at: Point, now: number) {
      states.set(id, {
        kind: "spawn",
        at: { x: at.x, y: at.y, z: at.z },
        t0: now,
        soundAt: now,
        soundDone: false,
        visualAt: now,
        visualDone: false,
        fade,
      });
      fire(id, states.get(id)!, now);
    },
    /**
     * A character went at `at`. The sequence starts at `now + holdMs`. A despawn already running keeps its start.
     * `timing` replaces the configured despawn delay and fade for this despawn only.
     */
    despawn(id: number, at: Point, now: number, holdMs = 0, timing: DespawnTiming = {}) {
      const current = states.get(id);
      if (current?.kind === "despawn") return;
      const t0 = now + Math.max(0, holdMs);
      states.set(id, {
        kind: "despawn",
        at: { x: at.x, y: at.y, z: at.z },
        t0,
        soundAt: t0 + config.despawnSoundDelayMs,
        soundDone: false,
        visualAt: t0 + Math.max(0, timing.delayMs ?? config.despawnDelayMs),
        visualDone: false,
        fade: Math.max(1, timing.fadeMs ?? fade),
      });
      fire(id, states.get(id)!, now);
    },
    /** Fire what is due, and drop finished spawn fades. Call once per frame. */
    update(now: number) {
      for (const [id, state] of states) {
        fire(id, state, now);
        if (state.kind === "spawn" && state.visualDone && state.soundDone && now - state.visualAt >= state.fade) states.delete(id);
      }
    },
    /** 1 plain, 0 gone, between: fading. */
    opacity(id: number, now: number): number {
      const state = states.get(id);
      return state ? opacityOf(state, now) : 1;
    },
    /** True while a despawn is running or finished (the model is held, fading, or gone). */
    leaving(id: number): boolean {
      return states.get(id)?.kind === "despawn";
    },
    /** True once a despawn has fully faded: the model should stay hidden. */
    gone(id: number, now: number): boolean {
      const state = states.get(id);
      return state?.kind === "despawn" && now - state.visualAt >= state.fade;
    },
    /** Total time of a despawn from its event, with no hold, in ms. */
    get despawnMs() {
      return config.despawnDelayMs + fade;
    },
    forget(id: number) {
      states.delete(id);
    },
    clear() {
      states.clear();
    },
    get active() {
      return states.size;
    },
  };
}
