// ARCHITECTURE: Tick-budget telemetry for the host loop: per-phase ring buffers,
//   nearest-rank percentiles, and one formatted line per window.
// Wiring: game.ts's startWanderLoop owns one instance and marks the eight
//   phases; no other module imports it.
export type TickPhase =
  | "timeouts"
  | "interest"
  | "elevators"
  | "agents"
  | "commit"
  | "hooks"
  | "publish"
  | "frames";

export type BudgetStats = {
  readonly samples: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
};

export type TickReport = {
  readonly ticks: number;
  readonly total: BudgetStats;
  /** p99 of the interval between tick starts minus `tickMs`, clamped at 0. */
  readonly lagMs: number;
  readonly phases: Readonly<Record<TickPhase, BudgetStats>>;
};

export type TickMetrics = {
  beginTick(): void;
  endPhase(phase: TickPhase): void;
  endTick(): void;
  report(): TickReport;
  format(report?: TickReport): string;
};

const EMPTY: BudgetStats = { samples: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0 };
const PHASES: readonly TickPhase[] = [
  "timeouts", "interest", "elevators", "agents", "commit", "hooks", "publish", "frames",
];

function stats(samples: readonly number[]): BudgetStats {
  if (samples.length === 0) return EMPTY;
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p: number): number => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!;
  return { samples: sorted.length, p50Ms: at(0.5), p95Ms: at(0.95), p99Ms: at(0.99), maxMs: sorted[sorted.length - 1]! };
}

export function createTickMetrics(opts: { window?: number; tickMs?: number; now?: () => number } = {}): TickMetrics {
  const window = Math.max(1, opts.window ?? 200);
  const tickMs = opts.tickMs ?? 50;
  const now = opts.now ?? (() => performance.now());
  const totals: number[] = [];
  const lag: number[] = [];
  const phases = new Map<TickPhase, number[]>(PHASES.map((p) => [p, []]));
  let tickStart = Number.NaN;
  let lastMark = Number.NaN;
  let lastTickStart = Number.NaN;

  const push = (list: number[], value: number): void => {
    list.push(value);
    if (list.length > window) list.shift();
  };

  function beginTick(): void {
    const t = now();
    tickStart = t;
    lastMark = t;
    if (Number.isFinite(lastTickStart)) push(lag, Math.max(0, t - lastTickStart - tickMs));
    lastTickStart = t;
  }

  function endPhase(phase: TickPhase): void {
    const list = phases.get(phase);
    if (!list) throw new Error(`unknown tick phase: ${phase}`);
    if (!Number.isFinite(lastMark)) throw new Error("endPhase before beginTick");
    const t = now();
    push(list, t - lastMark);
    lastMark = t;
  }

  function endTick(): void {
    if (!Number.isFinite(tickStart)) throw new Error("endTick before beginTick");
    const t = now();
    push(totals, t - tickStart);
    tickStart = Number.NaN;
    lastMark = Number.NaN;
  }

  function report(): TickReport {
    const record = {} as Record<TickPhase, BudgetStats>;
    for (const phase of PHASES) record[phase] = stats(phases.get(phase)!);
    return { ticks: totals.length, total: stats(totals), lagMs: stats(lag).p99Ms, phases: record };
  }

  function format(value: TickReport = report()): string {
    const parts = [
      `n=${value.ticks}`,
      `p50=${value.total.p50Ms.toFixed(2)}`,
      `p99=${value.total.p99Ms.toFixed(2)}`,
      `max=${value.total.maxMs.toFixed(2)}`,
      `lag99=${value.lagMs.toFixed(2)}`,
    ];
    for (const phase of PHASES) {
      const s = value.phases[phase];
      if (s.samples) parts.push(`${phase} ${s.p50Ms.toFixed(2)}/${s.p99Ms.toFixed(2)}`);
    }
    return `[tick] ${parts.join(" | ")}`;
  }

  return { beginTick, endPhase, endTick, report, format };
}
