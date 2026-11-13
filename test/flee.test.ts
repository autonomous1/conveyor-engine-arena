import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const { pickFleePoint, costInPlaces, FLEE_TUNING } = await import("../src/shared/bots/flee.ts");

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = ["door.json", "u.json", "wall.json"].map((name) => path.join(here, "fixtures/regions", name));

type RegionFile = {
  placeId: string;
  regions: Array<{ id: string; minX: number; maxX: number; minZ: number; maxZ: number; y: number }>;
};

type Centre = { placeId: string; x: number; y: number; z: number };

function load(file: string): { placeId: string; centres: Centre[] } {
  const graph = JSON.parse(readFileSync(file, "utf8")) as RegionFile;
  return {
    placeId: graph.placeId,
    centres: graph.regions.map((region) => ({
      placeId: graph.placeId,
      x: (region.minX + region.maxX) / 2,
      y: region.y,
      z: (region.minZ + region.maxZ) / 2,
    })),
  };
}

/** Normalised (c − me)·(me − threat). Undefined when either vector has no length. */
function awayDot(
  me: { x: number; y: number; z: number },
  threat: { x: number; y: number; z: number },
  centre: { x: number; y: number; z: number },
): number | undefined {
  const ax = me.x - threat.x;
  const ay = me.y - threat.y;
  const az = me.z - threat.z;
  const bx = centre.x - me.x;
  const by = centre.y - me.y;
  const bz = centre.z - me.z;
  const al = Math.hypot(ax, ay, az);
  const bl = Math.hypot(bx, by, bz);
  if (!(al > 1e-6) || !(bl > 1e-6)) return undefined;
  return (ax * bx + ay * by + az * bz) / (al * bl);
}

test("flee.ts does not read a clock or import node", () => {
  const text = readFileSync(path.join(here, "../src/shared/bots/flee.ts"), "utf8");
  assert.equal(text.includes("node:"), false);
  assert.equal(text.includes("Date"), false);
  assert.equal(text.includes("Math.random"), false);
  assert.equal(FLEE_TUNING.wMedkit, 0);
  assert.equal(FLEE_TUNING.wAmmo, 0);
  assert.equal(FLEE_TUNING.minRunM, 12);
  assert.equal(FLEE_TUNING.rayCount, 12);
  assert.equal(FLEE_TUNING.wMyPath, 0.3);
  assert.equal(FLEE_TUNING.threatRangeM, 30);
  assert.equal(FLEE_TUNING.beyondCapM, 40);
  assert.equal(FLEE_TUNING.wBeyond, 0.6);
  assert.equal(FLEE_TUNING.threatEyeM, 1.6);
  assert.equal(FLEE_TUNING.chestM, 1);
});

test("costInPlaces uses Euclidean inside a place and the route map outside it", () => {
  const from = { x: 0, y: 0, z: 0 };
  const costs = new Map<string, number>([["hall", 12], ["yard", Number.POSITIVE_INFINITY]]);
  const same = costInPlaces(from, "hall", costs, "hall", { x: 3, y: 0, z: 4 });
  assert.equal(same, 5);
  assert.equal(costInPlaces(from, "hall", costs, "hall", { x: 30, y: 0, z: 40 }), 50);
  assert.equal(costInPlaces(from, "room", costs, "hall", { x: 3, y: 0, z: 4 }), 12);
  assert.equal(costInPlaces(from, "room", costs, "attic", { x: 1, y: 0, z: 1 }), undefined);
  assert.equal(costInPlaces(from, "room", costs, "yard", { x: 1, y: 0, z: 1 }), undefined);
});

test("flee: a fixture centre toward the threat is never chosen", () => {
  for (const file of FIXTURES) {
    const { placeId, centres } = load(file);
    const me = { x: 10, y: 0, z: 10 };
    const threat = { x: 10, y: 0, z: 0 };
    const choice = pickFleePoint({
      me,
      myPlace: placeId,
      threat,
      threatPlace: placeId,
      centres,
      // The point behind me would win on distance. The filter has to drop it.
      costFromMe: (centre) => (awayDot(me, threat, centre)! <= FLEE_TUNING.awayDot ? 1 : 30),
      costFromThreat: (centre) => (awayDot(me, threat, centre)! <= FLEE_TUNING.awayDot ? 60 : 10),
    });
    assert.ok(choice, file);
    const dot = awayDot(me, threat, choice!);
    assert.ok(dot !== undefined && dot > FLEE_TUNING.awayDot, `${file} dot ${dot}`);
    assert.equal(centres.some((centre) => centre.x === choice!.x && centre.z === choice!.z), true);
  }
});

test("flee: an occluded fixture centre beats an equal-distance visible one", () => {
  const { placeId, centres } = load(FIXTURES[0]!);
  const me = { x: 20, y: 0, z: 0 };
  const threat = { x: 20, y: 0, z: -4 };
  const hidden = centres.reduce((best, centre) => (centre.z > best.z ? centre : best));
  let rays = 0;
  const choice = pickFleePoint({
    me,
    myPlace: placeId,
    threat,
    threatPlace: placeId,
    centres,
    costFromMe: () => 15,
    costFromThreat: () => 30,
    occluded(_from, to) {
      rays += 1;
      return to.x === hidden.x && to.z === hidden.z;
    },
  });
  assert.ok(choice);
  assert.equal(choice!.x, hidden.x);
  assert.equal(choice!.z, hidden.z);
  assert.ok(choice!.score > 0);
  assert.equal(rays, centres.length);
  assert.ok(rays <= FLEE_TUNING.rayCount);
});

test("flee: occlusion rays stop at the cheap top 12", () => {
  const { placeId } = load(FIXTURES[0]!);
  const me = { x: 0, y: 0, z: 0 };
  const threat = { x: 0, y: 0, z: -5 };
  const centres: Centre[] = [];
  for (let i = 0; i < 16; i += 1) centres.push({ placeId, x: 0, y: 0, z: 5 + i * 3 });
  let rays = 0;
  const choice = pickFleePoint({
    me,
    myPlace: placeId,
    threat,
    threatPlace: placeId,
    centres,
    costFromMe: () => 15,
    costFromThreat: () => 40,
    occluded() {
      rays += 1;
      return false;
    },
  });
  assert.equal(rays, FLEE_TUNING.rayCount);
  assert.ok(choice);
});

test("flee: an occluded point 15 m away beats a visible point under minRunM", () => {
  const me = { x: 0, y: 0, z: 0 };
  const threat = { x: 0, y: 0, z: -4 };
  const visible = { placeId: "hall", x: 0, y: 0, z: 6 };
  const hidden = { placeId: "hall", x: 0, y: 0, z: 15 };
  const choice = pickFleePoint({
    me,
    myPlace: "hall",
    threat,
    threatPlace: "hall",
    centres: [visible, hidden],
    costFromMe: (centre) => centre.z,
    costFromThreat: (centre) => centre.z + 4,
    occluded(_from, to) {
      return to.z === hidden.z;
    },
  });
  assert.equal(choice?.z, hidden.z);
  const onlyShort = pickFleePoint({
    me,
    myPlace: "hall",
    threat,
    threatPlace: "hall",
    centres: [visible],
    costFromMe: () => 6,
    costFromThreat: () => 30,
    occluded: () => true,
  });
  assert.equal(onlyShort, undefined);
});

test("flee: with no occluded candidate the farthest threat distance wins", () => {
  const me = { x: 0, y: 0, z: 0 };
  const threat = { x: 0, y: 0, z: -5 };
  const near = { placeId: "other", x: 0, y: 0, z: 12 };
  const far = { placeId: "hall", x: 0, y: 0, z: 40 };
  const input = {
    me,
    myPlace: "hall",
    threat,
    threatPlace: "hall",
    centres: [near, far],
    costFromMe: (centre: Centre) => (centre.z === near.z ? 12 : 40),
    costFromThreat: (centre: Centre) => (centre.z === near.z ? 10 : 12),
  };
  const scored = pickFleePoint(input);
  assert.equal(scored?.z, near.z);
  const farthest = pickFleePoint({ ...input, occluded: () => false });
  assert.equal(farthest?.z, far.z);
});

test("flee: no reachable centre returns undefined", () => {
  for (const file of FIXTURES) {
    const { placeId, centres } = load(file);
    const me = { x: 0, y: 0, z: 0 };
    const threat = { x: -5, y: 0, z: 0 };
    const blocked = pickFleePoint({
      me,
      myPlace: placeId,
      threat,
      threatPlace: placeId,
      centres,
      costFromMe: () => FLEE_TUNING.maxPathM + 1,
      costFromThreat: () => 10,
    });
    assert.equal(blocked, undefined, file);
    const unreachable = pickFleePoint({
      me,
      myPlace: placeId,
      threat,
      threatPlace: placeId,
      centres,
      costFromMe: () => undefined,
      costFromThreat: () => 10,
    });
    assert.equal(unreachable, undefined, file);
  }
});

test("flee: a medkit does not change the pick while its weight is 0", () => {
  const me = { x: 0, y: 0, z: 0 };
  const threat = { x: 0, y: 0, z: -5 };
  const near = { placeId: "floor", x: 0, y: 0, z: 14 };
  const far = { placeId: "floor", x: 0, y: 0, z: 20 };
  let medkitLookups = 0;
  const choice = pickFleePoint({
    me,
    myPlace: "floor",
    threat,
    threatPlace: "floor",
    centres: [near, far],
    costFromMe: (centre) => centre.z,
    costFromThreat: () => 30,
    hasMedkit(centre) {
      medkitLookups += 1;
      return centre.z === far.z;
    },
  });
  assert.equal(choice?.z, near.z);
  assert.equal(medkitLookups, 0);
});
