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
import { createBotContext, groundActions, placeOfPickup, type BotCtx } from "../../../src/shared/bots/actions.ts";
import { assaultGoal, chooseCombatGoal, combatGoals, combatHeuristic } from "../proto/combat.ts";
import { HAS_AMMO } from "../../../src/shared/bots/state.ts";
import { reach } from "../../../src/shared/bots/goals.ts";
import { plan, type Action, type Goal, type Plan, type WorldState } from "../../../src/shared/bots/goap.ts";
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
