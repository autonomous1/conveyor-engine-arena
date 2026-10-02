import { GamepadInput } from "three-gamepad-controls";
import {
  axesFromStick,
  clampPitch,
  JUMPER_LOOK_X,
  JUMPER_LOOK_Y,
  JUMPER_MOVE_X,
  JUMPER_MOVE_Y,
  jumperStick,
  lookFromMouse,
  lookFromStick,
} from "../shared/look.js";

/**
 * Jumper-T gamepad, read through `three-gamepad-controls` `GamepadInput`.
 * Triggers are unbound: this loop does not fly or jump.
 *
 * | Control | Hardware axis | After the old remap |
 * | --- | --- | --- |
 * | Move horizontal | RightY (3) | Negated, then strafe |
 * | Move vertical | RightX (2) | Negated, then forward along look |
 * | Look yaw | LeftX (0) | Unchanged |
 * | Look pitch | LeftY (1) | Unchanged |
 */

const LOOK_YAW_RATE = 2.4;
const LOOK_PITCH_RATE = 1.8;

export type PlaySample = {
  forward: number;
  strafe: number;
  yaw: number;
  pitch: number;
};

export type PlayInput = {
  update(dt: number): void;
  sample(): PlaySample;
  setYaw(yaw: number): void;
  readonly locked: boolean;
};

export function attachPlayInput(dom: HTMLElement): PlayInput {
  const keys = new Set<string>();
  let yaw = 0;
  let pitch = 0;
  let locked = false;
  const pad = new GamepadInput();

  const onKey = (ev: KeyboardEvent, down: boolean) => {
    if (ev.repeat) return;
    if (!["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(ev.code)) return;
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
    document.body.style.cursor = locked ? "none" : "default";
  };
  const onClick = () => {
    const pending = dom.requestPointerLock();
    void Promise.resolve(pending).catch(() => {});
  };

  window.addEventListener("keydown", down);
  window.addEventListener("keyup", up);
  document.addEventListener("mousemove", onMouse);
  document.addEventListener("pointerlockchange", onLock);
  dom.addEventListener("click", onClick);

  return {
    get locked() {
      return locked;
    },
    setYaw(next: number) {
      yaw = next;
    },
    update(dt: number) {
      pad.update();
      if (!pad.connected) return;
      const look = jumperStick(JUMPER_LOOK_Y, pad.stick(JUMPER_LOOK_X, JUMPER_LOOK_Y));
      const delta = lookFromStick(look.x, look.y, dt, LOOK_YAW_RATE, LOOK_PITCH_RATE);
      yaw += delta.yaw;
      pitch = clampPitch(pitch + delta.pitch);
    },
    sample() {
      let forward = (keys.has("KeyW") || keys.has("ArrowUp") ? 1 : 0) - (keys.has("KeyS") || keys.has("ArrowDown") ? 1 : 0);
      let strafe = (keys.has("KeyD") || keys.has("ArrowRight") ? 1 : 0) - (keys.has("KeyA") || keys.has("ArrowLeft") ? 1 : 0);
      if (pad.connected) {
        const move = axesFromStick(...stickPair(pad));
        forward += move.forward;
        strafe += move.strafe;
      }
      return { forward, strafe, yaw, pitch };
    },
  };
}

function stickPair(pad: GamepadInput): [number, number] {
  const stick = jumperStick(JUMPER_MOVE_Y, pad.stick(JUMPER_MOVE_X, JUMPER_MOVE_Y));
  return [stick.x, stick.y];
}
