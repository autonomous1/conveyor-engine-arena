import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { createElevatorRooms } from "../src/client/elevator-room.ts";
import { createPlacementVisibility } from "../src/client/placements.ts";
import type { ArenaElevator, ArenaView } from "../src/shared/arena-view.ts";
import type { ElevatorState } from "../src/shared/elevators.ts";

function near(actual: number, expected: number, label: string): void {
  assert.ok(Math.abs(actual - expected) < 1e-4, `${label}: ${actual} != ${expected}`);
}

function matrixClose(actual: THREE.Matrix4, expected: THREE.Matrix4, label: string): void {
  for (let i = 0; i < 16; i += 1) near(actual.elements[i]!, expected.elements[i]!, `${label}[${i}]`);
}

function slotMesh(matrix: THREE.Matrix4): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial(), 1);
  mesh.setMatrixAt(0, matrix);
  mesh.computeBoundingSphere();
  return mesh;
}

test("setOffsetY composes a world translation and showing the slot keeps it", () => {
  const base = new THREE.Matrix4().makeRotationX(Math.PI / 2);
  base.setPosition(1, 2, 3);
  const mesh = slotMesh(base);
  const placements = createPlacementVisibility();
  placements.addInstance("room", mesh, 0);
  placements.setOffsetY("room", 5);

  const lifted = new THREE.Matrix4().makeTranslation(0, 5, 0).multiply(base);
  const got = new THREE.Matrix4();
  mesh.getMatrixAt(0, got);
  matrixClose(got, lifted, "offset");
  const pos = new THREE.Vector3().setFromMatrixPosition(got);
  near(pos.x, 1, "world x");
  near(pos.y, 7, "world y");
  near(pos.z, 3, "world z");

  placements.setVisible("room", false);
  mesh.getMatrixAt(0, got);
  assert.equal(placements.hidden("room"), true);
  placements.setVisible("room", true);
  mesh.getMatrixAt(0, got);
  matrixClose(got, lifted, "shown again");
  assert.equal(placements.hidden("room"), false);
});

test("flushBounds grows the bounding sphere to the moved slot", () => {
  const mesh = slotMesh(new THREE.Matrix4());
  const before = mesh.boundingSphere!.center.y;
  const placements = createPlacementVisibility();
  placements.addInstance("room", mesh, 0);
  placements.setOffsetY("room", 12);
  near(mesh.boundingSphere!.center.y, before, "stale until flush");
  placements.flushBounds();
  near(mesh.boundingSphere!.center.y, 12, "flushed center");
  assert.ok(mesh.boundingSphere!.radius > 0.5);
});

test("a clone offset is relative to the home y", () => {
  const group = new THREE.Group();
  group.position.set(4, 2, 6);
  const placements = createPlacementVisibility();
  placements.addClone("room", group);
  placements.setOffsetY("room", 3);
  near(group.position.y, 5, "home + 3");
  placements.setOffsetY("room", 1);
  near(group.position.y, 3, "home + 1, not stacked");
  placements.setOffsetY("room", 0);
  near(group.position.y, 2, "home");
  near(group.position.x, 4, "x stays");
  near(group.position.z, 6, "z stays");
});

const cab: ArenaElevator = {
  id: "e1",
  room: "bldg.cab",
  building: "bldg",
  stops: [0, 3, 6, 9, 12],
  speed: 1,
  waitS: 1,
  polygon: [[0, 0], [2, 0], [2, 2], [0, 2]],
  landings: [[3, 0, 1], [3, 3, 1], [3, 6, 1], [3, 9, 1], [3, 12, 1]],
};

function rideView(): ArenaView {
  const wall = {
    id: 10,
    minX: 0, maxX: 1, minY: 0, maxY: 2.2, minZ: 0, maxZ: 1,
    source: "bldg.cab.front.0",
  };
  const other = {
    id: 20,
    minX: 0, maxX: 1, minY: 1, maxY: 4, minZ: 0, maxZ: 1,
    source: "bldg.other.front.0",
  };
  return {
    bundleId: "t",
    bundleVersion: "0",
    authoritativeHash: "a",
    presentationHash: "p",
    collisionContentHash: "c",
    world: "w",
    bounds: { minX: -10, maxX: 10, minY: 0, maxY: 12, minZ: -10, maxZ: 10 },
    walls: [],
    buildings: [
      { id: "bldg.cab", model: "/assets/models/elevator-1.glb", position: [0, 0, 0], yaw: 0, scale: 1 },
      { id: "bldg.floor-2.hall", model: "/h.glb", position: [0, 3, 0], yaw: 0, scale: 1 },
      { id: "bldg.floor-5.hall", model: "/h.glb", position: [0, 12, 0], yaw: 0, scale: 1 },
      { id: "bldg.floor-1.slab", model: "/h.glb", position: [0, 0, 0], yaw: 0, scale: 1 },
      { id: "other.floor-2.hall", model: "/h.glb", position: [8, 3, 0], yaw: 0, scale: 1 },
    ],
    props: [{
      id: "bldg.cab.sign",
      idNum: 0,
      model: "/s.glb",
      minX: 0, maxX: 1, minY: 1, maxY: 2, minZ: 0, maxZ: 1,
      position: [0, 1, 0],
      yaw: 0,
      scale: 1,
    }],
    doors: [{
      id: "bldg.cab.door-1",
      model: "/d.glb",
      position: [1, 0, 2],
      yaw: 0,
      hinge: "left",
      size: [1, 2.1, 0.08],
      open: true,
    }],
    characters: [],
    staticModels: [],
    aabbs: [wall, other],
    pawnRadius: 0.3,
    pawnHeight: 1.7,
    modelChoices: [],
    lights: [{ id: "bldg.cab.lamp", type: "point", position: [1, 2.2, 1], color: "#fff", intensity: 1 }],
    elevators: [cab, { ...cab, id: "loose", room: undefined, building: undefined }],
  };
}

function clocked(run: (at: (t: number) => void) => void): void {
  const original = performance.now;
  let t = 0;
  performance.now = () => t;
  try {
    run((next) => { t = next; });
  } finally {
    performance.now = original;
  }
}

function harness(arena: ArenaView = rideView()) {
  const offsets = new Map<string, number>();
  const visible = new Map<string, boolean>();
  let flushes = 0;
  const lamp = new THREE.Object3D();
  lamp.position.set(1, 2.2, 1);
  const lights = new Map<string, THREE.Object3D>([["bldg.cab.lamp", lamp]]);
  const shifted: string[] = [];
  const rooms = createElevatorRooms(arena, {
    placements: {
      setOffsetY(id, dy) {
        offsets.set(id, dy);
      },
      setVisible(id, on) {
        visible.set(id, on);
      },
      flushBounds() {
        flushes += 1;
      },
    },
    lights,
  }, {
    offsetY(prefix, dy) {
      shifted.push(`${prefix}:${dy}`);
    },
  });
  const frame = (y: number, doorsOpen: boolean, id = "e1", stop = 0): ElevatorState => (
    { t: "elevator", id, y, doorsOpen, stop }
  );
  return { rooms, offsets, visible, lamp, shifted, frame, flushes: () => flushes, arena };
}

test("render y samples now minus 80 ms, clamps, and a rider y overrides", () => {
  clocked((at) => {
    const h = harness();
    at(1000);
    h.rooms.onCab(h.frame(0, false));
    at(1100);
    h.rooms.onCab(h.frame(2, false));

    h.rooms.tick(1130, undefined);
    near(h.offsets.get("bldg.cab")!, 1, "halfway");

    h.rooms.tick(1180, undefined);
    near(h.offsets.get("bldg.cab")!, 2, "clamped to the newest");

    h.rooms.tick(1080, undefined);
    near(h.offsets.get("bldg.cab")!, 0, "clamped to the older frame");

    at(2000);
    h.rooms.onCab(h.frame(5.8, false));
    at(2100);
    h.rooms.onCab(h.frame(6, false, "e1", 2));
    h.rooms.tick(2140, { x: 1, y: 5.7, z: 1 });
    near(h.offsets.get("bldg.cab")!, 5.7, "rider y");
    near(h.lamp.position.y, 2.2 + 5.7, "lamp");
  });
});

test("halls hide only while the owned pawn rides and come back on arrival", () => {
  clocked((at) => {
    const h = harness();
    at(1000);
    h.rooms.onCab(h.frame(0, false));
    h.rooms.tick(1000, { x: 1, y: 0, z: 1 });
    assert.equal(h.visible.get("bldg.floor-2.hall"), false);
    assert.equal(h.visible.get("bldg.floor-5.hall"), false);
    assert.equal(h.visible.has("bldg.floor-1.slab"), false);
    assert.equal(h.visible.has("other.floor-2.hall"), false);

    h.rooms.tick(1000, { x: 9, y: 0, z: 9 });
    assert.equal(h.visible.get("bldg.floor-2.hall"), true);
    assert.equal(h.visible.get("bldg.floor-5.hall"), true);

    h.rooms.tick(1000, { x: 1, y: 0, z: 1 });
    assert.equal(h.visible.get("bldg.floor-2.hall"), false);

    h.rooms.onCab(h.frame(6, true, "e1", 2));
    h.rooms.tick(1000, { x: 1, y: 6, z: 1 });
    assert.equal(h.visible.get("bldg.floor-2.hall"), true, "arrival restores the halls");
    assert.equal(h.visible.get("bldg.floor-5.hall"), true);
  });
});

test("client wall and door copies shift with the cab and restore at the home stop", () => {
  clocked((at) => {
    const h = harness();
    const wall = h.arena.aabbs[0]!;
    const other = h.arena.aabbs[1]!;
    const door = h.arena.doors[0]!;
    at(1000);
    h.rooms.onCab(h.frame(6, false, "e1", 2));
    h.rooms.tick(1000, undefined);
    near(wall.minY!, 6, "wall minY");
    near(wall.maxY!, 8.2, "wall maxY");
    near(other.minY!, 1, "other minY");
    near(other.maxY!, 4, "other maxY");
    near(door.position[1], 6, "door y");
    assert.equal(h.offsets.get("bldg.cab.door-1"), 6);
    assert.equal(h.offsets.get("bldg.cab.sign"), 6);
    assert.equal(h.offsets.has("loose"), false);
    assert.ok(h.shifted.includes("bldg.cab.:6"));

    h.rooms.onCab(h.frame(0, true));
    h.rooms.tick(1000, undefined);
    assert.equal(wall.minY, 0);
    assert.equal(wall.maxY, 2.2);
    assert.equal(door.position[1], 0);
    near(h.lamp.position.y, 2.2, "lamp home");
  });
});
