/**
 * Minimal synchronous GOAP planner sketch for conveyor-engine-arena.
 * Forward A* over a flat world-state record. Deterministic: no clocks, no
 * Math.random, stable tie-break by insertion order and action id.
 */
export type Fact = boolean | number | string;
export type WorldState = Readonly<Record<string, Fact>>;

export type Action<Ctx = unknown> = {
  /** Stable, grounded id, e.g. "pickupKey:key-1" or "openDoor:door-1-1-9-2-4". */
  id: string;
  pre: WorldState;
  eff: WorldState;
  /** Static or context cost (e.g. nav path length / speed). Must be > 0. */
  cost: number | ((s: WorldState, ctx: Ctx) => number);
  /** Optional procedural check (reachable, not claimed by another bot...). */
  usable?: (s: WorldState, ctx: Ctx) => boolean;
};

export type Goal = { id: string; want: WorldState; priority: (s: WorldState) => number };
export type Plan = { goal: string; steps: string[]; cost: number; expanded: number };

const satisfies = (s: WorldState, want: WorldState): boolean => {
  for (const k in want) if ((s[k] ?? false) !== want[k]) return false;
  return true;
};
const unmet = (s: WorldState, want: WorldState): number => {
  let n = 0;
  for (const k in want) if ((s[k] ?? false) !== want[k]) n++;
  return n;
};
const apply = (s: WorldState, eff: WorldState): WorldState => ({ ...s, ...eff });
const key = (s: WorldState): string =>
  Object.keys(s).sort().map((k) => `${k}=${String(s[k])}`).join("|");

type Node = { s: WorldState; g: number; f: number; steps: string[]; seq: number };

export type PlanOptions = {
  maxExpand?: number;
  /** Admissible when this is <= the cheapest action cost. */
  minCost?: number;
  /**
   * Extra admissible lower bound in seconds. Combined with `unmet * minCost` by max.
   * The default search does not call it.
   */
  heuristic?: (s: WorldState) => number;
  /** Stop and return no plan once `now()` reaches this absolute time. */
  deadlineMs?: number;
  /** Action evaluations (pre/usable/cost), not expansions. */
  maxEvaluations?: number;
  /** Injected clock. Absent means no deadline. The planner does not read `Date` itself. */
  now?: () => number;
};

export function plan<Ctx>(
  start: WorldState,
  goal: Goal,
  actions: readonly Action<Ctx>[],
  ctx: Ctx,
  opts: PlanOptions = {},
): Plan | undefined {
  const maxExpand = opts.maxExpand ?? 2_000;
  const maxEval = opts.maxEvaluations ?? Number.POSITIVE_INFINITY;
  const deadline = opts.deadlineMs;
  const clock = opts.now;
  const expired = (): boolean => deadline !== undefined && clock !== undefined && clock() >= deadline;
  const h = (s: WorldState) => {
    const base = unmet(s, goal.want) * (opts.minCost ?? 0); // admissible if minCost <= cheapest action
    const extra = opts.heuristic?.(s) ?? 0;
    return extra > base ? extra : base;
  };
  if (expired()) return undefined;
  const startH = h(start);
  // A non-finite bound means the goal is unreachable from here. Don't search.
  if (!Number.isFinite(startH)) return undefined;
  const open: Node[] = [{ s: start, g: 0, f: startH, steps: [], seq: 0 }];
  const best = new Map<string, number>([[key(start), 0]]);
  let seq = 0;
  let expanded = 0;
  let evaluations = 0;
  while (open.length > 0 && expanded < maxExpand) {
    if (expired()) return undefined;
    // Small open lists: linear min is fine and deterministic (f, then seq).
    let i = 0;
    for (let j = 1; j < open.length; j++) {
      const a = open[j]!, b = open[i]!;
      if (a.f < b.f || (a.f === b.f && a.seq < b.seq)) i = j;
    }
    const node = open.splice(i, 1)[0]!;
    expanded++;
    if (satisfies(node.s, goal.want)) return { goal: goal.id, steps: node.steps, cost: node.g, expanded };
    for (const act of actions) {
      evaluations += 1;
      if (evaluations > maxEval) return undefined;
      if ((evaluations & 63) === 0 && expired()) return undefined;
      if (!satisfies(node.s, act.pre)) continue;
      if (act.usable && !act.usable(node.s, ctx)) continue;
      const next = apply(node.s, act.eff);
      const k = key(next);
      const c = typeof act.cost === "function" ? act.cost(node.s, ctx) : act.cost;
      if (!(c > 0) || !Number.isFinite(c)) continue;
      const g = node.g + c;
      if ((best.get(k) ?? Infinity) <= g) continue;
      const nextH = h(next);
      if (!Number.isFinite(nextH)) continue;
      best.set(k, g);
      open.push({ s: next, g, f: g + nextH, steps: [...node.steps, act.id], seq: ++seq });
    }
  }
  return undefined;
}

/** Highest-priority goal that has a plan. Ties: goal array order. */
export function chooseGoal<Ctx>(
  s: WorldState,
  goals: readonly Goal[],
  actions: readonly Action<Ctx>[],
  ctx: Ctx,
  opts: PlanOptions = {},
): Plan | undefined {
  const ranked = goals
    .map((g, i) => ({ g, i, p: g.priority(s) }))
    .filter((r) => r.p > 0 && !satisfies(s, r.g.want))
    .sort((a, b) => b.p - a.p || a.i - b.i);
  for (const r of ranked) {
    if (opts.deadlineMs !== undefined && opts.now && opts.now() >= opts.deadlineMs) return undefined;
    const p = plan(s, r.g, actions, ctx, opts);
    if (p) return p;
  }
  return undefined;
}
