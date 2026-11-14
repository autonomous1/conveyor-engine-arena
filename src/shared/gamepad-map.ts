/**
 * Standard-mapping gamepad buttons for the arena client.
 * Triggers use analog values with hysteresis. Digital buttons use edges.
 * @why `jumper-t` and a disconnected pad bind nothing. This module does not read
 *      the DOM and does not change the 20 Hz input message.
 */
// ARCHITECTURE: Standard-mapping pad buttons, edges, and repeat navigation.
// Wiring: client/input.ts reads it.

export const STD = {
  A: 0,
  B: 1,
  X: 2,
  Y: 3,
  LB: 4,
  RB: 5,
  LT: 6,
  RT: 7,
  BACK: 8,
  START: 9,
  L3: 10,
  R3: 11,
  UP: 12,
  DOWN: 13,
  LEFT: 14,
  RIGHT: 15,
} as const;

const TRIGGER_ON = 0.55;
const TRIGGER_OFF = 0.35;
const STICK_ON = 0.6;
const STICK_OFF = 0.3;
const REPEAT_DELAY_MS = 350;
const REPEAT_INTERVAL_MS = 120;

export type PadFrame = {
  connected: boolean;
  mapping: string;
  buttons: { pressed: boolean; value: number }[];
  axes: number[];
};

export type PadEdge = { held: boolean; pressed: boolean };

export type PadActions = {
  fire: PadEdge;
  grenade: PadEdge;
  use: PadEdge;
  callLanding: PadEdge;
  /** Y, one edge per press. Inspects the crosshair. Not sent to the host. */
  info: PadEdge;
  ascend: -1 | 0 | 1;
  menuToggle: PadEdge;
  mapToggle: PadEdge;
  back: PadEdge;
  select: PadEdge;
  /** −1 is up / previous row. +1 is down / next row. */
  nav: -1 | 0 | 1;
  /** −1 is left. +1 is right. Menu only. */
  navX: -1 | 0 | 1;
};

type Dir = -1 | 0 | 1;

export class TriggerLatch {
  private down = false;
  private readonly on: number;
  private readonly off: number;

  constructor(on = TRIGGER_ON, off = TRIGGER_OFF) {
    this.on = on;
    this.off = off;
  }

  step(value: number): PadEdge {
    const sample = typeof value === "number" && Number.isFinite(value) ? value : 0;
    const was = this.down;
    if (this.down) {
      if (sample <= this.off) this.down = false;
    } else if (sample >= this.on) {
      this.down = true;
    }
    return { held: this.down, pressed: this.down && !was };
  }

  reset(): void {
    this.down = false;
  }
}

export class ButtonEdge {
  private down = false;

  step(down: boolean): PadEdge {
    const was = this.down;
    this.down = down === true;
    return { held: this.down, pressed: this.down && !was };
  }

  reset(): void {
    this.down = false;
  }
}

/**
 * First step on the press frame, then one after 350 ms, then one every 120 ms.
 * A zero direction resets the hold.
 * @post A large `dtMs` still emits one step per call.
 */
export class RepeatNav {
  private dir: Dir = 0;
  private heldMs = 0;
  private emitted = 0;

  step(dir: Dir, dtMs: number): Dir {
    if (dir !== -1 && dir !== 1) {
      this.reset();
      return 0;
    }
    if (dir !== this.dir) {
      this.dir = dir;
      this.heldMs = 0;
      this.emitted = 1;
      return dir;
    }
    const dt = typeof dtMs === "number" && Number.isFinite(dtMs) && dtMs > 0 ? dtMs : 0;
    this.heldMs += dt;
    const due = this.heldMs >= REPEAT_DELAY_MS
      ? 2 + Math.floor((this.heldMs - REPEAT_DELAY_MS) / REPEAT_INTERVAL_MS)
      : 1;
    if (due > this.emitted) {
      this.emitted += 1;
      return dir;
    }
    return 0;
  }

  reset(): void {
    this.dir = 0;
    this.heldMs = 0;
    this.emitted = 0;
  }
}

class StickLatch {
  private dir: Dir = 0;

  step(value: number): Dir {
    const sample = typeof value === "number" && Number.isFinite(value) ? value : 0;
    if (this.dir === 0) {
      if (sample <= -STICK_ON) this.dir = -1;
      else if (sample >= STICK_ON) this.dir = 1;
    } else if (this.dir === -1) {
      if (sample >= -STICK_OFF) this.dir = sample >= STICK_ON ? 1 : 0;
    } else if (sample <= STICK_OFF) {
      this.dir = sample <= -STICK_ON ? -1 : 0;
    }
    return this.dir;
  }

  reset(): void {
    this.dir = 0;
  }
}

function quietEdge(): PadEdge {
  return { held: false, pressed: false };
}

function idleActions(): PadActions {
  return {
    fire: quietEdge(),
    grenade: quietEdge(),
    use: quietEdge(),
    callLanding: quietEdge(),
    info: quietEdge(),
    ascend: 0,
    menuToggle: quietEdge(),
    mapToggle: quietEdge(),
    back: quietEdge(),
    select: quietEdge(),
    nav: 0,
    navX: 0,
  };
}

function buttonDown(frame: PadFrame, index: number): boolean {
  const button = frame.buttons[index];
  if (!button) return false;
  if (button.pressed === true) return true;
  return typeof button.value === "number" && Number.isFinite(button.value) && button.value >= 0.5;
}

function triggerValue(frame: PadFrame, index: number): number {
  const button = frame.buttons[index];
  if (!button || typeof button.value !== "number" || !Number.isFinite(button.value)) return 0;
  return button.value;
}

function axisValue(frame: PadFrame, index: number): number {
  const value = frame.axes[index];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function dpadY(frame: PadFrame): Dir {
  const up = buttonDown(frame, STD.UP);
  const down = buttonDown(frame, STD.DOWN);
  if (up === down) return 0;
  return up ? -1 : 1;
}

function dpadX(frame: PadFrame): Dir {
  const left = buttonDown(frame, STD.LEFT);
  const right = buttonDown(frame, STD.RIGHT);
  if (left === right) return 0;
  return left ? -1 : 1;
}

function shoulders(frame: PadFrame): Dir {
  const descend = buttonDown(frame, STD.LB);
  const ascend = buttonDown(frame, STD.RB);
  if (descend === ascend) return 0;
  return ascend ? 1 : -1;
}

export type PadReader = {
  step(frame: PadFrame, dtMs: number, profile: string, menu?: boolean): PadActions;
  reset(): void;
};

export function createPadReader(): PadReader {
  const fire = new TriggerLatch();
  const grenade = new TriggerLatch();
  const use = new ButtonEdge();
  const back = new ButtonEdge();
  const callLanding = new ButtonEdge();
  const info = new ButtonEdge();
  const menuToggle = new ButtonEdge();
  const mapToggle = new ButtonEdge();
  const navY = new RepeatNav();
  const navX = new RepeatNav();
  const stickY = new StickLatch();

  const reset = () => {
    fire.reset();
    grenade.reset();
    use.reset();
    back.reset();
    callLanding.reset();
    info.reset();
    menuToggle.reset();
    mapToggle.reset();
    navY.reset();
    navX.reset();
    stickY.reset();
  };

  return {
    reset,
    step(frame, dtMs, profile, menu = false) {
      if (!frame.connected || profile !== "standard") {
        reset();
        return idleActions();
      }
      const fired = fire.step(triggerValue(frame, STD.RT));
      const thrown = grenade.step(triggerValue(frame, STD.LT));
      const confirm = use.step(buttonDown(frame, STD.A));
      const cancel = back.step(buttonDown(frame, STD.B));
      const call = callLanding.step(buttonDown(frame, STD.X));
      const inspect = info.step(buttonDown(frame, STD.Y));
      const start = menuToggle.step(buttonDown(frame, STD.START));
      const select = mapToggle.step(buttonDown(frame, STD.BACK));
      const stick = menu ? stickY.step(axisValue(frame, 1)) : (stickY.reset(), 0);
      const padY = dpadY(frame);
      const yDir: Dir = padY !== 0 ? padY : (menu ? stick : 0);
      const xDir: Dir = menu ? dpadX(frame) : 0;
      const quiet = quietEdge();
      return {
        fire: menu ? quiet : fired,
        grenade: menu ? quietEdge() : thrown,
        use: menu ? quietEdge() : confirm,
        select: menu ? confirm : quietEdge(),
        callLanding: menu ? quietEdge() : call,
        info: menu ? quietEdge() : inspect,
        back: menu ? cancel : quietEdge(),
        menuToggle: start,
        mapToggle: select,
        ascend: menu ? 0 : shoulders(frame),
        nav: navY.step(yDir, dtMs),
        navX: navX.step(xDir, dtMs),
      };
    },
  };
}
