import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as THREE from "three";
import { loadArenaVisuals, placeBuildingModel, type ArenaScene } from "../src/client/arena-scene.ts";
import type { ArenaView } from "../src/shared/arena-view.ts";

const lamp = {
  id: "lamp",
  type: "point" as const,
  position: [1, 2, 3] as [number, number, number],
  color: "#ffd9a0",
  intensity: 8,
  range: 4,
};

const panel = {
  id: "panel",
  type: "rect" as const,
  position: [4, 5, 6] as [number, number, number],
  yaw: 90,
  color: "#ffffff",
  intensity: 150,
  width: 0.8,
  height: 0.3,
};

function bareArena(): ArenaScene {
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xc8d8ff, 0x3a3228, 1.3));
  scene.add(new THREE.DirectionalLight(0xfff2d6, 2.3));
  const content = new THREE.Group();
  scene.add(content);
  const camera = new THREE.PerspectiveCamera();
  return {
    renderer: {} as THREE.WebGLRenderer,
    scene,
    camera,
    content,
    resize() {},
  };
}

function view(): ArenaView {
  const prop = (
    id: string,
    model: string,
    min: [number, number, number],
    max: [number, number, number],
  ): ArenaView["props"][number] => ({
    id,
    idNum: 0,
    model,
    minX: min[0], maxX: max[0],
    minY: min[1], maxY: max[1],
    minZ: min[2], maxZ: max[2],
    animation: undefined,
    position: [(min[0] + max[0]) / 2, min[1] + Math.max(0.1, max[1] - min[1]) / 2, (min[2] + max[2]) / 2],
    yaw: 0,
    scale: 1,
  });
  return {
    bundleId: "test",
    bundleVersion: "0",
    authoritativeHash: "a",
    presentationHash: "p",
    collisionContentHash: "c",
    world: "w",
    bounds: { minX: -10, maxX: 10, minY: 0, maxY: 4, minZ: -10, maxZ: 10 },
    floor: { y: 0, texture: "/assets/textures/missing-floor.png" },
    walls: [],
    buildings: [],
    props: [
      prop("room-1", "/assets/models/room-b.glb", [0, 0, 0], [1, 2, 1]),
      prop("crate-1", "/assets/models/crate.glb", [10, 0, 10], [12, 1, 12]),
    ],
    doors: [],
    characters: [],
    staticModels: ["/assets/models/room-b.glb", "/assets/models/crate.glb"],
    aabbs: [],
    pawnRadius: 0.3,
    pawnHeight: 1.7,
    lights: [lamp, panel],
  };
}

function at(parent: THREE.Object3D, x: number, y: number, z: number): THREE.Object3D | undefined {
  return parent.children.find((child) => {
    const p = child.position;
    return Math.abs(p.x - x) < 1e-6 && Math.abs(p.y - y) < 1e-6 && Math.abs(p.z - z) < 1e-6;
  });
}

test("room lamps leave layer 0 and only room roots join layer 1", async () => {
  const arena = bareArena();
  const hemi = arena.scene.children.find((child) => child instanceof THREE.HemisphereLight);
  const key = arena.scene.children.find((child) => child instanceof THREE.DirectionalLight);
  assert.ok(hemi && key);
  await loadArenaVisuals(view(), arena);

  assert.equal(arena.camera.layers.isEnabled(0), true);
  assert.equal(arena.camera.layers.isEnabled(1), true);
  assert.equal(hemi.layers.isEnabled(0), true);
  assert.equal(hemi.layers.isEnabled(1), false);
  assert.equal(key.layers.isEnabled(0), true);
  assert.equal(key.layers.isEnabled(1), false);

  const point = arena.scene.children.find((child) => child instanceof THREE.PointLight);
  assert.ok(point instanceof THREE.PointLight);
  assert.equal(point.castShadow, false);
  assert.equal(point.layers.isEnabled(0), false);
  assert.equal(point.layers.isEnabled(1), true);

  const rectGroup = arena.scene.children.find((child) => child instanceof THREE.Group && child.children[0] instanceof THREE.RectAreaLight);
  const rect = rectGroup?.children[0];
  assert.ok(rect instanceof THREE.RectAreaLight);
  assert.equal(rect.castShadow, false);
  assert.equal(rect.layers.isEnabled(0), false);
  assert.equal(rect.layers.isEnabled(1), true);

  const floor = arena.scene.children.find((child) => (child as THREE.Mesh).isMesh);
  assert.ok(floor);
  assert.equal(floor.layers.isEnabled(0), true);
  assert.equal(floor.layers.isEnabled(1), false);

  const room = at(arena.content, 0.5, 1, 0.5);
  const crate = at(arena.content, 11, 0.5, 11);
  assert.ok(room);
  assert.ok(crate);
  room.traverse((node) => {
    assert.equal(node.layers.isEnabled(0), true, node.type);
    assert.equal(node.layers.isEnabled(1), true, node.type);
  });
  crate.traverse((node) => {
    assert.equal(node.layers.isEnabled(0), true, node.type);
    assert.equal(node.layers.isEnabled(1), false, node.type);
  });

  const source = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
  const outdoor = placeBuildingModel(source, {
    id: "hall",
    model: "/assets/models/brutalist-building-1-cbake.glb",
    position: [8, 0, 0],
    yaw: 0,
    scale: 1,
  });
  assert.equal(outdoor.layers.isEnabled(0), true);
  assert.equal(outdoor.layers.isEnabled(1), false);
  outdoor.traverse((node) => assert.equal(node.layers.isEnabled(1), false));

  const roomRoot = placeBuildingModel(source, {
    id: "room-b-1",
    model: "/assets/models/room-b.glb",
    position: [3, 0, 0],
    yaw: 90,
    scale: 1,
  });
  assert.equal(source.layers.isEnabled(1), false);
  assert.equal(roomRoot.layers.isEnabled(0), true);
  assert.equal(roomRoot.layers.isEnabled(1), true);
  roomRoot.traverse((node) => {
    assert.equal(node.layers.isEnabled(0), true);
    assert.equal(node.layers.isEnabled(1), true);
  });
});

test("the room-lamp pass can split direct light out of the standard shader", () => {
  const glsl = readFileSync(
    new URL("../node_modules/three/src/renderers/shaders/ShaderLib/meshphysical.glsl.js", import.meta.url),
    "utf8",
  );
  assert.match(glsl, /vec3 outgoingLight = totalDiffuse \+ totalSpecular \+ totalEmissiveRadiance;/);
});
