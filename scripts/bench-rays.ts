/**
 * `npm run bench:rays`. 2000 random rays on the installed arena.
 * Prints microseconds per ray for the brute scan and the floor-grid scan.
 */
import { createArenaDoors, createDoorBlockers } from "../src/server/doors.ts";
import { loadArena } from "../src/server/world-loader.ts";
import { traceHitscan, traceIndexed, type Vec3 } from "../src/shared/hitscan.ts";
import { aimDirection, EYE_HEIGHT } from "../src/shared/look.ts";
import { floorIndexFor } from "../src/shared/movements.ts";

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const loaded = loadArena();
const blockers = createDoorBlockers(loaded.world);
createArenaDoors({
  doors: loaded.view.doors,
  pawnOf: () => undefined,
  keys: { hasKey: () => false, consumeKey: () => false },
  sendAll() {},
  ownedPawn: () => undefined,
  sessionId: () => undefined,
  blockers,
});
const boxes = loaded.world.listObstacles();
const regions = (loaded.regions?.places ?? [])
  .flatMap((place) => place.regions)
  .filter((region) => region.maxX > region.minX && region.maxZ > region.minZ);
if (regions.length === 0) throw new Error("arena has no walkable regions");

const rand = rng(48);
const pitch = Math.PI / 6;
const rays: Array<{ origin: Vec3; dir: Vec3 }> = [];
for (let i = 0; i < 2_000; i++) {
  const region = regions[Math.floor(rand() * regions.length)]!;
  rays.push({
    origin: {
      x: region.minX + rand() * (region.maxX - region.minX),
      y: region.y + EYE_HEIGHT,
      z: region.minZ + rand() * (region.maxZ - region.minZ),
    },
    dir: aimDirection(rand() * Math.PI * 2, (rand() * 2 - 1) * pitch),
  });
}

for (let i = 0; i < 200; i++) {
  const ray = rays[i % rays.length]!;
  const brute = traceHitscan(ray.origin, ray.dir, boxes, []);
  const indexed = traceIndexed(ray.origin, ray.dir, boxes, []);
  if (brute.hitId !== indexed.hitId || Math.abs(brute.distance - indexed.distance) > 1e-9) {
    throw new Error(`warmup ray ${i} diverged: brute ${brute.hitId}@${brute.distance} indexed ${indexed.hitId}@${indexed.distance}`);
  }
}

const index = floorIndexFor(boxes);
const covered = new Uint8Array(boxes.length);
for (let i = 0; i < index.items.length; i++) covered[index.items[i]!] = 1;
for (let i = 0; i < index.always.length; i++) covered[index.always[i]!] = 1;
let uncovered = 0;
for (let i = 0; i < covered.length; i++) if (covered[i] === 0) uncovered += 1;
let bruteAcc = 0;
let indexedAcc = 0;
const t0 = performance.now();
for (const ray of rays) bruteAcc += traceHitscan(ray.origin, ray.dir, boxes, []).distance;
const bruteMs = performance.now() - t0;
const t1 = performance.now();
for (const ray of rays) indexedAcc += traceIndexed(ray.origin, ray.dir, boxes, []).distance;
const indexedMs = performance.now() - t1;
if (bruteAcc === Number.POSITIVE_INFINITY || indexedAcc === Number.POSITIVE_INFINITY) {
  throw new Error("non-finite bench accumulator");
}

const n = rays.length;
const bruteUs = (bruteMs * 1000) / n;
const indexedUs = (indexedMs * 1000) / n;
const ratio = bruteUs / indexedUs;
console.log(`[bench:rays] ${boxes.length} boxes, always ${index.always.length}, uncovered ${uncovered}, grid ${index.cols}x${index.rows}`);
console.log(`brute ${bruteUs.toFixed(2)} µs/ray`);
console.log(`indexed ${indexedUs.toFixed(2)} µs/ray`);
console.log(`ratio ${ratio.toFixed(2)}×`);
