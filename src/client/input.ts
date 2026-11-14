// ARCHITECTURE: Keyboard, mouse, pointer-lock, and gamepad input for one play
//   session, sampled once per frame; also the menu-open gate.
// Wiring: boot.ts calls `attachPlayInput` on the renderer canvas and reads
//   `update`/`sample` each frame; `onPadMenu` routes pad menu events.
// Order: listeners are attached once at creation; the frame must call `update`
//   before `sample`.
// Invariants: The nine window/document listeners are attached once and never
//   removed; the page is expected to outlive the socket.
import { GamepadInput } from "three-gamepad-controls";
import { createPadReader, type PadFrame, type PadActions } from "../shared/gamepad-map.ts";
import {
  type GamepadProfileName,
  type ProfileStorage,
  clampPitch,
  gamepadLook,
  isMoveKey,
  loadGamepadProfile,
  lookFromMouse,
  nextGamepadProfile,
  sampleMove,
  saveGamepadProfile,
} from "../shared/look.ts";

/**
 * Keyboard, mouse, and one `three-gamepad-controls` `GamepadInput`.
 * The active profile (`standard` or `jumper-t`) is read on each sample.
 * Primary mousedown requests pointer lock once and cancels that gesture so
 * the click cannot navigate or submit a form. It does not fire, and it does
 * not request the lock again while this element already holds it.
 * F fires while the pointer is locked. F does not change the gamepad profile.
 * P throws a grenade on the same lock. P does not fire. F does not throw.
 * E uses the door the pawn is overlapping. E does not fire and does not throw.
 * Digit0–Digit9 and Numpad0–Numpad9 call an elevator floor while the pointer
 * is locked. A repeat does not call again. They do not fire or use a door.
 * Space ascends and Control descends. Both are held, like WASD, and do not fire.
 *
 * A standard pad (F310 switch on X) does not need pointer lock. It does need
 * window focus, and gameplay actions pause while the options panel is open.
 * RT fires (held). LT throws one grenade per squeeze. A uses a door and, when
 * no door overlaps, confirms a cab stop or calls a landing. X calls a landing.
 * LB descends and RB ascends (noclip only; the host flag still gates the send).
 * Back toggles the scene map. Start toggles options. D-pad up raises the cab
 * pick; D-pad down lowers it. In the options panel, D-pad and the left stick
 * move the highlight, A toggles the row, and B closes the panel.
 * I, or Y on a standard pad, inspects the crosshair once per press. A hold
 * does not repeat. Menus and text fields swallow it. It is not a wire bit.
 * `jumper-t` keeps its sticks and binds no buttons.
 * The 20 Hz message is still `{ moveX, moveZ, yaw, buttons, seq, entity }`.
 */

export type PlaySample = {
  forward: number;
  strafe: number;
  yaw: number;
  pitch: number;
  /** F is down while locked, or RT is held, or a tap landed since the previous sample. */
  firing: boolean;
  /** P or an LT squeeze landed since the previous sample. */
  grenade: boolean;
  /** E or A was pressed once. A hold does not repeat. */
  using: boolean;
  /** Digit or numpad code pressed once while locked. Absent when none. */
  digit?: string;
  /** Space or RB is +1, Control or LB is -1, both or neither is 0. Keyboard wins. */
  ascend: -1 | 0 | 1;
  /** D-pad up is +1 (higher cab stop). One step, including repeat. */
  cabNav: -1 | 0 | 1;
  /** A was pressed once. Main prefers a door, then a cab confirm, then a landing. */
  cabConfirm: boolean;
  /** X was pressed once. Calls the landing the pawn is standing on. */
  callLanding: boolean;
  /** I or Y was pressed once. Local inspect. A hold does not repeat. Not sent. */
  info: boolean;
};

/** Space up, Control down. Both held cancel. */
export function ascendFromKeys(held: { has(code: string): boolean }): -1 | 0 | 1 {
  const up = held.has("Space");
  const down = held.has("ControlLeft") || held.has("ControlRight");
  if (up === down) return 0;
  return up ? 1 : -1;
}

export type PadStatus = { readonly id: string; readonly mapping: string };

export type PadMenuEvent = "toggle" | "map" | "back" | "select" | "up" | "down" | "left" | "right";

export type PlayInput = {
  update(dt: number): void;
  sample(): PlaySample;
  setYaw(yaw: number): void;
  toggleProfile(): void;
  setMenuOpen(open: boolean): void;
  onPadMenu(handler: (ev: PadMenuEvent) => void): void;
  readonly locked: boolean;
  readonly profile: GamepadProfileName;
  readonly padStatus: PadStatus | null;
};

function browserProfileStorage(): ProfileStorage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

function pageFocused(): boolean {
  try {
    const doc = globalThis.document as { hasFocus?: () => boolean } | undefined;
    if (!doc || typeof doc.hasFocus !== "function") return true;
    return doc.hasFocus();
  } catch {
    return true;
  }
}

/** Up on the pad is nav −1. Cab stops count the other way, so up is +1. */
function cabDelta(nav: -1 | 0 | 1): -1 | 0 | 1 {
  if (nav === -1) return 1;
  if (nav === 1) return -1;
  return 0;
}

function frameFromGamepad(gamepad: Gamepad | null): PadFrame {
  if (!gamepad || gamepad.connected !== true) {
    return { connected: false, mapping: "", buttons: [], axes: [] };
  }
  const buttons: PadFrame["buttons"] = [];
  for (const button of gamepad.buttons) {
    const value = typeof button?.value === "number" && Number.isFinite(button.value) ? button.value : 0;
    buttons.push({ pressed: button?.pressed === true, value });
  }
  const axes: number[] = [];
  for (const axis of gamepad.axes) axes.push(typeof axis === "number" && Number.isFinite(axis) ? axis : 0);
  return {
    connected: true,
    mapping: typeof gamepad.mapping === "string" ? gamepad.mapping : "",
    buttons,
    axes,
  };
}

export function attachPlayInput(
  dom: HTMLElement,
  storage: ProfileStorage | null = browserProfileStorage(),
  onFirePress: () => void = () => {},
  getInvertY: () => boolean = () => false,
  getMenuOpen: () => boolean = () => false,
  requestLock = true,
): PlayInput {
  const keys = new Set<string>();
  let yaw = 0;
  let pitch = 0;
  let locked = false;
  let fireDown = false;
  let fireQueued = false;
  let grenadeDown = false;
  let grenadeQueued = false;
  let useQueued = false;
  let digitQueued: string | undefined;
  let profile = loadGamepadProfile(storage);
  let menuOpen = false;
  let padFireHeld = false;
  let padFireQueued = false;
  let padGrenadeQueued = false;
  let padUseQueued = false;
  let padCabConfirmQueued = false;
  let padCallQueued = false;
  let keyInfoQueued = false;
  let padInfoQueued = false;
  let padAscend: -1 | 0 | 1 = 0;
  let padCabNav: -1 | 0 | 1 = 0;
  let sticksLive = false;
  let padStatus: PadStatus | null = null;
  let padIndex: number | null = null;
  let onMenu: (ev: PadMenuEvent) => void = () => {};
  const pad = new GamepadInput();
  const padReader = createPadReader();

  const menuIsOpen = () => menuOpen || getMenuOpen();

  const persist = (next: GamepadProfileName) => {
    if (next !== profile) padInfoQueued = false;
    profile = next;
    saveGamepadProfile(storage, next);
  };

  const clearPadGameplay = () => {
    padFireHeld = false;
    padFireQueued = false;
    padGrenadeQueued = false;
    padUseQueued = false;
    padCabConfirmQueued = false;
    padCallQueued = false;
    padInfoQueued = false;
    padAscend = 0;
    padCabNav = 0;
  };

  const releasePad = () => {
    padReader.reset();
    clearPadGameplay();
    sticksLive = false;
  };

  const dropPad = () => {
    releasePad();
    padStatus = null;
    padIndex = null;
  };

  const notePad = (gamepad: Gamepad) => {
    const mapping = typeof gamepad.mapping === "string" ? gamepad.mapping : "";
    const next = { id: gamepad.id, mapping };
    if (!padStatus || padStatus.id !== next.id || padStatus.mapping !== next.mapping) {
      console.info("gamepad", next.id, next.mapping);
    }
    padStatus = next;
    padIndex = gamepad.index;
  };

  const applyActions = (actions: PadActions) => {
    if (actions.fire.pressed) {
      padFireQueued = true;
      onFirePress();
    }
    padFireHeld = actions.fire.held;
    if (actions.grenade.pressed) padGrenadeQueued = true;
    if (actions.use.pressed) {
      padUseQueued = true;
      padCabConfirmQueued = true;
    }
    if (actions.callLanding.pressed) padCallQueued = true;
    if (actions.info.pressed) padInfoQueued = true;
    padAscend = actions.ascend;
    if (actions.nav !== 0) padCabNav = cabDelta(actions.nav);
  };

  const emitMenu = (actions: PadActions, menu: boolean) => {
    if (actions.menuToggle.pressed) onMenu("toggle");
    if (actions.mapToggle.pressed) onMenu("map");
    if (!menu) return;
    if (actions.back.pressed) onMenu("back");
    if (actions.select.pressed) onMenu("select");
    if (actions.nav < 0) onMenu("up");
    if (actions.nav > 0) onMenu("down");
    if (actions.navX < 0) onMenu("left");
    if (actions.navX > 0) onMenu("right");
  };

  const onKey = (ev: KeyboardEvent, down: boolean) => {
    if (ev.code === "KeyF") {
      if (!down) {
        fireDown = false;
        return;
      }
      // F10 switches profiles. F must not. Repeats are not extra presses.
      if (ev.repeat || document.pointerLockElement !== dom) return;
      fireDown = true;
      fireQueued = true;
      onFirePress();
      return;
    }
    if (ev.code === "KeyP") {
      if (!down) {
        grenadeDown = false;
        return;
      }
      if (ev.repeat || document.pointerLockElement !== dom) return;
      grenadeDown = true;
      grenadeQueued = true;
      return;
    }
    if (ev.code === "KeyE") {
      if (!down) return;
      if (ev.repeat || document.pointerLockElement !== dom) return;
      useQueued = true;
      return;
    }
    if (ev.code === "KeyI") {
      if (!down) return;
      if (ev.repeat || menuIsOpen() || isEditable(ev.target) || isEditable(document.activeElement)) return;
      if (document.pointerLockElement !== dom) return;
      keyInfoQueued = true;
      return;
    }
    if (/^(?:Digit|Numpad)[0-9]$/.test(ev.code)) {
      if (!down) return;
      if (ev.repeat || document.pointerLockElement !== dom) return;
      digitQueued = ev.code;
      return;
    }
    if (ev.code === "Space" || ev.code === "ControlLeft" || ev.code === "ControlRight") {
      if (ev.repeat) return;
      ev.preventDefault();
      if (down) keys.add(ev.code);
      else keys.delete(ev.code);
      return;
    }
    if (ev.repeat) return;
    if (down && ev.code === "F10") {
      ev.preventDefault();
      persist(nextGamepadProfile(profile));
      return;
    }
    if (!isMoveKey(ev.code)) return;
    ev.preventDefault();
    if (down) keys.add(ev.code);
    else keys.delete(ev.code);
  };
  const down = (ev: KeyboardEvent) => onKey(ev, true);
  const up = (ev: KeyboardEvent) => onKey(ev, false);
  const onMouse = (ev: MouseEvent) => {
    if (document.pointerLockElement !== dom) return;
    const look = lookFromMouse(ev.movementX, ev.movementY);
    yaw += look.yaw;
    pitch = clampPitch(pitch + look.pitch);
  };
  const onLock = () => {
    locked = document.pointerLockElement === dom;
    if (!locked) {
      fireDown = false;
      fireQueued = false;
      grenadeDown = false;
      grenadeQueued = false;
      useQueued = false;
      digitQueued = undefined;
      keyInfoQueued = false;
    }
    document.body.style.cursor = locked ? "none" : "default";
  };
  const onMouseDown = (ev: MouseEvent) => {
    // Primary only. This gesture locks the pointer. It is not fire.
    if (ev.button !== 0) return;
    // Cancel the click default before it can follow a link or submit a form.
    ev.preventDefault();
    if (!requestLock || document.pointerLockElement === dom) return;
    const pending = dom.requestPointerLock();
    void Promise.resolve(pending).catch(() => {});
  };
  const onClick = (ev: MouseEvent) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
  };
  const onBlur = () => {
    fireDown = false;
    fireQueued = false;
    grenadeDown = false;
    grenadeQueued = false;
    useQueued = false;
    digitQueued = undefined;
    keyInfoQueued = false;
    releasePad();
  };
  const onPadConnected = (ev: Event) => {
    const gamepad = (ev as GamepadEvent).gamepad;
    if (!gamepad || gamepad.connected !== true) return;
    if (padIndex !== null && gamepad.index !== padIndex) return;
    notePad(gamepad);
  };
  const onPadDisconnected = (ev: Event) => {
    const gamepad = (ev as GamepadEvent).gamepad;
    if (padIndex !== null && gamepad && gamepad.index !== padIndex) return;
    dropPad();
  };

  window.addEventListener("keydown", down);
  window.addEventListener("keyup", up);
  window.addEventListener("blur", onBlur);
  window.addEventListener("gamepadconnected", onPadConnected);
  window.addEventListener("gamepaddisconnected", onPadDisconnected);
  document.addEventListener("mousemove", onMouse);
  document.addEventListener("pointerlockchange", onLock);
  dom.addEventListener("mousedown", onMouseDown);
  dom.addEventListener("click", onClick);

  return {
    get locked() {
      return locked;
    },
    get profile() {
      return profile;
    },
    get padStatus() {
      return padStatus;
    },
    toggleProfile() {
      persist(nextGamepadProfile(profile));
    },
    setMenuOpen(open: boolean) {
      menuOpen = open;
    },
    onPadMenu(handler: (ev: PadMenuEvent) => void) {
      onMenu = handler;
    },
    setYaw(next: number) {
      yaw = next;
    },
    update(dt: number) {
      pad.update();
      const raw = pad.rawGamepad;
      if (!raw || raw.connected !== true) {
        dropPad();
        return;
      }
      if (!pageFocused()) {
        releasePad();
        return;
      }
      notePad(raw);
      const menu = menuOpen;
      sticksLive = !menu;
      const actions = padReader.step(frameFromGamepad(raw), dt * 1000, profile, menu);
      if (sticksLive && profile === "standard") applyActions(actions);
      else clearPadGameplay();
      if (profile === "standard") emitMenu(actions, menu);
      if (!sticksLive) return;
      const look = gamepadLook(profile, readDeadzonedAxes(pad), dt, getInvertY());
      yaw += look.yaw;
      pitch = clampPitch(pitch + look.pitch);
    },
    sample() {
      const move = sampleMove(profile, keys, {
        connected: sticksLive && pad.connected,
        axes: sticksLive && pad.connected ? readDeadzonedAxes(pad) : [],
      });
      const keyAscend = ascendFromKeys(keys);
      const firing = (document.pointerLockElement === dom && (fireDown || fireQueued)) || padFireHeld || padFireQueued;
      const grenade = (document.pointerLockElement === dom && (grenadeDown || grenadeQueued)) || padGrenadeQueued;
      const using = (document.pointerLockElement === dom && useQueued) || padUseQueued;
      const digit = digitQueued;
      const cabNav = padCabNav;
      const cabConfirm = padCabConfirmQueued;
      const callLanding = padCallQueued;
      const info = !menuIsOpen() && (keyInfoQueued || padInfoQueued);
      fireQueued = false;
      grenadeQueued = false;
      useQueued = false;
      digitQueued = undefined;
      padFireQueued = false;
      padGrenadeQueued = false;
      padUseQueued = false;
      padCabConfirmQueued = false;
      padCallQueued = false;
      padInfoQueued = false;
      keyInfoQueued = false;
      padCabNav = 0;
      return {
        forward: move.forward,
        strafe: move.strafe,
        yaw,
        pitch,
        firing,
        grenade,
        using,
        ascend: keyAscend !== 0 ? keyAscend : padAscend,
        cabNav,
        cabConfirm,
        callLanding,
        info,
        ...(digit ? { digit } : {}),
      };
    },
  };
}

/**
 * Default `GamepadInput.stick` pipeline: axial deadzone 0.1, no rescale.
 * Pair order does not matter for that axial deadzone. Returned order is
 * axis 0, 1, 2, 3.
 */
function isEditable(target: EventTarget | null): boolean {
  if (!target || typeof target !== "object") return false;
  const el = target as { tagName?: string; isContentEditable?: boolean };
  const tag = typeof el.tagName === "string" ? el.tagName.toUpperCase() : "";
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return el.isContentEditable === true;
}

function readDeadzonedAxes(pad: GamepadInput): number[] {
  const left = pad.stick(0, 1);
  const right = pad.stick(2, 3);
  return [left.x, left.y, right.x, right.y];
}
