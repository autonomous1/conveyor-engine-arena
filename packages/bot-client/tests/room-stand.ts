// Scratch controller: walk a place route (doors already open) with waypoint steering,
// then stand in front of one wall inside the room and face it.
// Run: node --import ./scripts/ts-ext-register.mjs plan/dsh-tasks/live/room-stand.ts \
//        --wall <wall AABB source> --room <place id> [--offset 1.2] [--timeout-s 120]
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { connectBot } from "../../../packages/bot-client/src/connection.ts";
import { openNodeSocket } from "../../../packages/bot-client/src/node-socket.ts";
import { INPUT_HZ } from "../../../src/shared/look.ts";
import { placeAt, type ScenePortal } from "../../../src/shared/scene-graph.ts";
import { wishTo, type Pose } from "../../../src/shared/nav/follow.ts";
import { createNavCache, planLegs } from "../../../src/shared/nav/legs.ts";
import { planRoute, type Gate } from "../../../src/shared/nav/route.ts";

type Triple = [number, number, number];

const STEP_MS = 1000 / INPUT_HZ;
const args = new Map<string, string>();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i]!;
  if (arg.startsWith("--")) args.set(arg.slice(2), argv[i + 1] ?? "");
}
const wallSource = args.get("wall");
const roomId = args.get("room");
if (!wallSource || !roomId) {
  console.error("usage: room-stand.ts --wall <wall aabb source> --room <place id>");
  process.exit(1);
}
const offsetM = Number(args.get("offset") ?? 1.2);
const viaText = args.get("via");
const via = (viaText ?? "").split(";").filter((part) => part.length > 0).map((part) => {
  const [x, z] = part.split(",").map(Number);
  return [x, z] as [number, number];
});
const timeoutMs = Number(args.get("timeout-s") ?? 120) * 1000;

const token = readFileSync("plan/dsh-tasks/live/.ce-auth/bot-1.token", "utf8").trim();
const sceneGraph = JSON.parse(readFileSync("web/game/scene-graph.json", "utf8")) as unknown;
const regions = JSON.parse(readFileSync("web/game/regions.json", "utf8")) as unknown;

const session = await connectBot({
  url: "ws://127.0.0.1:4173",
  token,
  name: "dev-1",
  role: "bot",
  sceneGraph,
  regions,
  openSocket: openNodeSocket,
  onLog: (line) => console.error(line),
});
const world = session.world;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const t0 = Date.now();
const secs = () => ((Date.now() - t0) / 1000).toFixed(2);
const log = (line: string) => console.log(line);
const captureDir = "plan/dsh-tasks/live/captures";
mkdirSync(captureDir, { recursive: true });
const capture = `${captureDir}/room-stand-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`;
appendFileSync(capture, JSON.stringify({ t: 0, event: "start", wall: wallSource, room: roomId, offsetM }) + "\n");

const until = async <T>(read: () => T | undefined, ms: number, label: string): Promise<T> => {
  const started = Date.now();
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() - started > ms) throw new Error(label);
    await sleep(40);
  }
};

const poseNow = (): Pose | undefined => {
  const self = world.self();
  if (!self) return undefined;
  return { x: self.x, y: self.y, z: self.z, vx: 0, vz: 0, yaw: self.yaw };
};

/** Straight waypoint steering: wishTo each leg point in turn, no follower grid. */
async function walk(points: Triple[], deadline: number): Promise<"arrived" | "stuck" | "timeout"> {
  let wp = 1;
  let lastDist = Infinity;
  let lastProgress = Date.now();
  let tick = 0;
  while (Date.now() < deadline) {
    const now = poseNow();
    if (!now) {
      await sleep(STEP_MS);
      continue;
    }
    while (wp < points.length - 1) {
      const point = points[wp]!;
      if (Math.hypot(now.x - point[0], now.z - point[2]) > 0.55) break;
      wp += 1;
      lastDist = Infinity;
      lastProgress = Date.now();
    }
    const goal = points[points.length - 1]!;
    if (wp === points.length - 1 && Math.hypot(now.x - goal[0], now.z - goal[2]) <= 0.5) return "arrived";
    const point = points[wp]!;
    const dist = Math.hypot(now.x - point[0], now.z - point[2]);
    if (dist < lastDist - 0.25 || dist < 0.6) {
      lastDist = dist;
      lastProgress = Date.now();
    }
    if (Date.now() - lastProgress > 2500) return "stuck";
    const scale = dist < 1.2 ? 0.4 : 1;
    session.input.sendInput(wishTo(now, { x: point[0], z: point[2] }, scale));
    tick += 1;
    if (tick % 10 === 0) {
      const place = world.placeOf(now)?.id ?? "?";
      log(`t=${secs()}s self=${now.x.toFixed(2)} ${now.y.toFixed(2)} ${now.z.toFixed(2)} place=${place} wp=${wp}/${points.length - 1} dist=${dist.toFixed(2)}m stay=${((Date.now() - lastProgress) / 1000).toFixed(1)}s`);
      appendFileSync(capture, JSON.stringify({ t: Number(secs()), x: now.x, y: now.y, z: now.z, place, wp, dist: Number(dist.toFixed(2)) }) + "\n");
    }
    await sleep(STEP_MS);
  }
  return "timeout";
}

try {
  const self0 = await until(() => world.self(), 8000, "no owned pawn");
  const graph = await until(() => world.sceneGraph(), 8000, "no scene graph");
  log(`seated self=${self0.x.toFixed(2)} ${self0.y.toFixed(2)} ${self0.z.toFixed(2)} place=${world.placeOf(self0)?.id ?? "?"} others=${world.others().length}`);
  const open = world.doors().filter((d) => d.open).map((d) => d.id);
  log(`doors open ${open.length}: ${open.join(", ") || "none"}`);

  const wall = world.aabbs.find((box) => box.source === wallSource);
  if (!wall) {
    console.error(`no aabb with source ${wallSource}`);
    session.close();
    process.exit(2);
  }
  const room = graph.placeById.get(roomId);
  if (!room) {
    console.error(`unknown room ${roomId}`);
    session.close();
    process.exit(2);
  }
  const midX = (wall.minX + wall.maxX) / 2;
  const midZ = (wall.minZ + wall.maxZ) / 2;
  const thinZ = wall.maxZ - wall.minZ <= wall.maxX - wall.minX;
  const baseY = room.kind === "outside" ? 0 : room.y;
  const candidates = thinZ
    ? [
      { x: midX, z: wall.maxZ + offsetM, axis: "z+" },
      { x: midX, z: wall.minZ - offsetM, axis: "z-" },
    ]
    : [
      { x: wall.maxX + offsetM, z: midZ, axis: "x+" },
      { x: wall.minX - offsetM, z: midZ, axis: "x-" },
    ];
  let target: { x: number; y: number; z: number } | undefined;
  for (const candidate of candidates) {
    const place = placeAt(graph, candidate.x, baseY, candidate.z);
    log(`  candidate ${candidate.axis} ${candidate.x.toFixed(2)},${candidate.z.toFixed(2)} place=${place.id}`);
    if (place.id === roomId) target = { x: candidate.x, y: baseY, z: candidate.z };
  }
  if (!target) {
    console.error("neither side of the wall is inside the room");
    session.close();
    process.exit(2);
  }
  log(`wall ${wallSource} x[${wall.minX.toFixed(2)},${wall.maxX.toFixed(2)}] z[${wall.minZ.toFixed(2)},${wall.maxZ.toFixed(2)}]`);
  log(`target ${target.x.toFixed(2)} ${target.y.toFixed(2)} ${target.z.toFixed(2)} (${offsetM} m into ${roomId})`);

  const gate = (portal: ScenePortal): Gate => {
    if (portal.kind !== "door") return "open";
    const live = world.door(portal.door ?? portal.id);
    if (!live) return portal.locked === true ? "locked" : "closed-unlocked";
    if (live.open) return "open";
    return live.locked ? "locked" : "closed-unlocked";
  };
  const shut = new Set(world.doors().filter((row) => !row.open).map((row) => row.id));
  const navView = {
    aabbs: world.aabbs,
    doors: world.doors().map((row) => ({ ...world.doorBody(row.id)!, open: row.open, locked: row.locked })),
    pawnRadius: world.pawnRadius,
    pawnHeight: world.pawnHeight,
  };
  const cache = createNavCache();
  const pose = poseNow();
  if (!pose) process.exit(2);
  const here = world.placeOf(pose)?.id ?? placeAt(graph, pose.x, pose.y, pose.z).id;

  const points: Triple[] = [[pose.x, pose.y, pose.z]];
  if (via.length > 0) {
    log(`via waypoints ${via.length}`);
    for (const [x, z] of via) points.push([x, pose.y, z]);
  } else if (here !== roomId) {
    const route = planRoute(graph, pose, roomId, gate);
    if (!route.ok) {
      console.error(`no route to ${roomId} (${route.reason}) — a door on the way is still locked`);
      session.close();
      process.exit(2);
    }
    log(`route steps ${route.steps.length}: ${route.steps.map((step) => `${step.portal.kind}:${step.portal.id} gate=${gate(step.portal)}`).join(" | ")}`);
    const legs = planLegs(graph, navView, route, pose, { cache, regions: regions as never });
    if (!legs.ok) {
      console.error(`no legs to ${roomId} (step ${legs.step})`);
      session.close();
      process.exit(2);
    }
    for (const point of legs.points) {
      const [px, py, pz] = Array.isArray(point) ? point : [point.x, point.y, point.z];
      const last = points[points.length - 1]!;
      if (Math.abs(last[0] - px) < 1e-3 && Math.abs(last[2] - pz) < 1e-3) continue;
      points.push([px, py, pz]);
    }
    log(`legs points ${legs.points.length}`);
  }
  {
    const last = points[points.length - 1]!;
    if (Math.hypot(last[0] - target.x, last[2] - target.z) > 0.25) points.push([target.x, target.y, target.z]);
  }
  log(`path points ${points.length} from ${pose.x.toFixed(1)},${pose.z.toFixed(1)} to ${target.x.toFixed(1)},${target.z.toFixed(1)}`);
  for (const point of points) log(`  wp ${point[0].toFixed(2)} ${point[2].toFixed(2)}`);

  const result = await walk(points, t0 + timeoutMs);
  const now = poseNow();
  log(`walk ${result} t=${secs()}s self=${now?.x.toFixed(2)} ${now?.y.toFixed(2)} ${now?.z.toFixed(2)} place=${now ? world.placeOf(now)?.id : "?"}`);
  appendFileSync(capture, JSON.stringify({ t: Number(secs()), event: "walk", result }) + "\n");
  if (result !== "arrived") {
    session.close();
    process.exit(result === "stuck" ? 3 : 3);
  }

  const wallPoint = { x: midX, z: midZ };
  for (let i = 0; i < 4; i += 1) {
    const p = poseNow();
    if (p) session.input.sendInput(wishTo(p, wallPoint, 0));
    await sleep(STEP_MS);
  }
  const final = poseNow();
  const finalPlace = final ? world.placeOf(final)?.id : undefined;
  log(`ARRIVED wall=${wallSource} room=${finalPlace} self=${final?.x.toFixed(2)} ${final?.y.toFixed(2)} ${final?.z.toFixed(2)} dist=${final ? Math.hypot(final.x - target.x, final.z - target.z).toFixed(2) : "?"}m`);
  appendFileSync(capture, JSON.stringify({ t: Number(secs()), event: "arrived", x: final?.x, y: final?.y, z: final?.z, place: finalPlace, wall: wallSource }) + "\n");

  for (;;) {
    const p = poseNow();
    if (p) session.input.sendInput(wishTo(p, wallPoint, 0));
    const dist = p ? Math.hypot(p.x - target.x, p.z - target.z) : Infinity;
    log(`HOLD t=${secs()}s self=${p?.x.toFixed(2)} ${p?.y.toFixed(2)} ${p?.z.toFixed(2)} place=${p ? world.placeOf(p)?.id : "?"} dist=${dist.toFixed(2)}m`);
    await sleep(5000);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  session.close();
  process.exit(3);
}
