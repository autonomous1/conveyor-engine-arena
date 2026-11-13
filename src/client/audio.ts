import type { ArenaSoundEffect, ArenaSoundName, ArenaSounds } from "../shared/arena-view.js";

/**
 * Sound effects on one Web Audio context.
 *
 * Each file is fetched once at boot and decoded once into an AudioBuffer. The context is
 * created on the first user gesture (browser autoplay policy), and the decode runs then.
 * A play is one new AudioBufferSourceNode into the effect's GainNode, then the master gain.
 * There is no HTMLAudioElement per shot.
 *
 * Each effect has `maxVoices` slots. A play past the cap stops the oldest voice.
 * A positional play goes through that slot's PannerNode, made once and reused. The camera
 * is the listener. A non-positional play (your own shot) skips the panner.
 *
 * A missing file, a decode error, or no AudioContext is reported once and turns that
 * effect (or all audio) off. Nothing here throws.
 */

export const SOUND_NAMES: readonly ArenaSoundName[] = ["laser", "grenadeLaunch", "grenadeBlast", "cratePickup", "keyPickup", "medkitPickup", "doorOpen", "doorClose", "elevatorStart", "beamSpawn", "beamDespawn"];

/** The part of AudioParam this module sets. */
type ParamLike = { value: number };

type NodeLike = {
  connect(target: unknown): unknown;
  disconnect(): void;
};

type GainLike = NodeLike & { gain: ParamLike };

type CompressorLike = NodeLike & {
  threshold: ParamLike;
  knee: ParamLike;
  ratio: ParamLike;
  attack: ParamLike;
  release: ParamLike;
};

type PannerLike = NodeLike & {
  panningModel: string;
  distanceModel: string;
  refDistance: number;
  rolloffFactor: number;
  positionX: ParamLike;
  positionY: ParamLike;
  positionZ: ParamLike;
};

type SourceLike = NodeLike & {
  buffer: unknown;
  start(when?: number): void;
  stop(when?: number): void;
};

type ListenerLike = {
  positionX?: ParamLike;
  positionY?: ParamLike;
  positionZ?: ParamLike;
  forwardX?: ParamLike;
  forwardY?: ParamLike;
  forwardZ?: ParamLike;
  upX?: ParamLike;
  upY?: ParamLike;
  upZ?: ParamLike;
  setPosition?(x: number, y: number, z: number): void;
  setOrientation?(fx: number, fy: number, fz: number, ux: number, uy: number, uz: number): void;
};

/** The part of AudioContext this module uses, so tests can pass a fake. */
export type AudioContextLike = {
  readonly state: string;
  readonly currentTime: number;
  readonly destination: unknown;
  readonly listener: ListenerLike;
  createGain(): GainLike;
  createPanner(): PannerLike;
  createBufferSource(): SourceLike;
  /** Optional. When present, a peak limiter sits between the master gain and the destination. */
  createDynamicsCompressor?(): CompressorLike;
  decodeAudioData(data: ArrayBuffer): Promise<{ duration: number }>;
  resume(): Promise<void>;
  suspend(): Promise<void>;
};

export type SfxOptions = {
  sounds?: ArenaSounds;
  /** Returns the file bytes. Default `fetch(uri)`. */
  fetchBytes?: (uri: string) => Promise<ArrayBuffer>;
  /** Default `new AudioContext()`. Return undefined, or throw, when there is none. */
  createContext?: () => AudioContextLike | undefined;
  /** Once per effect that fails, once for a missing context. `effect` is `context` for that. */
  onError?: (err: unknown, effect: ArenaSoundName | "context") => void;
};

export type Point = { x: number; y: number; z: number };

/** A positional play that can still be moved. See `playTracked`. */
export type SoundHandle = { move(x: number, y: number, z: number): boolean };

type Voice = {
  source: SourceLike | undefined;
  panner: PannerLike | undefined;
  /** Context time when the play ends. */
  endsAt: number;
  startedAt: number;
};

type Effect = {
  name: ArenaSoundName;
  spec: ArenaSoundEffect;
  state: "fetching" | "fetched" | "decoding" | "ready" | "off";
  bytes: ArrayBuffer | undefined;
  buffer: { duration: number } | undefined;
  gain: GainLike | undefined;
  voices: Voice[];
};

function defaultContext(): AudioContextLike | undefined {
  const Ctor = (globalThis as { AudioContext?: new () => AudioContextLike; webkitAudioContext?: new () => AudioContextLike }).AudioContext
    ?? (globalThis as { webkitAudioContext?: new () => AudioContextLike }).webkitAudioContext;
  return Ctor ? new Ctor() : undefined;
}

async function defaultFetch(uri: string): Promise<ArrayBuffer> {
  const res = await fetch(uri);
  if (!res.ok) throw new Error(`${uri}: HTTP ${res.status}`);
  return res.arrayBuffer();
}

function setParam(param: ParamLike | undefined, value: number): void {
  if (param && param.value !== value) param.value = value;
}

/** One Web Audio context. Files are fetched up front and decoded after unlock. */
export interface Sfx {
  /** Fetches each file. A bad file calls onError and turns that effect off. Never rejects. */
  load(): Promise<void>;
  /** Call from a user gesture. Creates the context once and resumes it. True when one exists. Never throws. */
  unlock(): boolean;
  /**
   * One play. False when locked, hidden, not running, or the effect is off.
   * Master mute still starts the voice, silent. `at` is world metres when the effect is positional.
   */
  play(name: ArenaSoundName, at?: Point): boolean;
  /** Like play, plus a handle. `move` allocates nothing and returns false once the voice ends or is replaced. */
  playTracked(name: ArenaSoundName, at: Point): SoundHandle | undefined;
  /** Listener pose in world metres. No-op until the context is running. Allocates nothing. */
  setListener(px: number, py: number, pz: number, fx: number, fy: number, fz: number, ux: number, uy: number, uz: number): void;
  /** Hidden suspends the context and stops voices. Shown resumes. A repeat is a no-op. */
  setHidden(value: boolean): void;
  /** Master gain, clamped to 0..1. A non-finite value is ignored. */
  setVolume(value: number): void;
  /** Pass false to unmute. Omitted means mute. The stored volume stays. */
  mute(value?: boolean): void;
  readonly volume: number;
  readonly muted: boolean;
  /** True once a context exists, even when it is not running. */
  readonly unlocked: boolean;
  /** True when the context state is running. */
  readonly running: boolean;
  /** Decoded and able to play. An unknown name is false. */
  ready(name: ArenaSoundName): boolean;
  /** Failed, or absent from the manifest. An unknown name is true. */
  off(name: ArenaSoundName): boolean;
  /** Voices of this effect still sounding. Zero when there is no context. */
  playing(name: ArenaSoundName): number;
  /** Slots made so far, never more than the effect's maxVoices. */
  voices(name: ArenaSoundName): number;
  /** Stop every voice. The context stays open. */
  stopAll(): void;
}

export function createSfx(opts: SfxOptions = {}): Sfx {
  const fetchBytes = opts.fetchBytes ?? defaultFetch;
  const makeContext = opts.createContext ?? defaultContext;
  const effects = new Map<ArenaSoundName, Effect>();
  for (const name of SOUND_NAMES) {
    const spec = opts.sounds?.[name];
    if (!spec) continue;
    effects.set(name, { name, spec, state: "fetching", bytes: undefined, buffer: undefined, gain: undefined, voices: [] });
  }
  let ctx: AudioContextLike | undefined;
  let master: GainLike | undefined;
  let contextFailed = false;
  let hidden = false;
  let volume = 1;
  let muted = false;

  function fail(effect: Effect, err: unknown) {
    if (effect.state === "off") return;
    effect.state = "off";
    effect.bytes = undefined;
    effect.buffer = undefined;
    try {
      opts.onError?.(err, effect.name);
    } catch {
      // A reporter fault must not stop the game.
    }
  }

  function applyMaster() {
    if (master) setParam(master.gain, muted ? 0 : volume);
  }

  function decode(effect: Effect) {
    if (!ctx || effect.state !== "fetched" || !effect.bytes) return;
    const bytes = effect.bytes;
    effect.bytes = undefined;
    effect.state = "decoding";
    let pending: Promise<{ duration: number }>;
    try {
      pending = ctx.decodeAudioData(bytes);
    } catch (err) {
      fail(effect, err);
      return;
    }
    pending.then((buffer) => {
      if (effect.state !== "decoding") return;
      if (!buffer || !(buffer.duration > 0)) {
        fail(effect, new Error(`${effect.spec.uri}: decoded to no audio`));
        return;
      }
      effect.buffer = buffer;
      effect.state = "ready";
    }, (err: unknown) => fail(effect, err));
  }

  /** Fetches every file once. Decoding waits for {@link unlock}. Never rejects. */
  async function load(): Promise<void> {
    await Promise.all([...effects.values()].map(async (effect) => {
      try {
        const bytes = await fetchBytes(effect.spec.uri);
        if (effect.state !== "fetching") return;
        if (!bytes || bytes.byteLength === 0) throw new Error(`${effect.spec.uri}: empty file`);
        effect.bytes = bytes;
        effect.state = "fetched";
        decode(effect);
      } catch (err) {
        fail(effect, err);
      }
    }));
  }

  /**
   * Call from a user gesture. Creates the context once, resumes it, and starts decoding.
   * Returns true when a context exists. Never throws.
   */
  function unlock(): boolean {
    if (contextFailed) return false;
    if (!ctx) {
      let made: AudioContextLike | undefined;
      try {
        made = makeContext();
      } catch (err) {
        made = undefined;
        contextFailed = true;
        for (const effect of effects.values()) effect.state = "off";
        try {
          opts.onError?.(err, "context");
        } catch {
          // ignore
        }
        return false;
      }
      if (!made) {
        contextFailed = true;
        for (const effect of effects.values()) effect.state = "off";
        try {
          opts.onError?.(new Error("Web Audio is not available"), "context");
        } catch {
          // ignore
        }
        return false;
      }
      ctx = made;
      try {
        master = ctx.createGain();
        // There was no compressor. A blast gain of 2 (+6 dB) would hard-clip a
        // near-full-scale sample at the destination, and stacked voices would be worse.
        // A peak limiter between master and destination holds that down.
        if (typeof ctx.createDynamicsCompressor === "function") {
          const limiter = ctx.createDynamicsCompressor();
          limiter.threshold.value = -1;
          limiter.knee.value = 0;
          limiter.ratio.value = 20;
          limiter.attack.value = 0.003;
          limiter.release.value = 0.25;
          master.connect(limiter);
          limiter.connect(ctx.destination);
        } else {
          master.connect(ctx.destination);
        }
        applyMaster();
        for (const effect of effects.values()) {
          effect.gain = ctx.createGain();
          effect.gain.gain.value = effect.spec.volume;
          effect.gain.connect(master);
        }
      } catch (err) {
        for (const effect of effects.values()) fail(effect, err);
        return true;
      }
      for (const effect of effects.values()) decode(effect);
    }
    if (!hidden && ctx.state !== "running") ctx.resume().catch(() => undefined);
    return true;
  }

  function pickVoice(effect: Effect, now: number): Voice {
    const voices = effect.voices;
    for (const voice of voices) if (!voice.source || now >= voice.endsAt) return voice;
    if (voices.length < effect.spec.maxVoices) {
      const voice: Voice = { source: undefined, panner: undefined, endsAt: 0, startedAt: 0 };
      voices.push(voice);
      return voice;
    }
    let oldest = voices[0]!;
    for (const voice of voices) if (voice.startedAt < oldest.startedAt) oldest = voice;
    return oldest;
  }

  function stopVoice(voice: Voice) {
    const source = voice.source;
    voice.source = undefined;
    if (!source) return;
    try {
      source.stop();
    } catch {
      // Already stopped.
    }
    try {
      source.disconnect();
    } catch {
      // Already disconnected.
    }
  }

  /**
   * One play. `at` set and the effect positional: through a panner at that world point.
   * Returns false when audio is locked, hidden, muted at the source, or the effect is off.
   */
  function play(name: ArenaSoundName, at?: Point): boolean {
    return start(name, at) !== undefined;
  }

  /**
   * Like {@link play}, and returns a handle that moves the voice's panner while it sounds. `move` takes plain
   * numbers, so a per-frame call allocates nothing. It returns false once the voice has ended or been replaced.
   * Undefined when nothing started (locked, hidden, effect off).
   */
  function playTracked(name: ArenaSoundName, at: Point): SoundHandle | undefined {
    const started = start(name, at);
    if (!started) return undefined;
    const { voice, source } = started;
    return {
      move(x: number, y: number, z: number): boolean {
        const panner = voice.panner;
        if (voice.source !== source || !panner || !ctx || ctx.currentTime >= voice.endsAt) return false;
        if (!(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z))) return false;
        setParam(panner.positionX, x);
        setParam(panner.positionY, y);
        setParam(panner.positionZ, z);
        return true;
      },
    };
  }

  function start(name: ArenaSoundName, at?: Point): { voice: Voice; source: SourceLike } | undefined {
    const effect = effects.get(name);
    if (!ctx || !effect || effect.state !== "ready" || !effect.buffer || !effect.gain || hidden) return undefined;
    if (ctx.state !== "running") return undefined;
    if (at && !(Number.isFinite(at.x) && Number.isFinite(at.y) && Number.isFinite(at.z))) return undefined;
    try {
      const now = ctx.currentTime;
      const voice = pickVoice(effect, now);
      stopVoice(voice);
      const source = ctx.createBufferSource();
      source.buffer = effect.buffer;
      if (at && effect.spec.positional) {
        if (!voice.panner) {
          const panner = ctx.createPanner();
          panner.panningModel = "equalpower";
          panner.distanceModel = "inverse";
          panner.refDistance = effect.spec.refDistance;
          panner.rolloffFactor = 1;
          panner.connect(effect.gain);
          voice.panner = panner;
        }
        setParam(voice.panner.positionX, at.x);
        setParam(voice.panner.positionY, at.y);
        setParam(voice.panner.positionZ, at.z);
        source.connect(voice.panner);
      } else {
        source.connect(effect.gain);
      }
      source.start();
      voice.source = source;
      voice.startedAt = now;
      voice.endsAt = now + effect.buffer.duration;
      return { voice, source };
    } catch (err) {
      fail(effect, err);
      return undefined;
    }
  }

  /**
   * Camera as the listener: position, forward, up. Plain numbers, so a frame allocates nothing.
   */
  function setListener(px: number, py: number, pz: number, fx: number, fy: number, fz: number, ux: number, uy: number, uz: number) {
    if (!ctx || ctx.state !== "running") return;
    const l = ctx.listener;
    if (l.positionX) {
      setParam(l.positionX, px);
      setParam(l.positionY, py);
      setParam(l.positionZ, pz);
      setParam(l.forwardX, fx);
      setParam(l.forwardY, fy);
      setParam(l.forwardZ, fz);
      setParam(l.upX, ux);
      setParam(l.upY, uy);
      setParam(l.upZ, uz);
    } else {
      l.setPosition?.(px, py, pz);
      l.setOrientation?.(fx, fy, fz, ux, uy, uz);
    }
  }

  /** Hidden tab: suspend the context and drop plays. Visible: resume. */
  function setHidden(value: boolean) {
    if (hidden === value) return;
    hidden = value;
    if (!ctx) return;
    if (hidden) {
      for (const effect of effects.values()) for (const voice of effect.voices) stopVoice(voice);
      ctx.suspend().catch(() => undefined);
    } else ctx.resume().catch(() => undefined);
  }

  return {
    load,
    unlock,
    play,
    playTracked,
    setListener,
    setHidden,
    /** Master volume 0 to 1. */
    setVolume(value: number) {
      if (!Number.isFinite(value)) return;
      volume = Math.min(1, Math.max(0, value));
      applyMaster();
    },
    mute(value = true) {
      muted = value;
      applyMaster();
    },
    get volume() {
      return volume;
    },
    get muted() {
      return muted;
    },
    get unlocked() {
      return !!ctx;
    },
    get running() {
      return ctx?.state === "running";
    },
    /** True when the effect is decoded and can play. */
    ready(name: ArenaSoundName): boolean {
      return effects.get(name)?.state === "ready";
    },
    /** True when the effect failed or the context is missing. */
    off(name: ArenaSoundName): boolean {
      const effect = effects.get(name);
      return !effect || effect.state === "off";
    },
    /** Voices still sounding for one effect. */
    playing(name: ArenaSoundName): number {
      const effect = effects.get(name);
      if (!ctx || !effect) return 0;
      const now = ctx.currentTime;
      let count = 0;
      for (const voice of effect.voices) if (voice.source && now < voice.endsAt) count += 1;
      return count;
    },
    /** Voice slots made so far for one effect, never more than `maxVoices`. */
    voices(name: ArenaSoundName): number {
      return effects.get(name)?.voices.length ?? 0;
    },
    stopAll() {
      for (const effect of effects.values()) for (const voice of effect.voices) stopVoice(voice);
    },
  };
}

/**
 * Your own shot plays on the local press. The host echo of that shot must not play again.
 * `noteLocal` records a local play. `echo` returns true when an own echo should still play:
 * there is no local play waiting inside `windowMs`. Fixed storage: no allocation per call.
 */
/** Fixed-slot gate so a host echo of your own shot does not play twice. No allocation per call. */
export interface EchoDedupe {
  /** Record a local play. Notes older than the window are dropped. `now` is ms. */
  noteLocal(now: number): void;
  /** True: play this echo. False: a waiting local play covered it and is consumed. */
  echo(now: number): boolean;
  /** Local plays still inside the window. */
  readonly pending: number;
  /** Drop every waiting local play. */
  clear(): void;
}

export function createEchoDedupe(windowMs = 1000, capacity = 8): EchoDedupe {
  const at = new Float64Array(capacity);
  let head = 0;
  let count = 0;
  function prune(now: number) {
    while (count > 0 && now - at[head]! > windowMs) {
      head = (head + 1) % capacity;
      count -= 1;
    }
  }
  return {
    noteLocal(now: number) {
      prune(now);
      if (count === capacity) {
        head = (head + 1) % capacity;
        count -= 1;
      }
      at[(head + count) % capacity] = now;
      count += 1;
    },
    /** True: play this echo. False: a local play already covered it (and is consumed). */
    echo(now: number): boolean {
      prune(now);
      if (count === 0) return true;
      head = (head + 1) % capacity;
      count -= 1;
      return false;
    },
    get pending() {
      return count;
    },
    clear() {
      head = 0;
      count = 0;
    },
  };
}
