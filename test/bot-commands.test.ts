import assert from "node:assert/strict";
import test from "node:test";
import { createCommandHost, parseCommand } from "../packages/bot-client/src/commands.ts";

const NAMES = ["arm", "goto", "stand", "path", "walk", "reload", "hunt", "patrol", "retrieve", "getkey", "projectile"];

type WorldOptions = {
  placeOf?: (pos: { x: number; y: number; z: number }) => { id: string; kind: string };
  others?: () => Array<{ id: number; x: number; y: number; z: number }>;
  weapon?: () => string;
  ammo?: () => number;
  hp?: () => number;
  pickups?: () => string[];
  pickupPlacements?: () => Array<{ id: string; kind?: string; minX: number; maxX: number; minZ: number; maxZ: number; minY?: number; maxY?: number }>;
};

/** The minimal session port; `calls` records every read so a test can prove "not touched". */
function fakeSession(options: WorldOptions = {}) {
  const calls: string[] = [];
  const me = { id: 7, x: 1, y: 0, z: 2, yaw: 0 };
  const hp = (): number => (options.hp ? options.hp() : 100);
  const world = {
    self: () => {
      calls.push("self");
      return me;
    },
    healthOf: (id: number) => ({ hp: id === 7 ? hp() : 50, dead: false }),
    health: () => ({ hp: hp(), dead: false }),
    placeOf: (pos: { x: number; y: number; z: number }) => {
      calls.push("placeOf");
      return options.placeOf ? options.placeOf(pos) : { id: "outside", kind: "outside" };
    },
    weapon: () => (options.weapon ? options.weapon() : "laser"),
    ammo: () => (options.ammo ? options.ammo() : 30),
    pickups: () => (options.pickups ? options.pickups() : ["key"]),
    pickupPlacements: () => (options.pickupPlacements ? options.pickupPlacements() : []),
    keys: () => [],
    others: () => (options.others ? options.others() : []),
    playerIds: () => {
      calls.push("playerIds");
      return [7];
    },
    doors: () => [],
    doorBody: () => undefined,
    sceneGraph: () => undefined,
    scope: () => [],
    regions: () => undefined,
    aabbs: [],
    pawnRadius: 0.5,
    pawnHeight: 1.8,
    grenades: () => [],
    landed: () => [],
    messages: () => [],
    messagesSupported: () => false,
    claims: () => new Map(),
  };
  const session = {
    world,
    input: {
      sendInput: () => calls.push("sendInput"),
      use: () => false,
      fire: () => false,
      grenade: () => false,
      resetSeq() {},
      callElevator() {},
    },
    messages: { say: () => true },
    claims: { acquire() {}, release() {} },
    close() {},
    spectate: false,
  };
  return { session, calls };
}

async function waitUntil(predicate: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

test("parse_command_accepts_every_handler", () => {
  const cases: Array<{ name: string; args: Record<string, unknown> }> = [
    { name: "arm", args: {} },
    { name: "goto", args: { place: "hall" } },
    { name: "stand", args: { x: 1, y: 0, z: 2, yaw: 1.5 } },
    { name: "path", args: { x: 1, y: 0, z: 2, yaw: 1.5 } },
    { name: "walk", args: { points: [{ x: 1, z: 2 }, { x: 3, z: 4 }] } },
    { name: "reload", args: { crate: "ammo-1" } },
    { name: "hunt", args: { minutes: 1 } },
    { name: "patrol", args: { places: ["a", "b"], minutes: 0.5 } },
    { name: "retrieve", args: { pickup: "key" } },
    { name: "getkey", args: {} },
    { name: "projectile", args: { bands: [5, 10, 20], throws: 4, seconds: 120 } },
  ];
  for (const item of cases) {
    const parsed = parseCommand(item);
    assert.ok(!("error" in parsed), `${item.name}: ${JSON.stringify(parsed)}`);
    assert.equal(parsed.name, item.name);
  }
  assert.deepEqual(parseCommand({ name: "goto", args: { place: "hall" } }), { name: "goto", place: "hall" });
  assert.deepEqual(parseCommand({ name: "projectile", args: { seconds: 10 } }), {
    name: "projectile",
    bands: [5, 10, 20],
    throws: 4,
    seconds: 10,
    trial: "control",
    fallback: "straight",
    filter: "none",
    route: "point",
  });
  assert.deepEqual(parseCommand({ name: "arm" }), { name: "arm" });
});

test("parse_command_preserves_every_bad_args_why", () => {
  const bad: Array<{ name: string; args?: Record<string, unknown>; why: string }> = [
    { name: "goto", args: {}, why: "bad-args" },
    { name: "stand", args: { x: "nope", y: 0, z: 0 }, why: "bad-args" },
    { name: "path", args: { x: "nope", y: 0, z: 0 }, why: "bad-args" },
    { name: "walk", args: { points: [] }, why: "bad-args" },
    { name: "hunt", args: { minutes: 0.2 }, why: "bad-args" },
    { name: "hunt", args: { minutes: 11 }, why: "bad-args" },
    { name: "hunt", args: { weapon: "grenade" }, why: "unsupported-weapon" },
    { name: "patrol", args: { places: ["only-one"] }, why: "bad-args" },
    { name: "projectile", args: { bands: [] }, why: "bad-args" },
    { name: "projectile", args: { bands: [31] }, why: "bad-args" },
    { name: "projectile", args: { throws: 0 }, why: "bad-args" },
    { name: "projectile", args: { throws: 9 }, why: "bad-args" },
    { name: "projectile", args: { seconds: 5 }, why: "bad-args" },
    { name: "no-such-command", args: {}, why: "unknown-task" },
  ];
  for (const item of bad) {
    assert.deepEqual(parseCommand(item), { error: item.why }, `${item.name} ${JSON.stringify(item.args ?? {})}`);
  }
});

test("status_is_typed_and_trimmed_in_order", async () => {
  // A place long enough that dropping `pos` alone is enough.
  const first = fakeSession({ placeOf: () => ({ id: "p".repeat(120), kind: "outside" }) });
  const host = createCommandHost({ session: first.session, log: () => {} });
  await host.dispatch({ id: "c1", name: "arm" });
  const one = host.status("s1");
  assert.equal(one.t, "status");
  assert.equal(one.self, 7);
  assert.ok(JSON.stringify(one).length <= 256, `${JSON.stringify(one).length}`);
  assert.equal("pos" in one, false, "pos is dropped first");
  assert.ok("last" in one, "last survives when dropping pos is enough");

  // Longer still: pos and then last.
  const second = fakeSession({ placeOf: () => ({ id: "p".repeat(150), kind: "outside" }) });
  const host2 = createCommandHost({ session: second.session, log: () => {} });
  await host2.dispatch({ id: "c1", name: "arm" });
  const two = host2.status("s2");
  assert.ok(JSON.stringify(two).length <= 256, `${JSON.stringify(two).length}`);
  assert.equal("pos" in two, false);
  assert.equal("last" in two, false, "last is dropped second");
});

test("command_names_match_the_registry", () => {
  assert.equal(new Set(NAMES).size, NAMES.length, "no duplicates");
  const required: Record<string, Record<string, unknown>> = {
    arm: {},
    getkey: {},
    goto: { place: "hall" },
    stand: { x: 0, y: 0, z: 0 },
    path: { x: 0, y: 0, z: 0 },
    walk: { x: 0, z: 0 },
    reload: {},
    hunt: {},
    patrol: { places: ["a", "b"] },
    retrieve: { pickup: "key" },
    projectile: {},
  };
  for (const name of NAMES) {
    assert.ok(!("error" in parseCommand({ name, args: required[name] })), name);
  }
  assert.ok("error" in parseCommand({ name: "status" }), "status is a host method, not a handler");
  // arm and getkey take no arguments, so an empty request parses.
  assert.deepEqual(parseCommand({ name: "arm" }), { name: "arm" });
  assert.deepEqual(parseCommand({ name: "getkey" }), { name: "getkey" });
});

test("dispatch_rejects_unknown_command_before_touching_the_session", async () => {
  const { session, calls } = fakeSession();
  const host = createCommandHost({ session, log: () => {} });
  calls.length = 0;
  const result = await host.dispatch({ id: "x1", name: "no-such-command" });
  assert.deepEqual(result, { ok: false, code: 1, why: "unknown-task" });
  assert.deepEqual(calls, []);
});

test("dispatch_rejects_while_busy", async () => {
  const { session } = fakeSession({ others: () => [{ id: 9, x: 5, y: 0, z: 5 }] });
  const host = createCommandHost({ session, log: () => {} });
  const first = host.dispatch({ id: "p1", name: "projectile", args: { seconds: 10, bands: [5], throws: 1 } });
  const second = await host.dispatch({ id: "a1", name: "arm" });
  assert.deepEqual(second, { ok: false, code: 1, why: "busy" });
  host.abort();
  const done = await first;
  assert.equal(done.ok, false);
  assert.equal(done.why, "aborted");
});

test("the arm retrieves the weapon after the climb when the stand left it unarmed", async () => {
  // 153 F2: the climb's stand resolves to a cell 0.52 m outside the weapon's
  // pickup box, so a stand alone cannot take it. The arm must follow the stand
  // with the retrieve mission (the driver's fix), before the step-off.
  const { session } = fakeSession({ weapon: () => "", ammo: () => 0, pickups: () => ["alien-weapon-1"] });
  const logs: string[] = [];
  const host = createCommandHost({ session, log: (line) => logs.push(line) });
  const result = await host.dispatch({ id: "a1", name: "arm" });
  assert.equal(result.ok, false);
  assert.ok(logs.some((line) => line.includes("arm: retrieve the weapon")), logs.join("\n"));
  assert.ok(logs.some((line) => line.startsWith("  weapon ")), `the retrieve mission never ran\n${logs.join("\n")}`);
  assert.ok(logs.some((line) => line.includes("arm retrieve code=")), logs.join("\n"));
});

test("hunt heals at hp 50 and reloads at ammo 0 instead of stopping", async () => {
  // The 108 driver's mid-run cycle: at the top of the loop, heal <= 50 hp and
  // reload at 0 ammo, then keep hunting. On HEAD the product hunt returns
  // no-ammo before the loop and never heals.
  let hp = 50;
  const { session } = fakeSession({
    weapon: () => "laser",
    ammo: () => 0,
    hp: () => hp,
    pickups: () => ["key", "health-1", "ammo-1"],
    pickupPlacements: () => [
      { id: "health-1", kind: "health", minX: 1, maxX: 1.4, minZ: 2, maxZ: 2.4 },
      { id: "ammo-1", kind: "ammo", minX: 3, maxX: 3.4, minZ: 4, maxZ: 4.4 },
    ],
    others: () => [{ id: 9, x: 5, y: 0, z: 5 }],
  });
  const logs: string[] = [];
  const host = createCommandHost({ session, log: (line) => logs.push(line) });
  const done = host.dispatch({ id: "h1", name: "hunt", args: { minutes: 0.5 } });
  const sawHeal = await waitUntil(() => logs.some((line) => line.includes("HEAL start")), 5_000);
  hp = 100;
  const sawReload = await waitUntil(() => logs.some((line) => line.includes("RELOAD start")), 5_000);
  const result = await done;
  assert.ok(sawHeal, `no HEAL start\n${logs.join("\n")}`);
  assert.ok(sawReload, `no RELOAD start\n${logs.join("\n")}`);
  assert.equal(result.ok, false);
  assert.equal(result.why, "no-ammo");
});
