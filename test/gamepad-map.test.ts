import assert from "node:assert/strict";
import test from "node:test";
import { attachPlayInput } from "../src/client/input.ts";
import {
  createPadReader,
  RepeatNav,
  STD,
  type PadActions,
  type PadFrame,
} from "../src/shared/gamepad-map.ts";
import { GAMEPAD_PROFILE_STORAGE_KEY, gamepadBindings } from "../src/shared/look.ts";

function fakePad(partial: {
  connected?: boolean;
  mapping?: string;
  buttons?: Record<number, number>;
  pressed?: Record<number, boolean>;
  axes?: number[];
} = {}): PadFrame {
  const buttons = Array.from({ length: 17 }, (_, index) => {
    const value = partial.buttons?.[index] ?? 0;
    return { pressed: partial.pressed?.[index] ?? value >= 0.5, value };
  });
  return {
    connected: partial.connected !== false,
    mapping: partial.mapping ?? "standard",
    buttons,
    axes: partial.axes ?? [0, 0, 0, 0],
  };
}

function assertQuiet(actions: PadActions): void {
  assert.deepEqual(actions, {
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
  });
}

test("RT hysteresis fires once and a resting trigger never fires", () => {
  const reader = createPadReader();
  const pressed = reader.step(fakePad({ buttons: { [STD.RT]: 0.6 } }), 16, "standard");
  assert.equal(pressed.fire.held, true);
  assert.equal(pressed.fire.pressed, true);
  const mid = reader.step(fakePad({ buttons: { [STD.RT]: 0.45 } }), 16, "standard");
  assert.equal(mid.fire.held, true);
  assert.equal(mid.fire.pressed, false);
  const released = reader.step(fakePad({ buttons: { [STD.RT]: 0.3 } }), 16, "standard");
  assert.equal(released.fire.held, false);
  assert.equal(released.fire.pressed, false);

  const resting = createPadReader();
  for (let frame = 0; frame < 20; frame += 1) {
    const sample = resting.step(fakePad({
      buttons: { [STD.RT]: 0.02 },
      pressed: { [STD.RT]: true },
    }), 16, "standard");
    assert.equal(sample.fire.held, false);
    assert.equal(sample.fire.pressed, false);
  }
});

test("LT grenade and A use are one edge per squeeze", () => {
  const reader = createPadReader();
  assert.equal(reader.step(fakePad({ buttons: { [STD.LT]: 0.8 } }), 16, "standard").grenade.pressed, true);
  assert.equal(reader.step(fakePad({ buttons: { [STD.LT]: 0.8 } }), 16, "standard").grenade.pressed, false);
  assert.equal(reader.step(fakePad({ buttons: { [STD.LT]: 0.2 } }), 16, "standard").grenade.pressed, false);
  assert.equal(reader.step(fakePad({ buttons: { [STD.LT]: 0.8 } }), 16, "standard").grenade.pressed, true);

  const use = createPadReader();
  let uses = 0;
  for (let frame = 0; frame < 10; frame += 1) {
    if (use.step(fakePad({ buttons: { [STD.A]: 1 } }), 16, "standard").use.pressed) uses += 1;
  }
  assert.equal(uses, 1);
  assert.equal(use.step(fakePad({ buttons: { [STD.A]: 0 } }), 16, "standard").use.pressed, false);
  assert.equal(use.step(fakePad({ buttons: { [STD.A]: 1 } }), 16, "standard").use.pressed, true);
});

test("Start toggles the menu once and Back toggles the map once", () => {
  const reader = createPadReader();
  assert.equal(reader.step(fakePad({ buttons: { [STD.START]: 1 } }), 16, "standard").menuToggle.pressed, true);
  assert.equal(reader.step(fakePad({ buttons: { [STD.START]: 1 } }), 16, "standard").menuToggle.pressed, false);
  assert.equal(reader.step(fakePad({ buttons: { [STD.BACK]: 1 } }), 16, "standard").mapToggle.pressed, true);
  assert.equal(reader.step(fakePad({ buttons: { [STD.BACK]: 1 } }), 16, "standard").mapToggle.pressed, false);
  assert.equal(gamepadBindings("standard").fire, STD.RT);
  assert.equal(gamepadBindings("standard").grenade, STD.LT);
  assert.equal(gamepadBindings("jumper-t").fire, undefined);
});

test("D-pad down repeats on press, after 350 ms, then every 120 ms", () => {
  const nav = new RepeatNav();
  const direct: number[] = [];
  for (let elapsed = 0; elapsed <= 1000; elapsed += 16) {
    const dir = nav.step(1, elapsed === 0 ? 0 : 16);
    if (dir !== 0) direct.push(elapsed);
  }
  assert.equal(direct.length, 1 + Math.floor((1000 - 350) / 120) + 1);
  assert.equal(direct.length, 7);
  assert.equal(direct[0], 0);
  assert.ok(direct[1]! >= 350 && direct[1]! < 350 + 16, String(direct));
  for (let index = 2; index < direct.length; index += 1) {
    const gap = direct[index]! - direct[index - 1]!;
    assert.ok(gap >= 120 - 16 && gap <= 120 + 16, String(direct));
  }

  const reader = createPadReader();
  const times: number[] = [];
  const held = fakePad({ buttons: { [STD.DOWN]: 1 } });
  for (let elapsed = 0; elapsed <= 1000; elapsed += 16) {
    const sample = reader.step(held, elapsed === 0 ? 0 : 16, "standard");
    if (sample.nav !== 0) {
      assert.equal(sample.nav, 1);
      times.push(elapsed);
    }
  }
  assert.deepEqual(times, direct);
});

test("menu stick nav latches between 0.6 and 0.3", () => {
  const reader = createPadReader();
  assert.equal(reader.step(fakePad({ axes: [0, -0.7, 0, 0] }), 16, "standard", true).nav, -1);
  assert.equal(reader.step(fakePad({ axes: [0, -0.4, 0, 0] }), 16, "standard", true).nav, 0);
  assert.equal(reader.step(fakePad({ axes: [0, -0.4, 0, 0] }), 400, "standard", true).nav, -1);
  assert.equal(reader.step(fakePad({ axes: [0, 0.2, 0, 0] }), 400, "standard", true).nav, 0);
  assert.equal(createPadReader().step(fakePad({ axes: [0, -0.4, 0, 0] }), 400, "standard", true).nav, 0);
  assert.equal(createPadReader().step(fakePad({ axes: [0, -0.7, 0, 0] }), 16, "standard").nav, 0);
});

test("an open menu suppresses play actions and jumper-t binds nothing", () => {
  const reader = createPadReader();
  const opened = reader.step(fakePad({ buttons: { [STD.RT]: 1, [STD.A]: 1, [STD.START]: 1 } }), 16, "standard", true);
  assert.equal(opened.fire.held, false);
  assert.equal(opened.use.pressed, false);
  assert.equal(opened.select.pressed, true);
  assert.equal(opened.menuToggle.pressed, true);
  assertQuiet(reader.step(fakePad({ buttons: { [STD.RT]: 1, [STD.A]: 1, [STD.LB]: 1 } }), 16, "jumper-t"));
  assertQuiet(reader.step(fakePad({ connected: false, buttons: { [STD.RT]: 1 } }), 16, "standard"));
});

test("reset clears a held trigger", () => {
  const reader = createPadReader();
  const hot = fakePad({ buttons: { [STD.RT]: 0.8 } });
  assert.equal(reader.step(hot, 16, "standard").fire.held, true);
  reader.reset();
  assertQuiet(reader.step(fakePad({ connected: false, buttons: { [STD.RT]: 0.8 } }), 16, "standard"));
  const again = reader.step(hot, 16, "standard");
  assert.equal(again.fire.held, true);
  assert.equal(again.fire.pressed, true);
});

type Listener = (ev: Record<string, unknown>) => void;

function installDom() {
  const listeners = new Map<string, Set<Listener>>();
  const windowTarget = {
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
      for (const fn of [...(listeners.get(type) ?? [])]) fn(ev);
    },
  };
  const documentListeners = new Map<string, Set<Listener>>();
  let focused = true;
  const dom = {
    addEventListener() {},
    removeEventListener() {},
    requestPointerLock() {
      return Promise.resolve();
    },
  };
  const document = {
    addEventListener(type: string, fn: Listener) {
      let set = documentListeners.get(type);
      if (!set) {
        set = new Set();
        documentListeners.set(type, set);
      }
      set.add(fn);
    },
    removeEventListener() {},
    hasFocus() {
      return focused;
    },
    get pointerLockElement() {
      return null;
    },
    body: { style: { cursor: "default" } },
  };
  const pads: Array<ReturnType<typeof livePad> | null> = [];
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
  };
  const root = globalThis as { window: unknown; document: unknown };
  root.window = windowTarget;
  root.document = document;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    writable: true,
    value: { getGamepads: () => pads },
  });
  const values = new Map<string, string>();
  return {
    dom: dom as unknown as HTMLElement,
    storage: {
      getItem(key: string) {
        return values.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        values.set(key, value);
      },
    },
    setPads(next: Array<ReturnType<typeof livePad> | null>) {
      pads.splice(0, pads.length, ...next);
    },
    blur() {
      windowTarget.dispatch("blur", {});
    },
    setFocused(next: boolean) {
      focused = next;
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

function livePad() {
  const buttons = Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 }));
  return {
    index: 0,
    connected: true,
    mapping: "standard",
    axes: [0, 0, 0, 0],
    buttons,
    id: "Logitech Gamepad F310 (STANDARD GAMEPAD Vendor: 046d Product: c21d)",
    timestamp: 0,
  };
}

test("a focused pad fires from RT without pointer lock and drops the hold on blur", () => {
  const rig = installDom();
  try {
    const pad = livePad();
    rig.setPads([pad]);
    let invert = false;
    let presses = 0;
    const menu: string[] = [];
    const input = attachPlayInput(rig.dom, rig.storage, () => {
      presses += 1;
    }, () => invert);
    input.onPadMenu((ev) => {
      menu.push(ev);
    });
    assert.equal(input.locked, false);

    pad.buttons[STD.RT]!.value = 0.6;
    input.update(1 / 60);
    assert.equal(input.padStatus?.mapping, "standard");
    assert.match(input.padStatus?.id ?? "", /F310/);
    const fired = input.sample();
    assert.equal(fired.firing, true);
    assert.equal(presses, 1);
    assert.equal(input.sample().firing, true);
    assert.equal(presses, 1);

    pad.axes[1] = -1;
    input.setMenuOpen(true);
    input.update(1 / 60);
    assert.equal(input.sample().firing, false);
    assert.equal(input.sample().forward, 0);
    assert.deepEqual(menu, ["up"]);
    pad.axes[1] = 0;
    input.setMenuOpen(false);
    input.update(1 / 60);
    assert.equal(input.sample().firing, true);
    assert.equal(presses, 1);

    rig.blur();
    assert.equal(input.sample().firing, false);
    rig.setFocused(false);
    input.update(1 / 60);
    assert.equal(input.sample().firing, false);
    assert.equal(presses, 1);
    rig.setFocused(true);
    input.update(1 / 60);
    assert.equal(input.sample().firing, true);
    assert.equal(presses, 2);

    pad.axes = [0, 0, 0, -1];
    input.update(0.2);
    const lookedUp = input.sample().pitch;
    assert.ok(lookedUp > 0);
    invert = true;
    input.update(0.2);
    assert.ok(Math.abs(input.sample().pitch) < 1e-6);

    pad.buttons[STD.UP]!.pressed = true;
    pad.buttons[STD.UP]!.value = 1;
    input.update(1 / 60);
    assert.equal(input.sample().cabNav, 1);

    pad.buttons[STD.START]!.pressed = true;
    pad.buttons[STD.START]!.value = 1;
    input.update(1 / 60);
    assert.deepEqual(menu, ["up", "toggle"]);

    pad.connected = false;
    pad.buttons[STD.RT]!.value = 1;
    input.update(1 / 60);
    assert.equal(input.sample().firing, false);
    assert.equal(input.padStatus, null);

    rig.storage.setItem(GAMEPAD_PROFILE_STORAGE_KEY, "jumper-t");
    const radio = attachPlayInput(rig.dom, rig.storage);
    const radioPad = livePad();
    radioPad.buttons[STD.RT]!.value = 1;
    rig.setPads([radioPad]);
    radio.update(1 / 60);
    assert.equal(radio.sample().firing, false);
    assert.equal(radio.profile, "jumper-t");
  } finally {
    rig.restore();
  }
});
