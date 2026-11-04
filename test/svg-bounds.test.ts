import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseTransform, svgMapBounds } from "../src/shared/svg-bounds.ts";

const doc = (inner: string) =>
  `<svg xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" viewBox="0 0 210 297"><g inkscape:label="other"><rect x="0" y="0" width="1" height="1"/></g>${inner}</svg>`;
const close = (a: number, b: number) => Math.abs(a - b) < 1e-6;

test("plain bounds rect flips svg y into world z", () => {
  const b = svgMapBounds(doc(`<g inkscape:label="bounds"><rect x="-10" y="200" width="40" height="20"/></g>`));
  assert.deepEqual(b, { minX: -10, maxX: 30, minZ: 77, maxZ: 97 });
});

test("group and rect transforms compose", () => {
  const b = svgMapBounds(doc(`<g inkscape:label="bounds" transform="translate(5,-3)"><rect transform="rotate(90)" x="0" y="-10" width="20" height="10"/></g>`));
  // rotate(90): (x,y)->(-y,x). Corners x∈[0,20], y∈[-10,0] -> x'∈[0,10], y'∈[0,20]; translate -> x∈[5,15], y∈[-3,17].
  assert.ok(close(b.minX, 5) && close(b.maxX, 15), JSON.stringify(b));
  assert.ok(close(b.minZ, 280) && close(b.maxZ, 300), JSON.stringify(b));
});

test("matrix and scale parse", () => {
  assert.deepEqual(parseTransform("matrix(1 2 3 4 5 6)"), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(parseTransform("scale(2)"), [2, 0, 0, 2, 0, 0]);
});

test("missing layer throws", () => {
  assert.throws(() => svgMapBounds(doc("")), /bounds/);
});

test("arena-1.svg bounds match web/game/bounds.json", () => {
  const b = svgMapBounds(readFileSync("dev/scenes/arena-1/designs/arena-1.svg", "utf8"));
  const json = JSON.parse(readFileSync("web/game/bounds.json", "utf8"));
  for (const k of ["minX", "maxX", "minZ", "maxZ"] as const) assert.ok(close(b[k], json[k]), `${k} ${b[k]} vs ${json[k]}`);
});
