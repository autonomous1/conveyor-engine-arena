import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import test from "node:test";
import * as THREE from "three";
import { attachPlayInput } from "../src/client/input.ts";
import { createHud } from "../src/client/hud.ts";
import type { ArenaView } from "../src/shared/arena-view.ts";
import { createPadReader, STD, type PadActions, type PadFrame } from "../src/shared/gamepad-map.ts";
import type { InfoCandidate, InfoKind, Vec3 } from "../src/shared/info-probe.ts";
import { gamepadBindings } from "../src/shared/look.ts";
import type { SceneGraphFrame } from "../src/shared/bot-protocol.ts";
import type { CabState, SceneGraph } from "../src/shared/scene-graph.ts";

// Shared and client modules import siblings as `.js`. Strip-types loads this
// file from source, so those specifiers resolve to the `.ts` files.
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

const { createInfoProbe, leafAabb } = await import("../src/client/info-probe.ts");
const { connectLive } = await import("../src/client/net.ts");
const { doorLeafBox } = await import("../src/shared/doors.ts");
const {
  INFO_RANGE_M,
  INFO_SHOW_MS,
  collectInfoCandidates,
  createInfoSession,
  formatDoorLine,
  pickInfoTarget,
  placeSampleY,
} = await import("../src/shared/info-probe.ts");
const { parseSceneGraph, placeAt } = await import("../src/shared/scene-graph.ts");

const HASH = "ab".repeat(32);

function vec(x: number, y: number, z: number): Vec3 {
  return { x, y, z };
}

function box(
  kind: InfoKind,
  id: string,
  min: [number, number, number],
  max: [number, number, number],
): InfoCandidate {
  return { kind, id, min: vec(min[0], min[1], min[2]), max: vec(max[0], max[1], max[2]), metadata: {} };
}

function near(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} vs ${expected}`);
}

test("the nearest box wins independent of order, and a wall hides what is behind it", () => {
  const nearBox = box("collision", "wall", [0, 0, 2], [1, 2, 2.2]);
  const far = box("door", "leaf", [0, 0, 6], [1, 2, 6.2]);
  const pawn = box("pawn", "8", [0, 0, 8], [1, 2, 8.4]);
  const origin = vec(0.5, 1, 0);
  const dir = vec(0, 0, 1);
  for (const order of [[nearBox, far, pawn], [pawn, far, nearBox], [far, pawn, nearBox]]) {
    const hit = pickInfoTarget(origin, dir, order);
    assert.equal(hit?.id, "wall");
    near(hit!.distance, 2);
    near(hit!.point.z, 2);
    near(hit!.point.x, 0.5);
    near(hit!.point.y, 1);
  }
});

test("a parallel ray misses outside the slab and hits when the origin is inside the other axes", () => {
  assert.equal(pickInfoTarget(vec(0, 0, 0), vec(1, 0, 0), [box("collision", "side", [0, 0, 5], [1, 2, 6])]), undefined);
  const hit = pickInfoTarget(vec(0, 0, 0), vec(1, 0, 0), [box("collision", "ahead", [2, -1, -1], [4, 1, 1])]);
  assert.equal(hit?.id, "ahead");
  near(hit!.distance, 2);
  near(hit!.point.x, 2);
  near(hit!.point.y, 0);
  near(hit!.point.z, 0);
  const scaled = pickInfoTarget(vec(0, 0, 0), vec(0, 0, 4), [box("prop", "crate", [-1, -1, 4], [1, 1, 5])]);
  near(scaled!.distance, 4);
  near(scaled!.point.z, 4);
});

test("an origin inside a box hits at distance 0, and a box behind the camera misses", () => {
  const inside = pickInfoTarget(vec(0.2, 0.3, 0.4), vec(0, 1, 0), [box("collision", "room", [-1, -1, -1], [1, 1, 1])]);
  assert.equal(inside?.id, "room");
  near(inside!.distance, 0);
  near(inside!.point.x, 0.2);
  near(inside!.point.y, 0.3);
  near(inside!.point.z, 0.4);
  assert.equal(pickInfoTarget(vec(0, 1, 0), vec(0, 0, 1), [box("door", "back", [-1, 0, -5], [1, 2, -4])]), undefined);
  assert.equal(pickInfoTarget(vec(0, 1, 0), vec(0, 0, 0), [box("door", "any", [-1, 0, 1], [1, 2, 2])]), undefined);
});

test("the inspect ray stops at 96 m", () => {
  assert.equal(INFO_RANGE_M, 96);
  const far = box("collision", "far", [-1, 0, 100], [1, 2, 101]);
  const edge = box("collision", "edge", [-1, 0, 96], [1, 2, 97]);
  const just = box("collision", "just", [-1, 0, 96.2], [1, 2, 97]);
  assert.equal(pickInfoTarget(vec(0, 1, 0), vec(0, 0, 1), [far]), undefined);
  assert.equal(pickInfoTarget(vec(0, 1, 0), vec(0, 0, 1), [just]), undefined);
  const hit = pickInfoTarget(vec(0, 1, 0), vec(0, 0, 1), [edge]);
  near(hit!.distance, 96);
});

test("a tied door or pickup beats a duplicate collision box, then the smaller id", () => {
  const door = box("door", "z-door", [0, 0, 2], [1, 2, 2.2]);
  const pickup = box("pickup", "z-med", [0, 0, 2], [1, 2, 2.2]);
  const wall = box("collision", "a-wall", [0, 0, 2], [1, 2, 2.2]);
  const other = box("collision", "m-wall", [0, 0, 2], [1, 2, 2.2]);
  assert.equal(pickInfoTarget(vec(0.5, 1, 0), vec(0, 0, 1), [wall, door])?.kind, "door");
  assert.equal(pickInfoTarget(vec(0.5, 1, 0), vec(0, 0, 1), [door, wall])?.id, "z-door");
  assert.equal(pickInfoTarget(vec(0.5, 1, 0), vec(0, 0, 1), [wall, pickup])?.kind, "pickup");
  assert.equal(pickInfoTarget(vec(0.5, 1, 0), vec(0, 0, 1), [other, wall])?.id, "a-wall");
  assert.equal(pickInfoTarget(vec(0.5, 1, 0), vec(0, 0, 1), [wall, other])?.id, "a-wall");
  const ahead = box("collision", "nearer", [0, 0, 1], [1, 2, 1.2]);
  assert.equal(pickInfoTarget(vec(0.5, 1, 0), vec(0, 0, 1), [door, ahead])?.id, "nearer");
});

test("an open doorway is not the closed leaf, and a moved leaf or cab is what the ray hits", () => {
  const closed = { minX: 0, maxX: 1, minY: 0, maxY: 2, minZ: -0.1, maxZ: 0.1 };
  const swung = { minX: 1, maxX: 1.2, minY: 0, maxY: 2, minZ: 0, maxZ: 1 };
  const raised = { minX: 0, maxX: 1, minY: 4, maxY: 6, minZ: -0.1, maxZ: 0.1 };
  const wall = { id: 4, source: "hall-wall", minX: -1, maxX: 2, minY: 0, maxY: 3, minZ: 3, maxZ: 3.2 };
  const open = collectInfoCandidates({
    doors: [{ id: "hall.door", open: true, closed }],
    pickups: [],
    pawns: [],
    volumes: [wall],
    propIds: [],
    pickupIds: [],
  });
  assert.equal(open.some((row) => row.kind === "door"), false);
  assert.equal(pickInfoTarget(vec(0.5, 1, -2), vec(0, 0, 1), open)?.id, "hall-wall");

  const leaf = collectInfoCandidates({
    doors: [{ id: "hall.door", open: true, leaf: swung, closed }],
    pickups: [],
    pawns: [],
    volumes: [wall],
    propIds: [],
    pickupIds: [],
  });
  assert.equal(pickInfoTarget(vec(0.5, 1, -2), vec(0, 0, 1), leaf)?.id, "hall-wall");
  assert.equal(pickInfoTarget(vec(1.1, 1, -1), vec(0, 0, 1), leaf)?.id, "hall.door");

  const cab = collectInfoCandidates({
    doors: [{ id: "cab.door", open: false, leaf: raised, closed }],
    pickups: [],
    pawns: [],
    volumes: [],
    propIds: [],
    pickupIds: [],
  });
  assert.equal(pickInfoTarget(vec(0.5, 1, -2), vec(0, 0, 1), cab), undefined);
  assert.equal(pickInfoTarget(vec(0.5, 5, -2), vec(0, 0, 1), cab)?.id, "cab.door");
});

test("a gone pickup is absent, and the nearer pawn hides the one behind it", () => {
  const rows = collectInfoCandidates({
    doors: [],
    pickups: [
      { id: "med", kind: "health", available: false, min: vec(-1, 0, 2), max: vec(1, 1, 2.4) },
      { id: "ammo", kind: "ammo", available: true, min: vec(-1, 0, 4), max: vec(1, 1, 4.4) },
    ],
    pawns: [
      { id: "1", min: vec(-0.4, 0, 1), max: vec(0.4, 1.8, 1.8) },
      { id: "2", min: vec(-0.4, 0, 6), max: vec(0.4, 1.8, 6.8), name: "Ada", model: "grok" },
    ],
    volumes: [
      { id: 3, source: "med-box", minX: -1, maxX: 1, minY: 0, maxY: 1, minZ: 2, maxZ: 2.4 },
      { id: 8, source: "crate-box", mesh: true, minX: -1, maxX: 1, minY: 0, maxY: 1, minZ: 8, maxZ: 8.4 },
    ],
    propIds: ["crate"],
    pickupIds: ["med", "ammo"],
  });
  assert.equal(rows.some((row) => row.id === "med" || row.id === "med-box"), false);
  assert.equal(rows.find((row) => row.id === "ammo")?.kind, "pickup");
  assert.equal(rows.find((row) => row.id === "crate")?.kind, "prop");
  const hit = pickInfoTarget(vec(0, 1, 0), vec(0, 0, 1), rows);
  assert.equal(hit?.id, "1");
  const ada = pickInfoTarget(vec(0, 1.2, 5), vec(0, 0, 1), rows);
  assert.equal(ada?.id, "2");
  assert.equal(ada?.metadata.name, "Ada");
  assert.equal(ada?.metadata.model, "grok");
});

test("door lines follow the live open and locked bits and do not invent a key", () => {
  assert.equal(formatDoorLine("hall.door", { open: false, locked: true, key: "key-1" }), "door hall.door · closed · locked · needs key-1");
  assert.equal(formatDoorLine("hall.door", { open: false, locked: false, key: "key-1" }), "door hall.door · closed · unlocked · key key-1");
  assert.equal(formatDoorLine("hall.door", { open: true, locked: false, key: "key-1" }), "door hall.door · open · unlocked · key key-1");
  assert.equal(formatDoorLine("hall.door", { open: true, locked: false }), "door hall.door · open · unlocked");
  const bare = formatDoorLine("hall.door", { open: false, locked: true });
  assert.equal(bare, "door hall.door · closed · locked");
  assert.equal(bare.includes("unknown"), false);
  assert.equal(bare.includes("needs"), false);
});

test("a welcome or door frame replaces the baked lock, and the readout expires", () => {
  const session = createInfoSession({
    doors: [doorDef("hall.door", false, true, "key-1")],
    pickups: [{ id: "med", kind: "health" }],
  });
  const candidates = [box("door", "hall.door", [0, 0, 2], [1, 2, 2.2])];
  const first = session.inspect({ now: 1000, origin: vec(0.5, 1, 0), direction: vec(0, 0, 1), candidates });
  assert.equal(first.split("\n")[0], "door hall.door · closed · locked · needs key-1");
  assert.match(first, /2 m/);
  session.onDoor({ id: "hall.door", open: false, locked: false });
  assert.equal(session.refresh(1000).split("\n")[0], "door hall.door · closed · unlocked · key key-1");
  session.onDoors([{ id: "hall.door", open: true, locked: false }]);
  assert.equal(session.refresh(2000).split("\n")[0], "door hall.door · open · unlocked · key key-1");
  assert.equal(session.refresh(4999).includes("door hall.door"), true);
  assert.equal(session.refresh(5000), "");
  const again = session.inspect({ now: 5000, origin: vec(0.5, 1, 0), direction: vec(0, 0, 1), candidates });
  assert.match(again, /open · unlocked/);
  assert.equal(session.refresh(8999).includes("door"), true);
  assert.equal(session.refresh(9000), "");
  assert.equal(INFO_SHOW_MS, 4000);
});

test("pickups leave the ray when they are gone, including after a fresh welcome", () => {
  const session = createInfoSession({
    doors: [],
    pickups: [
      { id: "med", kind: "health" },
      { id: "ammo", kind: "ammo" },
    ],
  });
  const med = box("pickup", "med", [-1, 0, 2], [1, 1, 2.4]);
  med.metadata = { pickupKind: "health" };
  const ammo = box("pickup", "ammo", [-1, 0, 5], [1, 1, 5.4]);
  ammo.metadata = { pickupKind: "ammo" };
  const first = session.inspect({
    now: 0,
    origin: vec(0, 0.5, 0),
    direction: vec(0, 0, 1),
    candidates: [med, ammo],
  });
  assert.equal(first.split("\n")[0], "pickup med · health · available");
  session.onPickupGone("med");
  assert.match(session.refresh(10), /pickup med · health · gone/);
  const left = session.inspect({
    now: 10,
    origin: vec(0, 0.5, 0),
    direction: vec(0, 0, 1),
    candidates: collectInfoCandidates({
      doors: [],
      pickups: [
        { id: "med", kind: "health", available: session.pickupAvailable("med"), min: med.min, max: med.max },
        { id: "ammo", kind: "ammo", available: session.pickupAvailable("ammo"), min: ammo.min, max: ammo.max },
      ],
      pawns: [],
      volumes: [],
      propIds: [],
      pickupIds: ["med", "ammo"],
    }),
  });
  assert.equal(left.split("\n")[0], "pickup ammo · ammo · available");
  session.onPickupSet(["ammo"]);
  assert.equal(session.pickupAvailable("med"), false);
  assert.equal(session.pickupAvailable("ammo"), true);
});

test("place and you follow placeAt, including a nested room, a tall wall, and outside", () => {
  const file = placeFile();
  const graph = loadGraph(file);
  const session = createInfoSession({ doors: [], pickups: [] });
  session.onSceneGraph(frame(file));
  assert.ok(session.graph);

  const wall = box("collision", "wall", [2.5, 0, 3], [3.5, 8, 3.2]);
  const own = { x: 1, y: 0, z: 1 };
  const shown = session.inspect({
    now: 0,
    origin: vec(3, 5, 0),
    direction: vec(0, 0, 1),
    candidates: [wall],
    own,
  });
  const hit = pickInfoTarget(vec(3, 5, 0), vec(0, 0, 1), [wall])!;
  assert.equal(placeSampleY(hit), 0);
  assert.equal(placeAt(graph, hit.point.x, placeSampleY(hit), hit.point.z).id, "room");
  assert.equal(placeAt(graph, 3, 5, hit.point.z).id, "outside");
  assert.equal(placeAt(graph, own.x, own.y, own.z).id, "hall");
  assert.match(shown, /^collision wall\n/);
  assert.match(shown, /\nplace room\n/);
  assert.match(shown, /\nyou: hall$/);

  const pawn = box("pawn", "8", [2.6, 0.2, 3], [3.4, 2, 3.8]);
  const pawnHit = pickInfoTarget(vec(3, 1.6, 0), vec(0, 0, 1), [pawn])!;
  assert.equal(placeSampleY(pawnHit), 0.2);
  assert.equal(placeAt(graph, pawnHit.point.x, 1.6, pawnHit.point.z).id, "outside");
  const pawnText = session.inspect({
    now: 0,
    origin: vec(3, 1.6, 0),
    direction: vec(0, 0, 1),
    candidates: [pawn],
    own,
  });
  assert.match(pawnText, /\nplace room\n/);

  const missed = session.inspect({
    now: 0,
    origin: vec(40, 1, 40),
    direction: vec(0, 0, 1),
    candidates: [],
    own: { x: 40, y: 0, z: 40 },
  });
  assert.equal(placeAt(graph, 40, 0, 40).id, "outside");
  assert.equal(missed, "place outside\nyou: outside");

  const moved = session.refresh(10, { x: 3, y: 0, z: 3 });
  assert.match(moved, /you: room/);
  assert.match(moved, /place room/);
});

test("a cab stop is the place under the rider, and a moving cab reports the shaft", () => {
  const file = placeFile();
  const graph = loadGraph(file);
  const session = createInfoSession({ doors: [], pickups: [] });
  session.onSceneGraph(frame(file));
  const idle: CabState = { id: "shaft", at: 1, phase: "idle", y: 4 };
  const riding = session.inspect({
    now: 0,
    origin: vec(0, 1, 0),
    direction: vec(0, 0, 1),
    candidates: [],
    own: { x: 11, y: 4, z: 11 },
    cabs: [idle],
  });
  assert.equal(placeAt(graph, 11, 4, 11, [idle]).id, "shaft@1");
  assert.equal(riding, "place shaft@1\nyou: shaft@1");
  const moving: CabState = { id: "shaft", at: 0, phase: "moving", y: 2 };
  const mid = session.refresh(10, { x: 11, y: 2, z: 11 }, [moving]);
  assert.equal(placeAt(graph, 11, 2, 11, [moving]).id, "shaft");
  assert.equal(mid, "place shaft\nyou: shaft");
});

test("without a graph the place lines are omitted, and a later frame brings them back", () => {
  const file = placeFile();
  const session = createInfoSession({
    doors: [doorDef("hall.door", false, true, "key-1")],
    pickups: [{ id: "med", kind: "health" }],
  });
  const door = box("door", "hall.door", [0, 0, 2], [1, 2, 2.2]);
  const prop = box("prop", "crate", [0, 0, 4], [1, 1, 4.4]);
  const bare = session.inspect({
    now: 0,
    origin: vec(0.5, 1, 0),
    direction: vec(0, 0, 1),
    candidates: [door, prop],
    own: { x: 1, y: 0, z: 1 },
  });
  assert.equal(bare.includes("place "), false);
  assert.equal(bare.includes("you:"), false);
  assert.match(bare, /^door hall.door · closed · locked · needs key-1\n/);
  const empty = session.inspect({
    now: 0,
    origin: vec(0, 1, 0),
    direction: vec(0, 0, 1),
    candidates: [],
    own: { x: 1, y: 0, z: 1 },
  });
  assert.equal(empty, "");

  session.onSceneGraph(frame(file));
  const placed = session.refresh(10, { x: 1, y: 0, z: 1 });
  assert.match(placed, /you: hall/);
  session.onSceneGraph(undefined);
  const cleared = session.refresh(20, { x: 1, y: 0, z: 1 });
  assert.equal(cleared.includes("place "), false);
  assert.equal(cleared.includes("you:"), false);
  session.onSceneGraph({
    t: "sceneGraph",
    v: 1,
    hash: HASH,
    graph: { formatVersion: 1, units: "meters", places: [], portals: [] },
  });
  assert.equal(session.graph, undefined);
  assert.equal(session.refresh(30, { x: 1, y: 0, z: 1 }).includes("you:"), false);
  session.onSceneGraph(frame(file));
  assert.match(session.refresh(40, { x: 3, y: 0, z: 3 }), /you: room/);
});

test("the probe HUD uses text and the current leaf, not a stale closed box", () => {
  const lines: string[] = [];
  const door = doorDef("hall.door", false, true, "key-1");
  const probe = createInfoProbe({
    doors: [door],
    pickups: [{
      id: "med",
      kind: "health",
      minX: -0.25,
      maxX: 0.25,
      minY: 0,
      maxY: 0.4,
      minZ: 2,
      maxZ: 2.4,
    }],
    props: [{ id: "crate" }],
    show(text) {
      lines.push(text);
    },
  });
  const shut = doorLeafBox(door);
  probe.inspect({
    now: 0,
    origin: { x: (shut.minX + shut.maxX) / 2, y: (shut.minY + shut.maxY) / 2, z: shut.minZ - 2 },
    direction: { x: 0, y: 0, z: 1 },
    leaves: new Map(),
    volumes: [],
    pawns: [],
    radius: 0.4,
    height: 1.8,
  });
  assert.match(lines.at(-1) ?? "", /^door hall.door · closed · locked · needs key-1/);

  door.position[1] = 5;
  const raised = doorLeafBox(door);
  probe.inspect({
    now: 10,
    origin: { x: 0.5, y: 1, z: -2 },
    direction: { x: 0, y: 0, z: 1 },
    leaves: new Map(),
    volumes: [],
    pawns: [],
    radius: 0.4,
    height: 1.8,
  });
  assert.equal(lines.at(-1), "");
  probe.inspect({
    now: 20,
    origin: { x: (raised.minX + raised.maxX) / 2, y: (raised.minY + raised.maxY) / 2, z: raised.minZ - 2 },
    direction: { x: 0, y: 0, z: 1 },
    leaves: new Map(),
    volumes: [],
    pawns: [],
    radius: 0.4,
    height: 1.8,
  });
  assert.match(lines.at(-1) ?? "", /^door hall.door/);

  probe.onDoor({ id: "hall.door", open: true, locked: false });
  const swung = { minX: 3, maxX: 3.2, minY: 5, maxY: 7, minZ: 0, maxZ: 1 };
  probe.inspect({
    now: 30,
    origin: { x: 0.5, y: 6, z: -2 },
    direction: { x: 0, y: 0, z: 1 },
    leaves: new Map([["hall.door", swung]]),
    volumes: [{ id: 2, source: "hall-wall", minX: -1, maxX: 2, minY: 5, maxY: 8, minZ: 4, maxZ: 4.2 }],
    pawns: [
      { id: 1, position: { x: 0.5, y: 5, z: 1 }, render: { assetKey: "self" } },
      { id: 2, position: { x: 0.5, y: 5, z: 6 }, render: { assetKey: "grok" } },
    ],
    ownedId: 1,
    radius: 0.4,
    height: 1.8,
  });
  assert.match(lines.at(-1) ?? "", /^collision hall-wall/);
  probe.inspect({
    now: 40,
    origin: { x: 3.1, y: 6, z: -1 },
    direction: { x: 0, y: 0, z: 1 },
    leaves: new Map([["hall.door", swung]]),
    volumes: [],
    pawns: [],
    radius: 0.4,
    height: 1.8,
  });
  assert.match(lines.at(-1) ?? "", /^door hall.door · open · unlocked · key key-1/);

  probe.inspect({
    now: 50,
    origin: { x: 0.5, y: 5.5, z: 2 },
    direction: { x: 0, y: 0, z: 1 },
    leaves: new Map(),
    volumes: [],
    pawns: [
      { id: 1, position: { x: 0.5, y: 5, z: 3 }, render: { assetKey: "self" } },
      { id: 4, position: { x: 0.5, y: 5, z: 6 }, render: { assetKey: "grok" }, name: "Ada" } as {
        id: number;
        position: { x: number; y: number; z: number };
        render?: { assetKey?: string };
        name?: string;
      },
    ],
    ownedId: 1,
    radius: 0.4,
    height: 1.8,
  });
  assert.match(lines.at(-1) ?? "", /^pawn 4 · Ada · grok/);

  probe.onPickupSet(["med"]);
  probe.inspect({
    now: 60,
    origin: { x: 0, y: 4.2, z: 0 },
    direction: { x: 0, y: 0, z: 1 },
    leaves: new Map(),
    volumes: [{ id: 7, source: "med-box", minX: -0.25, maxX: 0.25, minY: 4, maxY: 4.4, minZ: 2, maxZ: 2.4, mesh: true }],
    pawns: [],
    radius: 0.4,
    height: 1.8,
  });
  assert.match(lines.at(-1) ?? "", /^pickup med · health · available/);
  probe.inspect({
    now: 70,
    origin: { x: 0, y: 0.2, z: 0 },
    direction: { x: 0, y: 0, z: 1 },
    leaves: new Map(),
    volumes: [{ id: 7, source: "med-box", minX: -0.25, maxX: 0.25, minY: 4, maxY: 4.4, minZ: 2, maxZ: 2.4, mesh: true }],
    pawns: [],
    radius: 0.4,
    height: 1.8,
  });
  assert.equal(lines.at(-1), "");
  probe.onPickupGone("med");
  probe.inspect({
    now: 80,
    origin: { x: 0, y: 4.2, z: 0 },
    direction: { x: 0, y: 0, z: 1 },
    leaves: new Map(),
    volumes: [
      { id: 7, source: "med-box", minX: -0.25, maxX: 0.25, minY: 4, maxY: 4.4, minZ: 2, maxZ: 2.4, mesh: true },
      { id: 9, source: "crate-box", mesh: true, minX: -1, maxX: 1, minY: 4, maxY: 5, minZ: 6, maxZ: 6.4 },
    ],
    pawns: [],
    radius: 0.4,
    height: 1.8,
  });
  assert.match(lines.at(-1) ?? "", /^prop crate/);
  probe.refresh(80 + INFO_SHOW_MS);
  assert.equal(lines.at(-1), "");
});

test("a swung and lifted leaf reports its current world box", () => {
  const group = new THREE.Group();
  const hinge = new THREE.Group();
  hinge.name = "hinge";
  const leaf = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 0.1));
  leaf.name = "door";
  leaf.geometry.translate(0.5, 1, 0);
  hinge.add(leaf);
  group.add(hinge);
  const shut = leafAabb(group);
  assert.ok(shut);
  near(shut.minY, 0);
  hinge.rotation.y = Math.PI / 2;
  group.position.y = 3;
  const moved = leafAabb(group);
  assert.ok(moved);
  near(moved.minY, 3);
  assert.ok(Math.abs(moved.minZ - shut.minZ) > 0.2);
});

test("Y is free of the previous bindings and only emits info", () => {
  const legacy = [STD.A, STD.B, STD.X, STD.LB, STD.RB, STD.LT, STD.RT, STD.BACK, STD.START, STD.UP, STD.DOWN, STD.LEFT, STD.RIGHT];
  assert.equal(legacy.includes(STD.Y), false);
  assert.equal(STD.Y, 3);
  const bound = gamepadBindings("standard");
  assert.equal(bound.info, STD.Y);
  assert.equal(gamepadBindings("jumper-t").info, undefined);
  for (const [name, index] of Object.entries(bound)) {
    if (name === "info") continue;
    assert.equal(legacy.includes(index!), true, name);
  }

  const quiet = (actions: PadActions, except: Partial<PadActions> = {}) => {
    const expected: PadActions = {
      fire: { held: false, pressed: false },
      grenade: { held: false, pressed: false },
      use: { held: false, pressed: false },
      callLanding: { held: false, pressed: false },
      info: { held: false, pressed: false },
      ascend: 0,
      menuToggle: { held: false, pressed: false },
      mapToggle: { held: false, pressed: false },
      back: { held: false, pressed: false },
      select: { held: false, pressed: false },
      nav: 0,
      navX: 0,
      ...except,
    };
    assert.deepEqual(actions, expected);
  };

  quiet(createPadReader().step(pad({ [STD.A]: 1 }), 16, "standard"), { use: { held: true, pressed: true } });
  quiet(createPadReader().step(pad({ [STD.B]: 1 }), 16, "standard"));
  quiet(createPadReader().step(pad({ [STD.X]: 1 }), 16, "standard"), { callLanding: { held: true, pressed: true } });
  quiet(createPadReader().step(pad({ [STD.LB]: 1 }), 16, "standard"), { ascend: -1 });
  quiet(createPadReader().step(pad({ [STD.RB]: 1 }), 16, "standard"), { ascend: 1 });
  quiet(createPadReader().step(pad({ [STD.LT]: 1 }), 16, "standard"), { grenade: { held: true, pressed: true } });
  quiet(createPadReader().step(pad({ [STD.RT]: 1 }), 16, "standard"), { fire: { held: true, pressed: true } });
  quiet(createPadReader().step(pad({ [STD.BACK]: 1 }), 16, "standard"), { mapToggle: { held: true, pressed: true } });
  quiet(createPadReader().step(pad({ [STD.START]: 1 }), 16, "standard"), { menuToggle: { held: true, pressed: true } });
  quiet(createPadReader().step(pad({ [STD.UP]: 1 }), 16, "standard"), { nav: -1 });
  quiet(createPadReader().step(pad({ [STD.DOWN]: 1 }), 16, "standard"), { nav: 1 });
  quiet(createPadReader().step(pad({ [STD.LEFT]: 1 }), 16, "standard", true), {
    navX: -1,
    back: { held: false, pressed: false },
  });
  const menuLeft = createPadReader().step(pad({ [STD.LEFT]: 1 }), 16, "standard", true);
  assert.equal(menuLeft.navX, -1);
  assert.equal(menuLeft.info.pressed, false);
  assert.equal(menuLeft.use.pressed, false);
  const menuRight = createPadReader().step(pad({ [STD.RIGHT]: 1 }), 16, "standard", true);
  assert.equal(menuRight.navX, 1);
  assert.equal(menuRight.info.pressed, false);

  const y = createPadReader();
  const pressed = y.step(pad({ [STD.Y]: 1 }), 16, "standard");
  quiet(pressed, { info: { held: true, pressed: true } });
  const held = y.step(pad({ [STD.Y]: 1 }), 16, "standard");
  assert.equal(held.info.pressed, false);
  assert.equal(held.info.held, true);
  assert.equal(held.fire.pressed, false);
  assert.equal(held.mapToggle.pressed, false);
  assert.equal(held.callLanding.pressed, false);
  assert.equal(held.use.pressed, false);
  assert.equal(held.nav, 0);
  y.step(pad({}), 16, "standard");
  const again = y.step(pad({ [STD.Y]: 1 }), 16, "standard");
  assert.equal(again.info.pressed, true);
  assert.equal(again.mapToggle.pressed, false);

  const menu = createPadReader();
  const hidden = menu.step(pad({ [STD.Y]: 1, [STD.RT]: 1, [STD.A]: 1, [STD.X]: 1 }), 16, "standard", true);
  assert.equal(hidden.info.pressed, false);
  assert.equal(hidden.fire.pressed, false);
  assert.equal(hidden.use.pressed, false);
  assert.equal(hidden.callLanding.pressed, false);
  quiet(createPadReader().step(pad({ [STD.Y]: 1, [STD.RT]: 1 }), 16, "jumper-t"));
  quiet(createPadReader().step(pad({ [STD.Y]: 1 }, false), 16, "standard"));
});

test("I and Y inspect once, and the other controls stay on their own actions", () => {
  const rig = installPad();
  try {
    const menuEvents: string[] = [];
    let menuFlag = false;
    const input = attachPlayInput(rig.dom, rig.storage, () => {}, () => false, () => menuFlag);
    input.onPadMenu((ev) => {
      menuEvents.push(ev);
      if (ev === "toggle") input.setMenuOpen(!input["locked"]);
    });
    const gamepad = rig.pad;
    gamepad.buttons[STD.Y]!.pressed = true;
    gamepad.buttons[STD.Y]!.value = 1;
    input.update(1 / 60);
    assert.equal(input.sample().info, true);
    assert.equal(input.sample().firing, false);
    assert.equal(input.sample().callLanding, false);
    assert.equal(input.sample().using, false);
    assert.equal(input.sample().cabNav, 0);
    input.update(1 / 60);
    assert.equal(input.sample().info, false);
    gamepad.buttons[STD.Y]!.pressed = false;
    gamepad.buttons[STD.Y]!.value = 0;
    input.update(1 / 60);
    input.sample();
    gamepad.buttons[STD.Y]!.pressed = true;
    gamepad.buttons[STD.Y]!.value = 1;
    input.update(1 / 60);
    assert.equal(input.sample().info, true);

    gamepad.buttons[STD.Y]!.pressed = false;
    gamepad.buttons[STD.Y]!.value = 0;
    input.update(1 / 60);
    input.sample();
    input.setMenuOpen(true);
    gamepad.buttons[STD.Y]!.pressed = true;
    gamepad.buttons[STD.Y]!.value = 1;
    input.update(1 / 60);
    assert.equal(input.sample().info, false);
    input.setMenuOpen(false);
    gamepad.buttons[STD.Y]!.pressed = false;
    gamepad.buttons[STD.Y]!.value = 0;
    input.update(1 / 60);
    input.sample();

    gamepad.buttons[STD.BACK]!.pressed = true;
    gamepad.buttons[STD.BACK]!.value = 1;
    input.update(1 / 60);
    const mapped = input.sample();
    assert.equal(mapped.info, false);
    assert.deepEqual(menuEvents, ["map"]);
    gamepad.buttons[STD.BACK]!.pressed = false;
    gamepad.buttons[STD.BACK]!.value = 0;

    gamepad.buttons[STD.UP]!.pressed = true;
    gamepad.buttons[STD.UP]!.value = 1;
    input.update(1 / 60);
    assert.equal(input.sample().cabNav, 1);
    gamepad.buttons[STD.UP]!.pressed = false;
    gamepad.buttons[STD.UP]!.value = 0;
    input.update(1 / 60);
    input.sample();

    gamepad.buttons[STD.X]!.pressed = true;
    gamepad.buttons[STD.X]!.value = 1;
    input.update(1 / 60);
    const called = input.sample();
    assert.equal(called.callLanding, true);
    assert.equal(called.info, false);
    assert.equal(called.firing, false);
    gamepad.buttons[STD.X]!.pressed = false;
    gamepad.buttons[STD.X]!.value = 0;

    rig.click();
    rig.key("keydown", "KeyI");
    assert.equal(input.sample().info, true);
    assert.equal(input.sample().firing, false);
    assert.equal(input.sample().using, false);
    rig.key("keydown", "KeyI", true);
    assert.equal(input.sample().info, false);
    rig.key("keyup", "KeyI");
    rig.key("keydown", "KeyI");
    assert.equal(input.sample().info, true);

    menuFlag = true;
    rig.key("keydown", "KeyI");
    assert.equal(input.sample().info, false);
    menuFlag = false;
    rig.key("keydown", "KeyI", false, { tagName: "INPUT" });
    assert.equal(input.sample().info, false);
    rig.active = { tagName: "TEXTAREA" };
    rig.key("keydown", "KeyI");
    assert.equal(input.sample().info, false);
    rig.active = null;

    rig.key("keydown", "KeyF");
    const fired = input.sample();
    assert.equal(fired.firing, true);
    assert.equal(fired.info, false);
    rig.key("keyup", "KeyF");
    rig.key("keydown", "KeyE");
    const used = input.sample();
    assert.equal(used.using, true);
    assert.equal(used.info, false);
    rig.key("keydown", "KeyP");
    assert.equal(input.sample().grenade, true);
    rig.key("keyup", "KeyP");
    rig.key("keydown", "Digit1");
    assert.equal(input.sample().digit, "Digit1");
    rig.key("keydown", "Space");
    assert.equal(input.sample().ascend, 1);
    rig.key("keyup", "Space");

    rig.key("keydown", "KeyI");
    rig.blur();
    assert.equal(input.sample().info, false);

    gamepad.buttons[STD.Y]!.pressed = true;
    gamepad.buttons[STD.Y]!.value = 1;
    input.update(1 / 60);
    gamepad.connected = false;
    input.update(1 / 60);
    assert.equal(input.sample().info, false);
    assert.equal(input.padStatus, null);

    gamepad.connected = true;
    input.update(1 / 60);
    rig.key("keydown", "F10");
    assert.equal(input.profile, "jumper-t");
    gamepad.buttons[STD.Y]!.pressed = true;
    gamepad.buttons[STD.Y]!.value = 1;
    input.update(1 / 60);
    assert.equal(input.sample().info, false);
    rig.key("keydown", "KeyI");
    assert.equal(input.sample().info, true);
    assert.equal(input.sample().firing, false);
  } finally {
    rig.restore();
  }
});

test("the info line is text and does not replace the status line", () => {
  const rig = installElements();
  try {
    const hud = createHud();
    hud.setStatus("snap 3");
    hud.setInfo("door <hall> · closed");
    const info = rig.byId("info-probe");
    assert.equal(info.textContent, "door <hall> · closed");
    assert.equal(info.children.length, 0);
    assert.equal(rig.byId("status-text").textContent, "snap 3");
    assert.equal(rig.byId("stats").textContent.includes("door"), false);
    hud.setInfo("");
    assert.equal(info.textContent, "");
    assert.equal(info.style.display, "none");
    assert.equal(rig.byId("control-help"), undefined);
  } finally {
    rig.restore();
  }
});

test("options names I and Y", () => {
  const text = readFileSync("src/client/options.ts", "utf8");
  assert.match(text, /I or Y inspects the crosshair/);
  const input = readFileSync("src/client/input.ts", "utf8");
  assert.match(input, /I, or Y/);
});

test("welcome and close clear the scene graph, and a later frame is delivered", () => {
  const previous = globalThis.document;
  const listeners = new Map<string, Set<(ev: unknown) => void>>();
  (globalThis as { document: unknown }).document = {
    addEventListener(type: string, fn: (ev: unknown) => void) {
      const set = listeners.get(type) ?? new Set();
      set.add(fn);
      listeners.set(type, set);
    },
    removeEventListener() {},
    visibilityState: "visible",
  };
  const seen: Array<SceneGraphFrame | undefined> = [];
  const ws = {
    readyState: 1,
    OPEN: 1,
    CLOSED: 3,
    send() {},
    close() {},
    onopen: null as ((ev: unknown) => void) | null,
    onmessage: null as ((ev: { data: unknown }) => void) | null,
    onclose: null as ((ev: unknown) => void) | null,
    onerror: null as ((ev: unknown) => void) | null,
  };
  try {
    connectLive({
      bundleId: "arena",
      authoritativeHash: "hash",
      world: "arena",
      client: {
        connect() {},
        applySnapshot() {},
        renderSnapshot() {
          return { entities: [] };
        },
        clientId: 1,
        metrics: { snapshotReceive: 0 },
      } as never,
      onStatus() {},
      onApplied() {},
      onSceneGraph(frame) {
        seen.push(frame);
      },
      open: () => ws,
    });
    const graph = frame(placeFile());
    ws.onmessage?.({ data: JSON.stringify(graph) });
    ws.onmessage?.({ data: JSON.stringify({ type: "welcome", clientId: 1 }) });
    ws.onmessage?.({ data: JSON.stringify({ t: "sceneGraph", v: 1, hash: "nope", graph: graph.graph }) });
    ws.onmessage?.({ data: JSON.stringify(graph) });
    ws.onclose?.({});
    assert.equal(seen[0]?.t, "sceneGraph");
    assert.equal(seen[0]?.hash, HASH);
    assert.equal(seen[1], undefined);
    assert.equal(seen[2], undefined);
    assert.equal(seen[3]?.hash, HASH);
    assert.equal(seen[4], undefined);
  } finally {
    (globalThis as { document: unknown }).document = previous;
  }
});

test("info modules do not import node, the server, or a scene-graph file", () => {
  for (const file of ["src/client/info-probe.ts", "src/shared/info-probe.ts"]) {
    const text = readFileSync(file, "utf8");
    assert.equal(text.includes("node:"), false, file);
    assert.equal(text.includes("src/server"), false, file);
    assert.equal(/from ["']ws["']/.test(text), false, file);
    assert.equal(text.includes("scene-graph.json"), false, file);
    assert.equal(text.includes("fetch("), false, file);
  }
  const boot = readFileSync("src/client/boot.ts", "utf8");
  assert.equal(/sendInput\([^)]*info/.test(boot), false);
  assert.equal(boot.includes("sample.info"), true);
  const clientBuild = readFileSync("scripts/build-client.mjs", "utf8");
  assert.equal(clientBuild.includes("scene-graph.json"), false);
});

function doorDef(id: string, open: boolean, locked: boolean, key?: string): ArenaView["doors"][number] {
  return {
    id,
    model: "door.glb",
    position: [0, 0, 0],
    yaw: 0,
    hinge: "left",
    size: [1, 2, 0.08],
    open,
    locked,
    ...(key ? { key } : {}),
  };
}

function place(id: string, kind: string, y: number, minX: number, minZ: number, maxX: number, maxZ: number) {
  return {
    id,
    kind,
    y,
    polygon: [[minX, minZ], [maxX, minZ], [maxX, maxZ], [minX, maxZ]],
    bounds: { minX, maxX, minZ, maxZ },
  };
}

function placeFile() {
  return {
    formatVersion: 1 as const,
    units: "meters" as const,
    places: [
      place("outside", "outside", 0, -100, -100, 100, 100),
      place("hall", "hall", 0, 0, 0, 20, 20),
      place("room", "room", 0, 2, 2, 6, 6),
      place("cab-room", "room", 0, 10, 10, 12, 12),
      {
        ...place("shaft", "elevator", 0, 10, 10, 12, 12),
        stops: [0, 4],
        waitS: 1,
        speed: 1,
        landings: [[9, 0, 11], [9, 4, 11]],
        joins: ["hall", "hall"],
        room: "cab-room",
      },
      place("shaft@0", "landing", 0, 10, 10, 12, 12),
      place("shaft@1", "landing", 4, 10, 10, 12, 12),
    ],
    portals: [],
  };
}

function loadGraph(file: ReturnType<typeof placeFile>): SceneGraph {
  const parsed = parseSceneGraph(file, []);
  assert.deepEqual(parsed.issues, []);
  assert.ok(parsed.graph);
  return parsed.graph;
}

function frame(file: ReturnType<typeof placeFile>): SceneGraphFrame {
  return { t: "sceneGraph", v: 1, hash: HASH, graph: file };
}

function pad(buttons: Record<number, number>, connected = true): PadFrame {
  return {
    connected,
    mapping: "standard",
    buttons: Array.from({ length: 17 }, (_, index) => {
      const value = buttons[index] ?? 0;
      return { pressed: value >= 0.5, value };
    }),
    axes: [0, 0, 0, 0],
  };
}

type Listener = (ev: Record<string, unknown>) => void;

function installPad() {
  const listeners = new Map<string, Set<Listener>>();
  const windowTarget = {
    addEventListener(type: string, fn: Listener) {
      const set = listeners.get(`w:${type}`) ?? new Set();
      set.add(fn);
      listeners.set(`w:${type}`, set);
    },
    removeEventListener() {},
    dispatch(type: string, ev: Record<string, unknown>) {
      const event = {
        preventDefault() {},
        stopPropagation() {},
        repeat: false,
        ...ev,
      };
      for (const fn of listeners.get(`w:${type}`) ?? []) fn(event);
    },
  };
  const documentListeners = new Map<string, Set<Listener>>();
  let pointerLockElement: object | null = null;
  let active: object | null = null;
  const body = { style: { cursor: "default" } };
  const dom = {
    addEventListener() {},
    removeEventListener() {},
    requestPointerLock() {
      pointerLockElement = dom;
      for (const fn of documentListeners.get("pointerlockchange") ?? []) fn({});
      return Promise.resolve();
    },
  };
  const document = {
    addEventListener(type: string, fn: Listener) {
      const set = documentListeners.get(type) ?? new Set();
      set.add(fn);
      documentListeners.set(type, set);
    },
    removeEventListener() {},
    hasFocus() {
      return true;
    },
    get pointerLockElement() {
      return pointerLockElement;
    },
    get activeElement() {
      return active;
    },
    body,
  };
  const gamepad = {
    index: 0,
    connected: true,
    mapping: "standard",
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
    id: "test-pad",
    timestamp: 0,
  };
  const previous = { window: globalThis.window, document: globalThis.document, navigator: globalThis.navigator };
  const root = globalThis as { window: unknown; document: unknown };
  root.window = windowTarget;
  root.document = document;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    writable: true,
    value: { getGamepads: () => [gamepad] },
  });
  return {
    dom: dom as unknown as HTMLElement,
    storage: memoryStorage(),
    pad: gamepad,
    set active(next: object | null) {
      active = next;
    },
    click() {
      dom.requestPointerLock();
    },
    key(type: "keydown" | "keyup", code: string, repeat = false, target?: object) {
      windowTarget.dispatch(type, { code, repeat, target: target ?? null });
    },
    blur() {
      windowTarget.dispatch("blur", {});
    },
    restore() {
      root.window = previous.window;
      root.document = previous.document;
      Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        writable: true,
        value: previous.navigator,
      });
    },
  };
}

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  };
}

function installElements() {
  type El = {
    id: string;
    textContent: string;
    style: { cssText: string; display: string };
    children: El[];
    hidden: boolean;
    append(...nodes: El[]): void;
    addEventListener(): void;
    setAttribute(): void;
    type: string;
    title: string;
  };
  const nodes: El[] = [];
  const make = (): El => {
    const el: El = {
      id: "",
      textContent: "",
      style: { cssText: "", display: "" },
      children: [],
      hidden: false,
      append(...extra) {
        el.children.push(...extra);
      },
      addEventListener() {},
      setAttribute() {},
      type: "",
      title: "",
    };
    nodes.push(el);
    return el;
  };
  const body = make();
  const previous = { window: globalThis.window, document: globalThis.document };
  const root = globalThis as { window: unknown; document: unknown };
  root.window = { addEventListener() {} };
  root.document = {
    createElement: () => make(),
    body,
    addEventListener() {},
    getElementById: () => null,
  };
  return {
    byId(id: string) {
      return nodes.find((node) => node.id === id);
    },
    restore() {
      root.window = previous.window;
      root.document = previous.document;
    },
  };
}
