// Scratch: 5-minute attack run. Arm, reload as needed, return to the arena centre,
// attack the nearest wander bot one at a time, clean close at the end.
// Run: CE_TOKEN=<jwt> node --import ./scripts/ts-ext-register.mjs packages/bot-client/tests/attack-run.ts [--for-s 300]
import { writeFileSync } from "node:fs";
import { connectBot } from "../../../packages/bot-client/src/connection.ts";
import { openNodeSocket } from "../../../packages/bot-client/src/node-socket.ts";
import { runMission } from "../../../packages/bot-client/src/brain.ts";
import { parseMission } from "../../../packages/bot-client/src/missions.ts";
import { hasLineOfSight } from "../../../src/shared/hitscan.ts";
import { wishTo } from "../../../src/shared/nav/follow.ts";

const URL_ = "wss://arena.tszakacs.com";
const LOG = "plan/dsh-tasks/logs/53-attack-run.log";
const TRACE = "plan/dsh-tasks/logs/53-attack-run.json";
const token = (process.env.CE_TOKEN ?? "").trim();
const args = new Map<string, string>();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) if (argv[i]!.startsWith("--")) args.set(argv[i]!.slice(2), argv[i + 1] ?? "");
const RUN_MS = Number(args.get("for-s") ?? 300) * 1000;
const CENTRE = { x: -2.40, z: 6.00 };
const t0 = Date.now();
const secs = () => ((Date.now() - t0) / 1000).toFixed(2);
const lines: string[] = [];
const record = (line: string) => {
  const row = `t=${secs()}s ${line}`;
  lines.push(row);
  console.log(row);
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const session = await connectBot({ url: URL_, token, name: "bot-attack", role: "qa", openSocket: openNodeSocket, onLog: (l) => record(`[conn] ${l}`) });
const world = session.world;
const selfId = () => world.self()?.id;
const players = () => new Set([...(world.playerIds?.() ?? [])]);
const losNow = (targetId: number): boolean => {
  const me = world.self();
  const tg = world.others().find((p) => p.id === targetId);
  if (!me || !tg) return false;
  return hasLineOfSight(
    { x: me.x, y: me.y + world.pawnHeight * 0.8, z: me.z },
    { x: tg.x, y: tg.y + world.pawnHeight * 0.75, z: tg.z },
    world.aabbs,
  );
};
const walkToPoint = async (target: { x: number; z: number }, ms: number, label: string): Promise<boolean> => {
  const deadline = Date.now() + ms;
  let last = Infinity;
  let lastProgress = Date.now();
  while (Date.now() < deadline) {
    const me = world.self();
    if (!me) return false;
    const d = Math.hypot(me.x - target.x, me.z - target.z);
    if (d <= 0.6) {
      session.input.sendInput({ moveX: 0, moveZ: 0, yaw: me.yaw });
      await sleep(120);
      return true;
    }
    if (d < last - 0.2) { last = d; lastProgress = Date.now(); }
    if (Date.now() - lastProgress > 3000) {
      record(`${label}: no progress at ${me.x.toFixed(2)},${me.y.toFixed(2)},${me.z.toFixed(2)} d=${d.toFixed(2)}`);
      return false;
    }
    session.input.sendInput(wishTo({ x: me.x, y: me.y, z: me.z, vx: 0, vz: 0, yaw: me.yaw }, target, 1));
    await sleep(50);
  }
  return false;
};
// Stuck-aware walker: sidesteps/reverses when the capsule stops making progress.
const walkWithRecovery = async (target: { x: number; z: number }, ms: number, label: string): Promise<boolean> => {
  const deadline = Date.now() + ms;
  let lastX = Number.NaN;
  let lastZ = Number.NaN;
  let lastProgress = Date.now();
  let attempts = 0;
  while (Date.now() < deadline) {
    const me = world.self();
    if (!me) return false;
    const d = Math.hypot(me.x - target.x, me.z - target.z);
    if (d <= 0.6) {
      session.input.sendInput({ moveX: 0, moveZ: 0, yaw: me.yaw });
      await sleep(120);
      return true;
    }
    if (Number.isFinite(lastX) && Math.hypot(me.x - lastX, me.z - lastZ) < 0.15) {
      if (Date.now() - lastProgress > 1500) {
        attempts += 1;
        record(`${label}: STUCK #${attempts} at ${me.x.toFixed(2)},${me.y.toFixed(2)},${me.z.toFixed(2)} d=${d.toFixed(2)}`);
        if (attempts > 4) return false;
        const yaw = Math.atan2(target.x - me.x, target.z - me.z);
        const side = attempts % 2 === 1 ? 1 : -1;
        const sidePoint = { x: me.x + Math.cos(yaw) * side * 1.2, z: me.z - Math.sin(yaw) * side * 1.2 };
        const until = Date.now() + 700;
        while (Date.now() < until) {
          const p2 = world.self();
          if (!p2) break;
          session.input.sendInput(wishTo({ x: p2.x, y: p2.y, z: p2.z, vx: 0, vz: 0, yaw: p2.yaw }, sidePoint, 1));
          await sleep(50);
        }
        lastX = Number.NaN;
        lastProgress = Date.now();
        continue;
      }
    } else {
      lastX = me.x;
      lastZ = me.z;
      lastProgress = Date.now();
    }
    session.input.sendInput(wishTo({ x: me.x, y: me.y, z: me.z, vx: 0, vz: 0, yaw: me.yaw }, target, 1));
    await sleep(50);
  }
  record(`${label}: timeout`);
  return false;
};

const armed = () => (world.weapon() ?? "") !== "" && world.ammo() > 0;

const armUp = async (): Promise<boolean> => {
  if (![...world.pickups()].includes("alien-weapon-1")) {
    record("arm-up: alien-weapon-1 is not on the map");
    return false;
  }
  record("arm-up: east approach");
  await walkWithRecovery({ x: -13.90, z: 16.50 }, 60_000, "east");
  record("arm-up: climb");
  const climbed = await walkWithRecovery({ x: -23.90, z: 16.50 }, 60_000, "climb");
  record(`arm-up climb=${climbed} weapon=${world.weapon() ?? "none"} ammo=${world.ammo()}`);
  if (world.self() && world.self()!.y > 0.6) await walkWithRecovery({ x: -20.30, z: 16.50 }, 30_000, "step-off");
  return armed();
};

const reload = async (): Promise<boolean> => {
  const me = world.self();
  if (!me) return false;
  const avail = new Set(world.pickups());
  const crates = (world.pickupPlacements() as Array<{ id: string; kind?: string; minX: number; maxX: number; minZ: number; maxZ: number; minY?: number; maxY?: number }>)
    .filter((p) => {
      if (p.kind !== "ammo" || !avail.has(p.id)) return false;
      const cx = (p.minX + p.maxX) / 2;
      const cy = (p.minY ?? 0) + 0.2;
      const cz = (p.minZ + p.maxZ) / 2;
      return (world.placeOf({ x: cx, y: cy, z: cz })?.id ?? "") === "outside";
    })
    .map((p) => {
      const x = (p.minX + p.maxX) / 2;
      const z = (p.minZ + p.maxZ) / 2;
      return { id: p.id, d: Math.hypot(x - me.x, z - me.z) };
    })
    .sort((a, b) => a.d - b.d);
  const crate = crates[0];
  record(`reload: candidates ${crates.slice(0, 4).map((c) => `${c.id}(${c.d.toFixed(0)}m)`).join(" ") || "none"}`);
  if (!crate) return false;
  const mission = parseMission(`retrieve:${crate.id}@outside`);
  const code = mission ? await runMission(session, mission, { timeoutMs: 90_000, log: (l) => record(`  ammo ${l}`), error: (l) => record(`  ammo ERROR ${l}`) }) : 1;
  record(`reload code=${code} ammo=${world.ammo()}`);
  return world.ammo() > 0;
};

let missionStalls = 0;
const monitorMission = (label: string): (() => void) => {
  let lastX = Number.NaN;
  let lastZ = Number.NaN;
  let lastProgress = Date.now();
  const timer = setInterval(() => {
    const me = world.self();
    if (!me) return;
    if (Number.isFinite(lastX) && Math.hypot(me.x - lastX, me.z - lastZ) < 0.12) {
      if (Date.now() - lastProgress > 2500) {
        missionStalls += 1;
        record(`${label}: MISSION STALL at ${me.x.toFixed(2)},${me.y.toFixed(2)},${me.z.toFixed(2)}`);
        lastProgress = Date.now();
      }
    } else {
      lastX = me.x;
      lastZ = me.z;
      lastProgress = Date.now();
    }
  }, 250);
  return () => clearInterval(timer);
};

const goCentre = async (): Promise<void> => {
  const mission = parseMission(`stand:${CENTRE.x},0,${CENTRE.z}`);
  const stop = monitorMission("centre");
  const code = mission ? await runMission(session, mission, { timeoutMs: 25_000, log: (l) => record(`  centre ${l}`), error: (l) => record(`  centre ERROR ${l}`) }) : 1;
  stop();
  let me = world.self();
  record(`centre mission code=${code} self=${me?.x.toFixed(2)},${me?.y.toFixed(2)},${me?.z.toFixed(2)}`);
  if (code !== 0 && me) {
    record("centre: recovery walk");
    await walkWithRecovery({ x: CENTRE.x, z: CENTRE.z }, 40_000, "centre-recover");
  }
  me = world.self();
  record(`centre done self=${me?.x.toFixed(2)},${me?.y.toFixed(2)},${me?.z.toFixed(2)} stalls=${missionStalls}`);
};

const pickTarget = (): number | undefined => {
  const me = world.self();
  if (!me) return undefined;
  const skip = players();
  skip.add(me.id);
  const rows = world.others()
    .filter((p) => !skip.has(p.id) && world.healthOf?.(p.id)?.dead !== true)
    .map((p) => ({ id: p.id, d: Math.hypot(p.x - me.x, p.z - me.z), x: p.x, z: p.z }))
    .sort((a, b) => a.d - b.d);
  return rows[0]?.id;
};

let kills = 0;
let shots = 0;
const attacks: Array<Record<string, unknown>> = [];
try {
  const started = Date.now();
  while (!world.self() && Date.now() - started < 10_000) await sleep(20);
  while (!world.sceneGraph() && Date.now() - started < 10_000) await sleep(20);
  const me0 = world.self();
  record(`joined self=${me0?.id} at ${me0?.x.toFixed(2)},${me0?.z.toFixed(2)} pickups=${world.pickups().length} weapon=${world.weapon() ?? "none"} ammo=${world.ammo()}`);

  if (!armed()) await armUp();
  if (world.weapon() && world.ammo() <= 0) await reload();
  record(`armed weapon=${world.weapon() ?? "none"} ammo=${world.ammo()}`);
  await goCentre();

  const end = t0 + RUN_MS;
  while (Date.now() < end) {
    await sleep(150);
    if (!armed()) {
      if ((world.weapon() ?? "") === "") { record("no weapon (map pickup gone and the pawn is unarmed); stopping"); break; }
      if (!(await reload())) { record("no ammo available; stopping"); break; }
      await goCentre();
    }
    const targetId = pickTarget();
    if (targetId === undefined) { record("no target; patrolling centre"); await goCentre(); continue; }
    const tg = world.others().find((p) => p.id === targetId);
    const me = world.self()!;
    record(`target id=${targetId} d=${tg ? Math.hypot(tg.x - me.x, tg.z - me.z).toFixed(1) : "?"} hp=${JSON.stringify(world.healthOf?.(targetId))}`);
    // Pre-position inside the band with LOS.
    const preEnd = Date.now() + 20_000;
    while (Date.now() < preEnd && Date.now() < end) {
      const p = world.self();
      const t2 = world.others().find((q) => q.id === targetId);
      if (!p || !t2) break;
      const d = Math.hypot(t2.x - p.x, t2.z - p.z);
      if (d <= 15 && losNow(targetId)) break;
      session.input.sendInput(wishTo({ x: p.x, y: p.y, z: p.z, vx: 0, vz: 0, yaw: p.yaw }, { x: t2.x, z: t2.z }, 1));
      await sleep(50);
    }
    const mission = parseMission(`attack:${targetId}`);
    // Face the target while firing (product fix #10; the controller does not rotate the body).
    const face = setInterval(() => {
      const p = world.self();
      const t3 = world.others().find((q) => q.id === targetId);
      if (p && t3) session.input.sendInput({ moveX: 0, moveZ: 0, yaw: Math.atan2(t3.x - p.x, t3.z - p.z) });
    }, 100);
    const code = mission ? await runMission(session, mission, { timeoutMs: Math.min(60_000, Math.max(5000, end - Date.now())), log: (l) => {
      if (l.includes("attack: fire")) shots += 1;
      record(`  atk ${l}`);
    }, error: (l) => record(`  atk ERROR ${l}`) }) : 1;
    clearInterval(face);
    const hp = world.healthOf?.(targetId);
    if (code === 0 && hp?.dead === true) kills += 1;
    attacks.push({ t: Number(secs()), targetId, code, hp, shots });
    record(`attack done id=${targetId} code=${code} hp=${JSON.stringify(hp)} kills=${kills} shots=${shots}`);
    if (Date.now() < end) await goCentre();
  }
} catch (err) {
  record(`ERROR ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
} finally {
  const summary = { url: URL_, runMs: RUN_MS, kills, shots, attacks, elapsed: secs() };
  writeFileSync(TRACE, JSON.stringify({ summary, lines }, null, 1) + "\n");
  writeFileSync(LOG, lines.join("\n") + "\n");
  record(`EXIT kills=${kills} shots=${shots} elapsed=${secs()}s`);
  session.close();
  await sleep(400);
  record("closed");
}
