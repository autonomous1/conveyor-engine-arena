import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as THREE from "three";
import {
  attachBuildingProfiles,
  parseBuildingProfiles,
  profileFileText,
  profilesFromPlanSvg,
  svgPathRings,
  svgRingsToModel,
  yawOfSvgMatrix,
} from "../src/shared/building-profile.ts";

const PLAN = new URL("../dev/scenes/arena-1/designs/arena-1.svg", import.meta.url);
const PROFILES = new URL("../web/game/building-profiles.json", import.meta.url);
const PLACEMENTS = new URL("../web/game/buildings.placements.json", import.meta.url);

test("a path point uses model +X as SVG +x and model +Z as SVG −y", () => {
  const rings = svgRingsToModel(svgPathRings("M 2 3 L 4 3 L 2 5 Z"));
  assert.deepEqual(rings, [[[2, -3], [4, -3], [2, -5]]]);
});

test("svg matrix yaw matches a Three.js rotation.y quarter turn", () => {
  assert.equal(yawOfSvgMatrix([1, 0, 0, 1, 0, 0]), 0);
  assert.equal(yawOfSvgMatrix([0, 1, -1, 0, 0, 0]), 90);
  assert.equal(yawOfSvgMatrix([-1, 0, 0, -1, 0, 0]), 180);
  assert.equal(yawOfSvgMatrix([0, -1, 1, 0, 0, 0]), 270);
  const pivot = new THREE.Object3D();
  pivot.rotation.y = 90 * Math.PI / 180;
  pivot.updateMatrix();
  const plusX = new THREE.Vector3(1, 0, 0).applyMatrix4(pivot.matrix);
  assert.ok(plusX.z < -0.9 && Math.abs(plusX.x) < 1e-6, `${plusX.x}, ${plusX.z}`);
});

test("the plan profiles are the committed outlines, and each one is more than a rectangle", () => {
  const svg = readFileSync(PLAN, "utf8");
  const parsed = profilesFromPlanSvg(svg);
  assert.equal(profileFileText(parsed), readFileSync(PROFILES, "utf8"));
  const placements = JSON.parse(readFileSync(PLACEMENTS, "utf8")) as {
    placements: Array<{ id: string; yaw: number; model: string }>;
  };
  const buildings = placements.placements.filter((item) => item.model.startsWith("brutalist-building-"));
  assert.ok(buildings.length >= 1);
  for (const building of buildings) {
    const profile = parsed.find((item) => item.id === building.id);
    assert.ok(profile, building.id);
    assert.equal(profile.yaw, building.yaw, building.id);
    const ring = profile.rings[0]!;
    assert.ok(ring.length > 4, `${building.id} has ${ring.length} points`);
    assert.ok(ringArea(ring) < boxArea(ring) * 0.9, `${building.id} outline is a rectangle`);
  }
});

function ringArea(ring: ReadonlyArray<readonly [number, number]>): number {
  let area = 0;
  for (let index = 0; index < ring.length; index += 1) {
    const [x1, z1] = ring[index]!;
    const [x2, z2] = ring[(index + 1) % ring.length]!;
    area += x1 * z2 - x2 * z1;
  }
  return Math.abs(area) / 2;
}

function boxArea(ring: ReadonlyArray<readonly [number, number]>): number {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const [x, z] of ring) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  return (maxX - minX) * (maxZ - minZ);
}

test("a plan point turned by the parsed yaw lands on the SVG matrix", () => {
  const svg = readFileSync(PLAN, "utf8");
  const viewBox = /viewBox="([^"]+)"/.exec(svg);
  assert.ok(viewBox);
  const parts = viewBox[1]!.trim().split(/[\s,]+/).map(Number);
  assert.equal(parts.length, 4);
  // Toolbar y is (viewBox min y + height) − SVG y. The page shift is not added again.
  const pageTop = parts[1]! + parts[3]!;
  const hall = profilesFromPlanSvg(svg)[0];
  assert.ok(hall);
  const id = hall.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tag = new RegExp(`<g\\b[^>]*\\bid="${id}"[^>]*>`, "i").exec(svg);
  assert.ok(tag, hall.id);
  const transform = /transform="matrix\(([^)]*)\)"/i.exec(tag[0]);
  assert.ok(transform, hall.id);
  const matrix = transform[1]!.trim().split(/[\s,]+/).map(Number);
  assert.equal(matrix.length, 6);
  const [mx, mz] = hall.rings[0]![0]!;
  const sx = mx;
  const sy = -mz;
  const pageX = matrix[0]! * sx + matrix[2]! * sy + matrix[4]!;
  const pageY = matrix[1]! * sx + matrix[3]! * sy + matrix[5]!;
  const pivot = new THREE.Object3D();
  pivot.position.set(matrix[4]!, 0, pageTop - matrix[5]!);
  pivot.rotation.y = hall.yaw * Math.PI / 180;
  pivot.scale.setScalar(Math.hypot(matrix[0]!, matrix[1]!));
  pivot.updateMatrix();
  const world = new THREE.Vector3(mx, 0, mz).applyMatrix4(pivot.matrix);
  assert.ok(Math.abs(world.x - pageX) < 1e-4, `x ${world.x} vs ${pageX}`);
  assert.ok(Math.abs(world.z - (pageTop - pageY)) < 1e-4, `z ${world.z} vs ${pageTop - pageY}`);
});

test("profiles attach by placement id and a bad file is rejected", () => {
  const buildings = [
    { id: "hall", model: "m", position: [0, 0, 0] as [number, number, number], yaw: 0, scale: 1 },
    { id: "other", model: "m", position: [1, 0, 0] as [number, number, number], yaw: 90, scale: 1 },
  ];
  const text = JSON.stringify({
    formatVersion: 1,
    units: "model",
    profiles: { hall: { yaw: 270, rings: [[[0, 0], [1, 0], [0, 1]]] } },
  });
  attachBuildingProfiles(buildings, text);
  assert.deepEqual(buildings[0]?.profile, [[[0, 0], [1, 0], [0, 1]]]);
  assert.equal(buildings[0]?.authorYaw, 270);
  assert.equal(buildings[1]?.profile, undefined);
  assert.throws(() => parseBuildingProfiles("{"), /not json/);
  assert.equal(parseBuildingProfiles(text).get("hall")?.yaw, 270);
});
