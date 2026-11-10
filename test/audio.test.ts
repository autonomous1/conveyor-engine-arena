import assert from "node:assert/strict";
import test from "node:test";
import type { ArenaSounds } from "../src/shared/arena-view.ts";
import { createEchoDedupe, createSfx, type AudioContextLike } from "../src/client/audio.ts";

const param = () => ({ value: 0 });

class FakeNode {
  connected: unknown[] = [];
  connect(target: unknown) {
    this.connected.push(target);
    return target;
  }
  disconnect() {
    this.connected.length = 0;
  }
}

class FakeSource extends FakeNode {
  buffer: unknown;
  started = 0;
  stopped = 0;
  start() {
    this.started += 1;
  }
  stop() {
    this.stopped += 1;
  }
}

class FakeContext implements AudioContextLike {
  state = "suspended";
  currentTime = 0;
  destination = {};
  listener = { positionX: param(), positionY: param(), positionZ: param(), forwardX: param(), forwardY: param(), forwardZ: param(), upX: param(), upY: param(), upZ: param() };
  sources: FakeSource[] = [];
  panners = 0;
  decodes = 0;
  failDecode = new Set<number>();
  compressors: Array<FakeNode & { threshold: { value: number }; knee: { value: number }; ratio: { value: number }; attack: { value: number }; release: { value: number } }> = [];
  createGain() {
    return Object.assign(new FakeNode(), { gain: param() });
  }
  createDynamicsCompressor() {
    const node = Object.assign(new FakeNode(), {
      threshold: param(),
      knee: param(),
      ratio: param(),
      attack: param(),
      release: param(),
    });
    this.compressors.push(node);
    return node;
  }
  createPanner() {
    this.panners += 1;
    return Object.assign(new FakeNode(), {
      panningModel: "HRTF",
      distanceModel: "inverse",
      refDistance: 1,
      rolloffFactor: 1,
      positionX: param(),
      positionY: param(),
      positionZ: param(),
    });
  }
  createBufferSource() {
    const source = new FakeSource();
    this.sources.push(source);
    return source;
  }
  async decodeAudioData(data: ArrayBuffer) {
    this.decodes += 1;
    if (this.failDecode.has(data.byteLength)) throw new Error("decode");
    return { duration: 0.5 };
  }
  async resume() {
    this.state = "running";
  }
  async suspend() {
    this.state = "suspended";
  }
}

const sounds: ArenaSounds = {
  laser: { uri: "/assets/audio/laser-blast-sfx.mp3", volume: 0.6, maxVoices: 4, positional: true, refDistance: 4 },
  grenadeLaunch: { uri: "/assets/audio/grenade-launch.wav", volume: 0.8, maxVoices: 2, positional: true, refDistance: 3 },
  grenadeBlast: { uri: "/assets/audio/grenade-launch-grenade-blast.wav", volume: 2, maxVoices: 4, positional: true, refDistance: 8 },
};

const sizes: Record<string, number> = {
  "/assets/audio/laser-blast-sfx.mp3": 10,
  "/assets/audio/grenade-launch.wav": 20,
  "/assets/audio/grenade-launch-grenade-blast.wav": 30,
};

async function ready(opts: { missing?: string; failDecode?: number; noContext?: boolean } = {}) {
  const ctx = new FakeContext();
  if (opts.failDecode) ctx.failDecode.add(opts.failDecode);
  const errors: Array<[unknown, string]> = [];
  const fetched: string[] = [];
  const sfx = createSfx({
    sounds,
    fetchBytes: async (uri) => {
      fetched.push(uri);
      if (uri === opts.missing) throw new Error(`${uri}: HTTP 404`);
      return new ArrayBuffer(sizes[uri]!);
    },
    createContext: () => (opts.noContext ? undefined : ctx),
    onError: (err, effect) => errors.push([err, effect]),
  });
  await sfx.load();
  sfx.unlock();
  await new Promise((resolve) => setImmediate(resolve));
  return { ctx, sfx, errors, fetched };
}

test("nothing plays before the first gesture; each file is fetched and decoded once", async () => {
  const ctx = new FakeContext();
  let fetches = 0;
  const sfx = createSfx({ sounds, fetchBytes: async (uri) => (fetches++, new ArrayBuffer(sizes[uri]!)), createContext: () => ctx });
  await sfx.load();
  assert.equal(sfx.play("laser"), false, "locked until a gesture");
  assert.equal(ctx.decodes, 0, "no context, no decode");
  sfx.unlock();
  sfx.unlock();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetches, 3);
  assert.equal(ctx.decodes, 3);
  assert.equal(sfx.running, true);
  for (let i = 0; i < 5; i++) assert.equal(sfx.play("laser"), true);
  assert.equal(ctx.decodes, 3, "plays reuse the buffer");
});

test("voice cap: a play past maxVoices stops the oldest, slots are reused", async () => {
  const { ctx, sfx } = await ready();
  for (let i = 0; i < 4; i++) {
    ctx.currentTime = i * 0.01;
    assert.equal(sfx.play("laser", { x: i, y: 0, z: 0 }), true);
  }
  assert.equal(sfx.playing("laser"), 4);
  ctx.currentTime = 0.05;
  assert.equal(sfx.play("laser", { x: 9, y: 0, z: 0 }), true);
  assert.equal(sfx.voices("laser"), 4, "no slot past the cap");
  assert.equal(sfx.playing("laser"), 4);
  assert.equal(ctx.sources[0]!.stopped, 1, "the oldest stopped");
  assert.equal(ctx.sources[1]!.stopped, 0);
  assert.equal(ctx.panners, 4, "one panner per slot, reused");
  ctx.currentTime = 2;
  assert.equal(sfx.playing("laser"), 0, "all ended");
  sfx.play("laser");
  assert.equal(sfx.voices("laser"), 4);
  assert.equal(ctx.panners, 4);
});

test("positional plays use the panner at the point; own plays skip it", async () => {
  const { ctx, sfx } = await ready();
  sfx.play("grenadeBlast", { x: 3, y: 1, z: -2 });
  const positional = ctx.sources.at(-1)!;
  const panner = positional.connected[0] as { positionX: { value: number }; positionZ: { value: number }; refDistance: number };
  assert.equal(panner.positionX.value, 3);
  assert.equal(panner.positionZ.value, -2);
  assert.equal(panner.refDistance, 8);
  assert.equal(ctx.compressors.length, 1, "a limiter sits on the master output");
  assert.equal(ctx.compressors[0]!.threshold.value, -1);
  assert.equal(ctx.compressors[0]!.ratio.value, 20);
  assert.equal(ctx.compressors[0]!.connected[0], ctx.destination);
  sfx.play("grenadeBlast");
  const own = ctx.sources.at(-1)!;
  assert.ok(own.connected[0] && "gain" in (own.connected[0] as object), "straight into the effect gain");
  sfx.setListener(1, 2, 3, 0, 0, -1, 0, 1, 0);
  assert.equal(ctx.listener.positionY.value, 2);
  assert.equal(ctx.listener.forwardZ.value, -1);
  assert.equal(sfx.play("laser", { x: Number.NaN, y: 0, z: 0 }), false);
});

test("playTracked moves the panner while the voice sounds, and stops once it ends or is replaced", async () => {
  const { ctx, sfx } = await ready();
  const handle = sfx.playTracked("grenadeLaunch", { x: 1, y: 2, z: 3 });
  assert.ok(handle);
  const panner = ctx.sources.at(-1)!.connected[0] as { positionX: { value: number }; positionY: { value: number }; positionZ: { value: number } };
  assert.deepEqual([panner.positionX.value, panner.positionY.value, panner.positionZ.value], [1, 2, 3]);
  assert.equal(handle.move(4, 5, 6), true);
  assert.deepEqual([panner.positionX.value, panner.positionY.value, panner.positionZ.value], [4, 5, 6]);
  assert.equal(handle.move(Number.NaN, 0, 0), false);
  assert.equal(panner.positionX.value, 4, "a bad point is ignored");
  // maxVoices is 2: two more plays replace the first voice, and its handle goes dead.
  sfx.playTracked("grenadeLaunch", { x: 0, y: 0, z: 0 });
  sfx.playTracked("grenadeLaunch", { x: 0, y: 0, z: 0 });
  assert.equal(handle.move(7, 7, 7), false);
  assert.equal(panner.positionX.value, 0, "the slot's panner now belongs to the newer play and is not moved by the old handle");
  const later = sfx.playTracked("grenadeBlast", { x: 0, y: 0, z: 0 })!;
  ctx.currentTime = 5;
  assert.equal(later.move(1, 1, 1), false, "ended");
  assert.equal(sfx.playTracked("laser", { x: Number.NaN, y: 0, z: 0 }), undefined);
  sfx.setHidden(true);
  assert.equal(sfx.playTracked("grenadeBlast", { x: 0, y: 0, z: 0 }), undefined, "hidden tab: nothing starts");
});

test("hidden tab suspends and drops plays; volume and mute set the master gain", async () => {
  const { ctx, sfx } = await ready();
  sfx.setHidden(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ctx.state, "suspended");
  assert.equal(sfx.play("laser"), false);
  sfx.setHidden(false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sfx.play("laser"), true);
  sfx.setVolume(0.25);
  sfx.setVolume(7);
  assert.equal(sfx.volume, 1);
  sfx.setVolume(0.25);
  sfx.mute();
  assert.equal(sfx.muted, true);
  sfx.mute(false);
  assert.equal(sfx.volume, 0.25);
});

test("a missing file turns only that effect off and is reported once", async () => {
  const { sfx, errors } = await ready({ missing: "/assets/audio/grenade-launch.wav" });
  assert.equal(errors.length, 1);
  assert.equal(errors[0]![1], "grenadeLaunch");
  assert.equal(sfx.off("grenadeLaunch"), true);
  assert.equal(sfx.play("grenadeLaunch"), false);
  assert.doesNotThrow(() => sfx.play("grenadeLaunch", { x: 0, y: 0, z: 0 }));
  assert.equal(errors.length, 1);
  assert.equal(sfx.play("laser"), true);
  assert.equal(sfx.play("grenadeBlast"), true);
});

test("a decode error turns that effect off and is reported once", async () => {
  const { sfx, errors } = await ready({ failDecode: 30 });
  assert.equal(errors.length, 1);
  assert.equal(errors[0]![1], "grenadeBlast");
  assert.equal(sfx.play("grenadeBlast"), false);
  sfx.unlock();
  assert.equal(errors.length, 1);
  assert.equal(sfx.ready("laser"), true);
});

test("no AudioContext: one report, every effect off, nothing throws", async () => {
  const { sfx, errors } = await ready({ noContext: true });
  assert.equal(errors.length, 1);
  assert.equal(errors[0]![1], "context");
  assert.equal(sfx.unlock(), false);
  assert.equal(errors.length, 1);
  assert.equal(sfx.play("laser"), false);
  assert.equal(sfx.off("laser"), true);
  assert.doesNotThrow(() => sfx.setListener(0, 0, 0, 0, 0, -1, 0, 1, 0));

  const throwing = createSfx({ sounds, fetchBytes: async () => new ArrayBuffer(4), createContext: () => {
    throw new Error("blocked");
  }, onError: (err, effect) => errors.push([err, effect]) });
  assert.doesNotThrow(() => throwing.unlock());
  assert.equal(errors.length, 2);
});

test("absent manifest entries are simply silent", async () => {
  const sfx = createSfx({ createContext: () => new FakeContext() });
  await sfx.load();
  sfx.unlock();
  assert.equal(sfx.play("laser"), false);
});

test("own-shot dedupe: the host echo of a local play does not play again", () => {
  const dedupe = createEchoDedupe(1000);
  assert.equal(dedupe.echo(0), true, "an echo with no local play still plays");
  dedupe.noteLocal(100);
  assert.equal(dedupe.echo(180), false, "echo of the local play is dropped");
  assert.equal(dedupe.echo(190), true, "only once");
  dedupe.noteLocal(200);
  dedupe.noteLocal(400);
  assert.equal(dedupe.pending, 2);
  assert.equal(dedupe.echo(450), false);
  assert.equal(dedupe.echo(460), false);
  assert.equal(dedupe.echo(470), true);
  dedupe.noteLocal(500);
  assert.equal(dedupe.echo(1600), true, "a local play the host never echoed expires");
  assert.equal(dedupe.pending, 0);
  for (let i = 0; i < 20; i++) dedupe.noteLocal(2000 + i);
  assert.equal(dedupe.pending, 8, "fixed capacity");
  dedupe.clear();
  assert.equal(dedupe.pending, 0);
});
