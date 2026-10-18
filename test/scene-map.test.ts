import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { placeBuildingModel, placeStaticInstances } from "../src/client/arena-scene.ts";
import {
  SHOW_SCENE_MAP_STORAGE_KEY,
  createOptionsDialog,
  createOptionsModel,
  loadShowSceneMap,
  type KeyValueStorage,
} from "../src/client/options.ts";
import { MAP_BAKE_URL } from "../src/shared/map-frame.ts";
import {
  AUTHOR_PROFILE_COLOR,
  YAW_COLOR,
  assembleSceneMap,
  collectInstanceSamples,
  collectObjectSamples,
  SCENE_MAP_SIZE,
  createSceneMap,
  hitSceneMap,
  layoutSceneMap,
  paintSceneMap,
  yawMark,
  type MapDraw,
  type MapSample,
} from "../src/client/scene-map.ts";

const BOUNDS = { minX: -10, maxX: 10, minZ: -10, maxZ: 10 };

function spans(polygon: ReadonlyArray<[number, number]>) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const [x, z] of polygon) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  return { x: maxX - minX, z: maxZ - minZ };
}

function memory(initial?: string): KeyValueStorage & { getItem(key: string): string | null } {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set(SHOW_SCENE_MAP_STORAGE_KEY, initial);
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

test("yaw marks use the short arc, and 270° matches −90°", () => {
  assert.equal(yawMark(0, 0), "match");
  assert.equal(yawMark(4 * Math.PI / 180, 0), "match");
  assert.equal(yawMark(10 * Math.PI / 180, 0), "small");
  assert.equal(yawMark(44 * Math.PI / 180, 0), "small");
  assert.equal(yawMark(45 * Math.PI / 180, 0), "large");
  assert.equal(yawMark(-Math.PI / 2, 270 * Math.PI / 180), "match");
  assert.equal(yawMark(0, undefined), "unknown");
});

test("world +Z is up on the map and +X is to the right", () => {
  const layout = layoutSceneMap({
    bounds: { minX: -10, maxX: 10, minZ: -5, maxZ: 5 },
    samples: [],
  }, 200, 200);
  assert.ok(layout);
  const north = layout.toPixel(0, 5);
  const south = layout.toPixel(0, -5);
  const east = layout.toPixel(10, 0);
  const west = layout.toPixel(-10, 0);
  assert.ok(north[1] < south[1], `+Z pixel y ${north[1]} should be above −Z ${south[1]}`);
  assert.ok(east[0] > west[0], `+X pixel x ${east[0]} should be right of −X ${west[0]}`);
  const [x, z] = layout.toWorld(north[0], north[1]);
  assert.ok(Math.abs(x) < 1e-6, `round trip x ${x}`);
  assert.ok(Math.abs(z - 5) < 1e-6, `round trip z ${z}`);
  const width = Math.abs(layout.floor[1]![0] - layout.floor[0]![0]);
  const depth = Math.abs(layout.floor[2]![1] - layout.floor[1]![1]);
  assert.ok(width > depth, `floor pixel ${width} by ${depth}`);
});

test("a child node turned 90° is red against file yaw 0 and the long axis follows the mesh", () => {
  const template = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(4, 1, 1));
  mesh.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
  template.add(mesh);
  const instances = placeStaticInstances(template, [{ position: [10, 0, 5], yaw: 0, scale: 2 }]);
  const samples: MapSample[] = [];
  collectInstanceSamples(samples, instances, [{ id: "step-1", kind: "building", expectedYaw: 0 }]);
  const layout = layoutSceneMap({ bounds: BOUNDS, samples });
  assert.ok(layout);
  const entity = layout.entities.find((item) => item.id === "step-1");
  assert.ok(entity);
  assert.equal(entity.mark, "large");
  assert.ok(Math.abs(entity.x - 10) < 1e-3, `center x ${entity.x}`);
  assert.ok(Math.abs(entity.z - 5) < 1e-3, `center z ${entity.z}`);
  const span = spans(entity.polygon);
  // Box 4×1 scaled by 2 is 8×2. rotation.y = 90° sends local +X to world −Z.
  assert.ok(Math.abs(span.x - 2) < 0.05, `span x ${span.x}`);
  assert.ok(Math.abs(span.z - 8) < 0.05, `span z ${span.z}`);
  const oracle = new THREE.Object3D();
  oracle.rotation.y = Math.PI / 2;
  const plusX = new THREE.Vector3(1, 0, 0).applyQuaternion(oracle.quaternion);
  assert.ok(plusX.z < -0.9, `oracle +X z ${plusX.z}`);
  assert.ok(Math.abs(entity.axisX[0] - plusX.x) < 1e-4, `axis x ${entity.axisX[0]}`);
  assert.ok(Math.abs(entity.axisX[1] - plusX.z) < 1e-4, `axis z ${entity.axisX[1]}`);
  assert.match(entity.tip, /step-1/);
  assert.match(entity.tip, /mesh 90°/);
  assert.match(entity.tip, /file 0°/);
  assert.match(entity.tip, /off 90°/);

  const lines: Array<{ color: string; dash: boolean; dx: number; dy: number }> = [];
  const fills: string[] = [];
  const draw: MapDraw = {
    clear() {},
    polygon(_points, fill) {
      if (fill) fills.push(fill);
    },
    line(x0, y0, x1, y1, color, dash) {
      lines.push({ color, dash, dx: x1 - x0, dy: y1 - y0 });
    },
    circle() {},
    text() {},
  };
  paintSceneMap(layout, draw);
  assert.ok(fills.some((fill) => fill.includes("255, 90, 106")), fills.join(" | "));
  const meshArrow = lines.find((line) => line.color === "#ffffff");
  const fileArrow = lines.find((line) => line.dash);
  assert.ok(meshArrow && meshArrow.dy > 1 && Math.abs(meshArrow.dx) < meshArrow.dy, `mesh arrow ${JSON.stringify(meshArrow)}`);
  assert.ok(fileArrow && fileArrow.dx > 1 && Math.abs(fileArrow.dy) < fileArrow.dx, `file arrow ${JSON.stringify(fileArrow)}`);
});

test("placement yaw 90 turns the footprint and stays green when the file agrees", () => {
  const template = new THREE.Group();
  template.add(new THREE.Mesh(new THREE.BoxGeometry(4, 1, 1)));
  const instances = placeStaticInstances(template, [{ position: [0, 0, 0], yaw: 90, scale: 1 }]);
  const samples: MapSample[] = [];
  collectInstanceSamples(samples, instances, [{ id: "hall", kind: "building", expectedYaw: 90 }]);
  const layout = layoutSceneMap({ bounds: BOUNDS, samples });
  assert.ok(layout);
  const entity = layout.entities[0]!;
  assert.equal(entity.mark, "match");
  const span = spans(entity.polygon);
  assert.ok(span.z > span.x * 2, `span x ${span.x} z ${span.z}`);
  const fills: string[] = [];
  let dashed = 0;
  paintSceneMap(layout, {
    clear() {},
    polygon(_points, fill) {
      if (fill) fills.push(fill);
    },
    line(_x0, _y0, _x1, _y1, _color, dash) {
      if (dash) dashed += 1;
    },
    circle() {},
    text() {},
  });
  assert.equal(dashed, 0);
  assert.ok(fills.some((fill) => fill.includes("61, 255, 154")), fills.join(" | "));
  assert.equal(YAW_COLOR.match, "#3dff9a");
});

test("file yaw 270 matches the quaternion placeBuildingModel applies", () => {
  const group = placeBuildingModel(new THREE.Mesh(new THREE.BoxGeometry(4, 1, 1)), {
    id: "west",
    model: "/assets/models/step.glb",
    position: [1, 0, 2],
    yaw: 270,
    scale: 1,
  });
  const scene = new THREE.Scene();
  scene.add(group);
  const samples: MapSample[] = [];
  collectObjectSamples(samples, { id: "west", kind: "building", expectedYaw: 270 }, group);
  const layout = layoutSceneMap({ bounds: BOUNDS, samples });
  assert.ok(layout);
  const entity = layout.entities[0]!;
  assert.equal(entity.mark, "match");
  assert.match(entity.tip, /mesh 270°/);
  assert.match(entity.tip, /file 270°/);
  assert.match(entity.tip, /off 0°/);
  const q = new THREE.Quaternion();
  group.getWorldQuaternion(q);
  const worldYaw = 2 * Math.atan2(q.y, q.w);
  const delta = Math.atan2(Math.sin(entity.yaw - worldYaw), Math.cos(entity.yaw - worldYaw));
  assert.ok(Math.abs(delta) < 1e-4, `map yaw ${entity.yaw} mesh yaw ${worldYaw}`);
});

test("an open door leaf does not replace the frame footprint", () => {
  const group = new THREE.Group();
  const frame = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 0.1));
  frame.name = "frame";
  const hinge = new THREE.Group();
  hinge.name = "hinge";
  hinge.rotation.y = Math.PI / 2;
  const leaf = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 0.08));
  leaf.name = "door";
  hinge.add(leaf);
  frame.add(hinge);
  group.add(frame);
  const samples: MapSample[] = [];
  collectObjectSamples(samples, { id: "door-1", kind: "door", expectedYaw: 0 }, group, ["hinge", "door"]);
  const [entity] = assembleSceneMap(samples);
  assert.ok(entity);
  const span = spans(entity.polygon);
  assert.ok(span.z < 0.5, `leaf leaked into z span ${span.z}`);
  assert.ok(span.x > 1, `frame width ${span.x}`);
  assert.equal(yawMark(entity.yaw, entity.expectedYaw), "match");
});

test("the center of a footprint hits that building, and a spawn faces +Z at yaw 0", () => {
  const group = placeBuildingModel(new THREE.Mesh(new THREE.BoxGeometry(4, 1, 4)), {
    id: "hall",
    model: "m",
    position: [0, 0, 0],
    yaw: 0,
    scale: 1,
  });
  const samples: MapSample[] = [];
  collectObjectSamples(samples, { id: "hall", kind: "building", expectedYaw: 0 }, group);
  const layout = layoutSceneMap({
    bounds: BOUNDS,
    samples,
    spawns: [
      { id: "a", x: 6, z: 6, yaw: 0 },
      { id: "b", x: -6, z: -6, yaw: 90 },
    ],
  });
  assert.ok(layout);
  const center = layout.toPixel(0, 0);
  assert.equal(hitSceneMap(layout, center[0], center[1])?.id, "hall");
  assert.equal(hitSceneMap(layout, 0, 0), undefined);
  const north = layout.entities.find((entity) => entity.id === "a");
  const east = layout.entities.find((entity) => entity.id === "b");
  assert.ok(north && north.axisZ[1] > 0.9 && Math.abs(north.axisZ[0]) < 0.1);
  assert.ok(east && east.axisZ[0] > 0.9 && Math.abs(east.axisZ[1]) < 0.1);
  const spawnPixel = layout.toPixel(6, 6);
  assert.equal(hitSceneMap(layout, spawnPixel[0], spawnPixel[1])?.id, "a");
  assert.match(north.tip, /yaw 0°/);
});

const ELL: Array<[number, number]> = [[0, 0], [2, 0], [2, 1], [1, 1], [1, 2], [0, 2]];

test("an SVG profile turns with the mesh yaw, and the authoring yaw is a second outline", () => {
  const template = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  mesh.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
  template.add(mesh);
  const instances = placeStaticInstances(template, [{ position: [3, 0, 4], yaw: 0, scale: 2 }]);
  const samples: MapSample[] = [];
  collectInstanceSamples(samples, instances, [{
    id: "hall",
    kind: "building",
    expectedYaw: 0,
    authorYaw: 0,
    profile: [ELL],
    anchor: { x: 3, z: 4, scale: 2 },
  }]);
  const layout = layoutSceneMap({ bounds: BOUNDS, samples });
  assert.ok(layout);
  const entity = layout.entities.find((item) => item.id === "hall");
  assert.ok(entity);
  assert.equal(entity.mark, "large");
  assert.ok(entity.profile.length === 1 && entity.profile[0]!.length === 6);
  const oracle = new THREE.Object3D();
  oracle.position.set(3, 0, 4);
  oracle.rotation.y = Math.PI / 2;
  oracle.scale.setScalar(2);
  oracle.updateMatrix();
  const placed = new THREE.Vector3(2, 0, 0).applyMatrix4(oracle.matrix);
  const nose = entity.profile[0]!.find((point) => Math.hypot(point[0] - placed.x, point[1] - placed.z) < 1e-4);
  assert.ok(nose, `mesh outline missed ${placed.x}, ${placed.z}`);
  const author = new THREE.Object3D();
  author.position.set(3, 0, 4);
  author.scale.setScalar(2);
  author.updateMatrix();
  const flat = new THREE.Vector3(2, 0, 0).applyMatrix4(author.matrix);
  const ghost = entity.authorProfile[0]?.find((point) => Math.hypot(point[0] - flat.x, point[1] - flat.z) < 1e-4);
  assert.ok(ghost, `svg outline missed ${flat.x}, ${flat.z}`);
  assert.match(entity.tip, /svg 0°/);

  const painted: Array<{ stroke: string; dash: boolean; count: number }> = [];
  paintSceneMap(layout, {
    clear() {},
    polygon() {},
    rings(rings, _fill, stroke, dash) {
      painted.push({ stroke, dash, count: rings[0]?.length ?? 0 });
    },
    line() {},
    circle() {},
    text() {},
  });
  assert.ok(painted.some((ring) => !ring.dash && ring.count === 6));
  assert.ok(painted.some((ring) => ring.dash && ring.stroke === AUTHOR_PROFILE_COLOR && ring.count === 6));
});

test("a profile whose authoring yaw matches the mesh is drawn once, and a notch is not a hit", () => {
  const template = new THREE.Group();
  template.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)));
  const instances = placeStaticInstances(template, [{ position: [0, 0, 0], yaw: 0, scale: 1 }]);
  const samples: MapSample[] = [];
  collectInstanceSamples(samples, instances, [{
    id: "hall",
    kind: "building",
    expectedYaw: 0,
    authorYaw: 0,
    profile: [ELL],
    anchor: { x: 0, z: 0, scale: 1 },
  }]);
  const layout = layoutSceneMap({ bounds: BOUNDS, samples });
  assert.ok(layout);
  const entity = layout.entities[0]!;
  assert.equal(entity.authorProfile.length, 0);
  assert.equal(entity.mark, "match");
  const solid = layout.toPixel(0.5, 0.5);
  const notch = layout.toPixel(1.5, 1.5);
  assert.equal(hitSceneMap(layout, solid[0], solid[1])?.id, "hall");
  assert.equal(hitSceneMap(layout, notch[0], notch[1]), undefined);
  let dashed = 0;
  paintSceneMap(layout, {
    clear() {},
    polygon() {},
    rings(_rings, _fill, _stroke, dash) {
      if (dash) dashed += 1;
    },
    line() {},
    circle() {},
    text() {},
  });
  assert.equal(dashed, 0);
});

test("scene map stays hidden and does not paint until it is on and the world is set", () => {
  const rig = installDom();
  try {
    const map = createSceneMap();
    const root = rig.get("scene-map");
    const canvas = rig.get("scene-map-canvas");
    assert.equal(root.hidden, true);
    assert.equal(map.visible, false);
    map.setWorld({ bounds: BOUNDS, samples: [] });
    assert.equal(root.hidden, true);
    assert.equal(canvas.contextGets, 0);
    map.setVisible(true);
    assert.equal(root.hidden, false);
    assert.equal(map.visible, true);
    assert.equal(canvas.contextGets, 0);
    assert.equal(SCENE_MAP_SIZE, 360);
    assert.match(root.style.cssText, /360px/);
    const image = rig.get("scene-map-image") as FakeEl & { src?: string };
    assert.equal(image.tag, "img");
    assert.equal(image.src, MAP_BAKE_URL);
    const layout = map.layout();
    assert.ok(layout);
    assert.equal(layout.width, SCENE_MAP_SIZE);
    assert.equal(canvas.contextGets, 0);
    map.setVisible(false);
    assert.equal(root.hidden, true);
    assert.equal(canvas.contextGets, 0);
  } finally {
    rig.restore();
  }
});

test("show scene map defaults off, persists across a reload, and the dialog switch paints it", () => {
  assert.equal(loadShowSceneMap(null), false);
  assert.equal(loadShowSceneMap(memory()), false);
  assert.equal(loadShowSceneMap(memory("off")), false);
  assert.equal(loadShowSceneMap(memory("true")), false);
  assert.equal(loadShowSceneMap(memory("on")), true);

  const storage = memory();
  const seen: boolean[] = [];
  const first = createOptionsModel(storage, () => {}, () => {}, (on) => seen.push(on));
  assert.deepEqual(seen, [false]);
  assert.equal(first.showSceneMap, false);
  assert.equal(storage.getItem(SHOW_SCENE_MAP_STORAGE_KEY), null);
  first.toggleShowSceneMap();
  assert.equal(first.showSceneMap, true);
  assert.equal(first.showCollision, false);
  assert.equal(storage.getItem(SHOW_SCENE_MAP_STORAGE_KEY), "on");
  const restored: boolean[] = [];
  createOptionsModel(storage, () => {}, () => {}, (on) => restored.push(on));
  assert.deepEqual(restored, [true]);

  const denied: KeyValueStorage = {
    getItem() {
      throw new Error("denied");
    },
    setItem() {
      throw new Error("denied");
    },
  };
  const model = createOptionsModel(denied, () => {}, () => {}, () => {});
  model.toggleShowSceneMap();
  assert.equal(model.showSceneMap, true);

  const rig = installDom();
  try {
    const status = rig.document.createElement("div");
    status.id = "status";
    rig.document.body.append(status);
    const toggled: boolean[] = [];
    const dialog = createOptionsDialog(() => {}, storage, (on) => toggled.push(on));
    const toggle = rig.get("scene-map-toggle");
    assert.equal(toggle.textContent, "Scene map: on");
    assert.deepEqual(toggled, [true]);
    toggle.click();
    assert.equal(dialog.showSceneMap, false);
    assert.equal(toggle.textContent, "Scene map: off");
    assert.equal(storage.getItem(SHOW_SCENE_MAP_STORAGE_KEY), "off");
    assert.equal(rig.get("fire-debug").textContent, "Fire debug: off");
    assert.equal(rig.get("show-collision").textContent, "Show collision: off");
  } finally {
    rig.restore();
  }
});

type FakeEl = {
  tag: string;
  id: string;
  hidden: boolean;
  width: number;
  height: number;
  textContent: string;
  type: string;
  title: string;
  style: { cssText: string; display: string; borderColor: string };
  children: FakeEl[];
  contextGets: number;
  append(...nodes: FakeEl[]): void;
  setAttribute(name: string, value: string): void;
  addEventListener(type: string, fn: (ev: { preventDefault(): void; stopPropagation(): void }) => void): void;
  click(): void;
  getContext(kind: string): FakeCtx | null;
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
};

type FakeCtx = {
  canvas: { width: number; height: number };
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  font: string;
  textAlign: string;
  textBaseline: string;
  clearRect(): void;
  beginPath(): void;
  moveTo(): void;
  lineTo(): void;
  closePath(): void;
  fill(): void;
  stroke(): void;
  arc(): void;
  fillText(): void;
  setLineDash(): void;
};

function installDom() {
  const ids = new Map<string, FakeEl>();
  const previous = { window: globalThis.window, document: globalThis.document };
  function createElement(tag: string): FakeEl {
    const listeners = new Map<string, Array<(ev: { preventDefault(): void; stopPropagation(): void }) => void>>();
    let idValue = "";
    const el: FakeEl = {
      tag,
      hidden: false,
      width: 0,
      height: 0,
      textContent: "",
      type: "",
      title: "",
      style: { cssText: "", display: "", borderColor: "" },
      children: [],
      contextGets: 0,
      get id() {
        return idValue;
      },
      set id(value: string) {
        if (idValue) ids.delete(idValue);
        idValue = value;
        if (value) ids.set(value, el);
      },
      append(...nodes: FakeEl[]) {
        this.children.push(...nodes);
      },
      setAttribute() {},
      addEventListener(type, fn) {
        const list = listeners.get(type) ?? [];
        list.push(fn);
        listeners.set(type, list);
      },
      click() {
        for (const fn of listeners.get("click") ?? []) fn({ preventDefault() {}, stopPropagation() {} });
      },
      getContext() {
        el.contextGets += 1;
        return {
          canvas: el,
          fillStyle: "",
          strokeStyle: "",
          lineWidth: 1,
          font: "",
          textAlign: "",
          textBaseline: "",
          clearRect() {},
          beginPath() {},
          moveTo() {},
          lineTo() {},
          closePath() {},
          fill() {},
          stroke() {},
          arc() {},
          fillText() {},
          setLineDash() {},
        };
      },
      getBoundingClientRect() {
        return { left: 0, top: 0, width: el.width || SCENE_MAP_SIZE, height: el.height || SCENE_MAP_SIZE };
      },
    };
    return el;
  }
  const body = createElement("body");
  const document = {
    body,
    createElement,
    getElementById(id: string) {
      return ids.get(id) ?? null;
    },
  };
  globalThis.window = { addEventListener() {} } as unknown as Window & typeof globalThis;
  globalThis.document = document as unknown as Document;
  return {
    document,
    get(id: string) {
      const el = ids.get(id);
      assert.ok(el, id);
      return el;
    },
    restore() {
      globalThis.window = previous.window;
      globalThis.document = previous.document;
    },
  };
}
