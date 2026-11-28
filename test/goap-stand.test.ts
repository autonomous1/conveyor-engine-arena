import { test } from "node:test";
import assert from "node:assert/strict";
import { loadArena } from "../src/server/world-loader.ts";
import { createBotContext, estimateSeconds, groundActions } from "../src/shared/bots/actions.ts";
import { buildWorldState } from "../src/shared/bots/state.ts";
import { standAt } from "../src/shared/bots/goals.ts";
import { chooseGoal } from "../src/shared/bots/goap.ts";
import { resolveStand } from "../src/shared/nav/stand.ts";
import { placeAt, stopOf } from "../src/shared/scene-graph.ts";
import { runMission } from "../packages/bot-client/src/brain.ts";
import { parseMission } from "../packages/bot-client/src/missions.ts";

const loaded = loadArena();
const graph = loaded.sceneGraph!;
const door = loaded.view.doors.find((item) => item.id.startsWith("brutalist-building-1-cbake.door-1-1"))!;
const stand = resolveStand({ kind: "door", doorId: door.id }, graph, loaded.view.doors)!;

test("stand_goal_plans_a_route_then_the_stand", () => {
  const goal = standAt({ kind: "door", doorId: door.id });
  const ctx = createBotContext(graph, loaded.view.pickups ?? []);
  const state = buildWorldState({
    // The installed outside→hall route is not finite with the shipped door facts.
    at: stand.place,
    pickups: [],
    doors: loaded.view.doors.map((item) => ({ id: item.id, open: item.open, locked: item.locked === true })),
  });
  const actions = groundActions(graph, loaded.view.pickups ?? [], [goal], stand);
  const plan = chooseGoal(state, [goal], actions, ctx, { maxExpand: 5000 });
  assert.ok(plan);
  assert.ok(plan.steps.some((id) => id.startsWith("standAt:")));
  assert.ok(plan.steps[0] === `goTo:${stand.place}` || plan.steps[0]!.startsWith("standAt:"));

  // A stand goal now has a place bound: finite from another place, 0 at the stand.
  const heuristic = estimateSeconds(goal, ctx, loaded.view.pickups ?? [], stand);
  const openDoors = loaded.view.doors.map((item) => ({ id: item.id, open: true, locked: false }));
  const away = buildWorldState({
    at: "brutalist-building-1-cbake.floor-1.hall",
    pickups: [],
    doors: openDoors,
  });
  const bound = heuristic(away);
  assert.ok(Number.isFinite(bound) && bound > 0, `stand bound ${bound}`);
  assert.equal(heuristic({ ...away, at: stand.place }), 0);
});

test("a_stand_goal_on_an_upper_floor_grounds_the_ride", () => {
  const upper = loaded.view.doors.find((item) => item.position[1] > 1
    && graph.portals.some((portal) => portal.kind === "door" && (portal.door ?? portal.id) === item.id));
  assert.ok(upper, "no upper-floor scene-graph door in the installed graph");
  const target = { kind: "door" as const, doorId: upper.id };
  const upperStand = resolveStand(target, graph, loaded.view.doors);
  assert.ok(upperStand);
  const goal = standAt(target);
  const actions = groundActions(graph, [], [goal], upperStand);
  assert.ok(actions.some((action) => action.id.startsWith("rideTo:")), "stand goal has no ride");
  assert.ok(actions.some((action) => action.id.startsWith(`goTo:${upperStand.place}`)));
  const ctx = createBotContext(graph, []);
  const state = buildWorldState({
    at: upperStand.place, pickups: [],
    doors: loaded.view.doors.map((item) => ({ id: item.id, open: item.open, locked: item.locked === true })),
  });
  const plan = chooseGoal(state, [goal], actions, ctx, { maxExpand: 5000 });
  assert.ok(plan);

});

/**
 * A stand-only session over the real graph: the pawn is parked at the resolved
 * point and the fake host never turns it (native yaw 1.3). The brain's `sendInput`
 * is accepted but applied by nobody.
 */
function standOnlySession(pawn: { x: number; y: number; z: number; yaw: number }) {
  const doors = loaded.view.doors;
  const claims = new Map<string, { owner: number }>();
  return {
    spectate: false,
    close() {},
    input: {
      sendInput: () => {},
      use: () => false,
      fire: () => false,
      grenade: () => false,
      resetSeq() {},
      callElevator() {},
    },
    claims: { acquire() {}, release() {}, claims: () => claims },
    messages: { say: () => true },
    world: {
      aabbs: loaded.view.aabbs,
      pawnRadius: loaded.view.pawnRadius,
      pawnHeight: loaded.view.pawnHeight,
      self: () => ({ id: 1, ...pawn }),
      others: () => [],
      cabs: () => [],
      door: (id: string) => doors.find((item) => item.id === id),
      doors: () => doors,
      doorBody: (id: string) => doors.find((item) => item.id === id),
      pickups: () => [],
      pickupPlacements: () => [],
      keys: () => [],
      weapon: () => "",
      ammo: () => 0,
      scope: () => ["scene-graph"],
      sceneGraph: () => graph,
      sceneGraphHash: () => "real",
      regions: () => loaded.regions,
      placeOf: (pos: { x: number; y: number; z: number }) => {
        const place = placeAt(graph, pos.x, pos.y, pos.z);
        return { id: place.id, kind: place.kind };
      },
      health: () => ({ hp: 100, dead: false }),
      healthOf: () => ({ hp: 100, dead: false }),
      playerIds: () => new Set<number>(),
      teamOf: () => undefined,
      claims: () => claims,
      claimsSupported: () => false,
    },
  };
}

test("a_bare_stand_point_latches_the_stand_fact_without_a_yaw", async () => {
  // 230: `stand:x,y,z` has no facing. The pawn stands at the resolved point with
  // a native yaw of 1.3 rad; the STAND fact must latch on distance alone. On HEAD
  // the fact waits for the yaw, so the mission replans until the timeout.
  const resolved = resolveStand({ kind: "point", x: 0, y: 0, z: 0 }, graph, loaded.view.doors);
  assert.ok(resolved);
  const pawn = { x: resolved.x, y: resolved.y, z: resolved.z, yaw: 1.3 };
  const logs: string[] = [];
  const started = Date.now();
  const code = await runMission(standOnlySession(pawn) as never, parseMission("stand:0,0,0")!, {
    timeoutMs: 3_000,
    planMs: 2_000,
    predictOwned: false,
    log: (line) => logs.push(line),
  });
  assert.equal(code, 0, `code ${code} after ${Date.now() - started} ms; the fact must not demand the yaw\n${logs.slice(-10).join("\n")}`);
  assert.equal(pawn.yaw, 1.3, "the fake host never turned the pawn");
});
