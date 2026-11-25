// Task 184: the combat vocabulary's plan matrices and cost table, offline.
// The synthetic actions carry the combat ids and the cost shape from proto/combat.ts;
// the closure case uses the real scene graph and the real groundActions, so the
// locked-door closure is the production action set, not an assumption.
// Run: node --import ./scripts/ts-ext-register.mjs \
//   packages/bot-client/tests/combat-goap.ts --label 184-offline
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadArena } from "../../../src/server/world-loader.ts";
import { parseSceneGraph } from "../../../src/shared/scene-graph.ts";
import { createBotContext, estimateSeconds, goTo, groundActions, placeOfPickup, type BotCtx } from "../../../src/shared/bots/actions.ts";
import { assaultGoal, chooseCombatGoal, combatActions, combatFacts, combatGoals, combatHeuristic, healGoal, regroupGoal, threatWatchKey, visibleThreat } from "../proto/combat.ts";
import { HAS_AMMO } from "../../../src/shared/bots/state.ts";
import { reach } from "../../../src/shared/bots/goals.ts";
import { plan, type Action, type Goal, type Plan, type WorldState } from "../../../src/shared/bots/goap.ts";
import { placeAt } from "../../../src/shared/scene-graph.ts";
import { nextReloadCandidate, parseCommand, reloadVerdict } from "../proto/commands.ts";
import { patrolLegOutcome } from "../proto/brain.ts";
import { buildWorldState } from "../../../src/shared/bots/state.ts";
import type { PickupPlacement } from "../../../src/shared/pickups.ts";
import { homedir } from "node:os";
import { connectBot } from "../proto/connection.ts";
import { openNodeSocket } from "../proto/node-socket.ts";
import { runAttack, runBrain, runMission } from "../proto/brain.ts";
import { createCommandHost } from "../probe/commands-prototype.ts";
import { parseMission } from "../proto/missions.ts";


const args = new Map<string, string>();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) if (argv[i]!.startsWith("--")) args.set(argv[i]!.slice(2), argv[i + 1] ?? "");
const LABEL = args.get("label") ?? "184-offline";
const STAMP = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const LOGDIR = "plan/dsh-tasks/logs";
const NDJSON = join(LOGDIR, `${LABEL}-${STAMP}.ndjson`);
const SUMMARY = join(LOGDIR, `${LABEL}-${STAMP}.summary.md`);
mkdirSync(LOGDIR, { recursive: true });

const rows: Array<Record<string, unknown>> = [];
const record = (row: Record<string, unknown>): void => {
  const full = { label: LABEL, ...row };
  rows.push(full);
  appendFileSync(NDJSON, `${JSON.stringify(full)}\n`);
  console.log(`CASE ${JSON.stringify(full)}`);
};
const round1 = (n: number): number => Math.round(n * 10) / 10;

/** A plan-step action with the combat id shape and an explicit cost. */
const act = (id: string, pre: WorldState, eff: WorldState, cost: number): Action<BotCtx> => ({ id, pre, eff, cost });
const PLAN_MS = 600;

type Expect = { goal?: string; step?: string; none?: boolean };

/** Run one ladder case and report whether the expectation held. */
function reportCase(name: string, expect: Expect, state: WorldState, actions: Action<BotCtx>[], opts: { mission?: Goal; hp: number; underFire: boolean }): void {
  const started = performance.now();
  const chosenPlan: Plan | undefined = chooseCombatGoal(state, combatGoals(state, opts.mission), actions, undefined as unknown as BotCtx, () => ({
    deadlineMs: Date.now() + PLAN_MS,
    now: () => Date.now(),
    heuristic: (s: WorldState) => (s.hpHigh ? 0 : 1),
  }));
  const ms = performance.now() - started;
  const chosen = chosenPlan?.goal ?? "idle";
  const first = chosenPlan?.steps[0];
  const pass = expect.none === true
    ? chosenPlan === undefined
    : expect.step !== undefined
      ? first === expect.step
      : chosen === expect.goal;
  record({
    kind: "plan",
    case: name,
    hp: opts.hp,
    underFire: opts.underFire,
    chosen,
    want: expect.goal ?? (expect.step ?? "none"),
    firstStep: first ?? null,
    pass,
    steps: chosenPlan?.steps ?? null,
    planMs: round1(ms),
    expanded: chosenPlan?.expanded ?? 0,
    deadlineHit: chosenPlan === undefined && ms >= PLAN_MS,
  });
}

const crate = "health-crate-1";
const at = "outside";

// 1 hp30 + crate → survive / seekHealth
reportCase("hp30+crate", { goal: "survive", step: `seekHealth:${crate}` }, { at, hpWounded: true, [`avail:${crate}`]: true }, [
  act(`seekHealth:${crate}`, { hpWounded: true, [`avail:${crate}`]: true, at }, { hpHigh: true, [`avail:${crate}`]: false }, 2),
], { hp: 30, underFire: false });

// 2 hp80 + under fire + a near cover point → defend / takeCover
reportCase("hp80+underFire", { goal: "defend", step: "takeCover:1.0,1.0" }, { at, hpHigh: true, underFire: true, threatVisible: true }, [
  act("takeCover:1.0,1.0", { underFire: true, threatVisible: true }, { inCover: true, defended: true }, 1.5),
  act("returnFire:7", { hasWeapon: true, hasAmmo: true, threatVisible: true }, { threatDown: true, defended: true }, 8),
], { hp: 80, underFire: true });

// 3 hp100 + visible threat, assault order → assault / returnFire
reportCase("hp100+threat", { goal: "assault:7", step: "returnFire:7" }, { at, hpHigh: true, threatVisible: true, hasWeapon: true, hasAmmo: true }, [
  act("returnFire:7", { hasAmmo: true, hasWeapon: true }, { threatDown: true, defended: true }, 8),
  act("takeCover:1.0,1.0", { underFire: true, threatVisible: true }, { inCover: true, defended: true }, 1.5),
], { hp: 100, underFire: false, mission: assaultGoal(7) });

// 4 hp100, nothing → idle (no plan)
reportCase("hp100+none", { none: true, goal: "idle" }, { at, hpHigh: true }, [], { hp: 100, underFire: false });

// 5 critical + an assault order → survive wins, not the assault
reportCase("critical+order", { goal: "survive", step: `seekHealth:${crate}` }, { at, hpWounded: true, hpCritical: true, hasWeapon: true, hasAmmo: true, threatVisible: true, [`avail:${crate}`]: true }, [
  act(`seekHealth:${crate}`, { hpWounded: true, [`avail:${crate}`]: true, at }, { hpHigh: true, [`avail:${crate}`]: false }, 2),
  act("returnFire:7", { hasAmmo: true, hasWeapon: true }, { threatDown: true, defended: true }, 16),
], { hp: 20, underFire: false, mission: assaultGoal(7) });

// 6 wounded, no crate, no action → no plan (undefined; the caller falls back)
reportCase("no-crate", { none: true, goal: "none" }, { at, hpWounded: true }, [], { hp: 30, underFire: false });

// The cost knob: far cover (10 s) flips cover↔fire at the hp band boundary.
for (const [name, hp, wounded, step] of [
  ["flip-hp80", 80, false, "returnFire:7"],
  ["flip-hp40", 40, true, "takeCover:9.0,9.0"],
] as const) {
  const state: WorldState = { at, underFire: true, threatVisible: true, hasWeapon: true, hasAmmo: true, ...(wounded ? { hpWounded: true } : { hpHigh: true }) };
  reportCase(name, { goal: "defend", step }, state, [
    act("takeCover:9.0,9.0", { underFire: true, threatVisible: true }, { inCover: true, defended: true }, wounded ? 10 * 0.6 : 10),
    act("returnFire:7", { hasWeapon: true, hasAmmo: true, threatVisible: true }, { threatDown: true, defended: true }, wounded ? 8 * 2 : 8),
  ], { hp, underFire: true });
}

// ---- the live parity: control runAttack vs the planned ladder --------------
const URL_ = args.get("url");
const LIVE_MS = Number(args.get("seconds") ?? 30) * 1000;

async function liveParity(): Promise<void> {
  const token = (process.env.CE_TOKEN ?? "").trim()
    || readFileSync(join(homedir(), ".config/ce-arena/qa-token.pem"), "utf8").trim();
  const session = await connectBot({
    url: URL_ ?? "ws://127.0.0.1:4175",
    token,
    name: args.get("name") ?? "combat-goap",
    role: "qa",
    openSocket: openNodeSocket,
    onLog: (line) => console.log(`[conn] ${line}`),
  });
  const world = session.world;
  const joinAt = Date.now();
  while ((!world.self() || !world.sceneGraph()) && Date.now() - joinAt < 15_000) await new Promise((r) => setTimeout(r, 50));
  if (!world.self()) {
    record({ kind: "parity", mode: "abort", why: "no self" });
    session.close();
    return;
  }
  const host = createCommandHost({ session, log: (line) => console.log(`  [host] ${line}`) });
  const elapsed = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  world.self();
  record({ kind: "parity", mode: "join", self: world.self()!.id, place: world.placeOf(world.self()!)?.id ?? "?", weapon: world.weapon() ?? "none", ammo: world.ammo(), players: [...world.playerIds()] });

  const target = (): number | undefined => {
    const players = world.playerIds();
    const me = world.self();
    if (!me) return undefined;
    return world.others()
      .filter((pawn) => !players.has(pawn.id) && world.healthOf(pawn.id)?.dead !== true)
      .filter((pawn) => (world.placeOf(pawn)?.id ?? "") === "outside")
      .map((pawn) => ({ pawn, d: Math.hypot(pawn.x - me.x, pawn.z - me.z) }))
      .sort((a, b) => a.d - b.d)[0]?.pawn.id;
  };
  const runMode = async (mode: "control" | "planned"): Promise<void> => {
    const id = target();
    if (id === undefined) {
      record({ kind: "parity", mode, why: "no-target" });
      return;
    }
    const startHp = world.health()?.hp ?? null;
    let shots = 0;
    let kills = 0;
    let planSteps: string[] = [];
    let planMs = 0;
    const log = (line: string): void => {
      console.log(`  [${mode}] ${line}`);
      if (/attack: fire/.test(line)) shots += 1;
      if (/attack: dead/.test(line)) kills += 1;
      const m = /plan done (\d+)ms steps=(\d+) expanded=(\d+)/.exec(line);
      if (m) { planMs = Number(m[1]); planSteps = [`steps=${m[2]} expanded=${m[3]}`]; }
    };
    if (mode === "control") {
      await runMission(session, parseMission(`attack:${id}`)!, { timeoutMs: LIVE_MS, log, error: log });
    } else {
      await runBrain(session, assaultGoal(id), { timeoutMs: LIVE_MS, log, error: log });
    }
    const endHp = world.health()?.hp ?? null;
    record({ kind: "parity", mode, target: id, shots, kills, startHp, endHp, planMs, plan: planSteps });
  };

  try {
    // Arm through the prototype command surface (the same arm flow the suite uses).
    const arm = await host.dispatch({ id: "arm", name: "arm", args: {} }, { onLine: (line) => console.log(`  [arm] ${line}`) });
    record({ kind: "parity", mode: "arm", ok: arm.ok, why: arm.ok ? null : arm.why, weapon: world.weapon() ?? "none", ammo: world.ammo() });
    if (!arm.ok) return;
    await host.dispatch({ id: "reload", name: "reload", args: {} }, { onLine: (line) => console.log(`  [reload] ${line}`) });
    await runMode("control");
    await elapsed(1_000);
    await runMode("planned");
  } finally {
    session.close();
  }
}

if (args.has("live")) await liveParity();

// The rearm scoping: a dry, armed soldier on a reach mission keeps the mission;
// the same soldier on an assault order still gets rearm when no fire action plans.
const SCOPE_PLACE = "brutalist-building-1-cbake.floor-1.hall";
for (const [name, mission, want] of [
  ["rearm-scope-reach", reach(SCOPE_PLACE), "reach:" + SCOPE_PLACE],
  ["rearm-scope-assault", assaultGoal(7), "rearm"],
] as const) {
  const state: WorldState = { at, hasWeapon: true };
  const actions = [
    act("goTo:" + SCOPE_PLACE, {}, { at: SCOPE_PLACE }, 1),
    act("reload:crate", { [HAS_AMMO]: false }, { [HAS_AMMO]: true }, 2),
  ];
  reportCase(name, { goal: want }, state, actions, { hp: 100, underFire: false, mission });
}

// ---- 7 the locked-door closure, on the real graph --------------------------
const arena = loadArena();
const graph = parseSceneGraph(JSON.parse(readFileSync("web/game/scene-graph.json", "utf8")), arena.view.doors).graph;
if (!graph) {
  console.error("FATAL no scene graph");
  process.exit(2);
}
const KEY: PickupPlacement = {
  id: "key", kind: "key", model: "key.glb", amount: 1,
  minX: -7.1, maxX: -6.7, minY: 0.8, maxY: 1.2, minZ: 27.2, maxZ: 27.6,
} as PickupPlacement;
/** A health crate synthesised inside the locked hall (the real one is outside). */
const HALL_CRATE: PickupPlacement = {
  id: "health-crate-hall", kind: "health", model: "crate.glb", amount: 1,
  minX: -30, maxX: -29.6, minY: 0.2, maxY: 0.6, minZ: 27.2, maxZ: 27.6,
} as PickupPlacement;
const pickups = [KEY, HALL_CRATE];
const doors = arena.view.doors.map((door) => ({ id: door.id, open: false, locked: door.locked === true }));
const baseState = buildWorldState({ at: "outside", pickups: pickups.map((p) => p.id), doors });
const state = { ...baseState, hpWounded: true } as WorldState;
const ctx = createBotContext(graph, pickups);
const cratePlace = placeOfPickup(graph, HALL_CRATE);
// The union the brain grounds with: the crate's place must be in it, or no goTo.
const grounded = groundActions(graph, pickups, [{ want: { at: cratePlace } }]);
const seek = act(`seekHealth:${HALL_CRATE.id}`, { hpWounded: true, [`avail:${HALL_CRATE.id}`]: true, at: cratePlace }, { hpHigh: true, [`avail:${HALL_CRATE.id}`]: false }, 1);
const closureStart = performance.now();
const closurePlan = plan(state, { id: "survive", want: { hpHigh: true }, priority: () => 80 }, [...grounded, seek], ctx, {
  // The production cold budget (COLD_PLAN_BUDGET_MS), not the 600 ms warm one:
  // this state is new, so the route rows compile inside the search.
  deadlineMs: Date.now() + 4_000,
  now: () => Date.now(),
  heuristic: () => 0,
});
const closureMs = performance.now() - closureStart;
record({
  kind: "closure",
  case: "locked-cache",
  cratePlace,
  actions: grounded.length,
  chosen: closurePlan?.goal ?? "none",
  pass: closurePlan !== undefined && closurePlan.steps[0] === "pickup:key",
  steps: closurePlan?.steps ?? null,
  planMs: round1(closureMs),
  expanded: closurePlan?.expanded ?? 0,
});
if (!closurePlan) {
  const ids = new Set(grounded.map((a) => a.id));
  record({ kind: "closure-debug", hasGoTo: ids.has(`goTo:${cratePlace}`), hasPickup: ids.has(`pickup:${HALL_CRATE.id}`), hasUnlock: [...ids].some((id) => id.startsWith("unlock:")), sample: [...ids].filter((id) => id.includes("hall")).slice(0, 10) });
}

// ---- 8 the floor heuristic: a wounded survive plan over the real graph -----
// An open far place, so the route is finite and the floor is a real distance.
const FAR = "brutalist-building-2-cbake-3.rect21094-3-6";
const farBounds = graph.placeById.get(FAR)?.bounds;
if (!farBounds) throw new Error(`no bounds for ${FAR}`);
const farX = (farBounds.minX + farBounds.maxX) / 2;
const farZ = (farBounds.minZ + farBounds.maxZ) / 2;
const FAR_CRATE: PickupPlacement = {
  id: "health-crate-far", kind: "health", model: "crate.glb", amount: 1,
  minX: farX - 0.2, maxX: farX + 0.2, minY: 0.2, maxY: 0.6, minZ: farZ - 0.2, maxZ: farZ + 0.2,
} as PickupPlacement;
const farPlace = placeOfPickup(graph, FAR_CRATE);
{
  const farPickups = [KEY, FAR_CRATE];
  const farGround = groundActions(graph, farPickups, [{ want: { at: farPlace } }]);
  const farStart = buildWorldState({ at: "outside", pickups: farPickups.map((x) => x.id), doors });
  const state = { ...farStart, hpWounded: true } as WorldState;
  const farCtx = createBotContext(graph, farPickups);
  const seekFar: Action<BotCtx> = {
    id: `seekHealth:${FAR_CRATE.id}`,
    pre: { hpWounded: true, [`avail:${FAR_CRATE.id}`]: true, at: farPlace },
    eff: { hpHigh: true, [`avail:${FAR_CRATE.id}`]: false },
    cost: (s, c) => Math.max(0.5, c.routeCost(String(s.at), farPlace, s)) / 4,
  };
  const acts = [...farGround, seekFar];
  const goal: Goal = { id: "survive", want: { hpHigh: true }, priority: () => 80 };
  for (const [mode, heuristic] of [
    ["flat", () => 0],
    ["floor", combatHeuristic(goal, acts, farCtx)],
  ] as const) {
    const started = performance.now();
    const found = plan(state, goal, acts, farCtx, { deadlineMs: Date.now() + 4_000, now: () => Date.now(), heuristic });
    record({
      kind: "floor",
      case: `survive-${mode}`,
      place: farPlace,
      steps: found?.steps ?? null,
      expanded: found?.expanded ?? null,
      planMs: round1(performance.now() - started),
      pass: found !== undefined,
    });
  }
}

// ---- 9 the heal as a goal (193), on the real graph -------------------------
// The health crates come from the props placements (the arena view carries only
// weapons/keys). `combatActions` needs a session; a minimal fake world is enough
// because the heal path reads no pawn/health state.
const crateProps = JSON.parse(readFileSync("web/game/props.placements.json", "utf8"));
const allProps: Array<{ id: string; type: string; position: [number, number, number] }> = crateProps.placements ?? crateProps;
const asPlacement = (p: { id: string; type: string; position: [number, number, number] }): PickupPlacement => ({
  id: p.id, kind: p.type, model: "x", amount: 1,
  minX: p.position[0] - 0.2, maxX: p.position[0] + 0.2,
  minY: p.position[1], maxY: p.position[1] + 0.4,
  minZ: p.position[2] - 0.2, maxZ: p.position[2] + 0.2,
} as PickupPlacement);
const healthProps = allProps.filter((p) => p.type === "health");
const floorCrateProp = healthProps.find((p) => p.id === "cover-crate-2-6-0") ?? healthProps[0]!;
const raisedCrateProp = healthProps.find((p) => p.position[1] >= 3);
const fakeSession = (self: { x: number; y: number; z: number }, placements: PickupPlacement[], hostiles: Array<{ x: number; y: number; z: number }> = [], boxes: Array<{ minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number }> = [], dead: Set<number> = new Set<number>(), players: Set<number> = new Set<number>()) => ({
  world: {
    self: () => ({ id: 1, x: self.x, y: self.y, z: self.z, yaw: 0 }),
    others: () => hostiles.map((h, i) => ({ id: 90 + i, x: h.x, y: h.y, z: h.z, yaw: 0 })),
    playerIds: () => players,
    healthOf: (id: number) => ({ hp: dead.has(id) ? 0 : 100, alive: !dead.has(id), dead: dead.has(id) }),
    aabbs: boxes,
    pickups: () => placements.map((p) => p.id),
    pickupPlacements: () => placements,
    placeOf: (pos: { x: number; y: number; z: number }) => ({ id: placeAt(graph!, pos.x, pos.y, pos.z).id, kind: "place" }),
    sceneGraph: () => graph,
    weapon: () => "",
    ammo: () => 0,
  },
});

const healCase = (
  name: string,
  crateProp: { id: string; position: [number, number, number] },
  self: { x: number; y: number; z: number },
  hp: number,
): void => {
  const item = asPlacement(crateProp as { id: string; type: string; position: [number, number, number] });
  const placements = [item];
  const place = placeOfPickup(graph!, item);
  const session = fakeSession(self, placements);
  const actx = createBotContext(graph!, placements);
  // `goTo` is the base action the brain grounds for the crate place; the
  // fake harness adds it explicitly so the indoor/raised cases plan.
  const acts = [...combatActions(session as never, actx), goTo(place)];
  const selfPlace = placeAt(graph!, self.x, self.y, self.z).id;
  const state = { ...buildWorldState({ at: selfPlace, pickups: [item.id], doors }), safe: true, ...(hp <= 50 ? { hpWounded: true } : {}), ...(hp < 25 ? { hpCritical: true } : {}), ...(hp >= 70 ? { hpHigh: true } : {}) } as WorldState;
  const started = performance.now();
  const chosen = chooseCombatGoal(state, combatGoals(state), acts, actx, (g) => ({
    deadlineMs: Date.now() + 600,
    now: () => Date.now(),
    minCost: actx.minActionS,
    heuristic: (s: WorldState) => Math.max(estimateSeconds(g, actx, placements)(s), combatHeuristic(g, acts, actx)(s)),
  }));
  const seek = acts.find((a) => a.id.startsWith("seekHealth:"));
  const criticalCost = seek && typeof seek.cost === "function" ? seek.cost({ ...state, hpCritical: true } as WorldState, actx) : null;
  record({ kind: "heal", case: name, crate: item.id, cratePlace: place, hp, chosen: chosen?.goal ?? "idle", steps: chosen?.steps ?? null, planMs: round1(performance.now() - started), expanded: chosen?.expanded ?? null, criticalCost: criticalCost === null ? null : round1(criticalCost * 1000) / 1000, pass: hp >= 70 ? chosen === undefined : (chosen?.steps?.[0]?.startsWith("seekHealth:") || chosen?.steps?.[0]?.startsWith("goTo:")) === true });
};

// The place inventory: one row per health crate (the three resolvers).
for (const p of healthProps) {
  const item = asPlacement(p);
  const place = placeOfPickup(graph!, item);
  const at03 = placeAt(graph!, (item.minX + item.maxX) / 2, 0.3, (item.minZ + item.maxZ) / 2).id;
  const atMin = placeAt(graph!, (item.minX + item.maxX) / 2, (item.minY ?? 0) + 0.2, (item.minZ + item.maxZ) / 2).id;
  record({ kind: "place", id: p.id, minY: item.minY, maxY: item.maxY, placeOfPickup: place, placeAt03: at03, placeAtMinY02: atMin, inGraph: graph!.placeById.has(place) });
}

const floorCrate = asPlacement(floorCrateProp as { id: string; type: string; position: [number, number, number] });
const floorPlace = placeOfPickup(graph!, floorCrate);
const floorSelf = (floorCrateProp as { position: [number, number, number] }).position;
healCase("heal-inplace", floorCrateProp as never, { x: floorSelf[0], y: floorSelf[1], z: floorSelf[2] }, 30);
healCase("heal-indoor", floorCrateProp as never, { x: -22.64, y: 0, z: 27.16 }, 30);
healCase("hp30+crate", floorCrateProp as never, { x: floorSelf[0], y: floorSelf[1], z: floorSelf[2] }, 30);
healCase("hp20+crate", floorCrateProp as never, { x: floorSelf[0], y: floorSelf[1], z: floorSelf[2] }, 20);
healCase("hp80+crate", floorCrateProp as never, { x: floorSelf[0], y: floorSelf[1], z: floorSelf[2] }, 80);
if (raisedCrateProp) healCase("raised-crate", raisedCrateProp as never, { x: -22.64, y: 0, z: 27.16 }, 30);

// ---- 10 survive: break contact before the critical heal (197) ---------------
const surviveCase = (
  name: string,
  hp: number,
  threatDist: number | null,
  opts: { crate?: boolean; underFire?: boolean; mission?: boolean; threats?: number; expect: string } = { expect: "" },
): void => {
  const placements = opts.crate === false ? [] : [asPlacement(floorCrateProp as never)];
  const self = { x: -22.64, y: 0, z: 27.16 };
  const hostiles = threatDist === null
    ? []
    : Array.from({ length: opts.threats ?? 1 }, (_, i) => ({ x: self.x + threatDist + i * 0.1, y: 0, z: self.z }));
  const session = fakeSession(self, placements, hostiles);
  const actx = createBotContext(graph!, placements);
  const acts = combatActions(session as never, actx, { onNote: () => undefined });
  const place = placeOfPickup(graph!, asPlacement(floorCrateProp as never));
  const facts: Record<string, unknown> = { at: place, pickups: placements.map((p) => p.id), doors };
  if (hp >= 70) facts.hpHigh = true;
  if (hp <= 50) facts.hpWounded = true;
  if (hp < 25) facts.hpCritical = true;
  if (hp < 25 || (hp <= 50 && hostiles.length >= 2)) facts.hpPressured = true;
  if (opts.underFire) facts.underFire = true;
  if (!opts.underFire && hostiles.length === 0 && threatDist === null) facts.safe = true;
  if (facts.hpPressured === true || (facts.hpWounded === true && facts.safe !== true)) facts.needsRetreat = true;
  // buildWorldState only emits its own facts; overlay the hp/safe facts.
  const state = { ...buildWorldState({ at: place, pickups: placements.map((p2) => p2.id), doors }), ...facts } as WorldState;
  const mission = opts.mission ? { id: "assault", want: { threatDown: true }, priority: () => 60 } : undefined;
  const ladder = combatGoals(state, mission);
  const started = performance.now();
  const chosen = chooseCombatGoal(state, ladder, acts, actx, (g) => ({
    deadlineMs: Date.now() + 600, now: () => Date.now(), minCost: actx.minActionS,
    heuristic: (s: WorldState) => combatHeuristic(g, acts, actx)(s),
  }));
  const seek = acts.filter((a) => a.id.startsWith("seekHealth:")).map((a) => ({ id: a.id, pre: a.pre, usable: typeof a.usable === "function" ? a.usable(state, actx) : undefined }));
  if (name === "critical+no-threat+crate") console.log("DBG", JSON.stringify({ ladder: ladder.map((g) => `${g.id}@${g.priority(state)}`), seek, at: state.at, avail: state["avail:" + placements[0]?.id] }));
  const ids = new Set(acts.map((a) => a.id));
  record({
    kind: "survive", case: name, hp, threats: hostiles.length, crate: opts.crate !== false,
    chosen: chosen?.goal ?? "idle", steps: chosen?.steps ?? null,
    retreatGrounded: [...ids].some((i) => i.startsWith("retreat:")), planMs: round1(performance.now() - started),
    pass: opts.expect === "none" ? chosen === undefined : chosen?.goal === opts.expect,
  });
};
surviveCase("critical+threat+crate", 20, 8, { expect: "survive" });
surviveCase("critical+no-threat+crate", 20, null, { expect: "survive" });
surviveCase("critical+no-crate", 20, 8, { crate: false, underFire: true, expect: "none" });
surviveCase("hp40+crate", 40, null, { expect: "heal" });
surviveCase("hp50+2threats+crate", 50, 8, { threats: 2, expect: "survive" });
surviveCase("critical+assault", 20, 8, { mission: true, expect: "survive" });
surviveCase("hp40+threat+exit", 40, 8, { expect: "heal" });

// ---- 11 defend: the live defended fact (198) ------------------------------
const defendedFact = (name: string, cfg: { threat?: boolean; boxes?: boolean; dead?: boolean; mission?: number; underFire?: boolean; expect: boolean }): void => {
  const self = { x: -22.64, y: 0, z: 27.16 };
  const hostiles = cfg.threat ? [{ x: self.x + 8, y: 0, z: self.z }] : [];
  const boxes = cfg.boxes ? [{ minX: self.x + 3, maxX: self.x + 4, minY: 0, maxY: 2, minZ: self.z - 1, maxZ: self.z + 1 }] : [];
  const session = fakeSession(self, [], hostiles, boxes, cfg.dead ? new Set([90]) : new Set<number>());
  const facts = combatFacts(session as never, { hp: 80, at: cfg.underFire ? Date.now() : Date.now() - 5_000 }, Date.now(), { missionTarget: cfg.mission });
  record({ kind: "defend-fact", case: name, defended: facts.defended === true, expect: cfg.expect, pass: (facts.defended === true) === cfg.expect, threatKey: threatWatchKey(session as never) });
};
defendedFact("in-cover (mission target, LOS blocked)", { mission: 90, boxes: true, expect: true });
defendedFact("targetDown", { threat: true, dead: true, expect: true });
defendedFact("hidden shooter, damage memory hot", { underFire: true, expect: false });
defendedFact("threat gone", { expect: true });

const defendPlan = (name: string, cfg: { ammo?: boolean; target?: number; expect: string }): void => {
  const ammoProp = allProps.find((p2) => p2.type === "ammo");
  const placements = cfg.ammo ? [asPlacement(ammoProp as never)] : [];
  const self = { x: -22.64, y: 0, z: 27.16 };
  const session = fakeSession(self, placements, [{ x: self.x + 8, y: 0, z: self.z }]);
  const actx = createBotContext(graph!, placements);
  const acts = combatActions(session as never, actx, { target: cfg.target, onNote: () => undefined });
  const facts = combatFacts(session as never, { hp: 80, at: Date.now() }, Date.now(), {});
  const base = { ...buildWorldState({ at: "outside", pickups: placements.map((p2) => p2.id), doors }), ...facts } as WorldState;
  // The fake world has no weapon/ammo; the action preconditions read the state.
  const state = { ...base, hasWeapon: true, ...(cfg.expect === "defend" ? { hasAmmo: true } : {}) } as WorldState;
  const turnedOff = Object.fromEntries(Object.entries(state).filter(([k]) => k !== "defended"));
  const chosen = chooseCombatGoal(turnedOff as WorldState, combatGoals(turnedOff as WorldState), acts, actx, (g) => ({ deadlineMs: Date.now() + 600, now: () => Date.now(), minCost: actx.minActionS, heuristic: (s: WorldState) => combatHeuristic(g, acts, actx)(s) }));
  record({ kind: "defend", case: name, chosen: chosen?.goal ?? "idle", steps: chosen?.steps ?? null, pass: (chosen?.goal ?? "idle") === cfg.expect });
};
defendPlan("underFire+returnFire", { target: 90, expect: "defend" });
defendPlan("underFire+rearm", { ammo: true, expect: "rearm" });

// ---- 12 assault: live threatDown + hostile set (199) ----------------------
const assaultCase = (name: string, cfg: { dead?: boolean; absent?: boolean; players?: boolean; enemies?: boolean; target?: number; expect: string }): void => {
  const self = { x: -22.64, y: 0, z: 27.16 };
  const hostiles = cfg.absent ? [] : [{ x: self.x + 8, y: 0, z: self.z }];
  const players = cfg.players ? new Set<number>([90]) : new Set<number>();
  const enemies = cfg.enemies ? new Set<number>([90]) : new Set<number>();
  const session = fakeSession(self, [], hostiles, [], cfg.dead ? new Set<number>([90]) : new Set<number>(), players);
  const actx = createBotContext(graph!, []);
  const target = cfg.target ?? 90;
  const facts = combatFacts(session as never, { hp: 80, at: Date.now() - 5_000 }, Date.now(), { missionTarget: target, enemies });
  const acts = combatActions(session as never, actx, { target, enemies });
  const state = { ...buildWorldState({ at: "outside", pickups: [], doors }), ...facts, hasWeapon: true, hasAmmo: true } as WorldState;
  const mission = { id: `assault:${target}`, want: { threatDown: true }, priority: () => 60 };
  const chosen = chooseCombatGoal(state, combatGoals(state, mission), acts, actx, (g) => ({ deadlineMs: Date.now() + 600, now: () => Date.now(), minCost: actx.minActionS, heuristic: (s: WorldState) => combatHeuristic(g, acts, actx)(s) }));
  record({ kind: "assault", case: name, target, threatDown: facts.threatDown === true, threatVisible: facts.threatVisible === true, chosen: chosen?.goal ?? "idle", steps: chosen?.steps ?? null, pass: (chosen?.goal ?? "idle") === cfg.expect });
};
assaultCase("assault-live-target", { expect: "assault:90" });
assaultCase("assault-target-dead", { dead: true, expect: "idle" });
assaultCase("assault-target-absent-not-dead", { absent: true, target: 12, expect: "assault:12" });
// the hostile set: a player is visible only when declared
const playerThreat = (enemies: boolean): string | undefined => {
  const self = { x: -22.64, y: 0, z: 27.16 };
  const session = fakeSession(self, [], [{ x: self.x + 8, y: 0, z: self.z }], [], new Set<number>(), new Set<number>([90]));
  return visibleThreat(session as never, enemies ? new Set<number>([90]) : new Set<number>())?.id === 90 ? "hostile" : "friendly";
};
record({ kind: "assault", case: "player-in-enemies", threat: playerThreat(true), pass: playerThreat(true) === "hostile" });
record({ kind: "assault", case: "player-not-in-enemies", threat: playerThreat(false), pass: playerThreat(false) === "friendly" });

// ---- 13 regroup: an anchor order at 45 (200) ------------------------------
const REGROUP_ANCHOR = "outside";
const regroupCase = (name: string, cfg: { hp?: number; underFire?: boolean; crate?: boolean; target?: number; expect: string }): void => {
  const self = { x: -22.64, y: 0, z: 27.16 };
  const crate = asPlacement(floorCrateProp as never);
  const placements = cfg.crate === false ? [] : [crate];
  const hostiles = cfg.underFire ? [{ x: self.x + 8, y: 0, z: self.z }] : [];
  const session = fakeSession(self, placements, hostiles);
  const actx = createBotContext(graph!, placements);
  const facts = combatFacts(session as never, { hp: cfg.hp ?? 80, at: cfg.underFire ? Date.now() : Date.now() - 5_000 }, Date.now(), {});
  const acts = combatActions(session as never, actx, { target: cfg.target });
  const place = placeOfPickup(graph!, crate);
  const state = { ...buildWorldState({ at: "brutalist-building-1-cbake.floor-1.hall", pickups: placements.map((p2) => p2.id), doors }), ...facts, hasWeapon: true, hasAmmo: true } as WorldState;
  const goal = regroupGoal(REGROUP_ANCHOR);
  const ground = groundActions(graph!, placements, [goal]);
  const groundIds = new Set(ground.map((a) => a.id));
  const actions = [...ground, ...acts];
  const chosen = chooseCombatGoal(state, combatGoals(state, goal), actions, actx, (g) => ({ deadlineMs: Date.now() + 600, now: () => Date.now(), minCost: actx.minActionS, heuristic: (s: WorldState) => combatHeuristic(g, actions, actx)(s) }));
  record({ kind: "regroup", case: name, anchor: REGROUP_ANCHOR, goToGrounded: groundIds.has(`goTo:${REGROUP_ANCHOR}`), chosen: chosen?.goal ?? "idle", steps: chosen?.steps ?? null, pass: (chosen?.goal ?? "idle") === cfg.expect });
};
regroupCase("reachable-anchor", { expect: `regroup:${REGROUP_ANCHOR}` });
regroupCase("underFire-defend-wins", { underFire: true, target: 90, expect: "defend" });
regroupCase("hp20-survive-wins", { hp: 20, expect: "survive" });
// locked anchor shape: synthetic key → unlock → goTo
const lockedActions: Action<unknown>[] = [
  { id: "pickup:key", pre: {}, eff: { hasKey: true }, cost: () => 0.5 },
  { id: "unlock:door", pre: { hasKey: true }, eff: { doorOpen: true }, cost: () => 0.5 },
  { id: "goTo:anchor", pre: { doorOpen: true }, eff: { at: "anchor" }, cost: () => 1 },
] as never;
const lockedPlan = plan({ at: "start" } as never, { id: "regroup:anchor", want: { at: "anchor" }, priority: () => 45 }, lockedActions as never, createBotContext(graph!, []), { deadlineMs: Date.now() + 600, now: () => Date.now(), minCost: 0.1 });
record({ kind: "regroup", case: "locked-anchor-shape", steps: lockedPlan?.steps ?? null, pass: lockedPlan?.steps?.join(">") === "pickup:key>unlock:door>goTo:anchor" });
// bad anchor: parse + graph membership
const badParse = parseCommand({ name: "regroup", args: { place: "" } });
record({ kind: "regroup", case: "bad-anchor", parseError: "error" in badParse, graphHasFake: graph!.placeById.has("no-such-place-xyz"), pass: ("error" in badParse) && !graph!.placeById.has("no-such-place-xyz") });

// ---- 14 patrol leg policy (201) -------------------------------------------
const patrolRow = (name: string, code: number, noPlan: string | null, skips: number, retried: boolean, expect: string): void => {
  const out = patrolLegOutcome(code, noPlan, skips, retried);
  record({ kind: "patrol", case: name, outcome: out.action, skips: out.consecutiveSkips, pass: out.action === expect });
};
patrolRow("leg-reached", 0, null, 0, false, "advance");
patrolRow("leg-no-plan-retry", 2, "unsatisfiable", 0, false, "retry");
patrolRow("leg-no-plan-skip", 2, "unsatisfiable", 0, true, "skip");
patrolRow("leg-second-skip-stops", 2, "unsatisfiable", 1, true, "stop");
patrolRow("code2-without-plan-propagates", 2, null, 0, false, "propagate");
patrolRow("timeout-propagates", 3, null, 0, false, "propagate");

// ---- 15 reload re-scan policy (202) ---------------------------------------
const rrRow = (candidates: string[], tried: string[], expect: string): void => {
  const rows = candidates.map((id) => ({ item: { id } }));
  const chosen = nextReloadCandidate(rows, new Set(tried));
  record({ kind: "reload-policy", case: `next(${candidates.join(",")}|tried=${tried.join(",")})`, chosen: chosen?.item.id ?? "none", pass: (chosen?.item.id ?? "none") === expect });
};
rrRow(["a", "b", "c"], [], "a");
rrRow(["a", "b", "c"], ["a"], "b");
rrRow(["pin", "a", "b"], [], "pin");
rrRow(["pin", "a", "b"], ["pin"], "a");
const rvRow = (scan: number, attempts: Array<{ crate: string; why: string }>, expect: string): void => {
  const v = reloadVerdict(scan, attempts);
  record({ kind: "reload-policy", case: `verdict(${scan}|${attempts.length})`, why: v.why, crate: v.crate ?? "-", pass: v.why === expect });
};
rvRow(0, [], "no-crate");
rvRow(2, [], "gone");
rvRow(2, [{ crate: "a", why: "no-plan:x" }, { crate: "b", why: "gone" }], "gone");

// ---- summary ---------------------------------------------------------------
const plans = rows.filter((row) => row.kind === "plan");
const closure = rows.find((row) => row.kind === "closure");
const lines = [
  `# 184 combat-goap — ${LABEL} (${STAMP})`,
  "",
  `| case | hp | under fire | want | chosen | first step | ms | pass |`,
  `|---|---|---|---|---|---|---|---|`,
  ...plans.map((r) => `| ${r.case} | ${r.hp} | ${r.underFire} | ${r.want} | ${r.chosen} | ${r.firstStep ?? "—"} | ${r.planMs} | ${r.pass} |`),
  "",
  `| floor | case | place | steps | expanded | ms | pass |`,
  `|---|---|---|---|---|---|---|`,
  ...rows.filter((r) => r.kind === "floor").map((r) => `| floor | ${r.case} | ${r.place} | ${(r.steps as string[] | null)?.join(" → ") ?? "—"} | ${r.expanded} | ${r.planMs} | ${r.pass} |`),
  "",
  `| closure | crate place | actions | steps | ms | pass |`,
  `|---|---|---|---|---|---|`,
  ...(closure ? [`| locked-cache | ${closure.cratePlace} | ${closure.actions} | ${(closure.steps as string[] | null)?.join(" → ") ?? "—"} | ${closure.planMs} | ${closure.pass} |`] : []),
  "",
  `Rows: ${NDJSON}`,
  "",
];
writeFileSync(SUMMARY, lines.join("\n"));
const failed = plans.filter((r) => r.pass !== true);
console.log(`SUMMARY ${SUMMARY} rows=${rows.length}`);
console.log(`VERDICT matrices=${plans.length} failed=${failed.length} closure=${closure?.pass === true ? "pass" : "FAIL"}`);
process.exit(failed.length === 0 && closure?.pass === true ? 0 : 1);
