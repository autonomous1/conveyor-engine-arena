import type { PerspectiveCamera, WebGLRenderer } from "three";
import { FirstPersonControls } from "three/addons/controls/FirstPersonControls.js";
import { GAMEPAD_AXIS, GamepadFirstPersonControls } from "three-gamepad-controls";

class ArenaGamepad extends GamepadFirstPersonControls {
  constructor(controls: FirstPersonControls) {
    super(controls, {
      moveStick: { xAxis: GAMEPAD_AXIS.RightY, yAxis: GAMEPAD_AXIS.RightX },
      lookStick: { xAxis: GAMEPAD_AXIS.LeftX, yAxis: GAMEPAD_AXIS.LeftY },
    });
    const original = this.gamepadInput.stick.bind(this.gamepadInput);
    this.gamepadInput.stick = (xAxis, yAxis, pipeline) => {
      const sample = original(xAxis, yAxis, pipeline);
      if (yAxis === GAMEPAD_AXIS.RightX) return { x: -sample.x, y: -sample.y };
      return sample;
    };
  }
}

/** Camera fly + gamepad. Pawn intent is not sent from here yet. */
export function attachCameraControls(camera: PerspectiveCamera, renderer: WebGLRenderer) {
  const firstPerson = new FirstPersonControls(camera, renderer.domElement);
  firstPerson.movementSpeed = 5;
  firstPerson.lookSpeed = 0.005;
  const gamepad = new ArenaGamepad(firstPerson);
  return {
    update(dt: number) {
      gamepad.update(dt);
      firstPerson.update(dt);
    },
  };
}
