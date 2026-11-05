import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";

register(
  "data:text/javascript," +
    encodeURIComponent(`
      import { existsSync } from "node:fs";
      import { fileURLToPath } from "node:url";
      export async function resolve(specifier, context, nextResolve) {
        const parent = context.parentURL ?? "";
        if ((specifier.startsWith("./") || specifier.startsWith("../")) && specifier.endsWith(".js") && parent.includes("/src/")) {
          const ts = specifier.slice(0, -3) + ".ts";
          if (existsSync(fileURLToPath(new URL(ts, parent)))) return nextResolve(ts, context);
        }
        return nextResolve(specifier, context);
      }
    `),
);

const { createBotContext, estimateSeconds, groundActions, placeOfPickup } = await import("../src/shared/bots/actions.ts");
const { chooseGoal } = await import("../src/shared/bots/goap.ts");
const { reach, retrieve } = await import("../src/shared/bots/goals.ts");
const { buildWorldState } = await import("../src/shared/bots/state.ts");
const { isElevatorShaft, placeAt } = await import("../src/shared/scene-graph.ts");
const { loadArena } = await import("../src/server/world-loader.ts");
const { runMission } = await import("../packages/bot-client/src/brain.ts");

const HALL = "brutalist-building-2-cbake.floor-1.hall";
const SPAWN = { x: 0.5407, y: 0, z: -1.7784 };

const loaded = loadArena();
const graph = loaded.sceneGraph;
assert.ok(graph, "real scene graph missing");
const baked = JSON.parse(readFileSync(new URL("../web/game/scene-graph.json", import.meta.url), "utf8")) as {
  places: unknown[];
  portals: unknown[];
};
assert.equal(baked.places.length, 174);
assert.equal(graph.places.length, baked.places.length);
assert.equal(graph.portals.length, baked.portals.length);
const pickups = loaded.view.pickups ?? [];
assert.ok(pickups.some((item) => item.kind === "key"));

const at = placeAt(graph, SPAWN.x, SPAWN.y, SPAWN.z).id;

function doorFacts(source: NonNullable<typeof graph>): { id: string; open: boolean; locked: boolean }[] {
  const byId = new Map<string, { id: string; open: boolean; locked: boolean }>();
  for (const portal of source.portals) {
    if (portal.kind !== "door") continue;
    const id = portal.door ?? portal.id;
    if (!byId.has(id)) byId.set(id, { id, open: false, locked: portal.locked === true });
  }
  return [...byId.values()];
}

function world() {
  return buildWorldState({
    at,
    pickups: pickups.map((item) => item.id),
    doors: doorFacts(graph!),
  });
}

function plannerOpts(goal: { want: Record<string, string | number | boolean> }, ctx: ReturnType<typeof createBotContext>) {
  return {
    minCost: ctx.minActionS,
    heuristic: estimateSeconds(goal, ctx, pickups),
  };
}

test("reach the floor-1 hall from the outside spawn plans in under 500 ms", () => {
  const goal = reach(HALL);
  const actions = groundActions(graph!, pickups, [goal]);
  const ctx = createBotContext(graph!, pickups);
  const state = world();
  const started = performance.now();
  const result = chooseGoal(state, [goal], actions, ctx, plannerOpts(goal, ctx));
  const ms = performance.now() - started;
  assert.ok(result, `no plan from ${at} in ${ms.toFixed(0)} ms`);
  assert.ok(ms < 500, `plan took ${ms.toFixed(0)} ms, expanded ${result.expanded}, steps ${result.steps.join(" ")}`);
});

test("a retrieve that needs the key plans in under 1 s", () => {
  const probe = createBotContext(graph!, pickups);
  const state = world();
  const item = pickups.find((pickup) => {
    if (pickup.kind === "key") return false;
    const place = placeOfPickup(graph!, pickup);
    const strict = probe.routeCost(at, place, state);
    if (Number.isFinite(strict)) return false;
    return Number.isFinite(probe.routeBound(at, place, state));
  });
  assert.ok(item, "no locked-away pickup in the current game data");
  const place = placeOfPickup(graph!, item);
  const goal = retrieve(item.id, place);
  const actions = groundActions(graph!, pickups, [goal]);
  const ctx = createBotContext(graph!, pickups);
  const started = performance.now();
  const result = chooseGoal(state, [goal], actions, ctx, plannerOpts(goal, ctx));
  const ms = performance.now() - started;
  assert.ok(result, `no plan for ${item.id} at ${place} in ${ms.toFixed(0)} ms`);
  assert.ok(ms < 1_000, `plan took ${ms.toFixed(0)} ms, expanded ${result.expanded}`);
  assert.ok(result.steps.some((step) => step.startsWith("pickup:") && pickups.some((pickup) => pickup.kind === "key" && step === `pickup:${pickup.id}`)), result.steps.join(" "));
  assert.ok(result.steps.some((step) => step.startsWith("unlock:")), result.steps.join(" "));
});

test("an elevator shaft has no plan in under 500 ms", () => {
  const shaft = graph!.places.find((place) => isElevatorShaft(place));
  assert.ok(shaft);
  const goal = reach(shaft.id);
  const actions = groundActions(graph!, pickups, [goal]);
  const ctx = createBotContext(graph!, pickups);
  const started = performance.now();
  const result = chooseGoal(world(), [goal], actions, ctx, plannerOpts(goal, ctx));
  const ms = performance.now() - started;
  assert.equal(result, undefined, `shaft ${shaft.id} planned in ${ms.toFixed(0)} ms`);
  assert.ok(ms < 500, `no-plan took ${ms.toFixed(0)} ms`);
});

test("routeCost compiles once for the same door facts", () => {
  const ctx = createBotContext(graph!, pickups);
  const state = world();
  const hall = ctx.routeCost(at, HALL, state);
  assert.ok(hall > 0 && Number.isFinite(hall), `hall route ${hall}`);
  const again = ctx.routeCost(at, HALL, state);
  assert.equal(again, hall);
  const other = pickups.map((item) => placeOfPickup(graph!, item)).find((place) => place !== at);
  assert.ok(other);
  ctx.routeCost(at, other, state);
  const moved = { ...state, at: other };
  ctx.routeCost(other, HALL, moved);
  assert.equal(ctx.compiles, 1, "same doors compiled more than once");
  const door = doorFacts(graph!)[0];
  assert.ok(door);
  const opened = { ...state, [`doorOpen:${door.id}`]: true, [`doorLocked:${door.id}`]: false };
  ctx.routeCost(at, HALL, opened);
  assert.equal(ctx.compiles, 2);
});

test("a huge expand budget still returns before the mission timeout", async () => {
  const goal = reach("no-such-place");
  const pawn = { id: 1, x: SPAWN.x, y: SPAWN.y, z: SPAWN.z, yaw: 0 };
  const doors = doorFacts(graph!);
  const session = {
    spectate: false,
    close() {},
    input: {
      sendInput() {},
      use: () => false,
      fire: () => false,
      grenade: () => false,
      resetSeq() {},
    },
    world: {
      aabbs: [],
      pawnRadius: 0.4,
      pawnHeight: 1.8,
      self: () => pawn,
      others: () => [],
      door: (id: string) => doors.find((door) => door.id === id),
      doors: () => doors,
      doorBody: () => undefined,
      pickups: () => pickups.map((item) => item.id),
      pickupPlacements: () => pickups,
      keys: () => [],
      weapon: () => undefined,
      ammo: () => 0,
      scope: () => ["scene-graph"],
      sceneGraph: () => graph,
      sceneGraphHash: () => "real",
      placeOf: (pos: { x: number; y: number; z: number }) => {
        const place = placeAt(graph!, pos.x, pos.y, pos.z);
        return { id: place.id, kind: place.kind };
      },
    },
  };
  const logs: string[] = [];
  const started = Date.now();
  const code = await runMission(session as never, { kind: "goal", goal }, {
    timeoutMs: 2_000,
    maxExpand: 1_000_000_000,
    predictOwned: false,
    log: (line) => logs.push(line),
  });
  const wall = Date.now() - started;
  assert.ok(code === 2 || code === 3, `code ${code}\n${logs.join("\n")}`);
  assert.ok(wall < 3_000, `hung for ${wall} ms\n${logs.join("\n")}`);
  assert.ok(logs.includes("plan start"), logs.join("\n"));
  assert.ok(logs.some((line) => line.startsWith("plan done ")), logs.join("\n"));
});
