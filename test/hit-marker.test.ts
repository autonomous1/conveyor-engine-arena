import assert from "node:assert/strict";
import test from "node:test";
import { attachPlayInput, type PlayInput } from "../src/client/input.ts";
import { createHitMarker, HIT_MARKER_MS, type HitMarker } from "../src/client/hit-marker.ts";
import { advanceFireClock, fireFrame, type FireFrame } from "../src/shared/hitscan.ts";

/**
 * One F paints one screen circle at the crosshair for 150 ms.
 * The shooter's own laser does not paint a second circle.
 * Another client keeps its circle hidden. A miss still paints it.
 */

const OWN = 7;
const OTHER = 8;

type Listener = (ev: Record<string, unknown>) => void;

type MarkerNode = {
  tag: string;
  id: string;
  style: { cssText: string; display: string };
  parent: MarkerParent | null;
};

type MarkerParent = {
  style: { cursor: string };
  children: MarkerNode[];
  append(node: MarkerNode): void;
};

function createTarget() {
  const listeners = new Map<string, Set<Listener>>();
  let prevented = 0;
  return {
    addEventListener(type: string, fn: Listener) {
      let set = listeners.get(type);
      if (!set) {
        set = new Set();
        listeners.set(type, set);
      }
      set.add(fn);
    },
    removeEventListener(type: string, fn: Listener) {
      listeners.get(type)?.delete(fn);
    },
    dispatch(type: string, ev: Record<string, unknown>) {
      const event = {
        preventDefault() {
          prevented += 1;
        },
        stopPropagation() {},
        repeat: false,
        button: 0,
        ...ev,
      };
      for (const fn of [...(listeners.get(type) ?? [])]) fn(event);
      return prevented;
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

function markerDocument() {
  let created = 0;
  const body: MarkerParent = {
    style: { cursor: "default" },
    children: [],
    append(node) {
      node.parent = body;
      this.children.push(node);
    },
  };
  const doc = {
    body,
    createElement(tag: string) {
      created += 1;
      const node: MarkerNode = { tag, id: "", style: { cssText: "", display: "" }, parent: null };
      return node;
    },
  };
  return {
    doc,
    body,
    get created() {
      return created;
    },
  };
}

function pressedPad() {
  const buttons = Array.from({ length: 17 }, () => ({ pressed: true, touched: true, value: 1 }));
  return { index: 0, connected: true, mapping: "standard", axes: [0, 0, 0, 0], buttons, id: "test-pad", timestamp: 0 };
}

function installDom() {
  const page = markerDocument();
  const windowTarget = createTarget();
  const documentTarget = createTarget();
  let pointerLockElement: object | null = null;
  const dom = Object.assign(createTarget(), {
    requestPointerLock() {
      pointerLockElement = dom;
      documentTarget.dispatch("pointerlockchange", {});
      return Promise.resolve();
    },
  });
  const document = {
    ...page.doc,
    addEventListener: documentTarget.addEventListener.bind(documentTarget),
    removeEventListener: documentTarget.removeEventListener.bind(documentTarget),
    get pointerLockElement() {
      return pointerLockElement;
    },
  };
  const root = globalThis as { window: unknown; document: unknown };
  root.window = windowTarget;
  root.document = document;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    writable: true,
    value: { getGamepads: () => [pressedPad()] },
  });
  return {
    document,
    dom: dom as unknown as HTMLElement,
    storage: memoryStorage(),
    body: page.body,
    get created() {
      return page.created;
    },
    click() {
      dom.dispatch("mousedown", { button: 0 });
      windowTarget.dispatch("mouseup", { button: 0 });
      dom.dispatch("click", { button: 0 });
    },
    key(type: "keydown" | "keyup", code: string, repeat = false) {
      windowTarget.dispatch(type, { code, repeat });
    },
  };
}

function watch(marker: HitMarker) {
  let flashes = 0;
  let was = false;
  return {
    get flashes() {
      return flashes;
    },
    sample() {
      const on = marker.visible;
      if (on && !was) flashes += 1;
      was = on;
      return on;
    },
  };
}

function drive(input: PlayInput, marker: HitMarker) {
  let nextAt = 0;
  let seq = 0;
  const eye = watch(marker);
  return {
    at(now: number, lasers: ReadonlyArray<{ shooter: number }> = []) {
      input.update(1 / 60);
      const sample = input.sample();
      const clock = advanceFireClock(sample.firing, now, nextAt);
      nextAt = clock.nextAt;
      let frame: FireFrame | undefined;
      if (clock.due) {
        frame = fireFrame(++seq, sample.yaw, sample.pitch);
        marker.note({ kind: "fire", sent: true }, now);
      }
      for (const laser of lasers) marker.note({ kind: "laser", shooter: laser.shooter, ownedId: OWN }, now);
      marker.tick(now);
      return { frame, sample, visible: eye.sample(), flashes: eye.flashes };
    },
  };
}

test("one F flashes the circle once", () => {
  assert.equal(HIT_MARKER_MS, 150);
  const rig = installDom();
  const input = attachPlayInput(rig.dom, rig.storage);
  const marker = createHitMarker(rig.document as unknown as Document);
  const otherPage = markerDocument();
  const other = createHitMarker(otherPage.doc as unknown as Document);
  const otherEye = watch(other);
  const element = marker.element as unknown as MarkerNode;

  assert.equal(rig.created, 1);
  assert.equal(element.tag, "div");
  assert.equal(element.id, "hit-marker");
  assert.equal(element.parent, rig.body);
  assert.equal(rig.body.children.length, 1);
  assert.equal(marker.visible, false);
  const css = element.style.cssText;
  for (const part of [
    "position:fixed",
    "left:50%",
    "top:50%",
    "width:8px",
    "height:8px",
    "border-radius:50%",
    "background:#ff2020",
    "transform:translate(-50%,-50%)",
    "pointer-events:none",
  ]) {
    assert.ok(css.includes(part), css);
  }

  const play = drive(input, marker);
  rig.click();
  const clicked = play.at(0);
  assert.equal(clicked.frame, undefined);
  assert.equal(clicked.visible, false);
  assert.equal(clicked.flashes, 0);

  rig.key("keydown", "KeyF");
  rig.key("keyup", "KeyF");
  const fired = play.at(64);
  assert.ok(fired.frame);
  assert.deepEqual(fired.frame, fireFrame(1, fired.sample.yaw, fired.sample.pitch));
  assert.equal(fired.visible, true);
  assert.equal(fired.flashes, 1);
  assert.equal(element.style.display, "block");

  const echo = play.at(104, [{ shooter: OWN }]);
  assert.equal(echo.frame, undefined);
  assert.equal(echo.visible, true);
  assert.equal(echo.flashes, 1);
  other.note({ kind: "laser", shooter: OWN, ownedId: OTHER }, 104);
  other.tick(104);
  assert.equal(otherEye.sample(), false);
  assert.equal(otherEye.flashes, 0);
  assert.equal(otherPage.created, 1);

  const mid = play.at(64 + 149);
  assert.equal(mid.frame, undefined);
  assert.equal(mid.visible, true);
  assert.equal(mid.flashes, 1);

  const end = play.at(64 + HIT_MARKER_MS);
  assert.equal(end.visible, false);
  assert.equal(end.flashes, 1);
  assert.equal(element.style.display, "none");

  const later = play.at(400);
  assert.equal(later.frame, undefined);
  assert.equal(later.visible, false);
  assert.equal(later.flashes, 1);
  assert.equal(rig.created, 1);
  assert.equal(rig.body.children.length, 1);
});

test("a miss still shows the circle and another shooter does not", () => {
  const page = markerDocument();
  const marker = createHitMarker(page.doc as unknown as Document);
  assert.equal(marker.visible, false);

  marker.note({ kind: "fire", sent: false }, 0);
  marker.tick(0);
  assert.equal(marker.visible, false);

  marker.note({ kind: "laser", shooter: OWN, ownedId: OTHER }, 0);
  marker.tick(0);
  assert.equal(marker.visible, false);

  marker.note({ kind: "fire", sent: true }, 20);
  marker.tick(20);
  assert.equal(marker.visible, true);
  marker.note({ kind: "laser", shooter: OWN, ownedId: OWN }, 50);
  marker.tick(20 + 149);
  assert.equal(marker.visible, true);
  marker.tick(20 + HIT_MARKER_MS);
  assert.equal(marker.visible, false);

  marker.note({ kind: "laser", shooter: OWN, ownedId: OWN }, 400);
  marker.tick(400);
  assert.equal(marker.visible, true);
  marker.tick(400 + HIT_MARKER_MS);
  assert.equal(marker.visible, false);
  assert.equal(page.created, 1);

  const late = markerDocument();
  const lateMarker = createHitMarker(late.doc as unknown as Document);
  lateMarker.note({ kind: "fire", sent: true }, 0);
  lateMarker.tick(HIT_MARKER_MS);
  assert.equal(lateMarker.visible, false);
  lateMarker.note({ kind: "laser", shooter: OWN, ownedId: OWN }, HIT_MARKER_MS + 80);
  lateMarker.tick(HIT_MARKER_MS + 80);
  assert.equal(lateMarker.visible, false);
  assert.equal(late.created, 1);
});
