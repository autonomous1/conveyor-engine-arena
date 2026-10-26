import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import test from "node:test";
import * as THREE from "three";
import { placeRoomLights } from "../src/client/arena-scene.ts";
import type { CompileSources } from "../src/server/game-manifest.ts";

// Server modules import siblings as `.js`. Strip-types loads this file from
// source, so those specifiers resolve to the `.ts` files.
register(
  "data:text/javascript," +
    encodeURIComponent(`
      import { existsSync } from "node:fs";
      import { fileURLToPath } from "node:url";
      export async function resolve(specifier, context, nextResolve) {
        const parent = context.parentURL ?? "";
        if ((specifier.startsWith("./") || specifier.startsWith("../")) && specifier.endsWith(".js") && parent.includes("/src/")) {
          const ts = specifier.slice(0, -3) + ".ts";
          if (existsSync(fileURLToPath(new URL(ts, parent)))) return nextResolve(ts, context);
        }
        return nextResolve(specifier, context);
      }
    `),
);

const { compileGame, GameManifestError } = await import("../src/server/game-manifest.ts");
const { projectRoot, readManifestSources } = await import("../src/server/load-game.ts");

function document(): Record<string, unknown> {
  return JSON.parse(readFileSync(`${projectRoot()}/web/game/arena.game.json`, "utf8")) as Record<string, unknown>;
}

function filesFromDisk(): Map<string, Uint8Array> {
  const doc = document() as { assets?: Array<{ uri?: unknown }> };
  const root = projectRoot();
  const out = new Map<string, Uint8Array>();
  for (const asset of doc.assets ?? []) {
    if (typeof asset.uri !== "string") continue;
    out.set(asset.uri, new Uint8Array(readFileSync(`${root}/web${asset.uri}`)));
  }
  return out;
}

const files = filesFromDisk();
const read = (uri: string) => files.get(uri);

function sourcesFor(doc: unknown, lightsText?: string): CompileSources | undefined {
  const sources = readManifestSources(projectRoot(), doc);
  if (lightsText === undefined || !sources) return sources;
  const scene = (doc as { scene?: { lights?: unknown } }).scene;
  const path = typeof scene?.lights === "string" ? scene.lights : "./web/game/rooms.lights.json";
  sources.lightsFile = { path, text: lightsText };
  return sources;
}

function compile(doc: unknown, lightsText?: string) {
  return compileGame(doc, read, sourcesFor(doc, lightsText));
}

const lamp = {
  id: "lamp",
  type: "point",
  position: [1, 2, 3],
  color: "#ffd9a0",
  intensity: 8,
  range: 4,
};

const panel = {
  id: "panel",
  type: "rect",
  position: [4, 5, 6],
  yaw: 90,
  color: "#ffffff",
  intensity: 150,
  width: 0.8,
  height: 0.3,
};

test("scene.lights becomes view.lights", () => {
  const doc = document();
  const game = compile(doc, JSON.stringify({
    formatVersion: 1,
    units: "meters",
    lights: [lamp, panel],
  }));
  assert.deepEqual(game.view.lights, [lamp, panel]);
  const installed = compile(document());
  const file = JSON.parse(readFileSync(`${projectRoot()}/web/game/rooms.lights.json`, "utf8")) as { lights: unknown };
  assert.deepEqual(installed.view.lights, file.lights);
});

test("colour red and 33 lights are issues", () => {
  const doc = document();
  assert.throws(() => compile(doc, JSON.stringify({
    lights: [{ id: "lamp", type: "point", position: [0, 1, 0], color: "red", intensity: 1 }],
  })), (err: unknown) => {
    assert.ok(err instanceof GameManifestError);
    assert.ok(err.issues.some((issue) => issue.path.includes("lamp") && issue.message === "must be #rrggbb"));
    assert.ok(err.issues.every((issue) => issue.path.startsWith("scene.lights")));
    return true;
  });

  const many = Array.from({ length: 33 }, (_, index) => ({
    id: `light-${index}`,
    type: "point",
    position: [0, 1, 0],
    color: "#ffffff",
    intensity: 1,
  }));
  assert.throws(() => compile(doc, JSON.stringify({ lights: many })), (err: unknown) => {
    assert.ok(err instanceof GameManifestError);
    assert.ok(err.issues.some((issue) => issue.path === "scene.lights.light-32" && issue.message === "at most 32 lights"));
    assert.ok(err.issues.every((issue) => issue.path.startsWith("scene.lights")));
    return true;
  });
});

test("no scene.lights is an empty list and lights stay out of the authoritative hash", () => {
  const doc = document();
  const withLights = compile(doc, JSON.stringify({ lights: [lamp] }));
  const brighter = compile(doc, JSON.stringify({ lights: [{ ...lamp, intensity: 9 }] }));
  assert.equal(withLights.authoritativeHash, brighter.authoritativeHash);
  assert.notEqual(withLights.presentationHash, brighter.presentationHash);

  const bare = structuredClone(doc) as { scene: Record<string, unknown> };
  delete bare.scene.lights;
  const sources = readManifestSources(projectRoot(), bare);
  assert.equal(sources?.lightsFile, undefined);
  const game = compileGame(bare, read, sources);
  assert.deepEqual(game.view.lights, []);
  assert.equal(game.authoritativeHash, withLights.authoritativeHash);
});

test("a rect light faces down and a point light uses decay 2", () => {
  const scene = new THREE.Scene();
  placeRoomLights([lamp, panel], scene);
  const point = scene.children.find((child) => child instanceof THREE.PointLight) as THREE.PointLight | undefined;
  assert.ok(point);
  assert.equal(point.decay, 2);
  assert.equal(point.distance, 4);
  assert.equal(point.castShadow, false);
  assert.deepEqual(point.position.toArray(), [1, 2, 3]);

  const group = scene.children.find((child) => child instanceof THREE.Group) as THREE.Group | undefined;
  assert.ok(group);
  assert.deepEqual(group.position.toArray(), [4, 5, 6]);
  assert.ok(Math.abs(group.rotation.y - (Math.PI / 2)) < 1e-9);
  const rect = group.children[0] as THREE.RectAreaLight;
  assert.ok(rect instanceof THREE.RectAreaLight);
  assert.equal(rect.castShadow, false);
  assert.equal(rect.width, 0.8);
  assert.equal(rect.height, 0.3);
  assert.ok(Math.abs(rect.rotation.x + Math.PI / 2) < 1e-9);
  scene.updateMatrixWorld(true);
  const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(rect.getWorldQuaternion(new THREE.Quaternion()));
  assert.ok(dir.y < -0.99, dir.toArray().join(","));
  assert.ok(Math.abs(dir.x) < 1e-6 && Math.abs(dir.z) < 1e-6, dir.toArray().join(","));

  const hemisphere = scene.children.find((child) => child instanceof THREE.HemisphereLight);
  const directional = scene.children.find((child) => child instanceof THREE.DirectionalLight);
  assert.equal(hemisphere, undefined);
  assert.equal(directional, undefined);
});
