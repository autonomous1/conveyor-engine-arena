import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { ArenaView } from "../src/shared/arena-view.ts";
import { createBotContext, groundActions, placeOfPickup } from "../dist/shared/bots/actions.js";
import { armUp, idle, reach, retrieve } from "../dist/shared/bots/goals.js";
import { chooseGoal, plan, type Goal, type WorldState } from "../dist/shared/bots/goap.js";
import { HAS_WEAPON, availFact, buildWorldState } from "../dist/shared/bots/state.js";
import type { PickupPlacement } from "../src/shared/pickups.ts";
import { parseSceneGraph, type SceneGraph } from "../dist/shared/scene-graph.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const DOOR = "hall-b.door-ext";
const PRIZE = "retrieve:prize@hall-b.room-1";
const KEY_PLAN = [
  "pickup:key",
  `goToDoor:${DOOR}`,
  `unlock:${DOOR}`,
  "goTo:hall-b.room-1",
  "pickup:prize",
];

type GraphFile = {
  places: unknown[];
  portals: Array<Record<string, unknown> & { id: string; a: string; b: string; at: { a: number[]; b: number[] } }>;
};

function readFixture(): GraphFile {
  return JSON.parse(readFileSync(join(here, "fixtures/scene-graph.json"), "utf8")) as GraphFile;
}

function doorRow(id: string, key: string): ArenaView["doors"][number] {
  return {
    id,
    model: "/assets/models/door.glb",
    position: [0, 0, 0],
    yaw: 0,
    hinge: "left",
    size: [1, 2, 0.1],
    open: false,
    locked: true,
    key,
  };
}

function loadGraph(
  mutate?: (file: GraphFile) => void,
  doors: ArenaView["doors"] = [doorRow(DOOR, "key")],
): SceneGraph {
  const file = readFixture();
  mutate?.(file);
  const parsed = parseSceneGraph(file, doors);
  assert.deepEqual(parsed.issues, []);
  assert.ok(parsed.graph);
  return parsed.graph;
}

function box(id: string, kind: PickupPlacement["kind"], x: number, y: number, z: number): PickupPlacement {
  return {
    id,
    kind,
    model: `${id}.glb`,
    amount: 1,
    minX: x - 0.2,
    maxX: x + 0.2,
    minY: y - 0.2,
    maxY: y + 0.2,
    minZ: z - 0.2,
    maxZ: z + 0.2,
  };
}

function items(): PickupPlacement[] {
  return [box("key", "key", -5, 1, -5), box("prize", "health", 2, 1, 2)];
}

function doorsOf(ids: readonly string[], open = false): { id: string; open: boolean; locked: boolean }[] {
  return ids.map((id) => ({ id, open, locked: !open }));
}

function outsideState(doorIds: readonly string[], extra?: { gone?: string[]; open?: boolean }): WorldState {
  return {
    ...buildWorldState({
      at: "outside",
      pickups: ["key", "prize"],
      gone: extra?.gone,
      doors: doorsOf(doorIds, extra?.open === true),
    }),
    [availFact("rifle")]: true,
  };
}

function mission(): Goal[] {
  return [retrieve("prize", "hall-b.room-1"), armUp(["rifle"]), reach("hall-b.room-1"), idle()];
}

function setup(graph = loadGraph(), pickups = items()) {
  return { graph, pickups, actions: groundActions(graph, pickups), ctx: createBotContext(graph, pickups) };
}

test("feet under a pickup resolve to the place that holds it", () => {
  const graph = loadGraph();
  const pickups = items();
  assert.equal(placeOfPickup(graph, pickups[0]!), "outside");
  assert.equal(placeOfPickup(graph, pickups[1]!), "hall-b.room-1");
});

test("retrieve prize from outside fetches the key, unlocks, then picks up the prize", () => {
  const { actions, ctx } = setup();
  const state = outsideState([DOOR]);
  const result = plan(state, retrieve("prize", "hall-b.room-1"), actions, ctx);
  assert.ok(result);
  assert.deepEqual(result.steps, KEY_PLAN);
  assert.ok(result.expanded > 5);

  const chosen = chooseGoal(state, mission(), actions, ctx);
  assert.equal(chosen?.goal, PRIZE);
  assert.deepEqual(chosen?.steps, KEY_PLAN);
});

test("an open door is not a key detour", () => {
  const { actions, ctx } = setup();
  const state = outsideState([DOOR], { open: true });
  const result = plan(state, retrieve("prize", "hall-b.room-1"), actions, ctx);
  assert.ok(result);
  assert.equal(result.steps.includes("pickup:key"), false);
  assert.equal(result.steps.some((step) => step.startsWith("unlock:")), false);
  assert.equal(result.steps.at(-1), "pickup:prize");
});

test("one key unlocks every leaf that names it", () => {
  const graph = loadGraph((file) => {
    file.places.push({
      id: "hall-b.vestibule",
      kind: "room",
      y: 0,
      polygon: [[50, 50], [54, 50], [54, 54], [50, 54]],
      bounds: { minX: 50, maxX: 54, minZ: 50, maxZ: 54 },
    });
    const ext = file.portals.find((portal) => portal.id === DOOR);
    assert.ok(ext);
    ext.a = "hall-b.vestibule";
    ext.b = "outside";
    ext.at = { a: [51, 0, 52], b: [-1, 0.1, 2] };
    file.portals.push({
      id: "hall-b.door-in",
      kind: "door",
      a: "hall-b.room-1",
      b: "hall-b.vestibule",
      door: "hall-b.door-in",
      locked: true,
      key: "key",
      at: { a: [2, 0, 2], b: [52, 0, 52] },
      width: 1,
      cost: 1,
    });
  }, [doorRow(DOOR, "key"), doorRow("hall-b.door-in", "key")]);
  const pickups = items();
  const actions = groundActions(graph, pickups);
  const ctx = createBotContext(graph, pickups);
  const result = plan(outsideState([DOOR, "hall-b.door-in"]), retrieve("prize", "hall-b.room-1"), actions, ctx);
  assert.ok(result);
  const steps = result.steps;
  assert.deepEqual(steps.filter((step) => step === "pickup:key"), ["pickup:key"]);
  assert.equal(steps.includes(`unlock:${DOOR}`), true);
  assert.equal(steps.includes("unlock:hall-b.door-in"), true);
  assert.ok(steps.indexOf("pickup:key") < steps.indexOf(`unlock:${DOOR}`));
  assert.ok(steps.indexOf(`unlock:${DOOR}`) < steps.indexOf("unlock:hall-b.door-in"));
  assert.equal(steps.at(-1), "pickup:prize");
});

test("armUp picks up an available weapon", () => {
  const graph = loadGraph();
  const pickups = [...items(), box("rifle", "weapon", -4, 1, -5)];
  const actions = groundActions(graph, pickups);
  const ctx = createBotContext(graph, pickups);
  const state = buildWorldState({
    at: "outside",
    pickups: ["key", "prize", "rifle"],
    doors: doorsOf([DOOR]),
  });
  const chosen = chooseGoal(state, [armUp(["rifle"]), idle()], actions, ctx);
  assert.equal(chosen?.goal, "armUp");
  assert.deepEqual(chosen?.steps, ["pickup:rifle"]);
});

test("an unavailable key leaves no plan", () => {
  const { actions, ctx } = setup();
  const state = outsideState([DOOR], { gone: ["key"] });
  assert.equal(plan(state, retrieve("prize", "hall-b.room-1"), actions, ctx), undefined);
  assert.equal(chooseGoal(state, mission(), actions, ctx), undefined);
});

test("the same facts plan the same steps", () => {
  const { actions, ctx } = setup();
  const state = outsideState([DOOR]);
  const goal = retrieve("prize", "hall-b.room-1");
  const first = plan(state, goal, actions, ctx);
  assert.ok(first);
  for (let i = 0; i < 100; i += 1) {
    assert.deepEqual(plan(state, goal, actions, ctx), first);
  }
});

test("a tiny expansion budget returns no plan", () => {
  const { actions, ctx } = setup();
  const result = plan(outsideState([DOOR]), retrieve("prize", "hall-b.room-1"), actions, ctx, { maxExpand: 5 });
  assert.equal(result, undefined);
});

test("a plan finishes within 10 ms", () => {
  const { actions, ctx } = setup();
  const state = outsideState([DOOR]);
  const goal = retrieve("prize", "hall-b.room-1");
  plan(state, goal, actions, ctx);
  const started = performance.now();
  const result = plan(state, goal, actions, ctx);
  const elapsed = performance.now() - started;
  assert.ok(result);
  assert.ok(elapsed < 10, `plan took ${elapsed} ms`);
});

test("goal priorities stay retrieve, arm, reach, idle", () => {
  const armed: WorldState = { [HAS_WEAPON]: true, [availFact("rifle")]: true };
  assert.equal(retrieve("prize", "hall-b.room-1").priority({}), 5);
  assert.equal(armUp(["rifle"]).priority({ [availFact("rifle")]: true }), 4);
  assert.equal(armUp(["rifle"]).priority(armed), 0);
  assert.equal(armUp(["rifle"]).priority({}), 0);
  assert.equal(reach("outside").priority({}), 3);
  assert.equal(idle().priority({}), 0);
});

test("goap.ts matches the appendix byte for byte", () => {
  const got = readFileSync(join(root, "src/shared/bots/goap.ts"));
  const appendix = readFileSync(join(root, "plan/arena-roadmap-tasks-v3/reference/goap.ts"));
  assert.deepEqual(got, appendix);
});

test("bot planner source has no clock and no Math.random", () => {
  const dir = join(root, "src/shared/bots");
  const names = readdirSync(dir).filter((name) => name.endsWith(".ts"));
  assert.ok(names.includes("goap.ts"));
  for (const name of names) {
    // The appendix comment names the call it forbids. Only code counts.
    const text = readFileSync(join(dir, name), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    assert.equal(/\bMath\.random\b/.test(text), false, name);
    assert.equal(/\bDate\.now\b/.test(text), false, name);
  }
});
