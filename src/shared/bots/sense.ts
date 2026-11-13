/**
 * Observe-only surroundings for a wander bot.
 * The host stores the result. Nothing here aims, steers, or touches the world.
 */
import { MAX_HP, type DamageNote } from "../health.js";
import type { ScenePortal } from "../scene-graph.js";

/** Host tick rate the default throttle is written against. */
export const SENSE_TICK_HZ = 20;

export type SenseTuning = {
  /** A bot is re-sensed every N update() calls. */
  everyTicks: number;
  /** Doors and pickups are re-read at most this often. */
  worldEveryTicks: number;
  /** A bot's place is re-evaluated at most this often. 0 = every sense. */
  placeEveryMs: number;
  /** Metres. Straight-line, walls ignored. */
  nearRadius: number;
  maxNearby: number;
  damageMemoryMs: number;
  /** Metres, horizontal. */
  progressRadius: number;
  /** Metres. Straight-line, not path-reachable. */
  pickupRadius: number;
};

/** 4, 20, 2000, 30, 8, 20000, 1, 15. */
export const DEFAULT_SENSE_TUNING: Readonly<SenseTuning> = Object.freeze({
  everyTicks: 4,
  worldEveryTicks: 20,
  placeEveryMs: 2000,
  nearRadius: 30,
  maxNearby: 8,
  damageMemoryMs: 20000,
  progressRadius: 1,
  pickupRadius: 15,
});

export type SensePawn = {
  id: number;
  kind: "bot" | "player";
  x: number;
  y: number;
  z: number;
  alive: boolean;
};

export type SensePickup = {
  id: string;
  kind: "health" | "ammo";
  x: number;
  y: number;
  z: number;
};

export type SensedPawn = {
  id: number;
  kind: "bot" | "player";
  dist: number;
  dy: number;
  yawTo: number;
  relYaw: number;
};

export type SensedPickup = {
  id: string;
  dist: number;
  yawTo: number;
  relYaw: number;
};

export type SensedDamage = {
  attacker: number | undefined;
  ageMs: number;
  /** Increments on every hp loss. A new value is a new hit even when `at` did not move. */
  seq?: number;
  attackerKind?: "bot" | "player";
  dist?: number;
  dy?: number;
  yawTo?: number;
  relYaw?: number;
};

export type SensedExit = { open: boolean; unlocked: boolean };

export type BotSense = {
  id: number;
  tick: number;
  at: number;
  alive: boolean;
  hp: number;
  hpFrac: number;
  place: string | undefined;
  msInPlace: number;
  msNoProgress: number;
  damage?: SensedDamage;
  nearby: readonly SensedPawn[];
  routeOut?: SensedExit;
  pickups: { health?: SensedPickup; ammo?: SensedPickup };
};

export type ExitPortal = Pick<ScenePortal, "id" | "kind" | "a" | "b" | "door">;
export type ExitDoor = { open: boolean; locked: boolean };

/** Which places can reach the exit. Reach sets rebuild when the door signature changes. */
export type ExitIndex = {
  /** No-op when the open and locked bits are unchanged. Otherwise rebuilds both floods. */
  update(doors: ReadonlyMap<string, ExitDoor>): void;
  /**
   * Shared object; do not mutate it. No flood path yields `{ open: false, unlocked: false }`.
   * That includes every place before the first `update`.
   */
  reaches(placeId: string): SensedExit;
  /** How many times `update` rebuilt. Unchanged doors do not increment. */
  readonly rebuilds: number;
};

export type SenseDeps = {
  now(): number;
  botIds(): readonly number[];
  pawns(): readonly SensePawn[];
  /** Actual facing. Called once per bot sensed. */
  headingOf(id: number): number;
  health(id: number): { hp: number; dead: boolean };
  lastDamage(id: number): DamageNote | undefined;
  placeOf?(x: number, y: number, z: number): string;
  exits?: ExitIndex;
  doors?(): ReadonlyMap<string, ExitDoor>;
  pickups?(): readonly SensePickup[];
  log?(line: string): void;
};

/** Per-bot surroundings. Each row is overwritten in place. */
export type BotSensor = {
  /**
   * Once per host tick. Increments `tick` first and swallows errors.
   * Re-senses a bot on its `everyTicks` turn. Wired doors and pickups refresh every `worldEveryTicks` calls.
   */
  update(): void;
  /**
   * Live row, overwritten the next time this id is sensed.
   * An unknown id is undefined and does not create one.
   */
  get(id: number): BotSense | undefined;
  /** Sorted copy of ids sensed at least once. */
  ids(): number[];
  /** How many `update` calls have started. 0 before the first. */
  readonly tick: number;
};

export type BotSenseReader = Pick<BotSensor, "get" | "ids">;

const TAU = Math.PI * 2;
const EMPTY_NEARBY: readonly SensedPawn[] = Object.freeze([]);
const EMPTY_PICKUPS: BotSense["pickups"] = Object.freeze({});

/** Into (−π, π]. Yaw 0 faces +Z; a larger yaw turns left, so positive is left. */
function wrapYaw(angle: number): number {
  const wrapped = angle % TAU;
  if (wrapped <= -Math.PI) return wrapped + TAU;
  if (wrapped > Math.PI) return wrapped - TAU;
  return wrapped;
}

function findPawn(pawns: readonly SensePawn[], id: number): SensePawn | undefined {
  for (let i = 0; i < pawns.length; i++) {
    if (pawns[i]!.id === id) return pawns[i];
  }
  return undefined;
}

function compareNear(a: SensedPawn, b: SensedPawn): number {
  return a.dist - b.dist || a.id - b.id;
}

/**
 * Adjacency is built once. The two reach sets rebuild only when the door
 * signature changes. An elevator never counts. A locked door never counts.
 * A door missing from the rows counts as open.
 */
export function createExitIndex(portals: readonly ExitPortal[], exit = "outside"): ExitIndex {
  const adj = new Map<string, ExitPortal[]>();
  for (let i = 0; i < portals.length; i++) {
    const portal = portals[i]!;
    let from = adj.get(portal.a);
    if (!from) {
      from = [];
      adj.set(portal.a, from);
    }
    from.push(portal);
    if (portal.b === portal.a) continue;
    let to = adj.get(portal.b);
    if (!to) {
      to = [];
      adj.set(portal.b, to);
    }
    to.push(portal);
  }

  const exitTT: SensedExit = { open: true, unlocked: true };
  const exitTF: SensedExit = { open: true, unlocked: false };
  const exitFT: SensedExit = { open: false, unlocked: true };
  const exitFF: SensedExit = { open: false, unlocked: false };
  let signature: string | undefined;
  let rebuilds = 0;
  let openReach = new Set<string>();
  let unlockedReach = new Set<string>();

  function links(portal: ExitPortal, doors: ReadonlyMap<string, ExitDoor>, allowShut: boolean): boolean {
    if (portal.kind === "elevator") return false;
    if (portal.kind !== "door" || !portal.door) return true;
    const door = doors.get(portal.door);
    if (!door) return true;
    if (door.locked) return false;
    return door.open || allowShut;
  }

  function flood(doors: ReadonlyMap<string, ExitDoor>, allowShut: boolean): Set<string> {
    const seen = new Set<string>();
    const queue: string[] = [exit];
    seen.add(exit);
    for (let q = 0; q < queue.length; q++) {
      const place = queue[q]!;
      const edges = adj.get(place);
      if (!edges) continue;
      for (let i = 0; i < edges.length; i++) {
        const portal = edges[i]!;
        if (!links(portal, doors, allowShut)) continue;
        const next = portal.a === place ? portal.b : portal.a;
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
    return seen;
  }

  function sign(doors: ReadonlyMap<string, ExitDoor>): string {
    const ids = [...doors.keys()];
    ids.sort();
    let out = "";
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]!;
      const door = doors.get(id)!;
      out += id;
      out += door.open ? "O" : "o";
      out += door.locked ? "L" : "l";
      out += "\n";
    }
    return out;
  }

  return {
    update(doors) {
      const next = sign(doors);
      if (next === signature) return;
      signature = next;
      rebuilds += 1;
      openReach = flood(doors, false);
      unlockedReach = flood(doors, true);
    },
    reaches(placeId) {
      const open = openReach.has(placeId);
      const unlocked = unlockedReach.has(placeId);
      if (open && unlocked) return exitTT;
      if (open) return exitTF;
      if (unlocked) return exitFT;
      return exitFF;
    },
    get rebuilds() {
      return rebuilds;
    },
  };
}

type Track = {
  place: string | undefined;
  placeCheckedAt: number;
  placeSince: number;
  anchorX: number;
  anchorZ: number;
  progressSince: number;
  seenGen: number;
  health?: SensePickup;
  ammo?: SensePickup;
};

type Held = {
  sense: BotSense;
  near: SensedPawn[];
  pool: SensedPawn[];
  healthOut?: SensedPickup;
  ammoOut?: SensedPickup;
  damage: SensedDamage;
};

function blankPawn(): SensedPawn {
  return { id: 0, kind: "bot", dist: 0, dy: 0, yawTo: 0, relYaw: 0 };
}

function clearBearings(damage: SensedDamage): void {
  delete damage.attackerKind;
  delete damage.dist;
  delete damage.dy;
  delete damage.yawTo;
  delete damage.relYaw;
}

export function createBotSensor(deps: SenseDeps, partial?: Partial<SenseTuning>): BotSensor {
  const tuning: SenseTuning = { ...DEFAULT_SENSE_TUNING, ...partial };
  const senses = new Map<number, BotSense>();
  const tracks = new Map<number, Track>();
  const helds = new Map<number, Held>();
  const known: number[] = [];
  const logged = new Set<string>();
  /** Reused across senses. Length stays at the high-water mark so the rows are not reallocated. */
  const scratch: SensedPawn[] = [];
  const grid = new Map<string, SensePickup[]>();
  let tick = 0;
  let worldTick = Number.NEGATIVE_INFINITY;
  let pickupGen = 0;
  const radius2 = tuning.progressRadius * tuning.progressRadius;

  function remember(id: number): void {
    let i = 0;
    while (i < known.length && known[i]! < id) i++;
    if (known[i] === id) return;
    known.splice(i, 0, id);
  }

  function report(err: unknown): void {
    try {
      const message = err instanceof Error ? err.message : String(err);
      if (logged.has(message) || logged.size >= 8) return;
      logged.add(message);
      deps.log?.(`[live] sense ${message}`);
    } catch {
      // update() must not throw, including when the sink throws.
    }
  }

  function cellKey(x: number, z: number): string {
    return Math.floor(x / tuning.pickupRadius) + "," + Math.floor(z / tuning.pickupRadius);
  }

  function rebuildGrid(list: readonly SensePickup[]): void {
    grid.clear();
    for (let i = 0; i < list.length; i++) {
      const item = list[i]!;
      const key = cellKey(item.x, item.z);
      let bucket = grid.get(key);
      if (!bucket) {
        bucket = [];
        grid.set(key, bucket);
      }
      bucket.push(item);
    }
  }

  function rememberPickups(self: SensePawn, track: Track): void {
    if (track.seenGen === pickupGen) return;
    track.seenGen = pickupGen;
    track.health = undefined;
    track.ammo = undefined;
    const cx = Math.floor(self.x / tuning.pickupRadius);
    const cz = Math.floor(self.z / tuning.pickupRadius);
    let bestHealth = Infinity;
    let bestAmmo = Infinity;
    for (let ix = cx - 1; ix <= cx + 1; ix++) {
      for (let iz = cz - 1; iz <= cz + 1; iz++) {
        const bucket = grid.get(ix + "," + iz);
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i++) {
          const item = bucket[i]!;
          const dist = Math.hypot(item.x - self.x, item.y - self.y, item.z - self.z);
          if (dist > tuning.pickupRadius) continue;
          if (item.kind === "health") {
            if (dist < bestHealth) {
              bestHealth = dist;
              track.health = item;
            }
          } else if (dist < bestAmmo) {
            bestAmmo = dist;
            track.ammo = item;
          }
        }
      }
    }
  }

  function heldFor(id: number): Held {
    let held = helds.get(id);
    if (!held) {
      const near: SensedPawn[] = [];
      const sense: BotSense = {
        id,
        tick: 0,
        at: 0,
        alive: false,
        hp: 0,
        hpFrac: 0,
        place: undefined,
        msInPlace: 0,
        msNoProgress: 0,
        nearby: near,
        pickups: {},
      };
      held = { sense, near, pool: [], damage: { attacker: undefined, ageMs: 0 } };
      helds.set(id, held);
    }
    return held;
  }

  function sensedPickup(held: Held, slot: "health" | "ammo", self: SensePawn, item: SensePickup | undefined, heading: number): SensedPickup | undefined {
    if (!item) return undefined;
    const dx = item.x - self.x;
    const dy = item.y - self.y;
    const dz = item.z - self.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist > tuning.pickupRadius) return undefined;
    const yawTo = Math.atan2(dx, dz);
    let out = slot === "health" ? held.healthOut : held.ammoOut;
    if (!out) {
      out = { id: item.id, dist, yawTo, relYaw: 0 };
      if (slot === "health") held.healthOut = out;
      else held.ammoOut = out;
    }
    out.id = item.id;
    out.dist = dist;
    out.yawTo = yawTo;
    out.relYaw = wrapYaw(yawTo - heading);
    return out;
  }

  function readDamage(held: Held, self: SensePawn | undefined, pawns: readonly SensePawn[], heading: number, at: number, id: number): SensedDamage | undefined {
    const note = deps.lastDamage(id);
    if (!note) return undefined;
    const rawAge = at - note.at;
    if (rawAge > tuning.damageMemoryMs) return undefined;
    const damage = held.damage;
    damage.attacker = note.attacker;
    damage.ageMs = rawAge < 0 ? 0 : rawAge;
    if (note.seq !== undefined) damage.seq = note.seq;
    else delete damage.seq;
    clearBearings(damage);
    if (note.attacker === undefined || !self) return damage;
    const foe = findPawn(pawns, note.attacker);
    if (!foe || !foe.alive) return damage;
    const dx = foe.x - self.x;
    const dy = foe.y - self.y;
    const dz = foe.z - self.z;
    const yawTo = Math.atan2(dx, dz);
    damage.attackerKind = foe.kind;
    damage.dist = Math.hypot(dx, dy, dz);
    damage.dy = dy;
    damage.yawTo = yawTo;
    damage.relYaw = wrapYaw(yawTo - heading);
    return damage;
  }

  function sortPrefix(n: number): void {
    for (let i = 1; i < n; i++) {
      const item = scratch[i]!;
      let j = i;
      while (j > 0 && compareNear(scratch[j - 1]!, item) > 0) {
        scratch[j] = scratch[j - 1]!;
        j--;
      }
      scratch[j] = item;
    }
  }

  function publishNearby(held: Held, count: number): void {
    const n = count < tuning.maxNearby ? count : tuning.maxNearby;
    const pool = held.pool;
    const near = held.near;
    while (pool.length < n) pool.push(blankPawn());
    near.length = n;
    for (let i = 0; i < n; i++) {
      const src = scratch[i]!;
      const dst = pool[i]!;
      dst.id = src.id;
      dst.kind = src.kind;
      dst.dist = src.dist;
      dst.dy = src.dy;
      dst.yawTo = src.yawTo;
      dst.relYaw = src.relYaw;
      near[i] = dst;
    }
    held.sense.nearby = n === 0 ? EMPTY_NEARBY : near;
  }

  function collectNearby(held: Held, self: SensePawn, pawns: readonly SensePawn[], heading: number): void {
    let count = 0;
    for (let i = 0; i < pawns.length; i++) {
      const pawn = pawns[i]!;
      if (pawn.id === self.id || !pawn.alive) continue;
      const dx = pawn.x - self.x;
      const dy = pawn.y - self.y;
      const dz = pawn.z - self.z;
      const dist = Math.hypot(dx, dy, dz);
      if (dist > tuning.nearRadius) continue;
      let row = scratch[count];
      if (!row) {
        row = blankPawn();
        scratch[count] = row;
      }
      const yawTo = Math.atan2(dx, dz);
      row.id = pawn.id;
      row.kind = pawn.kind;
      row.dist = dist;
      row.dy = dy;
      row.yawTo = yawTo;
      row.relYaw = wrapYaw(yawTo - heading);
      count += 1;
    }
    if (count > 1) sortPrefix(count);
    publishNearby(held, count);
  }

  function senseOne(id: number, pawns: readonly SensePawn[]): void {
    const heading = deps.headingOf(id);
    const at = deps.now();
    const vital = deps.health(id);
    const self = findPawn(pawns, id);
    const held = heldFor(id);
    const row = held.sense;
    row.tick = tick;
    row.at = at;
    row.hp = vital.hp;
    row.hpFrac = vital.hp / MAX_HP;
    if (vital.dead || !self || !self.alive) {
      tracks.delete(id);
      row.alive = false;
      row.place = undefined;
      row.msInPlace = 0;
      row.msNoProgress = 0;
      row.nearby = EMPTY_NEARBY;
      row.pickups.health = undefined;
      row.pickups.ammo = undefined;
      const damage = readDamage(held, self, pawns, heading, at, id);
      if (damage) row.damage = damage;
      else delete row.damage;
      delete row.routeOut;
      senses.set(id, row);
      remember(id);
      return;
    }

    let track = tracks.get(id);
    if (!track) {
      track = {
        place: undefined,
        placeCheckedAt: Number.NEGATIVE_INFINITY,
        placeSince: at,
        anchorX: self.x,
        anchorZ: self.z,
        progressSince: at,
        seenGen: -1,
      };
      tracks.set(id, track);
    }

    if (deps.placeOf && at - track.placeCheckedAt >= tuning.placeEveryMs) {
      const next = deps.placeOf(self.x, self.y, self.z);
      track.placeCheckedAt = at;
      if (next !== track.place) {
        track.place = next;
        track.placeSince = at;
      }
    }

    const movedX = self.x - track.anchorX;
    const movedZ = self.z - track.anchorZ;
    if (movedX * movedX + movedZ * movedZ >= radius2) {
      track.anchorX = self.x;
      track.anchorZ = self.z;
      track.progressSince = at;
    }

    if (deps.pickups) rememberPickups(self, track);

    row.alive = true;
    row.place = track.place;
    row.msInPlace = at - track.placeSince;
    row.msNoProgress = at - track.progressSince;
    collectNearby(held, self, pawns, heading);
    row.pickups.health = sensedPickup(held, "health", self, track.health, heading);
    row.pickups.ammo = sensedPickup(held, "ammo", self, track.ammo, heading);
    const damage = readDamage(held, self, pawns, heading, at, id);
    if (damage) row.damage = damage;
    else delete row.damage;
    if (deps.exits && track.place !== undefined) row.routeOut = deps.exits.reaches(track.place);
    else delete row.routeOut;
    senses.set(id, row);
    remember(id);
  }

  function step(): void {
    const slots = deps.botIds();
    if (tick - worldTick >= tuning.worldEveryTicks) {
      worldTick = tick;
      if (deps.exits && deps.doors) deps.exits.update(deps.doors());
      if (deps.pickups) {
        rebuildGrid(deps.pickups());
        pickupGen += 1;
      }
    }
    let due = false;
    for (let slot = 0; slot < slots.length; slot++) {
      if ((tick + slot) % tuning.everyTicks === 0) {
        due = true;
        break;
      }
    }
    if (!due) return;
    const pawns = deps.pawns();
    for (let slot = 0; slot < slots.length; slot++) {
      if ((tick + slot) % tuning.everyTicks === 0) senseOne(slots[slot]!, pawns);
    }
  }

  return {
    update() {
      tick += 1;
      try {
        step();
      } catch (err) {
        report(err);
      }
    },
    get(id) {
      return senses.get(id);
    },
    ids() {
      return known.slice();
    },
    get tick() {
      return tick;
    },
  };
}
