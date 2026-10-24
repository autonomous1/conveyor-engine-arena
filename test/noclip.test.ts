import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AuthoritativeWorld } from "conveyor-engine-world";
import { ascendFromKeys, attachPlayInput } from "../src/client/input.ts";
import {
  NOCLIP_STORAGE_KEY,
  createOptionsDialog,
  createOptionsModel,
  loadNoclip,
} from "../src/client/options.ts";
import {
  MOVE_DT,
  MOVE_SPEED,
  applyHostNoclip,
  commitShielded,
  decodeMoveButtons,
  encodeMoveButtons,
  enqueueNoclipMove,
  enqueueOwnedMove,
  enqueuePlanarMove,
  yawQuaternion,
} from "../src/shared/movements.ts";

const wall = { minX: 0, maxX: 2, minZ: -1, maxZ: 1, minY: 0, maxY: 3 };

test("enqueueNoclipMove steps into a box without reading obstacles", () => {
  const yaw = 0.7;
  const start = { x: -0.1, y: 2, z: 0 };
  const velocity = { x: MOVE_SPEED, y: 4, z: 0 };
  const fly = record(start, velocity);
  const stepped = enqueueNoclipMove(fly.world, 1, 1, 0, yaw, 1, MOVE_DT);
  assert.ok(stepped);
  assert.equal(fly.listed(), 0);
  const moved = transformOf(fly.commands);
  assert.ok(moved.position.x > wall.minX && moved.position.x < wall.maxX);
  assert.ok(Math.abs(moved.position.y - (start.y + MOVE_SPEED * MOVE_DT)) < 1e-9);
  assert.equal(moved.position.z, start.z);
  assert.deepEqual(moved.rotation, yawQuaternion(yaw));
  const linear = fly.commands.find((cmd) => cmd.kind === "setVelocity");
  assert.ok(linear && linear.kind === "setVelocity");
  assert.equal(linear.linear.y, 0);

  const blocked = record(start, velocity);
  enqueuePlanarMove(blocked.world, 1, 1, 0, yaw, MOVE_DT);
  assert.ok(blocked.listed() > 0);
  assert.deepEqual(transformOf(blocked.commands).rotation, moved.rotation);

  const owned = record(start, velocity);
  assert.ok(enqueueOwnedMove(owned.world, 1, 1, 0, yaw, { noclip: true, ascend: -1, dt: MOVE_DT }));
  assert.equal(owned.listed(), 0);
  const down = transformOf(owned.commands);
  assert.ok(Math.abs(down.position.y - (start.y - MOVE_SPEED * MOVE_DT)) < 1e-9);
});

test("a colliding commit stops on the box and a shielded noclip commit enters it", () => {
  const blocked = cruisingPawn();
  const free = cruisingPawn();
  blocked.world.addObstacle({ id: 1, ...wall });
  free.world.addObstacle({ id: 1, ...wall });
  let reads = 0;
  const obstacles = free.world.listObstacles.bind(free.world);
  free.world.listObstacles = () => {
    reads += 1;
    return obstacles();
  };

  let snap: ReturnType<typeof free.world.commit> | undefined;
  for (let tick = 1; tick <= 5; tick++) {
    assert.ok(enqueueOwnedMove(blocked.world, blocked.id, 1, 0, 0, MOVE_DT));
    blocked.world.commit(BigInt(tick));
    assert.ok(enqueueOwnedMove(free.world, free.id, 1, 0, 0, { noclip: true, ascend: 0, dt: MOVE_DT }));
    snap = commitShielded(free.world, BigInt(tick), [free.id]);
  }
  const stopped = blocked.world.store.view(blocked.id)!;
  const inside = free.world.store.view(free.id)!;
  assert.ok(stopped.position.x > -1 && stopped.position.x < wall.minX, `planar x ${stopped.position.x}`);
  assert.equal(stopped.position.y, 0);
  assert.equal(reads, 0);
  assert.ok(inside.position.x > wall.minX && inside.position.x < wall.maxX, `noclip x ${inside.position.x}`);
  assert.equal(inside.position.y, 0);
  assert.equal(inside.velocity.y, 0);
  assert.equal(inside.radius, 0.5);

  assert.ok(enqueueOwnedMove(free.world, free.id, 1, 0, 0, { noclip: true, ascend: 1, dt: MOVE_DT }));
  snap = commitShielded(free.world, 6n, [free.id]);
  const risen = free.world.store.view(free.id)!;
  assert.ok(Math.abs(risen.position.y - MOVE_SPEED * MOVE_DT) < 1e-9);
  assert.ok(risen.position.x > wall.minX && risen.position.x < wall.maxX);
  assert.equal(risen.radius, 0.5);
  const row = snap!.entities.find((entity) => entity.id === free.id);
  assert.ok(row);
  assert.equal(row.radius, 0.5);
  assert.ok(row.position.x > wall.minX);
});

test("move buttons carry noclip and ascend", () => {
  assert.deepEqual(decodeMoveButtons(0), { noclip: false, ascend: 0 });
  assert.deepEqual(decodeMoveButtons(undefined), { noclip: false, ascend: 0 });
  assert.deepEqual(decodeMoveButtons(encodeMoveButtons(true, 0)), { noclip: true, ascend: 0 });
  assert.deepEqual(decodeMoveButtons(encodeMoveButtons(true, 1)), { noclip: true, ascend: 1 });
  assert.deepEqual(decodeMoveButtons(encodeMoveButtons(true, -1)), { noclip: true, ascend: -1 });
  assert.deepEqual(decodeMoveButtons(encodeMoveButtons(true, 1) | encodeMoveButtons(true, -1)), { noclip: true, ascend: 0 });
  assert.deepEqual(decodeMoveButtons(encodeMoveButtons(false, 1)), { noclip: false, ascend: 1 });
});

test("Space and Control set PlaySample.ascend and the switch follows the host flag", () => {
  assert.equal(ascendFromKeys(new Set()), 0);
  assert.equal(ascendFromKeys(new Set(["Space"])), 1);
  assert.equal(ascendFromKeys(new Set(["ControlLeft"])), -1);
  assert.equal(ascendFromKeys(new Set(["ControlRight"])), -1);
  assert.equal(ascendFromKeys(new Set(["Space", "ControlLeft"])), 0);

  const rig = installInput();
  try {
    const input = attachPlayInput(rig.dom, rig.storage);
    assert.equal(input.sample().ascend, 0);
    rig.key("keydown", "Space");
    assert.equal(input.sample().ascend, 1);
    rig.key("keydown", "Space", true);
    assert.equal(input.sample().ascend, 1);
    rig.key("keydown", "ControlLeft");
    assert.equal(input.sample().ascend, 0);
    rig.key("keyup", "Space");
    assert.equal(input.sample().ascend, -1);
    rig.key("keyup", "ControlLeft");
    rig.key("keydown", "ControlRight");
    assert.equal(input.sample().ascend, -1);
    rig.key("keyup", "ControlRight");
    assert.equal(input.sample().ascend, 0);
  } finally {
    rig.restore();
  }

  const hidden = installDialog();
  try {
    createOptionsDialog(() => {});
    const row = hidden.get("noclip");
    assert.equal(row.hidden, true);
    assert.equal(row.textContent, "Noclip: off");
  } finally {
    hidden.restore();
  }

  const shown = installDialog();
  try {
    const storage = memory("on");
    const dialog = createOptionsDialog(() => {}, storage, () => {}, { noclipAllowed: true });
    const row = shown.get("noclip");
    assert.equal(row.hidden, false);
    assert.equal(row.textContent, "Noclip: on");
    assert.equal(dialog.showNoclip, true);
    dialog.toggleNoclip();
    assert.equal(dialog.showNoclip, false);
    assert.equal(storage.getItem(NOCLIP_STORAGE_KEY), "off");
  } finally {
    shown.restore();
  }
});

test("the noclip switch stays off unless the host allowed it", () => {
  assert.equal(loadNoclip(null), false);
  assert.equal(loadNoclip(memory()), false);
  assert.equal(loadNoclip(memory("off")), false);
  assert.equal(loadNoclip(memory("true")), false);
  assert.equal(loadNoclip(memory("on")), true);

  const storage = memory("on");
  const blocked = createOptionsModel(storage, () => {});
  assert.equal(blocked.showNoclip, false);
  blocked.toggleNoclip();
  assert.equal(blocked.showNoclip, false);
  assert.equal(storage.getItem(NOCLIP_STORAGE_KEY), "on");

  const seen: boolean[] = [];
  const open = createOptionsModel(storage, () => {}, () => {}, () => {}, (on) => seen.push(on), true);
  assert.deepEqual(seen, [true]);
  assert.equal(open.showNoclip, true);
  open.toggleNoclip();
  assert.equal(open.showNoclip, false);
  assert.equal(storage.getItem(NOCLIP_STORAGE_KEY), "off");
  open.toggleNoclip();
  assert.equal(storage.getItem(NOCLIP_STORAGE_KEY), "on");
});

test("view.noclip is set only when ARENA_NOCLIP is 1 at load", { timeout: 120_000 }, () => {
  const view: { noclip?: boolean } = {};
  applyHostNoclip(view, {});
  assert.equal(view.noclip, undefined);
  applyHostNoclip(view, { ARENA_NOCLIP: "1" });
  assert.equal(view.noclip, true);
  applyHostNoclip(view, { ARENA_NOCLIP: "0" });
  assert.equal(view.noclip, undefined);
  applyHostNoclip(view, { ARENA_NOCLIP: "true" });
  assert.equal(view.noclip, undefined);

  assert.equal(installedNoclip(undefined), false);
  assert.equal(installedNoclip("1"), true);
  assert.equal(installedNoclip("0"), false);
});

function installedNoclip(flag: string | undefined): boolean {
  const env = { ...process.env };
  if (flag === undefined) delete env.ARENA_NOCLIP;
  else env.ARENA_NOCLIP = flag;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { loadInstalledGame } from "./dist/server/load-game.js";
    console.log("NOCLIP " + (loadInstalledGame().view.noclip === true ? "yes" : "no"));
  `], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env,
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  const line = run.stdout.split("\n").find((item) => item.startsWith("NOCLIP "));
  assert.equal(line, flag === "1" ? "NOCLIP yes" : "NOCLIP no", run.stdout + run.stderr);
  return line === "NOCLIP yes";
}

type MoveCmd =
  | { kind: "setVelocity"; entity: number; linear: { x: number; y: number; z: number } }
  | { kind: "setTransform"; entity: number; position: { x: number; y: number; z: number }; rotation: { x: number; y: number; z: number; w: number }; scale: { x: number; y: number; z: number } }
  | { kind: "setClip"; entity: number; clip: string; speed: number };

function record(position: { x: number; y: number; z: number }, velocity: { x: number; y: number; z: number }) {
  const commands: MoveCmd[] = [];
  let listed = 0;
  const view = {
    position: { ...position },
    velocity: { ...velocity },
    scale: { x: 1, y: 1, z: 1 },
    clip: "idle",
    speed: 0,
    radius: 0.5,
  };
  return {
    commands,
    listed: () => listed,
    world: {
      store: { view: () => view },
      enqueue(cmd: MoveCmd) {
        commands.push(cmd);
      },
      listObstacles() {
        listed += 1;
        return [wall];
      },
    },
  };
}

function transformOf(commands: MoveCmd[]) {
  const cmd = commands.find((item) => item.kind === "setTransform");
  assert.ok(cmd && cmd.kind === "setTransform");
  return cmd;
}

function cruisingPawn(): { world: AuthoritativeWorld; id: number } {
  const world = new AuthoritativeWorld();
  world.pawnHeight = 1.8;
  const id = world.createEntity(0n, { type: "pawn", shape: "capsule" });
  world.enqueue({
    kind: "setTransform",
    entity: id,
    position: { x: -1, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    scale: { x: 1, y: 1, z: 1 },
  });
  world.enqueue({ kind: "setBounds", entity: id, radius: 0.5 });
  world.enqueue({ kind: "setVelocity", entity: id, linear: { x: MOVE_SPEED, y: 0, z: 0 } });
  world.commit(0n);
  return { world, id };
}

function memory(initial?: string) {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set(NOCLIP_STORAGE_KEY, initial);
  return {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  };
}

type Listener = (ev: Record<string, unknown>) => void;

function installInput() {
  const windowTarget = createTarget();
  const documentTarget = createTarget();
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
  };
  const body = { style: { cursor: "default" } };
  const dom = createTarget();
  globalThis.window = windowTarget as unknown as Window & typeof globalThis;
  globalThis.document = {
    addEventListener: documentTarget.addEventListener.bind(documentTarget),
    removeEventListener: documentTarget.removeEventListener.bind(documentTarget),
    pointerLockElement: null,
    body,
  } as unknown as Document;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { getGamepads: () => [] },
  });
  return {
    dom: dom as unknown as HTMLElement,
    storage: memory(),
    key(type: "keydown" | "keyup", code: string, repeat = false) {
      windowTarget.dispatch(type, { code, repeat });
    },
    restore() {
      globalThis.window = previous.window;
      globalThis.document = previous.document;
      Object.defineProperty(globalThis, "navigator", { configurable: true, value: previous.navigator });
    },
  };
}

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
      const event = { preventDefault() {}, stopPropagation() {}, repeat: false, ...ev };
      for (const fn of [...(listeners.get(type) ?? [])]) fn(event);
    },
  };
}

type FakeEl = {
  id: string;
  hidden: boolean;
  disabled: boolean;
  textContent: string;
  style: { cssText: string; borderColor: string };
  children: FakeEl[];
};

function installDialog() {
  const ids = new Map<string, FakeEl>();
  const previous = { window: globalThis.window, document: globalThis.document };
  function createElement(): FakeEl {
    let idValue = "";
    const el: FakeEl = {
      hidden: false,
      disabled: false,
      textContent: "",
      style: { cssText: "", borderColor: "" },
      children: [],
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
      addEventListener() {},
    } as FakeEl & { append(...nodes: FakeEl[]): void; setAttribute(): void; addEventListener(): void };
    return el;
  }
  const body = createElement();
  globalThis.window = { addEventListener() {} } as unknown as Window & typeof globalThis;
  globalThis.document = {
    body,
    createElement,
    getElementById(id: string) {
      return ids.get(id) ?? null;
    },
  } as unknown as Document;
  return {
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
