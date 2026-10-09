import assert from "node:assert/strict";
import test from "node:test";
import { attachPlayInput, type PlayInput } from "../src/client/input.ts";
import { startArenaServer } from "../dist/server/main.js";
import {
  advanceFireClock,
  FIRE_HZ,
  FIRE_INTERVAL_MS,
  fireFrame,
  parseFire,
  type FireFrame,
} from "../src/shared/hitscan.ts";
import { clampPitch, gamepadFireButton, lookFromMouse } from "../src/shared/look.ts";

/**
 * Click only locks the pointer. F sends one fire frame per press while that
 * lock is held, and a hold stays on the 8 Hz clock. The other client draws
 * a laser from that frame alone.
 */

type Listener = (ev: Record<string, unknown>) => void;

function createTarget() {
  const listeners = new Map<string, Set<Listener>>();
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
      const event = { preventDefault() {}, stopPropagation() {}, repeat: false, button: 0, ...ev };
      for (const fn of [...(listeners.get(type) ?? [])]) fn(event);
    },
  };
}

function pressedPad() {
  const buttons = Array.from({ length: 17 }, () => ({ pressed: true, touched: true, value: 1 }));
  return { index: 0, connected: true, mapping: "standard", axes: [0, 0, 0, 0], buttons, id: "test-pad", timestamp: 0 };
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

function installDom() {
  const windowTarget = createTarget();
  const documentTarget = createTarget();
  let pointerLockElement: object | null = null;
  let lockRequests = 0;
  const body = { style: { cursor: "default" } };
  const dom = Object.assign(createTarget(), {
    requestPointerLock() {
      lockRequests += 1;
      pointerLockElement = dom;
      documentTarget.dispatch("pointerlockchange", {});
      return Promise.resolve();
    },
  });
  const document = {
    addEventListener: documentTarget.addEventListener.bind(documentTarget),
    removeEventListener: documentTarget.removeEventListener.bind(documentTarget),
    get pointerLockElement() {
      return pointerLockElement;
    },
    body,
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
    dom: dom as unknown as HTMLElement,
    storage: memoryStorage(),
    get lockRequests() {
      return lockRequests;
    },
    cursor: () => body.style.cursor,
    click() {
      windowTarget.dispatch("mousedown", { button: 0 });
      windowTarget.dispatch("mouseup", { button: 0 });
      dom.dispatch("click", { button: 0 });
    },
    key(type: "keydown" | "keyup", code: string, repeat = false) {
      windowTarget.dispatch(type, { code, repeat });
    },
    move(movementX: number, movementY: number) {
      documentTarget.dispatch("mousemove", { movementX, movementY });
    },
    blur() {
      windowTarget.dispatch("blur", {});
    },
    unlock() {
      pointerLockElement = null;
      documentTarget.dispatch("pointerlockchange", {});
    },
  };
}

function drive(input: PlayInput) {
  let nextAt = 0;
  let seq = 0;
  return {
    at(now: number) {
      input.update(1 / 60);
      const sample = input.sample();
      const clock = advanceFireClock(sample.firing, now, nextAt);
      nextAt = clock.nextAt;
      const frame = clock.due ? fireFrame(++seq, sample.yaw, sample.pitch) : undefined;
      if (frame) assert.deepEqual(parseFire(frame), frame);
      return { sample, frame };
    },
  };
}

test("click locks the pointer and does not fire; F fires once and a hold stays at 8 Hz", () => {
  assert.equal(FIRE_HZ, 8);
  assert.equal(FIRE_INTERVAL_MS, 125);
  assert.equal(gamepadFireButton("standard"), undefined);
  assert.equal(gamepadFireButton("jumper-t"), undefined);

  const rig = installDom();
  const input = attachPlayInput(rig.dom, rig.storage);
  const play = drive(input);
  assert.equal(input.locked, false);
  assert.equal(input.profile, "standard");

  rig.click();
  assert.equal(rig.lockRequests, 1);
  assert.equal(input.locked, true);
  assert.equal(rig.cursor(), "none");
  const clicked = play.at(0);
  assert.equal(clicked.frame, undefined);
  assert.equal(clicked.sample.firing, false);

  rig.click();
  assert.equal(rig.lockRequests, 1);
  assert.equal(input.locked, true);
  const clickedAgain = play.at(32);
  assert.equal(clickedAgain.frame, undefined);
  assert.equal(clickedAgain.sample.firing, false);

  const before = clickedAgain.sample.yaw;
  rig.move(12, -3);
  const looked = play.at(40);
  const look = lookFromMouse(12, -3);
  assert.ok(looked.sample.yaw < before);
  assert.ok(Math.abs(looked.sample.yaw - look.yaw) < 1e-12);
  assert.ok(Math.abs(looked.sample.pitch - clampPitch(look.pitch)) < 1e-12);
  assert.equal(looked.frame, undefined);

  rig.key("keydown", "KeyW");
  const walked = play.at(48);
  assert.equal(walked.sample.forward, 1);
  assert.equal(walked.sample.strafe, 0);
  assert.equal(walked.frame, undefined);
  rig.key("keyup", "KeyW");
  assert.equal(play.at(56).sample.forward, 0);

  rig.key("keydown", "KeyF");
  rig.key("keydown", "KeyF", true);
  rig.key("keydown", "KeyF", true);
  rig.key("keyup", "KeyF");
  const fired = play.at(64);
  assert.ok(fired.frame);
  assert.deepEqual(fired.frame, fireFrame(1, looked.sample.yaw, looked.sample.pitch));
  assert.equal(input.profile, "standard");
  assert.equal(play.at(80).frame, undefined);
  assert.equal(play.at(64 + FIRE_INTERVAL_MS + 20).frame, undefined);

  rig.key("keydown", "F10");
  assert.equal(input.profile, "jumper-t");
  rig.key("keydown", "KeyF");
  assert.equal(input.profile, "jumper-t");
  rig.key("keyup", "KeyF");
  assert.equal(input.profile, "jumper-t");
  rig.key("keydown", "F10");
  assert.equal(input.profile, "standard");
  const afterToggle = play.at(400);
  assert.deepEqual(afterToggle.frame, fireFrame(2, looked.sample.yaw, looked.sample.pitch));

  rig.unlock();
  assert.equal(input.locked, false);
  assert.equal(rig.cursor(), "default");
  rig.key("keydown", "KeyF");
  rig.key("keyup", "KeyF");
  assert.equal(play.at(600).frame, undefined);
  rig.click();
  assert.equal(input.locked, true);
  assert.equal(rig.lockRequests, 2);
  assert.equal(play.at(700).frame, undefined);
  assert.equal(play.at(900).frame, undefined);

  rig.key("keydown", "KeyF");
  rig.blur();
  assert.equal(play.at(1000).frame, undefined);
  rig.key("keyup", "KeyF");

  const hold = installDom();
  const held = attachPlayInput(hold.dom, hold.storage);
  const clock = drive(held);
  hold.click();
  assert.equal(held.locked, true);
  assert.equal(held.profile, "standard");
  hold.key("keydown", "KeyF");
  const times: number[] = [];
  for (let i = 0; i < 60; i++) {
    const t = (i * 1000) / 60;
    hold.key("keydown", "KeyF", true);
    if (i === 10) hold.click();
    const shot = clock.at(t);
    if (!shot.frame) continue;
    assert.equal(shot.frame.t, "fire");
    assert.equal(shot.frame.v, 1);
    assert.equal(shot.frame.seq, times.length + 1);
    times.push(t);
  }
  assert.equal(times.length, FIRE_HZ);
  assert.equal(times[0], 0);
  for (let i = 1; i < times.length; i++) {
    const gap = times[i]! - times[i - 1]!;
    assert.ok(gap >= FIRE_INTERVAL_MS - 1e-9, `gap ${gap}`);
    assert.ok(gap < FIRE_INTERVAL_MS + 1000 / 60 + 1e-6, `gap ${gap}`);
  }
  assert.equal(hold.lockRequests, 1);
  assert.equal(held.locked, true);
  assert.equal(held.profile, "standard");

  hold.key("keyup", "KeyF");
  let t = 1000;
  const releaseEnd = 1000 + FIRE_INTERVAL_MS + 50;
  while (t < releaseEnd) {
    t += 1000 / 60;
    assert.equal(clock.at(t).frame, undefined);
  }
});

test("the other client sees the laser only after F, not after a click", async () => {
  const rig = installDom();
  const input = attachPlayInput(rig.dom, rig.storage);
  const play = drive(input);
  rig.click();
  assert.equal(input.locked, true);
  const clickFrames: FireFrame[] = [];
  const clicked = play.at(0);
  if (clicked.frame) clickFrames.push(clicked.frame);
  rig.click();
  const clickedAgain = play.at(20);
  if (clickedAgain.frame) clickFrames.push(clickedAgain.frame);
  assert.deepEqual(clickFrames, []);

  rig.move(8, 2);
  rig.key("keydown", "KeyF");
  rig.key("keyup", "KeyF");
  const fired = play.at(40);
  const frame = fired.frame;
  assert.ok(frame);
  assert.equal(frame.t, "fire");
  assert.equal(frame.v, 1);
  assert.equal(frame.seq, 1);
  assert.equal(frame.yaw, fired.sample.yaw);
  assert.equal(frame.pitch, fired.sample.pitch);
  assert.equal(input.profile, "standard");

  const host = await startArenaServer(0);
  let a: ReturnType<typeof openClient> | undefined;
  let b: ReturnType<typeof openClient> | undefined;
  try {
    const view = await (await fetch(host.url + "/arena.json")).json() as {
      world: string;
      bundleId: string;
      authoritativeHash: string;
    };
    a = openClient(host.url, view);
    const aw = await a.welcome;
    b = openClient(host.url, view);
    const bw = await b.welcome;
    assert.notEqual(aw.ownedEntityId, bw.ownedEntityId);
    await waitFor(2000, () => {
      const self = a!.poses.get(aw.ownedEntityId);
      const seen = b!.poses.get(aw.ownedEntityId);
      if (!self || !seen) return undefined;
      return self;
    });
    assert.equal(a.lasers.length, 0);
    assert.equal(b.lasers.length, 0);
    for (const extra of clickFrames) a.ws.send(JSON.stringify(extra));
    a.ws.send(JSON.stringify(frame));
    const laser = await waitFor(2000, () => b!.lasers[0]);
    await delay(FIRE_INTERVAL_MS);
    assert.equal(b.lasers.length, 1);
    assert.equal(a.lasers.length, 1);
    assert.equal(laser.shooter, aw.ownedEntityId);
    assert.equal(a.lasers[0]!.shooter, aw.ownedEntityId);
    assert.equal(a.errors.length, 0);
    assert.equal(b.errors.length, 0);
  } finally {
    a?.ws.close();
    b?.ws.close();
    await host.close();
  }
});

type Pose = { x: number; y: number; z: number };
type LaserMsg = { shooter: number; from: Pose; to: Pose; until: number };

function openClient(url: string, view: { world: string; bundleId: string; authoritativeHash: string }) {
  const lasers: LaserMsg[] = [];
  const errors: string[] = [];
  const poses = new Map<number, Pose>();
  const ws = new WebSocket(url.replace(/^http/, "ws"));
  const welcome = new Promise<{ clientId: number; ownedEntityId: number }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no welcome")), 3000);
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data)) as {
        t?: string;
        type?: string;
        reason?: string;
        clientId?: number;
        ownedEntityId?: number;
        envelope?: { spawns?: unknown[]; updates?: unknown[]; despawns?: unknown[] };
        shooter?: number;
        from?: Pose;
        to?: Pose;
        until?: number;
      };
      if (msg.t === "laser" && msg.from && msg.to && msg.shooter !== undefined && msg.until !== undefined) {
        lasers.push({ shooter: msg.shooter, from: msg.from, to: msg.to, until: msg.until });
        return;
      }
      if (msg.type === "error") errors.push(String(msg.reason ?? ""));
      if (msg.type === "reject") {
        clearTimeout(timer);
        reject(new Error(msg.reason ?? "reject"));
      }
      if (msg.type === "welcome") {
        clearTimeout(timer);
        resolve({ clientId: Number(msg.clientId), ownedEntityId: Number(msg.ownedEntityId) });
      }
      if (msg.type === "snapshot" && msg.envelope) absorb(poses, msg.envelope);
    });
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({
        v: 1,
        type: "hello",
        protocol: 1,
        world: view.world,
        bundleId: view.bundleId,
        authoritativeHash: view.authoritativeHash,
      }));
    });
  });
  return { ws, welcome, lasers, errors, poses };
}

function absorb(poses: Map<number, Pose>, envelope: { spawns?: unknown[]; updates?: unknown[]; despawns?: unknown[] }) {
  const rows = [...(envelope.spawns ?? []), ...(envelope.updates ?? [])] as Array<{ entity?: number; view?: { position?: Pose } }>;
  for (const row of rows) {
    const id = Number(row.entity);
    const position = row.view?.position;
    if (Number.isFinite(id) && position) poses.set(id, { x: position.x, y: position.y, z: position.z });
  }
  for (const row of envelope.despawns ?? []) {
    const id = Number((row as { entity?: number }).entity);
    if (Number.isFinite(id)) poses.delete(id);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitFor<T>(ms: number, read: () => T | undefined): Promise<T> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      const value = read();
      if (value !== undefined) {
        clearInterval(timer);
        resolve(value);
      } else if (Date.now() - started > ms) {
        clearInterval(timer);
        reject(new Error("timed out"));
      }
    }, 15);
  });
}
