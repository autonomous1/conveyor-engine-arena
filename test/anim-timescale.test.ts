import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as THREE from "three";
import type { CharacterTemplates } from "../src/client/arena-scene.ts";
import { createPawnLayer } from "../src/client/presentation.ts";
import {
  clipTimeScale,
  DEFAULT_MAX_TIME_SCALE,
  DEFAULT_MIN_TIME_SCALE,
  freshGroundSpeed,
  noteGroundSpeed,
} from "../src/shared/anim-speed.ts";
import { compileGame, GameManifestError } from "../dist/server/game-manifest.js";
import { projectRoot, readManifestSources } from "../dist/server/load-game.js";

const near = (a: number, b: number, label: string, tol = 1e-9) => assert.ok(Math.abs(a - b) < tol, `${label}: ${a} vs ${b}`);

test("time scale is ground speed over the scaled reference speed, clamped; no reference plays at 1x", () => {
  near(clipTimeScale(2.8, { referenceSpeed: 1.4 }), 2, "2x");
  // Asset scale 2 doubles the stride: the same 2.8 m/s is 1x.
  near(clipTimeScale(2.8, { referenceSpeed: 1.4 }, 2), 1, "scaled stride");
  near(clipTimeScale(100, { referenceSpeed: 1.4 }), DEFAULT_MAX_TIME_SCALE, "max clamp");
  near(clipTimeScale(0, { referenceSpeed: 1.4 }), DEFAULT_MIN_TIME_SCALE, "min clamp at rest");
  near(clipTimeScale(10, { referenceSpeed: 1, minTimeScale: 0.5, maxTimeScale: 4 }), 4, "own max");
  near(clipTimeScale(0.1, { referenceSpeed: 1, minTimeScale: 0.5, maxTimeScale: 4 }), 0.5, "own min");
  near(clipTimeScale(3, undefined), 1, "no entry");
  near(clipTimeScale(3, {}), 1, "no referenceSpeed");
  near(clipTimeScale(Number.NaN, { referenceSpeed: 1 }), DEFAULT_MIN_TIME_SCALE, "NaN speed");
});

test("ground speed is the low-passed rendered delta, and a teleport does not spike it", () => {
  const g = freshGroundSpeed();
  assert.equal(noteGroundSpeed(g, 0, 0, 1 / 60), 0, "first sample only anchors");
  let x = 0;
  let last = 0;
  for (let i = 0; i < 120; i++) {
    x += 3 / 60;
    // Snapshot jitter: alternate +-20% per frame.
    const jitter = i % 2 ? 0.2 * (3 / 60) : -0.2 * (3 / 60);
    last = noteGroundSpeed(g, x + jitter, 0, 1 / 60);
  }
  near(last, 3, "settles on 3 m/s", 0.5);
  const before = g.speed;
  noteGroundSpeed(g, x + 50, 0, 1 / 60);
  near(g.speed, before, "teleport ignored");
  for (let i = 0; i < 120; i++) last = noteGroundSpeed(g, x + 50, 0, 1 / 60);
  assert.ok(last < 0.01, `stops: ${last}`);
});

function rig(rates: Record<string, { referenceSpeed?: number }>, scale?: number): CharacterTemplates {
  const names = ["idle", "walk", "run", "fall", "angry"] as const;
  const clips = names.map((name) => new THREE.AnimationClip(name, 1, [
    new THREE.QuaternionKeyframeTrack(".quaternion", [0, 1], [0, 0, 0, 1, 0, 0, 0, 1]),
  ]));
  const animations = Object.fromEntries(names.map((name) => [name, { clip: name, speed: 0, ...(rates[name] ?? {}) }])) as never;
  return new Map([["pawn", { object: new THREE.Group(), clips, animations, ...(scale ? { scale } : {}) }]]);
}

function snap(clip: string, x: number, speed = 0) {
  return {
    frame: 1,
    serverTick: 1n,
    snapshotSeq: 1,
    entities: [{
      id: 1,
      render: { assetKey: "pawn" },
      position: { x, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 1, y: 1, z: 1 },
      clip,
      speed,
      visible: true,
      lifecycle: "alive" as const,
      predicted: false,
    }],
  };
}

type Row = { movement?: string; timeScale: number; groundSpeed: number };
const report = () => ((globalThis as { __pawnAnim?: Row[] }).__pawnAnim ?? [])[0]!;

test("a walking pawn's clip rate follows its rendered speed; idle and unmeasured clips stay at 1x", () => {
  const pawns = createPawnLayer(new THREE.Group(), rig({ walk: { referenceSpeed: 1.25 } }, 2), 1.8);
  let x = 0;
  for (let i = 0; i < 90; i++) {
    x += 2.5 / 60;
    pawns.apply(snap("walk", x, 2.5), 1 / 60, () => undefined);
  }
  // 2.5 m/s over a 1.25 m/s stride grown 2x by the asset scale = 1x.
  near(report().timeScale, 1, "walk rate", 0.05);
  for (let i = 0; i < 90; i++) {
    x += 5 / 60;
    pawns.apply(snap("walk", x, 5), 1 / 60, () => undefined);
  }
  near(report().timeScale, 2, "faster walk", 0.1);
  pawns.apply(snap("idle", x), 1 / 60, () => undefined);
  assert.equal(report().movement, "idle");
  assert.equal(report().timeScale, 1, "idle has no referenceSpeed");
  pawns.apply(snap("run", x + 0.1), 1 / 60, () => undefined);
  assert.equal(report().timeScale, 1, "run has no referenceSpeed");
});

function compile(doc: unknown) {
  const root = projectRoot();
  const files = new Map<string, Uint8Array>();
  for (const asset of (doc as { assets: Array<{ uri?: unknown }> }).assets) {
    if (typeof asset.uri === "string") files.set(asset.uri, new Uint8Array(readFileSync(`${root}/web${asset.uri}`)));
  }
  return compileGame(doc, (uri: string) => files.get(uri), readManifestSources(root, doc));
}

function withCyborg(edit: (animations: Record<string, Record<string, unknown>>) => void): unknown {
  const doc = JSON.parse(readFileSync(`${projectRoot()}/web/game/arena.game.json`, "utf8")) as {
    assets: Array<{ id: string; animations?: Record<string, Record<string, unknown>> }>;
  };
  const asset = doc.assets.find((item) => item.id === "cyborg-endoskeleton");
  assert.ok(asset?.animations);
  edit(asset.animations);
  return doc;
}

test("the manifest accepts optional referenceSpeed and a time-scale clamp, and names bad values", () => {
  const game = compile(withCyborg((a) => {
    a.walk!.referenceSpeed = 1.4;
    a.run!.referenceSpeed = 3.2;
    a.run!.minTimeScale = 0.5;
    a.run!.maxTimeScale = 2;
  }));
  const player = game.view.characters.find((c: { id: string }) => c.id === "cyborg-endoskeleton")!;
  assert.deepEqual(player.animations.walk, { clip: "walk", speed: 1, referenceSpeed: 1.4 });
  assert.deepEqual(player.animations.run, { clip: "run", speed: 3, referenceSpeed: 3.2, minTimeScale: 0.5, maxTimeScale: 2 });
  assert.deepEqual(player.animations.idle, { clip: "fold_arms", speed: 0 }, "absent fields stay absent");

  const plain = compile(withCyborg((a) => { for (const entry of Object.values(a)) delete entry.referenceSpeed; }));
  const before = plain.view.characters.find((c: { id: string }) => c.id === "cyborg-endoskeleton")!;
  assert.equal("referenceSpeed" in before.animations.walk, false, "an entry without the field parses without it");

  for (const [key, value, path] of [
    ["referenceSpeed", 0, "walk.referenceSpeed"],
    ["referenceSpeed", "fast", "walk.referenceSpeed"],
    ["maxTimeScale", -1, "walk.maxTimeScale"],
  ] as const) {
    assert.throws(() => compile(withCyborg((a) => { a.walk![key] = value; })), (err: unknown) => {
      assert.ok(err instanceof GameManifestError);
      assert.ok(err.issues.some((issue) => issue.path.endsWith(`.animations.${path}`)), JSON.stringify(err.issues));
      return true;
    });
  }
  assert.throws(() => compile(withCyborg((a) => { a.walk!.minTimeScale = 3; a.walk!.maxTimeScale = 2; })), (err: unknown) => {
    assert.ok(err instanceof GameManifestError);
    assert.ok(err.issues.some((issue) => issue.path.endsWith(".animations.walk.minTimeScale")));
    return true;
  });
});
