// Scratch controller: walk to one side of a door and stand in front of it.
// Not a mission (no GOAP goal names a door side), so this drives nav directly.
// Run: node --import ./scripts/ts-ext-register.mjs plan/dsh-tasks/live/door-stand.ts \
//        --door <doorId> [--side out|in|auto] [--timeout-s 90] [--stop-m 0.4]
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { connectBot } from "../../../packages/bot-client/src/connection.ts";
import { openNodeSocket } from "../../../packages/bot-client/src/node-socket.ts";
import { INPUT_HZ } from "../../../src/shared/look.ts";
import { placeAt, type SceneGraph, type ScenePortal } from "../../../src/shared/scene-graph.ts";
import type { FloorBox } from "../../../src/shared/movements.ts";
import { createFollower, doorStand, wishTo, type FollowPawn, type Pose } from "../../../src/shared/nav/follow.ts";
import { buildGrid, findLocalPath, navBoxes, specForPlace, type Grid } from "../../../src/shared/nav/grid.ts";
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
const doorId = args.get("door");
if (!doorId) {
  console.error("usage: door-stand.ts --door <doorId> [--side out|in|auto]");
  process.exit(1);
}
const wantSide = (args.get("side") ?? "auto") as "out" | "in" | "auto";
const timeoutMs = Number(args.get("timeout-s") ?? 90) * 1000;
const stopM = Number(args.get("stop-m") ?? 0.4);

const url = "ws://127.0.0.1:4173";
const token = readFileSync("plan/dsh-tasks/live/.ce-auth/bot-1.token", "utf8").trim();
const sceneGraph = JSON.parse(readFileSync("web/game/scene-graph.json", "utf8")) as unknown;
const regions = JSON.parse(readFileSync("web/game/regions.json", "utf8")) as unknown;


/**
 * Conservative ground grid for the outside plaza. The host grid models a prop
 * stack as a walkable surface (floor 2.75 m at ground level), so its path can
 * cross a crate stair the host collision blocks. Here a box blocks every cell
 * its expanded footprint covers unless it is a step (top <= 0.3 m) or overhead.
 */
function groundGrid(area: { minX: number; maxX: number; minZ: number; maxZ: number }, boxes: readonly FloorBox[], radius: number, height: number, baseY: number): Grid {
  const cell = 0.25;
  const w = Math.ceil((area.maxX - area.minX) / cell);
  const h = Math.ceil((area.maxZ - area.minZ) / cell);
  const floor = new Float32Array(w * h).fill(baseY);
  const blocked = new Uint8Array(w * h);
  const mark = (i0: number, i1: number, j0: number, j1: number) => {
    for (let j = Math.max(0, j0); j <= Math.min(h - 1, j1); j += 1) {
      for (let i = Math.max(0, i0); i <= Math.min(w - 1, i1); i += 1) blocked[j * w + i] = 1;
    }
  };
  for (const box of boxes) {
    const minY = box.minY ?? 0;
    const maxY = box.maxY ?? 0;
    if (maxY <= baseY + 0.3) continue;
    if (minY >= baseY + height) continue;
    const i0 = Math.floor((box.minX - radius - area.minX) / cell);
    const i1 = Math.floor((box.maxX + radius - area.minX) / cell);
    const j0 = Math.floor((box.minZ - radius - area.minZ) / cell);
    const j1 = Math.floor((box.maxZ + radius - area.minZ) / cell);
    if (i1 < 0 || j1 < 0 || i0 >= w || j0 >= h) continue;
    mark(i0, i1, j0, j1);
  }
  return { minX: area.minX, minZ: area.minZ, cell, w, h, floor, blocked };
}

const session = await connectBot({
  url,
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
const slug = doorId.split(".").slice(-2).join(".");
const capture = `${captureDir}/door-stand-${slug}-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`;
appendFileSync(capture, JSON.stringify({ t: 0, event: "start", door: doorId, wantSide, timeoutMs }) + "\n");

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
  const self0 = await until(() => world.self(), 8000, "no owned pawn");
  const graph = await until(() => world.sceneGraph(), 8000, "no scene graph");
  log(`seated self=${self0.x.toFixed(2)} ${self0.y.toFixed(2)} ${self0.z.toFixed(2)} place=${world.placeOf(self0)?.id ?? "?"}`);

  const body = world.doorBody(doorId);
  const door = world.door(doorId);
  if (!body || !door) {
    console.error(`unknown door ${doorId}`);
    process.exit(2);
  }
  log(`door ${doorId} pos=${body.position.join(",")} open=${door.open} locked=${door.locked}`);

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
    doors: world.doors().map((row) => {
      const leaf = world.doorBody(row.id)!;
      return { ...leaf, open: row.open, locked: row.locked };
    }),
    pawnRadius: world.pawnRadius,
    pawnHeight: world.pawnHeight,
  };
  const cache = createNavCache();

  const poseNow = (): Pose | undefined => {
    const self = world.self();
    if (!self) return undefined;
    return { x: self.x, y: self.y, z: self.z, vx: 0, vz: 0, yaw: self.yaw };
  };

  const chooseStand = (pose: Pose): { side: "out" | "in"; stand: { x: number; y: number; z: number }; place: string } | undefined => {
    const sides = wantSide === "auto" ? (["out", "in"] as const) : ([wantSide] as const);
    let best: { side: "out" | "in"; stand: { x: number; y: number; z: number }; place: string } | undefined;
    let bestScore = Infinity;
    for (const side of sides) {
      const stand = doorStand(body, side);
      const place = placeAt(graph, stand.x, stand.y, stand.z).id;
      const fromPlace = placeAt(graph, pose.x, pose.y, pose.z).id;
      let routeMetres = 0;
      if (place !== fromPlace) {
        const route = planRoute(graph, pose, place, gate);
        if (!route.ok) {
          log(`side ${side}: no route to ${place} (${route.reason})`);
          continue;
        }
        if (route.steps.some((step) => step.portal.kind === "door" && gate(step.portal) !== "open")) {
          log(`side ${side}: route to ${place} needs a shut door`);
          continue;
        }
        routeMetres = route.cost;
      }
      const score = routeMetres + Math.hypot(stand.x - pose.x, stand.z - pose.z);
      log(`side ${side}: stand=${stand.x.toFixed(2)} ${stand.z.toFixed(2)} place=${place} score=${score.toFixed(1)}m`);
      if (score < bestScore) {
        bestScore = score;
        best = { side, stand, place };
      }
    }
    return best;
  };

  const pose = poseNow();
  if (!pose) process.exit(2);
  const chosen = chooseStand(pose);
  if (!chosen) {
    console.error("no reachable door side");
    process.exit(2);
  }
  const { stand, place: standPlace } = chosen;
  log(`target stand side=${chosen.side} place=${standPlace} at=${stand.x.toFixed(2)} ${stand.y.toFixed(2)} ${stand.z.toFixed(2)}`);

  const fromPlace = placeAt(graph, pose.x, pose.y, pose.z).id;
  let points: Triple[] = [[pose.x, pose.y, pose.z]];
  if (standPlace !== fromPlace) {
    const route = planRoute(graph, pose, standPlace, gate);
    if (!route.ok) {
      console.error(`no route to stand place ${standPlace}: ${route.reason}`);
      process.exit(2);
    }
    const legs = planLegs(graph, navView, route, pose, { cache, regions: regions as never });
    if (!legs.ok) {
      console.error(`no legs to ${standPlace} (step ${legs.step})`);
      process.exit(2);
    }
    points = legs.points.map((point): Triple => [point.x, point.y, point.z]);
    if (points.length === 0) points = [[pose.x, pose.y, pose.z]];
  }

  // Same place: the host builds one grid over the whole place (see game.ts appendInterior),
  // not a bbox around the straight line. Outside is 143 x 93 m, so a corridor grid cannot
  // round a building; the place grid can.
  const herePlace = placeAt(graph, pose.x, pose.y, pose.z);
  const baseY = herePlace.kind === "outside" ? 0 : herePlace.y;
  const spec = specForPlace(graph, standPlace);
  if (!spec) {
    console.error(`no grid spec for place ${standPlace}`);
    session.close();
    process.exit(2);
  }
  const obstacles = navBoxes(navView, graph, shut);
  const outside = herePlace.kind === "outside";
  let grid: Grid = outside
    ? groundGrid(spec.area, obstacles, world.pawnRadius, world.pawnHeight, spec.baseY)
    : buildGrid(spec.area, obstacles, {
      cell: 0.25,
      radius: world.pawnRadius,
      height: world.pawnHeight,
      baseY: spec.baseY,
      block: spec.block,
    });
  const end = points[points.length - 1] ?? [pose.x, pose.y, pose.z];
  if (Math.hypot(end[0] - stand.x, end[2] - stand.z) > 0.25) {
    const local = findLocalPath(grid, { x: end[0], z: end[2] }, { x: stand.x, z: stand.z });
    if (!local) {
      console.error(`no local path in ${standPlace} from ${end[0].toFixed(1)},${end[2].toFixed(1)} to ${stand.x.toFixed(1)},${stand.z.toFixed(1)}`);
      session.close();
      process.exit(2);
    }
    log(`local path in ${standPlace}: ${local.length} points`);
    for (const point of local) {
      const [px, py, pz] = Array.isArray(point) ? point : [point.x, point.y, point.z];
      const last = points[points.length - 1]!;
      if (Math.abs(last[0] - px) < 1e-3 && Math.abs(last[2] - pz) < 1e-3) continue;
      points.push([px, py, pz]);
    }
  }
  log(`path points=${points.length} from ${pose.x.toFixed(1)},${pose.z.toFixed(1)} to ${stand.x.toFixed(1)},${stand.z.toFixed(1)}`);
  for (const point of points.slice(0, 5)) log(`  head ${point[0].toFixed(2)} ${point[2].toFixed(2)}`);
  for (const point of points.slice(-3)) log(`  tail ${point[0].toFixed(2)} ${point[2].toFixed(2)}`);

  const follower = createFollower(points, grid, { radius: world.pawnRadius });
  const others = (): FollowPawn[] => world.others().map((pawn) => ({ x: pawn.x, z: pawn.z, radius: world.pawnRadius }));

  let tick = 0;
  let lastLog = 0;
  let arrived = false;
  while (Date.now() - t0 < timeoutMs) {
    const now = poseNow();
    if (!now) {
      await sleep(STEP_MS);
      continue;
    }
    const dist = Math.hypot(now.x - stand.x, now.z - stand.z);
    const height = Math.abs(now.y - stand.y);
    if (dist <= stopM && height <= 0.6) {
      arrived = true;
      break;
    }
    const step = follower.step(now, others(), tick);
    tick += 1;
    session.input.sendInput(step.input);
    if (tick <= 5) log(`tick ${tick} input ${step.input.moveX.toFixed(2)} ${step.input.moveZ.toFixed(2)} yaw ${step.input.yaw.toFixed(2)} status ${step.status}`);
    const at = Date.now() - t0;
    if (at - lastLog >= 500) {
      lastLog = at;
      const place = world.placeOf(now)?.id ?? "?";
      log(`t=${secs()}s self=${now.x.toFixed(2)} ${now.y.toFixed(2)} ${now.z.toFixed(2)} place=${place} dist=${dist.toFixed(2)}m status=${step.status}`);
      appendFileSync(capture, JSON.stringify({
        t: Number(secs()), x: now.x, y: now.y, z: now.z, yaw: now.yaw,
        place, dist: Number(dist.toFixed(2)), status: step.status,
      }) + "\n");
    }
    if (step.status === "stuck") {
      log(`STUCK t=${secs()}s self=${now.x.toFixed(2)} ${now.y.toFixed(2)} ${now.z.toFixed(2)} dist=${dist.toFixed(2)}m`);
      appendFileSync(capture, JSON.stringify({ t: Number(secs()), event: "stuck", x: now.x, y: now.y, z: now.z }) + "\n");
      session.close();
      process.exit(3);
    }
    await sleep(STEP_MS);
  }

  if (!arrived) {
    log(`NOT ARRIVED t=${secs()}s`);
    session.close();
    process.exit(3);
  }

  const face = { x: body.position[0], z: body.position[2] };
  for (let i = 0; i < 4; i += 1) {
    const now = poseNow();
    if (now) session.input.sendInput(wishTo(now, face, 0));
    await sleep(STEP_MS);
  }
  const final = poseNow();
  const finalPlace = final ? world.placeOf(final)?.id : undefined;
  log(`ARRIVED door=${doorId} side=${chosen.side} self=${final?.x.toFixed(2)} ${final?.y.toFixed(2)} ${final?.z.toFixed(2)} place=${finalPlace} dist=${final ? Math.hypot(final.x - stand.x, final.z - stand.z).toFixed(2) : "?"}m`);
  appendFileSync(capture, JSON.stringify({
    t: Number(secs()), event: "arrived", x: final?.x, y: final?.y, z: final?.z, place: finalPlace,
    door: doorId, side: chosen.side,
  }) + "\n");

  // Hold in front of the door until the operator stops this job.
  for (;;) {
    const now = poseNow();
    if (now) session.input.sendInput(wishTo(now, face, 0));
    const dist = now ? Math.hypot(now.x - stand.x, now.z - stand.z) : Infinity;
    const place = now ? world.placeOf(now)?.id : undefined;
    log(`HOLD t=${secs()}s self=${now?.x.toFixed(2)} ${now?.y.toFixed(2)} ${now?.z.toFixed(2)} place=${place} dist=${dist.toFixed(2)}m`);
    await sleep(5000);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  session.close();
  process.exit(3);
}
