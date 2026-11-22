import assert from "node:assert/strict";
import test from "node:test";
import { createCommandHost, parseCommand } from "../packages/bot-client/src/commands.ts";

const NAMES = ["arm", "goto", "stand", "walk", "reload", "hunt", "patrol", "retrieve", "getkey", "projectile"];

type WorldOptions = {
  placeOf?: (pos: { x: number; y: number; z: number }) => { id: string; kind: string };
  others?: () => Array<{ id: number; x: number; y: number; z: number }>;
  weapon?: () => string;
};

/** The minimal session port; `calls` records every read so a test can prove "not touched". */
function fakeSession(options: WorldOptions = {}) {
  const calls: string[] = [];
  const me = { id: 7, x: 1, y: 0, z: 2, yaw: 0 };
  const world = {
    self: () => {
      calls.push("self");
      return me;
    },
    healthOf: (id: number) => ({ hp: id === 7 ? 100 : 50, dead: false }),
    health: () => ({ hp: 100 }),
    placeOf: (pos: { x: number; y: number; z: number }) => {
      calls.push("placeOf");
      return options.placeOf ? options.placeOf(pos) : { id: "outside", kind: "outside" };
    },
    weapon: () => (options.weapon ? options.weapon() : "laser"),
    ammo: () => 30,
    pickups: () => ["key"],
    pickupPlacements: () => [],
    keys: () => [],
    others: () => (options.others ? options.others() : []),
    playerIds: () => {
      calls.push("playerIds");
      return [7];
    },
    doors: () => [],
    doorBody: () => undefined,
    sceneGraph: () => undefined,
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

test("parse_command_accepts_every_handler", () => {
  const cases: Array<{ name: string; args: Record<string, unknown> }> = [
    { name: "arm", args: {} },
    { name: "goto", args: { place: "hall" } },
    { name: "stand", args: { x: 1, y: 0, z: 2, yaw: 1.5 } },
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
