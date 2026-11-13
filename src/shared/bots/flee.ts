/**
 * Choose where an Evade bot runs. Pure: no clock and no Node.
 * The caller supplies path costs (place routing, Euclidean inside a place)
 * and, if it wants, an occlusion test. Rays run only on the cheap top N.
 */
export type FleeVec = { readonly x: number; readonly y: number; readonly z: number };

/** One baked region centre. */
export type FleeCentre = {
  readonly placeId: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
};

export type FleeTuning = {
  /** Drop a centre whose path cost from me is above this. */
  maxPathM: number;
  /** Drop a centre whose path cost from me is below this. A flee has to leave. */
  minRunM: number;
  /** Normalised (c − me)·(me − threat) must be greater than this. */
  awayDot: number;
  /** Threat path distance is capped here before it is scaled into the score. */
  threatCapM: number;
  /** My path cost is divided by this. */
  myPathNormM: number;
  /** The straight line passes within this many metres of the threat. */
  passRadiusM: number;
  /** Past the threat's range, a point scores {@link FleeTuning.wBeyond}. */
  threatRangeM: number;
  /** Cap inside the beyond-range term, `min(D_threat, beyondCapM) / beyondCapM`. */
  beyondCapM: number;
  /** Occlusion is tested on this many cheap-ranked centres, and no more. */
  rayCount: number;
  /** Threat eye height. The caller raises the ray origin by this. */
  threatEyeM: number;
  /** Candidate chest height. The caller raises the ray target by this. */
  chestM: number;
  wThreatDist: number;
  wOccluded: number;
  wDifferentPlace: number;
  /** Added when `D_threat` is past {@link FleeTuning.threatRangeM}. */
  wBeyond: number;
  /** Subtracted. */
  wMyPath: number;
  /** Subtracted. */
  wPassesThreat: number;
  /** Reserved. Zero until a later task scores pickups. */
  wMedkit: number;
  /** Reserved. Zero until a later task scores pickups. */
  wAmmo: number;
};

/** Weights from the flee score. Medkit and ammo stay 0. */
export const FLEE_TUNING: Readonly<FleeTuning> = Object.freeze({
  maxPathM: 45,
  minRunM: 12,
  awayDot: -0.2,
  threatCapM: 60,
  myPathNormM: 45,
  passRadiusM: 4,
  threatRangeM: 30,
  beyondCapM: 40,
  rayCount: 12,
  threatEyeM: 1.6,
  chestM: 1.0,
  wThreatDist: 1,
  wOccluded: 0.8,
  wDifferentPlace: 0.4,
  wBeyond: 0.6,
  wMyPath: 0.3,
  wPassesThreat: 1.5,
  wMedkit: 0,
  wAmmo: 0,
});

export type FleeInput = {
  me: FleeVec;
  myPlace: string;
  threat: FleeVec;
  /** Place the threat is in. A grenade with no attacker uses the place I was hit. */
  threatPlace: string;
  centres: readonly FleeCentre[];
  /**
   * Path metres from me to the centre.
   * Undefined or non-finite means I cannot reach it.
   */
  costFromMe: (centre: FleeCentre) => number | undefined;
  /**
   * Path metres from the threat to the centre.
   * Undefined means the threat cannot reach it, which scores as "far".
   */
  costFromThreat: (centre: FleeCentre) => number | undefined;
  /** True when the segment is blocked. Called at most {@link FleeTuning.rayCount} times. */
  occluded?: (from: FleeVec, to: FleeVec) => boolean;
  hasMedkit?: (centre: FleeCentre) => boolean;
  hasAmmo?: (centre: FleeCentre) => boolean;
};

export type FleeChoice = {
  placeId: string;
  x: number;
  y: number;
  z: number;
  score: number;
};

/**
 * Metres along the place graph, or Euclidean when `toPlace` is `fromPlace`.
 * `placeCosts` is a `routePlaceCosts` map from `from`. A missing place is unreachable.
 */
export function costInPlaces(
  from: FleeVec,
  fromPlace: string,
  placeCosts: ReadonlyMap<string, number>,
  toPlace: string,
  to: FleeVec,
): number | undefined {
  if (toPlace === fromPlace) return Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
  const via = placeCosts.get(toPlace);
  if (via === undefined || !Number.isFinite(via)) return undefined;
  return via;
}

type Ranked = {
  centre: FleeCentre;
  mineM: number;
  threatM: number;
  score: number;
  hidden: boolean;
};

/**
 * Highest-scoring region centre that is away from the threat, or undefined
 * when every centre is toward it, too far, or unreachable.
 */
export function pickFleePoint(input: FleeInput, tuning: Readonly<FleeTuning> = FLEE_TUNING): FleeChoice | undefined {
  const away = unit(input.me.x - input.threat.x, input.me.y - input.threat.y, input.me.z - input.threat.z);
  const ranked: Ranked[] = [];
  for (let i = 0; i < input.centres.length; i += 1) {
    const centre = input.centres[i]!;
    const run = unit(centre.x - input.me.x, centre.y - input.me.y, centre.z - input.me.z);
    if (!run) continue;
    if (away) {
      const dot = run.x * away.x + run.y * away.y + run.z * away.z;
      if (!(dot > tuning.awayDot)) continue;
    }
    const mine = input.costFromMe(centre);
    if (mine === undefined || !Number.isFinite(mine) || mine > tuning.maxPathM || mine < tuning.minRunM) continue;
    const threatRaw = input.costFromThreat(centre);
    const threatM = threatRaw === undefined || !Number.isFinite(threatRaw) ? Number.POSITIVE_INFINITY : threatRaw;
    const threatTerm = tuning.wThreatDist * (Math.min(threatM, tuning.threatCapM) / tuning.threatCapM);
    const beyond = threatM > tuning.threatRangeM
      ? tuning.wBeyond * (Math.min(threatM, tuning.beyondCapM) / tuning.beyondCapM)
      : 0;
    const placeTerm = centre.placeId !== input.threatPlace ? tuning.wDifferentPlace : 0;
    const passTerm = passesNear(input.me, centre, input.threat, tuning.passRadiusM) ? tuning.wPassesThreat : 0;
    let pickup = 0;
    if (tuning.wMedkit !== 0 && input.hasMedkit?.(centre)) pickup += tuning.wMedkit;
    if (tuning.wAmmo !== 0 && input.hasAmmo?.(centre)) pickup += tuning.wAmmo;
    ranked.push({
      centre,
      mineM: mine,
      threatM,
      hidden: false,
      score: threatTerm + beyond + placeTerm + pickup - (tuning.wMyPath * mine) / tuning.myPathNormM - passTerm,
    });
  }
  if (ranked.length === 0) return undefined;
  ranked.sort(byScore);
  const top = ranked.slice(0, tuning.rayCount > 0 ? tuning.rayCount : 0);
  if (top.length === 0) return undefined;
  let best = top[0];
  if (input.occluded) {
    const hidden: Ranked[] = [];
    for (let i = 0; i < top.length; i += 1) {
      const row = top[i]!;
      if (!input.occluded(input.threat, row.centre)) continue;
      row.hidden = true;
      row.score += tuning.wOccluded;
      hidden.push(row);
    }
    if (hidden.length > 0) {
      hidden.sort(byScore);
      best = hidden[0];
    } else {
      top.sort(byThreat);
      best = top[0];
    }
  }
  if (!best) return undefined;
  return {
    placeId: best.centre.placeId,
    x: best.centre.x,
    y: best.centre.y,
    z: best.centre.z,
    score: best.score,
  };
}

function unit(x: number, y: number, z: number): FleeVec | undefined {
  const len = Math.hypot(x, y, z);
  if (!(len > 1e-6)) return undefined;
  return { x: x / len, y: y / len, z: z / len };
}

/**
 * The open segment comes within `radius` of the threat ahead of me.
 * A threat behind the start does not count: every path begins at my feet.
 */
function passesNear(me: FleeVec, to: FleeVec, threat: FleeVec, radius: number): boolean {
  const abx = to.x - me.x;
  const aby = to.y - me.y;
  const abz = to.z - me.z;
  const ab2 = abx * abx + aby * aby + abz * abz;
  if (!(ab2 > 1e-8)) return false;
  let t = ((threat.x - me.x) * abx + (threat.y - me.y) * aby + (threat.z - me.z) * abz) / ab2;
  if (!(t > 0)) return false;
  if (t > 1) t = 1;
  const dx = threat.x - (me.x + abx * t);
  const dy = threat.y - (me.y + aby * t);
  const dz = threat.z - (me.z + abz * t);
  return dx * dx + dy * dy + dz * dz <= radius * radius;
}

/** Farther from the threat first. Ties break by {@link byScore}. */
function byThreat(a: Ranked, b: Ranked): number {
  const threat = compareFar(b.threatM, a.threatM);
  if (threat !== 0) return threat;
  return byScore(a, b);
}

/** Higher score first. Ties break toward farther from the threat, then a shorter run. */
function byScore(a: Ranked, b: Ranked): number {
  if (a.score !== b.score) return b.score - a.score;
  const threat = compareFar(b.threatM, a.threatM);
  if (threat !== 0) return threat;
  if (a.mineM !== b.mineM) return a.mineM - b.mineM;
  if (a.centre.placeId !== b.centre.placeId) return a.centre.placeId < b.centre.placeId ? -1 : 1;
  if (a.centre.x !== b.centre.x) return a.centre.x - b.centre.x;
  return a.centre.z - b.centre.z;
}

function compareFar(a: number, b: number): number {
  const af = Number.isFinite(a);
  const bf = Number.isFinite(b);
  if (!af && !bf) return 0;
  if (!af) return 1;
  if (!bf) return -1;
  return a - b;
}
