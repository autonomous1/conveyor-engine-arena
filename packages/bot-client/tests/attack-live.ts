// Scratch: task 53 live run. One attack bot: arm up if needed, pick a wander-bot
// target (non-player), run attack:<id>, record health frames + every controller line.
// Run: CE_TOKEN=<jwt> node --import ./scripts/ts-ext-register.mjs packages/bot-client/tests/attack-live.ts [--target <id>]
import { appendFileSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { connectBot } from "../../../packages/bot-client/src/connection.ts";
import { openNodeSocket } from "../../../packages/bot-client/src/node-socket.ts";
import { runMission } from "../../../packages/bot-client/src/brain.ts";
import { parseMission } from "../../../packages/bot-client/src/missions.ts";
import { hasLineOfSight } from "../../../src/shared/hitscan.ts";
import { wishTo } from "../../../src/shared/nav/follow.ts";

const URL_ = "wss://arena.tszakacs.com";
const LOG = "plan/dsh-tasks/logs/53-attack.log";
const TRACE = "plan/dsh-tasks/logs/53-trace.json";
const token = (process.env.CE_TOKEN ?? "").trim() || readFileSync("/home/tim/.config/ce-arena/qa-token.pem", "utf8").trim();
const args = new Map<string, string>();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) if (argv[i]!.startsWith("--")) args.set(argv[i]!.slice(2), argv[i + 1] ?? "");
const fixedTarget = args.get("target") ? Number(args.get("target")) : undefined;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const t0 = Date.now();
const secs = () => ((Date.now() - t0) / 1000).toFixed(2);
const lines: string[] = [];
const trace: Array<Record<string, unknown>> = [];
const record = (line: string) => {
  const row = `t=${secs()}s ${line}`;
  lines.push(row);
  console.log(row);
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
      world.self();
      session.input.sendInput({ moveX: 0, moveZ: 0, yaw: me.yaw });
      await sleep(120);
      return true;
    }
    if (d < last - 0.2) {
      last = d;
      lastProgress = Date.now();
    }
    if (Date.now() - lastProgress > 3000) {
      record(`${label}: no progress at ${me.x.toFixed(2)},${me.y.toFixed(2)},${me.z.toFixed(2)} d=${d.toFixed(2)}`);
      return false;
    }
    session.input.sendInput(wishTo({ x: me.x, y: me.y, z: me.z, vx: 0, vz: 0, yaw: me.yaw }, target, 1));
    await sleep(50);
  }
  return false;
};

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

const session = await connectBot({ url: URL_, token, name: "bot-attack", role: "qa", openSocket: openNodeSocket, onLog: (l) => record(`[conn] ${l}`) });
const world = session.world;
let targetId: number | undefined;
try {
  const started = Date.now();
  while (!world.self() && Date.now() - started < 10_000) await sleep(20);
  while (!world.sceneGraph() && Date.now() - started < 10_000) await sleep(20);
  const self = world.self();
  if (!self) throw new Error("no owned pawn");
  const players = [...(world.playerIds?.() ?? [])];
  record(`joined self=${self.id} at ${self.x.toFixed(2)},${self.y.toFixed(2)},${self.z.toFixed(2)} place=${world.placeOf(self)?.id}`);
  record(`seat: others=${world.others().length} players=[${players.join(",")}] weapon=${world.weapon() ?? "none"} ammo=${world.ammo()} hp=${world.health()?.hp ?? "?"}`);
  record(`graph hash=${(world.sceneGraphHash() ?? "none").slice(0, 12)}`);
  const weaponPresent = [...world.pickups()].includes("alien-weapon-1");
  record(`pickups=${world.pickups().length} alien-weapon-1 present=${weaponPresent}`);

  // 1. Arm up: approach the alien weapon from 10 m east, then walk west up the steps.
  if ((!world.weapon() || world.ammo() <= 0) && weaponPresent) {
    const walkTo = async (target: { x: number; z: number }, ms: number, label: string): Promise<boolean> => {
      const deadline = Date.now() + ms;
      let last = Infinity;
      let lastProgress = Date.now();
      while (Date.now() < deadline) {
        const me = world.self();
        if (!me) return false;
        if (world.weapon() && world.ammo() > 0) return true;
        const d = Math.hypot(me.x - target.x, me.z - target.z);
        if (d <= 0.5) {
          session.input.sendInput({ moveX: 0, moveZ: 0, yaw: me.yaw });
          await sleep(100);
          return true;
        }
        if (d < last - 0.2) {
          last = d;
          lastProgress = Date.now();
        }
        if (Date.now() - lastProgress > 3000) {
          record(`arm-up ${label}: no progress at ${me.x.toFixed(2)},${me.y.toFixed(2)},${me.z.toFixed(2)} d=${d.toFixed(2)}`);
          return false;
        }
        session.input.sendInput(wishTo({ x: me.x, y: me.y, z: me.z, vx: 0, vz: 0, yaw: me.yaw }, target, 1));
        await sleep(50);
      }
      record(`arm-up ${label}: timeout`);
      return false;
    };
    record("arm-up: east approach to 10 m east of the weapon");
    const east = { x: -13.90, z: 16.50 };
    await walkTo(east, 60_000, "east");
    record(`at east point self=${world.self()?.x.toFixed(2)},${world.self()?.y.toFixed(2)},${world.self()?.z.toFixed(2)} weapon=${world.weapon() ?? "none"} ammo=${world.ammo()}`);
    if (!world.weapon() || world.ammo() <= 0) {
      record("arm-up: climbing the steps west toward the weapon");
      const climbed = await walkTo({ x: -23.90, z: 16.50 }, 60_000, "climb");
      record(`arm-up climb done=${climbed} self=${world.self()?.x.toFixed(2)},${world.self()?.y.toFixed(2)},${world.self()?.z.toFixed(2)} weapon=${world.weapon() ?? "none"} ammo=${world.ammo()}`);
    }
    record(`arm-up result weapon=${world.weapon() ?? "none"} ammo=${world.ammo()}`);
  } else if (world.weapon() && world.ammo() > 0) {
    record(`already armed weapon=${world.weapon()} ammo=${world.ammo()}`);
  } else {
    record("arm-up: alien-weapon-1 is not on the map (already taken); skipping the approach");
  }

  // 1b. Ammo: the alien weapon arrives empty; take the nearest available ammo crate.
  if (world.weapon() && world.ammo() <= 0) {
    let me = world.self()!;
    if (me.y > 0.6) {
      // The weapon sits on the crate stair; walk off east before routing anywhere.
      const off = { x: -13.90, z: 16.50 };
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const s2 = world.self();
        if (!s2 || s2.y < 0.3) break;
        session.input.sendInput(wishTo({ x: s2.x, y: s2.y, z: s2.z, vx: 0, vz: 0, yaw: s2.yaw }, off, 1));
        await sleep(50);
      }
      me = world.self()!;
      record(`stepped off the stairs: self=${me.x.toFixed(2)},${me.y.toFixed(2)},${me.z.toFixed(2)}`);
    }
    const avail = new Set(world.pickups());
    const crates = (world.pickupPlacements() as Array<{ id: string; kind?: string; minX: number; maxX: number; minZ: number; maxZ: number }>)
      .filter((p) => {
        if (p.kind !== "ammo" || !avail.has(p.id)) return false;
        const cx = (p.minX + p.maxX) / 2;
        const cy = ((p as { minY?: number; maxY?: number }).minY ?? 0) + 0.2;
        const cz = (p.minZ + p.maxZ) / 2;
        return (world.placeOf({ x: cx, y: cy, z: cz })?.id ?? "") === "outside";
      })
      .map((p) => {
        const x = (p.minX + p.maxX) / 2;
        const z = (p.minZ + p.maxZ) / 2;
        return { id: p.id, d: Math.hypot(x - me.x, z - me.z), x, z };
      })
      .sort((a, b) => a.d - b.d);
    record(`ammo candidates: ${crates.slice(0, 5).map((c) => `${c.id}(${c.d.toFixed(0)}m)`).join(" ") || "none"}`);
    const crate = crates[0];
    if (crate) {
      const mission = parseMission(`retrieve:${crate.id}@outside`);
      const code = mission ? await runMission(session, mission, { timeoutMs: 90_000, log: (l) => record(`  ammo ${l}`), error: (l) => record(`  ammo ERROR ${l}`) }) : 1;
      record(`ammo code=${code} ammo=${world.ammo()} weapon=${world.weapon() ?? "none"}`);
    }
  }

  // 1c. Back to the centre of the arena.
  const center = { x: -2.40, z: 3.00 };
  const atCenter = await walkToPoint(center, 60_000, "center");
  record(`back at the centre: ${atCenter} self=${world.self()?.x.toFixed(2)},${world.self()?.z.toFixed(2)}`);

  // 2. Target: explicit id, else the nearest non-player pawn.
  const selfNow = world.self()!;
  const candidates = world.others().filter((p) => p.id !== selfNow.id && !players.includes(p.id));
  if (fixedTarget !== undefined) {
    targetId = fixedTarget;
  } else {
    const nearest = candidates
      .map((p) => ({ p, d: Math.hypot(p.x - selfNow.x, p.z - selfNow.z) }))
      .sort((a, b) => a.d - b.d)[0];
    targetId = nearest?.p.id;
  }
  if (targetId === undefined) {
    record("no candidate target");
  } else {
    const t = world.others().find((p) => p.id === targetId);
    record(`target id=${targetId} at ${t?.x.toFixed(2)},${t?.y.toFixed(2)},${t?.z.toFixed(2)} d=${t ? Math.hypot(t.x - selfNow.x, t.z - selfNow.z).toFixed(1) : "?"} hp=${JSON.stringify(world.healthOf?.(targetId))}`);
    // Pre-position with the world-space walker so runAttack's approach is not needed.
    const preDeadline = Date.now() + 20_000;
    while (targetId !== undefined && Date.now() < preDeadline) {
      const me = world.self();
      const tg = world.others().find((p) => p.id === targetId);
      if (!me || !tg) break;
      const d = Math.hypot(tg.x - me.x, tg.z - me.z);
      if (d <= 15 && losNow(targetId)) break;
      session.input.sendInput(wishTo({ x: me.x, y: me.y, z: me.z, vx: 0, vz: 0, yaw: me.yaw }, { x: tg.x, z: tg.z }, 1));
      await sleep(50);
    }
    const me2 = world.self();
    const tg2 = targetId === undefined ? undefined : world.others().find((p) => p.id === targetId);
    record(`pre-position self=${me2?.x.toFixed(2)},${me2?.z.toFixed(2)} target=${tg2 ? `${tg2.x.toFixed(2)},${tg2.z.toFixed(2)} d=${Math.hypot(tg2.x - me2!.x, tg2.z - me2!.z).toFixed(1)} los=${losNow(targetId!)}` : "lost"}`);
    record(`candidates: ${candidates.slice(0, 6).map((p) => `${p.id}(${Math.hypot(p.x - selfNow.x, p.z - selfNow.z).toFixed(0)}m)`).join(" ")}`);

    // 3. Attack with a 10 Hz sampler.
    let sampling = true;
    const sampler = (async () => {
      while (sampling) {
        const me = world.self();
        const tg = targetId === undefined ? undefined : world.others().find((p) => p.id === targetId);
        if (me) {
          const hp = world.health();
          const tHp = targetId === undefined ? undefined : world.healthOf?.(targetId);
          let los = false;
          if (tg) {
            const eye = { x: me.x, y: me.y + world.pawnHeight * 0.8, z: me.z };
            const point = { x: tg.x, y: tg.y + world.pawnHeight * 0.75, z: tg.z };
            los = hasLineOfSight(eye, point, world.aabbs);
          }
          trace.push({
            t: Number(secs()),
            self: { x: me.x, y: me.y, z: me.z, hp: hp?.hp, dead: hp?.dead, ammo: world.ammo() },
            target: tg ? { id: tg.id, x: tg.x, y: tg.y, z: tg.z, d: Number(Math.hypot(tg.x - me.x, tg.z - me.z).toFixed(2)), hp: tHp?.hp, dead: tHp?.dead, los } : null,
          });
        }
        await sleep(100);
      }
    })();
    const mission = parseMission(`attack:${targetId}`);
    const code = mission ? await runMission(session, mission, { timeoutMs: 120_000, log: (l) => record(`  atk ${l}`), error: (l) => record(`  atk ERROR ${l}`) }) : 1;
    sampling = false;
    await sampler;
    const tEnd = targetId === undefined ? undefined : world.healthOf?.(targetId);
    const meEnd = world.self();
    record(`attack code=${code} targetHp=${JSON.stringify(tEnd)} selfHp=${JSON.stringify(world.health())} self=${meEnd ? `${meEnd.x.toFixed(2)},${meEnd.z.toFixed(2)}` : "?"} elapsed=${secs()}s`);
  }
} catch (err) {
  record(`ERROR ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
} finally {
  const shots = lines.filter((l) => l.includes("attack: fire")).length;
  const summary = { url: URL_, targetId, shots, outcome: lines.filter((l) => /attack: (dead|lost|refused|no_ammo|died|timeout|acquire|approach)/.test(l)).map((l) => l.trim()), samples: trace.length };
  writeFileSync(TRACE, JSON.stringify({ summary, samples: trace }, null, 1) + "\n");
  writeFileSync(LOG, lines.join("\n") + "\n");
  record(`EXIT shots=${shots} samples=${trace.length}`);
  session.close();
  await sleep(400);
  record("closed");
}
