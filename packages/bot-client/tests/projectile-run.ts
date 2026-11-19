// Task 94 spike: throw grenades at wander NPCs at 5/10/20 m with a low-arc
// ballistic pitch, with and without velocity lead, then read the hp frames.
// Movement is planner-driven (`stand:` mission) so a moved NPC is tracked, and
// a throw is refused unless the eye has line of sight to the predicted point.
// Run: CE_TOKEN=… node --import ./scripts/ts-ext-register.mjs \
//   packages/bot-client/tests/projectile-run.ts --url ws://127.0.0.1:4173 --bands 5,10,20
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { connectBot } from "../../../packages/bot-client/src/connection.ts";
import { openNodeSocket } from "../../../packages/bot-client/src/node-socket.ts";
import { runMission } from "../../../packages/bot-client/src/brain.ts";
import { parseMission } from "../../../packages/bot-client/src/missions.ts";
import { hasLineOfSight } from "../../../src/shared/hitscan.ts";
import { EYE_HEIGHT, PITCH_LIMIT } from "../../../src/shared/look.ts";
import { GRENADE_GRAVITY, GRENADE_SPEED, type GrenadePose } from "../../../src/shared/grenade.ts";
import { wishTo } from "../../../src/shared/nav/follow.ts";

const args = new Map<string, string>();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) if (argv[i]!.startsWith("--")) args.set(argv[i]!.slice(2), argv[i + 1] ?? "");
const token = (process.env.CE_TOKEN ?? "").trim() || readFileSync("/home/tim/.config/ce-arena/qa-token.pem", "utf8").trim();
const BANDS = (args.get("bands") ?? "5,10,20").split(",").map(Number).filter((n) => Number.isFinite(n) && n > 0);
const THROWS = Number(args.get("throws") ?? 4);
const RUN_MS = Number(args.get("for-s") ?? 300) * 1000;
const STAMP = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const LOG = `plan/dsh-tasks/logs/108-pursuit-throw-${STAMP}.log`;
const JSON_OUT = `plan/dsh-tasks/logs/108-pursuit-throw-${STAMP}.json`;

const t0 = Date.now();
const secs = (): number => Math.round((Date.now() - t0) / 100) / 10;
const lines: string[] = [];
const rows: Array<Record<string, unknown>> = [];
let noSend = 0;
const record = (line: string): void => {
  const row = `t=${secs().toFixed(1)}s ${line}`;
  lines.push(row);
  console.log(row);
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const session = await connectBot({
  url: args.get("url") ?? "ws://localhost:4173",
  token,
  name: `bot-throw-${STAMP.slice(11, 19).replace(/:/g, "")}`,
  role: "qa",
  openSocket: openNodeSocket,
  onLog: (l) => record(`[conn] ${l}`),
});
const world = session.world;
const finish = (code: number): never => {
  mkdirSync("plan/dsh-tasks/logs", { recursive: true });
  const fired = rows.filter((r) => r.fired === true).length;
  const hits = rows.filter((r) => r.hit === true).length;
  const kills = rows.filter((r) => r.kill === true).length;
  record(`EXIT rows=${rows.length} fired=${fired} hits=${hits} kills=${kills} elapsed=${secs()}s`);
  writeFileSync(LOG, `${lines.join("\n")}\n`);
  writeFileSync(JSON_OUT, `${JSON.stringify({ throws: rows }, null, 1)}\n`);
  session.close();
  process.exit(code);
};

const started = Date.now();
while ((!world.self() || !world.sceneGraph()) && Date.now() - started < 15_000) await sleep(50);
const me0 = world.self();
if (!me0) {
  record("FATAL no owned pawn");
  finish(2);
}
const selfId = me0!.id;
const players = new Set(world.playerIds());
record(`joined self=${selfId} at ${me0!.x.toFixed(2)},${me0!.y.toFixed(2)},${me0!.z.toFixed(2)} place=${world.placeOf(me0!)?.id ?? "?"} players=[${[...players].join(",")}] others=${world.others().length}`);
record(`weapon=${world.weapon() ?? "none"} ammo=${world.ammo()} hp=${world.health()?.hp ?? "?"}`);

// --- target + velocity -----------------------------------------------------
type Sample = { t: number; x: number; z: number };
const history = new Map<number, Sample[]>();
const poseOf = (id: number) => world.others().find((p) => p.id === id);
const isNpc = (id: number): boolean => !players.has(id) && id !== selfId && world.healthOf(id)?.dead !== true && (badTargets.get(id) ?? 0) <= Date.now();
const selectTarget = (): number | undefined => {
  const me = world.self();
  if (!me) return undefined;
  const candidates = world.others()
    .filter((p) => isNpc(p.id) && (world.placeOf(p)?.id ?? "outside") === "outside")
    .map((p) => ({ id: p.id, d: Math.hypot(p.x - me.x, p.z - me.z) }))
    .sort((a, b) => a.d - b.d);
  return candidates[0]?.id;
};
let targetId: number | undefined;
const badTargets = new Map<number, number>();
const sampleTarget = (): void => {
  if (targetId === undefined) return;
  const p = poseOf(targetId);
  if (!p) return;
  const list = history.get(targetId) ?? [];
  list.push({ t: Date.now(), x: p.x, z: p.z });
  while (list.length > 20) list.shift();
  history.set(targetId, list);
};
const velocityOf = (id: number): { x: number; z: number; speed: number } => {
  const list = history.get(id) ?? [];
  if (list.length < 2) return { x: 0, z: 0, speed: 0 };
  const last = list[list.length - 1]!;
  let first = list[0]!;
  for (let i = list.length - 2; i >= 0; i -= 1) {
    if (last.t - list[i]!.t <= 400) first = list[i]!;
    else break;
  }
  const dt = (last.t - first.t) / 1000;
  if (!(dt > 0.1)) return { x: 0, z: 0, speed: 0 };
  const x = (last.x - first.x) / dt;
  const z = (last.z - first.z) / dt;
  return { x, z, speed: Math.hypot(x, z) };
};

// --- aim -------------------------------------------------------------------
function solvePitch(d: number, dh: number): { pitch: number; tFlight: number } | undefined {
  const v = GRENADE_SPEED;
  const g = GRENADE_GRAVITY;
  if (!(d > 0.01)) return undefined;
  const v2 = v * v;
  const disc = v2 * v2 - g * (g * d * d + 2 * dh * v2);
  if (disc < 0) return undefined;
  const tan = (v2 - Math.sqrt(disc)) / (g * d);
  const pitch = Math.atan(tan);
  if (!Number.isFinite(pitch) || Math.abs(pitch) > PITCH_LIMIT) return undefined;
  return { pitch, tFlight: d / (v * Math.cos(pitch)) };
}
type Aim = { yaw: number; pitch: number; d: number; dh: number; tFlight: number; pred: { x: number; y: number; z: number }; outOfRange?: boolean };
function aimAt(id: number, lead: boolean): Aim | undefined {
  const me = world.self();
  const tgt = poseOf(id);
  if (!me || !tgt) return undefined;
  const eye = { x: me.x, y: me.y + EYE_HEIGHT, z: me.z };
  const vt = lead ? velocityOf(id) : { x: 0, z: 0, speed: 0 };
  let pred = { x: tgt.x, y: tgt.y + 1.0, z: tgt.z };
  let sol: { pitch: number; tFlight: number } | undefined;
  for (let i = 0; i < 4; i += 1) {
    const dx = pred.x - eye.x;
    const dz = pred.z - eye.z;
    const d = Math.hypot(dx, dz);
    const dh = pred.y - eye.y;
    sol = solvePitch(d, dh);
    if (!sol) return { yaw: Math.atan2(dx, dz), pitch: 0, d, dh, tFlight: 0, pred, outOfRange: true };
    pred = { x: tgt.x + vt.x * sol.tFlight, y: tgt.y + 1.0, z: tgt.z + vt.z * sol.tFlight };
  }
  const dx = pred.x - eye.x;
  const dz = pred.z - eye.z;
  const d = Math.hypot(dx, dz);
  return { yaw: Math.atan2(dx, dz), pitch: sol!.pitch, d, dh: pred.y - eye.y, tFlight: sol!.tFlight, pred };
}
const eyeNow = () => {
  const me = world.self();
  return me ? { x: me.x, y: me.y + EYE_HEIGHT, z: me.z } : undefined;
};

// --- movement: planner first, straight fallback only for the last metre ----
const standWalk = async (point: { x: number; z: number }, timeoutMs: number, label: string): Promise<boolean> => {
  const mission = parseMission(`stand:${point.x.toFixed(2)},0,${point.z.toFixed(2)}`);
  if (!mission) return false;
  const code = await runMission(session, mission, {
    timeoutMs,
    log: (l) => record(`  ${label} ${l}`),
    error: (l) => record(`  ${label} ERROR ${l}`),
  });
  return code === 0;
};
// Pick a point at `band` from the target that has line of sight to it, orbiting
// the target if the straight-away point is behind a wall. The planner walks
// there; a moved target is re-evaluated each attempt.
function pickLosPoint(band: number): { x: number; z: number; y: number } | undefined {
  if (targetId === undefined) return undefined;
  const me = world.self();
  const tg = poseOf(targetId);
  if (!me || !tg) return undefined;
  const base = Math.atan2(me.x - tg.x, me.z - tg.z);
  const aimPoint = { x: tg.x, y: tg.y + 1.0, z: tg.z };
  for (const off of [0, 25, -25, 50, -50, 90, -90, 135, -135, 180]) {
    const a = base + (off * Math.PI) / 180;
    const x = tg.x + Math.sin(a) * band;
    const z = tg.z + Math.cos(a) * band;
    const place = world.placeOf({ x, y: 0, z });
    if (!place || place.id !== "outside") continue;
    const eye = { x, y: 0 + EYE_HEIGHT, z };
    if (hasLineOfSight(eye, aimPoint, world.aabbs)) return { x, z, y: 0 };
  }
  return undefined;
}
function hasLosNow(): boolean {
  const me = world.self();
  const tg = targetId === undefined ? undefined : poseOf(targetId);
  if (!me || !tg) return false;
  return hasLineOfSight({ x: me.x, y: me.y + EYE_HEIGHT, z: me.z }, { x: tg.x, y: tg.y + 1.0, z: tg.z }, world.aabbs);
}
async function reachBand(band: number, deadline: number): Promise<number> {
  for (let attempt = 0; attempt < 4 && Date.now() < deadline; attempt += 1) {
    const me = world.self();
    const tg = targetId === undefined ? undefined : poseOf(targetId);
    if (!me || !tg) return Infinity;
    const d = Math.hypot(tg.x - me.x, tg.z - me.z);
    if (Math.abs(d - band) <= 1.2 && hasLosNow()) return d;
    const point = pickLosPoint(band);
    if (!point) {
      record(`  no LOS point at band=${band} for target ${targetId}; blacklisting it`);
      badTargets.set(targetId!, Date.now() + 20_000);
      targetId = undefined;
      return Infinity;
    }
    record(`  move band=${band}: target=${targetId} d=${d.toFixed(2)} to (${point.x.toFixed(2)},${point.z.toFixed(2)}) los=${hasLosNow()}`);
    sampleTarget();
    const ok = await standWalk(point, Math.min(8000, Math.max(1000, deadline - Date.now())), `band${band}`);
    const end = world.self();
    const endT = targetId === undefined ? undefined : poseOf(targetId);
    record(`  band move ${ok ? "done" : "failed"} d=${end && endT ? Math.hypot(endT.x - end.x, endT.z - end.z).toFixed(2) : "?"} los=${hasLosNow()}`);
    if (!ok) {
      const until = Date.now() + 2000;
      while (Date.now() < until) {
        const m2 = world.self();
        if (!m2) break;
        const d2 = Math.hypot(point.x - m2.x, point.z - m2.z);
        if (d2 <= 0.6) break;
        session.input.sendInput(wishTo({ x: m2.x, y: m2.y, z: m2.z, vx: 0, vz: 0, yaw: m2.yaw }, { x: point.x, z: point.z }, 1));
        await sleep(80);
      }
    }
  }
  const m = world.self();
  const t = targetId === undefined ? undefined : poseOf(targetId);
  return m && t ? Math.hypot(t.x - m.x, t.z - m.z) : Infinity;
}

// --- one throw ---// --- one throw -------------------------------------------------------------
// Fresh 10 Hz samples so the velocity (and the lead) is current, not from before
// the last planner walk.
async function track(ms = 700): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    sampleTarget();
    await sleep(50); // 20 Hz target sampling (task 108)
  }
}

async function throwOne(band: number, model: "flat" | "ballistic" | "ballistic+lead"): Promise<void> {
  if (targetId === undefined) return;
  await track(400);
  if (targetId === undefined) return;
  const lead = model === "ballistic+lead";
  let aim = aimAt(targetId, lead);
  if (!aim || aim.outOfRange) {
    record(`band=${band} model=${model}: out of range or no aim (d=${aim?.d.toFixed(1)})`);
    return;
  }
  // Line-of-sight gate: never fire through geometry. Re-position (planner) and
  // re-aim up to twice; if still blocked, record a no-fire and do not throw.
  let losOk = hasLineOfSight(eyeNow() ?? { x: 0, y: 0, z: 0 }, aim.pred, world.aabbs);
  for (let attempt = 0; !losOk && attempt < 2; attempt += 1) {
    const current = aim;
    if (!current) break;
    record(`SKIP los=false band=${band} model=${model} d=${current.d.toFixed(2)}; re-positioning (#${attempt + 1})`);
    await reachBand(band, Date.now() + 10_000);
    aim = aimAt(targetId, lead);
    if (!aim || aim.outOfRange) break;
    const eye = eyeNow();
    if (!eye) break;
    losOk = hasLineOfSight(eye, aim.pred, world.aabbs);
  }
  if (!losOk) {
    record(`NO-FIRE band=${band} model=${model}: no line of sight to the predicted point`);
    rows.push({ t: secs(), band, model, targetId, fired: false, los: false });
    if (targetId !== undefined) { badTargets.set(targetId, Date.now() + 20_000); targetId = undefined; }
    return;
  }
  // Face the target at the throw yaw first (the operator watches the body), then
  // re-aim from the settled pose — the throw frame carries its own yaw.
  const me0 = world.self();
  const tg0 = targetId === undefined ? undefined : poseOf(targetId);
  if (!me0 || !tg0) return;
  const faceYaw = model === "flat" ? Math.atan2(tg0.x - me0.x, tg0.z - me0.z) : aim?.yaw ?? Math.atan2(tg0.x - me0.x, tg0.z - me0.z);
  session.input.sendInput({ moveX: 0, moveZ: 0, yaw: faceYaw });
  await sleep(220);
  const me = world.self();
  const tg = targetId === undefined ? undefined : poseOf(targetId);
  if (!me || !tg) return;
  const shotAim = aimAt(targetId, lead);
  if (!shotAim || shotAim.outOfRange) {
    record(`NO-FIRE band=${band} model=${model}: re-aim out of range`);
    return;
  }
  const yaw = model === "flat" ? Math.atan2(tg.x - me.x, tg.z - me.z) : shotAim.yaw;
  const pitch = model === "flat" ? 0 : shotAim.pitch;
  const eye = { x: me.x, y: me.y + EYE_HEIGHT, z: me.z };
  // Final synchronous check at the exact aim point, then fire in the same tick.
  const losFinal = hasLineOfSight(eye, shotAim.pred, world.aabbs);
  if (!losFinal) {
    record(`NO-FIRE band=${band} model=${model}: LOS lost at the press`);
    rows.push({ t: secs(), band, model, targetId, fired: false, los: false });
    return;
  }
  const vt = velocityOf(targetId);
  const hp0 = world.healthOf(targetId)?.hp ?? null;
  const beforeIds = new Set(world.grenades().map((g) => g.id));
  const sent = session.input.grenade(yaw, pitch);
  record(`THROW band=${band} model=${model} d=${shotAim.d.toFixed(2)} dh=${shotAim.dh.toFixed(2)} vt=(${vt.x.toFixed(2)},${vt.z.toFixed(2)})|${vt.speed.toFixed(2)} aim=(${yaw.toFixed(3)},${pitch.toFixed(3)}) poseYaw=${me.yaw.toFixed(2)} faceYaw=${faceYaw.toFixed(2)} tFlight=${shotAim.tFlight.toFixed(2)} pred=(${shotAim.pred.x.toFixed(2)},${shotAim.pred.y.toFixed(2)},${shotAim.pred.z.toFixed(2)}) los=${losFinal} sent=${sent} hp0=${hp0}`);
  if (!sent) {
    noSend += 1;
    record(`NO-SEND band=${band} model=${model}: session input is not open (${noSend}/2)`);
    if (noSend >= 2) finish(3);
    return;
  }
  // Telemetry (task 101): `world.landed()` holds the stop poses (newest last,
  // cap 16); a stop with no `n` is a pawn hit, `n=±y` ground, `n=±x/±z` a prop.
  // `world.grenades()` gives the latest in-flight pose per id (update counter).
  const start = Date.now();
  const landedIdsBefore = new Set(world.landed().map((g) => g.id));
  const knownIds = new Set(world.grenades().map((g) => g.id));
  let hp600: number | null = null;
  let hp1600: number | null = null;
  let atFlight: { x: number; z: number } | null = null;
  let stop: GrenadePose | null = null;
  let stopTarget: { x: number; y: number; z: number } | null = null;
  let stopAt: number | null = null;
  let flightUpdates = 0;
  let lastPose: string | null = null;
  while (Date.now() - start < 4_500) {
    const now = Date.now();
    if (stop === null) {
      const fresh = world.landed().find((g) => !landedIdsBefore.has(g.id));
      if (fresh) {
        stop = fresh;
        stopAt = Math.round((now - start) / 10) / 100;
        const t = targetId === undefined ? undefined : poseOf(targetId);
        if (t) stopTarget = { x: t.x, y: t.y, z: t.z };
      }
    }
    const g = world.grenades().filter((row) => !knownIds.has(row.id)).sort((a, b) => b.id - a.id)[0];
    if (g) {
      const sig = `${g.x.toFixed(2)},${g.y.toFixed(2)},${g.z.toFixed(2)},${g.stop ? 1 : 0}`;
      if (sig !== lastPose) {
        lastPose = sig;
        flightUpdates += 1;
      }
    }
    if (atFlight === null && now - start >= shotAim.tFlight * 1000) {
      const t = targetId === undefined ? undefined : poseOf(targetId);
      if (t) atFlight = { x: t.x, z: t.z };
    }
    if (hp600 === null && now - start >= 600) hp600 = targetId === undefined ? null : world.healthOf(targetId)?.hp ?? null;
    if (hp1600 === null && now - start >= 1600) hp1600 = targetId === undefined ? null : world.healthOf(targetId)?.hp ?? null;
    if (hp1600 !== null && (stop !== null || now - start > 4_000)) break;
    await sleep(50);
  }
  const leadErr = atFlight ? Math.hypot(atFlight.x - shotAim.pred.x, atFlight.z - shotAim.pred.z) : null;
  const surface = stop === null ? "none" : !stop.n ? "pawn" : stop.n[1] !== 0 ? "ground" : "prop";
  const missH = stop ? Math.hypot(stop.x - shotAim.pred.x, stop.z - shotAim.pred.z) : null;
  const missV = stop ? stop.y - shotAim.pred.y : null;
  const toTarget = stop && stopTarget ? Math.hypot(stop.x - stopTarget.x, stop.z - stopTarget.z) : null;
  const dead = world.healthOf(targetId)?.dead === true;
  const drop = hp0 !== null && hp1600 !== null ? hp0 - hp1600 : 0;
  const hit = dead || drop >= 40;
  record(`  RESULT band=${band} model=${model} leadErr=${leadErr === null ? "?" : leadErr.toFixed(2)} landed=${stop ? `${stop.x.toFixed(2)},${stop.y.toFixed(2)},${stop.z.toFixed(2)}${stop.n ? ` n=${stop.n.join(",")}` : ""}` : "none"} surface=${surface} missH=${missH === null ? "?" : missH.toFixed(2)} missV=${missV === null ? "?" : missV.toFixed(2)} toTarget=${toTarget === null ? "?" : toTarget.toFixed(2)} stopAt=${stopAt === null ? "?" : stopAt.toFixed(2)} flight=${flightUpdates} hp600=${hp600} hp1600=${hp1600} hit=${hit} kill=${dead} selfHp=${world.health()?.hp ?? "?"}`);
  rows.push({
    t: secs(),
    band,
    model,
    targetId,
    fired: true,
    d: Math.round(shotAim.d * 100) / 100,
    dh: Math.round(shotAim.dh * 100) / 100,
    vt: { x: Math.round(vt.x * 100) / 100, z: Math.round(vt.z * 100) / 100, speed: Math.round(vt.speed * 100) / 100 },
    aim: { yaw: Math.round(yaw * 1000) / 1000, pitch: Math.round(pitch * 1000) / 1000 },
    poseYaw: Math.round(me.yaw * 100) / 100,
    faceYaw: Math.round(faceYaw * 1000) / 1000,
    tFlight: Math.round(shotAim.tFlight * 100) / 100,
    pred: shotAim.pred,
    los: true,
    hp0,
    hp600,
    hp1600,
    leadErr: leadErr === null ? null : Math.round(leadErr * 100) / 100,
    landed: stop ? { id: stop.id, x: stop.x, y: stop.y, z: stop.z, ...(stop.n ? { n: stop.n } : {}) } : null,
    surface,
    miss: missH === null || missV === null ? null : { h: Math.round(missH * 100) / 100, v: Math.round(missV * 100) / 100 },
    toTarget: toTarget === null ? null : Math.round(toTarget * 100) / 100,
    stopAt,
    flight: flightUpdates,
    hit,
    kill: dead,
  });
  if (dead) targetId = undefined;
}

// --- run -------------------------------------------------------------------
try {
  const end = t0 + RUN_MS;
  const controlBand = BANDS[BANDS.length - 1] ?? 20;
  for (let i = 0; i < 2 && Date.now() < end; i += 1) {
    if (targetId === undefined) targetId = selectTarget();
    if (targetId === undefined) {
      record("no outside non-player target");
      break;
    }
    await reachBand(controlBand, Math.min(end, Date.now() + 20_000));
    await throwOne(controlBand, "flat");
    await sleep(1100);
  }
  for (const band of BANDS) {
    for (const model of ["ballistic", "ballistic+lead"] as const) {
      for (let i = 0; i < THROWS && Date.now() < end; i += 1) {
        if (targetId === undefined) targetId = selectTarget();
        if (targetId === undefined) {
          record(`no target for band ${band}; skipping`);
          await sleep(500);
          break;
        }
        const d = await reachBand(band, Math.min(end, Date.now() + 20_000));
        record(`positioned band=${band} d=${d.toFixed(2)} target=${targetId}`);
        await throwOne(band, model);
        sampleTarget();
        await sleep(1100);
      }
    }
  }
} catch (err) {
  record(`ERROR ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
}
finish(0);
