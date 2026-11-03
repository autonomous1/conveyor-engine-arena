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

export function plan<Ctx>(
  start: WorldState,
  goal: Goal,
  actions: readonly Action<Ctx>[],
  ctx: Ctx,
  opts: { maxExpand?: number; minCost?: number } = {},
): Plan | undefined {
  const maxExpand = opts.maxExpand ?? 2_000;
  const h = (s: WorldState) => unmet(s, goal.want) * (opts.minCost ?? 0); // admissible if minCost <= cheapest action
  const open: Node[] = [{ s: start, g: 0, f: h(start), steps: [], seq: 0 }];
  const best = new Map<string, number>([[key(start), 0]]);
  let seq = 0;
  let expanded = 0;
  while (open.length > 0 && expanded < maxExpand) {
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
      if (!satisfies(node.s, act.pre)) continue;
      if (act.usable && !act.usable(node.s, ctx)) continue;
      const next = apply(node.s, act.eff);
      const k = key(next);
      const c = typeof act.cost === "function" ? act.cost(node.s, ctx) : act.cost;
      if (!(c > 0) || !Number.isFinite(c)) continue;
      const g = node.g + c;
      if ((best.get(k) ?? Infinity) <= g) continue;
      best.set(k, g);
      open.push({ s: next, g, f: g + h(next), steps: [...node.steps, act.id], seq: ++seq });
    }
  }
  return undefined;
}

/** Highest-priority goal that has a plan. Ties: goal array order. */
export function chooseGoal<Ctx>(s: WorldState, goals: readonly Goal[], actions: readonly Action<Ctx>[], ctx: Ctx): Plan | undefined {
  const ranked = goals
    .map((g, i) => ({ g, i, p: g.priority(s) }))
    .filter((r) => r.p > 0 && !satisfies(s, r.g.want))
    .sort((a, b) => b.p - a.p || a.i - b.i);
  for (const r of ranked) {
    const p = plan(s, r.g, actions, ctx);
    if (p) return p;
  }
  return undefined;
}
