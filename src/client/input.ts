import { GamepadInput } from "three-gamepad-controls";
import {
  type GamepadProfileName,
  type ProfileStorage,
  clampPitch,
  gamepadFireButton,
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
 * Click requests pointer lock once. It does not fire, and it does not
 * request the lock again while this element already holds it.
 * F fires while the pointer is locked. F does not change the gamepad profile.
 * A gamepad fire button is included only when that profile already binds one.
 */

export type PlaySample = {
  forward: number;
  strafe: number;
  yaw: number;
  pitch: number;
  /** F is down while locked, or a tap landed since the previous sample. */
  firing: boolean;
};

export type PlayInput = {
  update(dt: number): void;
  sample(): PlaySample;
  setYaw(yaw: number): void;
  toggleProfile(): void;
  readonly locked: boolean;
  readonly profile: GamepadProfileName;
};

function browserProfileStorage(): ProfileStorage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

export function attachPlayInput(
  dom: HTMLElement,
  storage: ProfileStorage | null = browserProfileStorage(),
  onFirePress: () => void = () => {},
): PlayInput {
  const keys = new Set<string>();
  let yaw = 0;
  let pitch = 0;
  let locked = false;
  let fireDown = false;
  let fireQueued = false;
  let profile = loadGamepadProfile(storage);
  const pad = new GamepadInput();

  const persist = (next: GamepadProfileName) => {
    profile = next;
    saveGamepadProfile(storage, next);
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
    }
    document.body.style.cursor = locked ? "none" : "default";
  };
  const onClick = () => {
    if (document.pointerLockElement === dom) return;
    const pending = dom.requestPointerLock();
    void Promise.resolve(pending).catch(() => {});
  };
  const onBlur = () => {
    fireDown = false;
    fireQueued = false;
  };

  window.addEventListener("keydown", down);
  window.addEventListener("keyup", up);
  window.addEventListener("blur", onBlur);
  document.addEventListener("mousemove", onMouse);
  document.addEventListener("pointerlockchange", onLock);
  dom.addEventListener("click", onClick);

  return {
    get locked() {
      return locked;
    },
    get profile() {
      return profile;
    },
    toggleProfile() {
      persist(nextGamepadProfile(profile));
    },
    setYaw(next: number) {
      yaw = next;
    },
    update(dt: number) {
      pad.update();
      if (!pad.connected) return;
      const look = gamepadLook(profile, readDeadzonedAxes(pad), dt);
      yaw += look.yaw;
      pitch = clampPitch(pitch + look.pitch);
    },
    sample() {
      const move = sampleMove(profile, keys, {
        connected: pad.connected,
        axes: pad.connected ? readDeadzonedAxes(pad) : [],
      });
      const button = gamepadFireButton(profile);
      const padFire = button !== undefined && pad.connected && pad.isPressed(button);
      const firing = (document.pointerLockElement === dom && (fireDown || fireQueued)) || padFire;
      fireQueued = false;
      return { forward: move.forward, strafe: move.strafe, yaw, pitch, firing };
    },
  };
}

/**
 * Default `GamepadInput.stick` pipeline: axial deadzone 0.1, no rescale.
 * Pair order does not matter for that axial deadzone. Returned order is
 * axis 0, 1, 2, 3.
 */
function readDeadzonedAxes(pad: GamepadInput): number[] {
  const left = pad.stick(0, 1);
  const right = pad.stick(2, 3);
  return [left.x, left.y, right.x, right.y];
}
