// Scratch: run a mission through the real runMission path, sampling pose every 0.5 s,
// then hold the seat so the pawn stays where it stopped.
// Run: node --import ./scripts/ts-ext-register.mjs plan/dsh-tasks/live/mission-run.ts \
//        --goal "stand:door:<doorId>" [--timeout-s 120] [--name dev-1]
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { connectBot } from "../../../packages/bot-client/src/connection.ts";
import { openNodeSocket } from "../../../packages/bot-client/src/node-socket.ts";
import { runMission } from "../../../packages/bot-client/src/brain.ts";
import { resolveStand, type DoorView } from "../../../src/shared/nav/stand.ts";
import { planRoute, type Gate } from "../../../src/shared/nav/route.ts";
import type { ScenePortal } from "../../../src/shared/scene-graph.ts";
import { parseMission } from "../../../packages/bot-client/src/missions.ts";

const args = new Map<string, string>();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i]!;
  if (arg.startsWith("--")) args.set(arg.slice(2), argv[i + 1] ?? "");
}
const goalText = args.get("goal");
if (!goalText) {
  console.error("usage: mission-run.ts --goal <mission>");
  process.exit(1);
}
const timeoutMs = Number(args.get("timeout-s") ?? 120) * 1000;
const name = args.get("name") ?? "dev-1";
const token = readFileSync("/home/tim/.config/ce-arena/qa-token.pem", "utf8").trim();
const waitDoor = args.get("wait-door");
const mission = parseMission(goalText);
if (!mission) {
  console.error(`bad mission ${goalText}`);
  process.exit(1);
}

const session = await connectBot({
  url: "ws://127.0.0.1:4173",
  token,
  name,
  role: "qa",
  openSocket: openNodeSocket,
  onLog: (line) => console.error(line),
});
const world = session.world;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const t0 = Date.now();
const secs = () => ((Date.now() - t0) / 1000).toFixed(2);
const log = (line: string) => console.log(line);
const dir = "plan/dsh-tasks/live/captures";
mkdirSync(dir, { recursive: true });
const capture = `${dir}/mission-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`;

const until = async <T>(read: () => T | undefined, ms: number, label: string): Promise<T> => {
  const started = Date.now();
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() - started > ms) throw new Error(label);
    await sleep(40);
  }
};

try {
  const self = await until(() => world.self(), 8000, "no owned pawn");
  const graph = await until(() => world.sceneGraph(), 8000, "no scene graph");
  log(`seated name=${name} role=${world.role() ?? "none"} scope=${world.scope()?.join(",") ?? "none"}`);
  log(`graph places=${graph.places.length} portals=${graph.portals.length} hash=${(world.sceneGraphHash() ?? "none").slice(0, 12)}`);
  log(`self=${self.x.toFixed(2)} ${self.y.toFixed(2)} ${self.z.toFixed(2)} place=${world.placeOf(self)?.id ?? "?"} health=${world.health()?.hp ?? "?"}`);
  const others = world.others();
  log(`others=${others.length}`);
  for (const pawn of others) {
    const d = Math.hypot(pawn.x - self.x, pawn.z - self.z);
    if (d < 6) log(`  near id=${pawn.id} ${pawn.x.toFixed(2)} ${pawn.z.toFixed(2)} d=${d.toFixed(2)}m`);
  }
  const open = world.doors().filter((d) => d.open).map((d) => d.id);
  log(`doors open ${open.length}: ${open.join(", ") || "none"}`);
  appendFileSync(capture, JSON.stringify({
    event: "start", goal: goalText, name, role: world.role(), hash: world.sceneGraphHash(),
    self: { x: self.x, y: self.y, z: self.z },
  }) + "\n");

  if (waitDoor) {
    const started = Date.now();
    for (;;) {
      const door = world.door(waitDoor);
      if (door?.open) {
        log(`door ${waitDoor} open at t=${secs()}s locked=${door.locked}`);
        break;
      }
      if (Date.now() - started > 90_000) {
        log(`door ${waitDoor} still shut after 90s (open=${door?.open} locked=${door?.locked})`);
        session.close();
        process.exit(2);
      }
      await sleep(100);
    }
  }

  if (mission.kind === "stand") {
    const views: DoorView[] = [];
    for (const row of world.doors()) {
      const body = world.doorBody(row.id);
      if (body) views.push({ ...body, open: row.open, locked: row.locked });
    }
    const stand = resolveStand(mission.target, graph, views);
    if (!stand) {
      console.error("preflight: stand target does not resolve");
      session.close();
      process.exit(2);
    }
    const gate = (portal: ScenePortal): Gate => {
      if (portal.kind !== "door") return "open";
      const live = world.door(portal.door ?? portal.id);
      if (!live) return portal.locked === true ? "locked" : "closed-unlocked";
      if (live.open) return "open";
      return live.locked ? "locked" : "closed-unlocked";
    };
    const route = planRoute(graph, self, stand.place, gate);
    log(`preflight stand place=${stand.place} point=${stand.x.toFixed(2)},${stand.z.toFixed(2)}`);
    if (!route.ok) {
      log(`preflight: no on-foot route (${route.reason}); the brain may still plan a ride`);
    } else {
      log(`preflight route steps=${route.steps.length}: ${route.steps.map((step) => `${step.portal.kind}:${step.portal.id} gate=${gate(step.portal)}`).join(" | ")}`);
    }
  }

  const sampler = setInterval(() => {
    const now = world.self();
    if (!now) return;
    const place = world.placeOf(now)?.id ?? "?";
    const gateDoor = waitDoor ? world.door(waitDoor) : undefined;
    log(`t=${secs()}s self=${now.x.toFixed(2)} ${now.y.toFixed(2)} ${now.z.toFixed(2)} place=${place}`);
    appendFileSync(capture, JSON.stringify({ t: Number(secs()), x: now.x, y: now.y, z: now.z, yaw: now.yaw, place, doorOpen: gateDoor?.open, doorLocked: gateDoor?.locked }) + "\n");
  }, 500);

  let code = 1;
  try {
    code = await runMission(session, mission, {
      timeoutMs,
      log: (line) => log(`  brain ${line}`),
      error: (line) => console.error(`  brain ${line}`),
    });
  } finally {
    clearInterval(sampler);
  }
  const end = world.self();
  const place = end ? world.placeOf(end)?.id : undefined;
  log(`MISSION ${code === 0 ? "MET" : code === 2 ? "NO-PLAN" : code === 3 ? "TIMEOUT" : `code=${code}`} t=${secs()}s self=${end?.x.toFixed(2)} ${end?.y.toFixed(2)} ${end?.z.toFixed(2)} place=${place}`);
  appendFileSync(capture, JSON.stringify({ event: "mission", code, x: end?.x, y: end?.y, z: end?.z, place }) + "\n");
  for (;;) {
    const now = world.self();
    log(`HOLD t=${secs()}s self=${now?.x.toFixed(2)} ${now?.y.toFixed(2)} ${now?.z.toFixed(2)} place=${now ? world.placeOf(now)?.id : "?"}`);
    await sleep(5000);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  session.close();
  process.exit(3);
}
