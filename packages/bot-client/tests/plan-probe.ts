// Task 177: offline GOAP planner-seam measurements, the review's §2 reproduced.
// Loads the real arena scene graph and measures, as rows:
//   1 ground   — groundActions cost/count for reach, stand, the cache, the union
//   2 heuristic — default (unmet×minCost) vs estimateSeconds on one goal
//   3 stand    — the stand-in-locked-hall case at 5 s and at the 600 ms gate
//   5 ladder   — chooseGoal over [survive, defend, assault, idle] for four states
// Written before the proto edits; it is a probe, not a test and not a suite.
// Run: node --import ./scripts/ts-ext-register.mjs packages/bot-client/tests/plan-probe.ts \
//   --label 177-plan --case all
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadArena } from "../../../src/server/world-loader.ts";
import { parseSceneGraph } from "../../../src/shared/scene-graph.ts";
import type { SceneGraph } from "../../../src/shared/scene-graph.ts";
import { createBotContext, estimateSeconds, groundActions, type BotCtx } from "../../../src/shared/bots/actions.ts";
import { chooseGoal, type Goal, type Plan, type WorldState } from "../../../src/shared/bots/goap.ts";
import { reach } from "../../../src/shared/bots/goals.ts";
import { standAt, type StandGoal } from "../../../src/shared/bots/goals.ts";
import { buildWorldState, STAND } from "../../../src/shared/bots/state.ts";
import { resolveStand, standKey, type Stand } from "../../../src/shared/nav/stand.ts";
import type { PickupPlacement } from "../../../src/shared/pickups.ts";
import { doorStand } from "../../../src/shared/nav/follow.ts";

const args = new Map<string, string>();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) if (argv[i]!.startsWith("--")) args.set(argv[i]!.slice(2), argv[i + 1] ?? "");
const LABEL = args.get("label") ?? "177-plan";
const CASE = args.get("case") ?? "all";
const STAMP = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const LOGDIR = "plan/dsh-tasks/logs";
const NDJSON = join(LOGDIR, `${LABEL}-${STAMP}.ndjson`);
const SUMMARY = join(LOGDIR, `${LABEL}-${STAMP}.summary.md`);
mkdirSync(LOGDIR, { recursive: true });

/** The hall whose reach plans with the key, and whose stand needs it unnamed. */
const HALL = "brutalist-building-1-cbake-0.floor-1.hall";
/** The review's key placement (the repo's outside key). */
const KEY: PickupPlacement = { id: "key", kind: "key", model: "key.glb", amount: 1, minX: -7.1, maxX: -6.7, minY: 0.8, maxY: 1.2, minZ: 27.2, maxZ: 27.6 } as PickupPlacement;
const pickups: PickupPlacement[] = [KEY];

const rows: Array<Record<string, unknown>> = [];
const record = (row: Record<string, unknown>): void => {
  const full = { t: Date.now(), label: LABEL, ...row };
  rows.push(full);
  appendFileSync(NDJSON, `${JSON.stringify(full)}\n`);
  const keys = Object.entries(row).map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`).join(" ");
  console.log(`${row.kind} ${keys}`);
};
const now = (): number => Date.now();
const round1 = (n: number): number => Math.round(n * 10) / 10;

const arena = loadArena();
const graph: SceneGraph | undefined = parseSceneGraph(
  JSON.parse(readFileSync("web/game/scene-graph.json", "utf8")),
  arena.view.doors,
).graph;
if (!graph) {
  console.error("FATAL no scene graph");
  process.exit(2);
}
const doors = arena.view.doors.map((door) => ({ id: door.id, open: false, locked: door.locked === true }));
const start: WorldState = buildWorldState({ at: "outside", pickups: pickups.map((p) => p.id), doors });
if (!graph.placeById.has(HALL)) {
  console.error(`FATAL no place ${HALL}`);
  process.exit(2);
}

/** The stand point on the hall side of the hall's own locked door. */
function hallStand(): { stand: Stand; doorId: string; portalLocked: boolean } {
  const portal = graph!.portals.find((p) => p.kind === "door" && (p.a === HALL || p.b === HALL));
  if (!portal) throw new Error(`no door portal touches ${HALL}`);
  const doorId = portal.door ?? portal.id;
  const body = arena.view.doors.find((door) => door.id === doorId);
  if (!body) throw new Error(`no door body ${doorId}`);
  for (const side of ["in", "out"] as const) {
    const point = doorStand(body, side);
    const resolved = resolveStand({ kind: "point", x: point.x, y: point.y, z: point.z }, graph!, arena.view.doors);
    if (resolved?.place === HALL) return { stand: resolved, doorId, portalLocked: portal.locked === true };
  }
  // Fall back to the portal's own hall-side anchor (`at.a`/`at.b` are tuples).
  const anchor = portal.a === HALL ? portal.at.a : portal.at.b;
  const resolved = resolveStand({ kind: "point", x: anchor[0], y: anchor[1], z: anchor[2] }, graph!, arena.view.doors);
  if (!resolved) throw new Error(`cannot resolve a stand in ${HALL}`);
  return { stand: resolved, doorId, portalLocked: portal.locked === true };
}

const timeIt = <T>(fn: () => T): { value: T; ms: number } => {
  const t0 = performance.now();
  const value = fn();
  return { value, ms: performance.now() - t0 };
};

const planRow = (
  seam: string,
  goal: Goal,
  plan: Plan | undefined,
  ms: number,
  extra: Record<string, unknown> = {},
): void =>
  record({
    kind: "plan",
    seam,
    goal: goal.id,
    planMs: round1(ms),
    expanded: plan?.expanded ?? null,
    steps: plan?.steps.length ?? 0,
    stepsList: plan?.steps ?? null,
    cost: plan ? round1(plan.cost) : null,
    ...extra,
  });

/** Action ids by family, so a goal-shaped grounding bill is visible in one line. */
const actionKinds = (actions: ReadonlyArray<{ id: string }>): string =>
  Object.entries(
    actions.reduce<Record<string, number>>((acc, act) => {
      const kind = act.id.slice(0, act.id.indexOf(":") < 0 ? act.id.length : act.id.indexOf(":"));
      acc[kind] = (acc[kind] ?? 0) + 1;
      return acc;
    }, {}),
  )
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([kind, n]) => `${kind}:${n}`)
    .join(",");

// ---- seam 2: the two heuristics on the same reach goal ----------------------
function caseHeuristic(): void {
  const goal = reach(HALL);
  const ctx = createBotContext(graph!, pickups);
  const grounded = timeIt(() => groundActions(graph!, pickups, [goal]));
  record({ kind: "ground", seam: "heuristic", goal: goal.id, groundMs: round1(grounded.ms), actions: grounded.value.length, kinds: actionKinds(grounded.value) });
  for (const [name, heuristic] of [
    ["default", undefined],
    ["route", estimateSeconds(goal, ctx, pickups)],
  ] as const) {
    const run = timeIt(() =>
      chooseGoal(start, [goal], grounded.value, ctx, {
        deadlineMs: now() + 8_000,
        now,
        ...(heuristic ? { heuristic } : {}),
      }),
    );
    planRow(name === "default" ? "heuristic-default" : "heuristic-route", goal, run.value, run.ms, { heuristic: name });
  }
}

// ---- seam 1 + 3: grounding cost/cache/union, the stand-in-locked-hall ------
function caseGround(): { stand: Stand; unionActions: ReturnType<typeof groundActions>; gatePass: boolean; gateMs: number } {
  const { stand, doorId, portalLocked } = hallStand();
  const standGoal: StandGoal = standAt({
    kind: "point",
    x: stand.x,
    y: stand.y,
    z: stand.z,
    yaw: stand.yaw,
  });
  const reachGoal = reach(HALL);
  const ctx = createBotContext(graph!, pickups);
  const route = estimateSeconds(standGoal, ctx, pickups, stand);

  // before: per-goal grounding, the proto's `[goal]` call
  const reachOnly = timeIt(() => groundActions(graph!, pickups, [reachGoal]));
  record({ kind: "ground", seam: "reach", goal: reachGoal.id, groundMs: round1(reachOnly.ms), actions: reachOnly.value.length, kinds: actionKinds(reachOnly.value), standKey: null });
  const standOnly = timeIt(() => groundActions(graph!, pickups, [standGoal], stand));
  record({ kind: "ground", seam: "stand", goal: standGoal.id, groundMs: round1(standOnly.ms), actions: standOnly.value.length, kinds: actionKinds(standOnly.value), standKey: stand.key, doorId, portalLocked });
  // The review's benchmark call: `[goal]` with no `stand` — the stand action is never grounded.
  const standNoArg = timeIt(() => groundActions(graph!, pickups, [standGoal]));
  record({ kind: "ground", seam: "stand-no-stand-arg", goal: standGoal.id, groundMs: round1(standNoArg.ms), actions: standNoArg.value.length, kinds: actionKinds(standNoArg.value), standKey: null });

  // the cache: keyed by (goal want, stand key); a hit costs nothing
  const cache = new Map<string, ReturnType<typeof groundActions>>();
  const cacheKey = (goal: Goal, s?: Stand): string => `${JSON.stringify(goal.want)}|${s ? standKey({ kind: "point", x: s.x, y: s.y, z: s.z, yaw: s.yaw }) : "-"}`;
  const groundedBy = (goal: Goal, s?: Stand): { actions: ReturnType<typeof groundActions>; ms: number; hit: boolean } => {
    const key = cacheKey(goal, s);
    const hit = cache.get(key);
    if (hit) return { actions: hit, ms: 0, hit: true };
    const run = timeIt(() => groundActions(graph!, pickups, [goal], s));
    cache.set(key, run.value);
    return { actions: run.value, ms: run.ms, hit: false };
  };
  const first = groundedBy(reachGoal);
  const second = groundedBy(reachGoal);
  record({ kind: "ground", seam: "cache", goal: reachGoal.id, groundMs: round1(second.ms), actions: second.actions.length, cacheHit: second.hit, firstMs: round1(first.ms), firstHit: first.hit });
  const standCached = groundedBy(standGoal, stand);
  const standCached2 = groundedBy(standGoal, stand);
  record({ kind: "ground", seam: "cache", goal: standGoal.id, groundMs: round1(standCached2.ms), actions: standCached2.actions.length, cacheHit: standCached2.hit, firstMs: round1(standCached.ms), firstHit: standCached.hit });

  // the union: one grounding that carries the key closure for the stand walk
  const union = timeIt(() => groundActions(graph!, pickups, [standGoal, reachGoal], stand));
  record({ kind: "ground", seam: "union", goal: `${standGoal.id}+${reachGoal.id}`, groundMs: round1(union.ms), actions: union.value.length, kinds: actionKinds(union.value), standKey: stand.key });

  // The stand-in-locked-hall case: the review's call, the brain's call, then the
  // gate at the warm and the 600 ms budget. A cold ctx recompiles the roads.
  const attempts: Array<{ name: string; actions: ReturnType<typeof groundActions>; budgetMs: number; heuristic: boolean; cold: boolean; gate?: boolean }> = [
    { name: "review-no-stand-arg-default-5s", actions: standNoArg.value, budgetMs: 5_000, heuristic: false, cold: false },
    { name: "default-5s", actions: standOnly.value, budgetMs: 5_000, heuristic: false, cold: false },
    { name: "default-250", actions: standOnly.value, budgetMs: 250, heuristic: false, cold: false },
    { name: "route-5s", actions: standOnly.value, budgetMs: 5_000, heuristic: true, cold: false },
    { name: "route-warm-250", actions: standOnly.value, budgetMs: 250, heuristic: true, cold: false },
    { name: "route-warm-600", actions: standOnly.value, budgetMs: 600, heuristic: true, cold: false },
    { name: "route-cold-600", actions: standOnly.value, budgetMs: 600, heuristic: true, cold: true },
    { name: "union-route-cold-600", actions: union.value, budgetMs: 600, heuristic: true, cold: true, gate: true },
  ];
  let gatePass = false;
  let gateMs = NaN;
  for (const attempt of attempts) {
    const useCtx = attempt.cold ? createBotContext(graph!, pickups) : ctx;
    const heuristic = attempt.heuristic ? estimateSeconds(standGoal, useCtx, pickups, stand) : undefined;
    const run = timeIt(() =>
      chooseGoal(start, [standGoal], attempt.actions, useCtx, {
        deadlineMs: now() + attempt.budgetMs,
        now,
        ...(heuristic ? { heuristic } : {}),
      }),
    );
    const steps = run.value?.steps.length ?? 0;
    planRow(`stand:${attempt.name}`, standGoal, run.value, run.ms, {
      actions: attempt.actions.length,
      kinds: actionKinds(attempt.actions),
      budgetMs: attempt.budgetMs,
      heuristic: attempt.heuristic ? "route" : "default",
      coldCtx: attempt.cold,
      gate: attempt.gate ? "<=600ms" : null,
    });
    if (attempt.gate) {
      gatePass = steps > 0 && run.ms <= 600;
      gateMs = run.ms;
    }
  }

  // The budget straddle on the reach plan: 317 ms warm route search > 250 ms.
  const reachRoute = estimateSeconds(reachGoal, ctx, pickups);
  for (const budgetMs of [250, 600]) {
    const run = timeIt(() =>
      chooseGoal(start, [reachGoal], reachOnly.value, ctx, { deadlineMs: now() + budgetMs, now, heuristic: reachRoute }),
    );
    planRow(`reach:route-warm-${budgetMs}`, reachGoal, run.value, run.ms, { actions: reachOnly.value.length, budgetMs, heuristic: "route" });
  }
  return { stand, unionActions: union.value, gatePass, gateMs };
}

// ---- seam 5: the goal ladder ------------------------------------------------
// Driver-local prototypes: the facts and priorities the driver wants the brain
// to carry; `src/shared/bots/goals.ts` is read-only.
type LadderState = WorldState & { hp: number; underFire: boolean; enemyVisible: boolean };
const ladderState = (hp: number, underFire: boolean, enemyVisible: boolean): LadderState =>
  ({ ...start, hp, underFire, enemyVisible, hpHigh: hp >= 70, hpLow: hp < 50 });

const surviveGoal = (): Goal => ({ id: "survive", want: { healed: true }, priority: (s) => ((s.hpLow as boolean) ? 10 : 0) });
const defendGoal = (): Goal => ({ id: "defend", want: { safe: true }, priority: (s) => ((s.underFire as boolean) && !(s.hpLow as boolean) ? 7 : 0) });
const assaultGoal = (targetId: number): Goal => ({ id: `assault:${targetId}`, want: { enemyDead: true }, priority: (s) => ((s.enemyVisible as boolean) && !(s.hpLow as boolean) ? 5 : 0) });
const idleGoal = (): Goal => ({ id: "idle", want: {}, priority: () => 0 });

/** One prototype action per ladder goal; the plan proves the goal was choosable. */
const ladderActions = (): ReturnType<typeof groundActions> => [
  { id: "heal:health-1", pre: {}, eff: { healed: true }, cost: 1 },
  { id: "cover:away", pre: {}, eff: { safe: true }, cost: 1 },
  { id: "fire:enemy", pre: {}, eff: { enemyDead: true }, cost: 1 },
];

function caseLadder(): void {
  const actions = ladderActions();
  const ctx = createBotContext(graph!, pickups);
  const target = 7;
  const goals = [surviveGoal(), defendGoal(), assaultGoal(target), idleGoal()];
  const cases: Array<{ name: string; state: LadderState; want: string }> = [
    { name: "hp30-no-threat", state: ladderState(30, false, false), want: "survive" },
    { name: "hp80-under-fire", state: ladderState(80, true, false), want: "defend" },
    { name: "hp100-visible-enemy", state: ladderState(100, false, true), want: "assault" },
    { name: "nothing", state: ladderState(100, false, false), want: "idle" },
  ];
  for (const c of cases) {
    const run = timeIt(() => chooseGoal(c.state, goals, actions, ctx, { deadlineMs: now() + 600, now }));
    const chosen = run.value?.goal ?? "idle";
    record({
      kind: "ladder",
      case: c.name,
      chosen,
      want: c.want,
      pass: chosen === c.want || (c.want === "assault" && chosen === `assault:${target}`),
      alternatives: goals.map((g) => `${g.id}@${g.priority(c.state as WorldState)}`),
      planMs: round1(run.ms),
    });
  }
}

// ---- run -------------------------------------------------------------------
const t0 = performance.now();
let standCtx: { stand: Stand; unionActions: ReturnType<typeof groundActions>; gatePass: boolean; gateMs: number } | undefined;
if (CASE === "all" || CASE === "heuristic") caseHeuristic();
if (CASE === "all" || CASE === "ground") standCtx = caseGround();
if (CASE === "all" || CASE === "ladder") caseLadder();
const elapsed = performance.now() - t0;

// ---- summary ---------------------------------------------------------------
const byKind = (kind: string): Array<Record<string, unknown>> => rows.filter((row) => row.kind === kind);
const fmt = (v: unknown): string => (v === null || v === undefined ? "—" : typeof v === "number" ? String(v) : String(v));
const plans = byKind("plan");
const ground = byKind("ground");
const ladder = byKind("ladder");
const lines: string[] = [
  `# 177 plan probe — ${LABEL} (${STAMP})`,
  "",
  `HEAD \`${process.env.GIT_HEAD ?? "?"}\` · graph places=${graph.places.length} portals=${graph.portals.length} · elapsed ${round1(elapsed)} ms`,
  "",
  "## Grounding",
  "",
  "| seam | goal | ms | actions | kinds | cache hit |",
  "|---|---|---|---|---|---|",
  ...ground.map((r) => `| ${fmt(r.seam)} | ${fmt(r.goal)} | ${fmt(r.groundMs)} | ${fmt(r.actions)} | ${fmt(r.kinds)} | ${fmt(r.cacheHit)} |`),
  "",
  "## Plans",
  "",
  "| seam | ms | expanded | steps | actions | budget ms | heuristic | cold ctx | gate |",
  "|---|---|---|---|---|---|---|---|---|",
  ...plans.map((r) => `| ${fmt(r.seam)} | ${fmt(r.planMs)} | ${fmt(r.expanded)} | ${fmt(r.steps)} | ${fmt(r.actions)} | ${fmt(r.budgetMs)} | ${fmt(r.heuristic)} | ${fmt(r.coldCtx)} | ${fmt(r.gate)} |`),
  "",
  "## Ladder",
  "",
  "| case | want | chosen | pass | alternatives |",
  "|---|---|---|---|---|",
  ...ladder.map((r) => `| ${fmt(r.case)} | ${fmt(r.want)} | ${fmt(r.chosen)} | ${fmt(r.pass)} | ${fmt(r.alternatives)} |`),
  "",
  `Rows: ${NDJSON}`,
  standCtx ? `\nGate stand-union-route-cold-600: **${standCtx.gatePass ? "PASS" : "FAIL"}** (${round1(standCtx.gateMs)} ms, union actions ${standCtx.unionActions.length})` : "",
  "",
];
writeFileSync(SUMMARY, lines.join("\n"));
console.log(`SUMMARY ${SUMMARY} rows=${rows.length} elapsed=${round1(elapsed)}ms`);
if (standCtx) console.log(`stand place=${standCtx.stand.place} key=${standCtx.stand.key} unionActions=${standCtx.unionActions.length}`);
