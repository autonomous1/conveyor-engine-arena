// Scratch: cross doors the way the user described — centre on the doorway,
// then walk straight along the door axis — for a chain of doors.
// Run: node --import ./scripts/ts-ext-register.mjs plan/dsh-tasks/live/through-doors.ts \
//   --doors "id1;id2" [--final "x,y,z"] [--timeout-s 180]
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { connectBot } from "../../../packages/bot-client/src/connection.ts";
import { openNodeSocket } from "../../../packages/bot-client/src/node-socket.ts";
import { INPUT_HZ } from "../../../src/shared/look.ts";
import { placeAt, type SceneGraph } from "../../../src/shared/scene-graph.ts";
import { createFollower, doorStand, wishTo, type FollowPawn, type Pose } from "../../../src/shared/nav/follow.ts";
import type { FloorBox } from "../../../src/shared/movements.ts";
import { buildGrid, findLocalPath, navBoxes, specForPlace, type Grid } from "../../../src/shared/nav/grid.ts";

type Triple = [number, number, number];
type Point = { x: number; y: number; z: number };

const STEP_MS = 1000 / INPUT_HZ;
const args = new Map<string, string>();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i]!;
  if (arg.startsWith("--")) args.set(arg.slice(2), argv[i + 1] ?? "");
}
const doorIds = (args.get("doors") ?? "").split(";").filter((part) => part.length > 0);
if (doorIds.length === 0) {
  console.error("usage: through-doors.ts --doors <id1;id2;...>");
  process.exit(1);
}
const finalText = args.get("final");
const finalPoint: Point | undefined = finalText
  ? (() => {
    const [x, y, z] = finalText.split(",").map(Number);
    return { x: x!, y: y!, z: z! };
  })()
  : undefined;
const faceText = args.get("face");
const facePoint: Point | undefined = faceText
  ? (() => {
    const [fx, fz] = faceText.split(",").map(Number);
    return { x: fx!, y: 0, z: fz! };
  })()
  : undefined;
const timeoutMs = Number(args.get("timeout-s") ?? 180) * 1000;

const token = readFileSync("/home/tim/.config/ce-arena/qa-token.pem", "utf8").trim();
const session = await connectBot({
  url: "ws://127.0.0.1:4173",
  token,
  name: "dev-1",
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
const capture = `${dir}/through-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`;
appendFileSync(capture, JSON.stringify({ event: "start", doors: doorIds, final: finalPoint }) + "\n");

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
const others = (): FollowPawn[] => world.others().map((pawn) => ({ x: pawn.x, z: pawn.z, radius: world.pawnRadius }));

/** Conservative ground grid: a box blocks unless it is a step or overhead. */
function groundGrid(area: { minX: number; maxX: number; minZ: number; maxZ: number }, boxes: readonly FloorBox[], radius: number, height: number, baseY: number): Grid {
  const cell = 0.25;
  const w = Math.ceil((area.maxX - area.minX) / cell);
  const h = Math.ceil((area.maxZ - area.minZ) / cell);
  const floor = new Float32Array(w * h).fill(baseY);
  const blocked = new Uint8Array(w * h);
  for (const box of boxes) {
    const minY = box.minY ?? 0;
    const maxY = box.maxY ?? 0;
    if (maxY <= baseY + 0.3) continue;
    if (minY >= baseY + height) continue;
    const i0 = Math.floor((box.minX - radius - area.minX) / cell);
    const i1 = Math.floor((box.maxX + radius - area.minX) / cell);
    const j0 = Math.floor((box.minZ - radius - area.minZ) / cell);
    const j1 = Math.floor((box.maxZ + radius - area.minZ) / cell);
    for (let j = Math.max(0, j0); j <= Math.min(h - 1, j1); j += 1) {
      for (let i = Math.max(0, i0); i <= Math.min(w - 1, i1); i += 1) blocked[j * w + i] = 1;
    }
  }
  return { minX: area.minX, minZ: area.minZ, cell, w, h, floor, blocked };
}

try {
  const self0 = await until(() => world.self(), 8000, "no owned pawn");
  const graph = await until(() => world.sceneGraph(), 8000, "no scene graph");
  log(`seated role=${world.role()} scope=${world.scope()?.join(",")} self=${self0.x.toFixed(2)} ${self0.z.toFixed(2)} place=${world.placeOf(self0)?.id}`);
  log(`doors open: ${world.doors().filter((d) => d.open).map((d) => d.id).join(", ") || "none"}`);

  const shut = new Set(world.doors().filter((row) => !row.open).map((row) => row.id));
  const navView = {
    aabbs: world.aabbs,
    doors: world.doors().map((row) => ({ ...world.doorBody(row.id)!, open: row.open, locked: row.locked })),
    pawnRadius: world.pawnRadius,
    pawnHeight: world.pawnHeight,
  };
  const obstacles = navBoxes(navView, graph, shut);

  const gridFor = (placeId: string): Grid | undefined => {
    const spec = specForPlace(graph, placeId);
    if (!spec) return undefined;
    const place = graph.placeById.get(placeId);
    if (place?.kind === "outside") return groundGrid(spec.area, obstacles, world.pawnRadius, world.pawnHeight, spec.baseY);
    return buildGrid(spec.area, obstacles, {
      cell: 0.25,
      radius: world.pawnRadius,
      height: world.pawnHeight,
      baseY: spec.baseY,
      block: spec.block,
    });
  };

  const walkTo = async (target: Point, deadline: number): Promise<"arrived" | "stuck" | "timeout"> => {
    const pose = poseNow();
    if (!pose) return "timeout";
    const placeId = placeAt(graph, pose.x, pose.y, pose.z).id;
    const grid = gridFor(placeId);
    if (!grid) return "stuck";
    const local = findLocalPath(grid, { x: pose.x, z: pose.z }, { x: target.x, z: target.z });
    if (!local) {
      log(`no local path in ${placeId} to ${target.x.toFixed(2)},${target.z.toFixed(2)}`);
      return "stuck";
    }
    const points: Triple[] = [[pose.x, pose.y, pose.z]];
    for (const point of local) {
      const [px, py, pz] = Array.isArray(point) ? point : [point.x, point.y, point.z];
      const last = points[points.length - 1]!;
      if (Math.abs(last[0] - px) < 1e-3 && Math.abs(last[2] - pz) < 1e-3) continue;
      points.push([px, py, pz]);
    }
    log(`walk ${placeId}: ${points.length} points to ${target.x.toFixed(2)},${target.z.toFixed(2)}`);
    const follower = createFollower(points, grid, { radius: world.pawnRadius });
    let tick = 0;
    let lastLog = 0;
    while (Date.now() < deadline) {
      const now = poseNow();
      if (!now) {
        await sleep(STEP_MS);
        continue;
      }
      const dist = Math.hypot(now.x - target.x, now.z - target.z);
      if (dist <= 0.35 && Math.abs(now.y - target.y) <= 0.6) return "arrived";
      const step = follower.step(now, others(), tick);
      tick += 1;
      session.input.sendInput(step.input);
      if (Date.now() - lastLog >= 500) {
        lastLog = Date.now();
        log(`t=${secs()}s self=${now.x.toFixed(2)} ${now.y.toFixed(2)} ${now.z.toFixed(2)} d=${dist.toFixed(2)} ${step.status}`);
      }
      if (step.status === "stuck") return "stuck";
      if (step.status === "arrived") return "arrived";
      await sleep(STEP_MS);
    }
    return "timeout";
  };

  /** Face a world point with a zero-move frame, a few ticks only. */
  const faceNow = async (point: Point): Promise<void> => {
    for (let i = 0; i < 4; i += 1) {
      const pose = poseNow();
      if (pose) session.input.sendInput(wishTo(pose, point, 0));
      await sleep(STEP_MS);
    }
  };

  /** Press use while near an unlocked shut leaf; true once it is open. */
  const tryOpen = async (doorId: string, deadline: number): Promise<boolean> => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const row = world.door(doorId);
      if (row?.open) return true;
      if (!row) return false;
      if (row.locked) {
        log(`door ${doorId} is locked; a key is needed`);
        return false;
      }
      const pose = poseNow();
      const body = world.doorBody(doorId);
      if (!pose || !body) return false;
      const dist = Math.hypot(pose.x - body.position[0], pose.z - body.position[2]);
      if (dist > 3.2) return false;
      session.input.use();
      await sleep(150);
      if (world.door(doorId)?.open) return true;
      if (Date.now() > deadline) return false;
    }
    return world.door(doorId)?.open === true;
  };

  /** Straight crossing along the door axis, centred on the doorway. */
  const crossDoor = async (doorId: string, far: Point, deadline: number): Promise<boolean> => {
    const door = world.door(doorId);
    if (!door) return false;
    const start = Date.now();
    while (Date.now() < deadline) {
      const now = poseNow();
      if (!now) {
        await sleep(STEP_MS);
        continue;
      }
      const dist = Math.hypot(now.x - far.x, now.z - far.z);
      if (dist <= 0.35 && Math.abs(now.y - far.y) <= 0.6) return true;
      const live = world.door(doorId);
      if (!live?.open) {
        log(`door ${doorId} closed before the crossing finished (d=${dist.toFixed(2)}m)`);
        return false;
      }
      const scale = dist < 1.2 ? 0.4 : 1;
      session.input.sendInput(wishTo(now, { x: far.x, z: far.z }, scale));
      if (Date.now() - start > 500 && (Date.now() - start) % 1000 < 60) {
        log(`cross ${doorId} t=${secs()}s self=${now.x.toFixed(2)} ${now.z.toFixed(2)} d=${dist.toFixed(2)}m open=${live.open}`);
      }
      await sleep(STEP_MS);
    }
    return false;
  };

  const deadline = t0 + timeoutMs;
  if (finalPoint) {
    const pose = poseNow();
    if (pose) {
      const herePlace = placeAt(graph, pose.x, pose.y, pose.z).id;
      const finalPlace = placeAt(graph, finalPoint.x, finalPoint.y, finalPoint.z).id;
      if (herePlace === finalPlace && finalPlace !== "outside") {
        log(`already in ${finalPlace}; local walk to the final point`);
        const walked = await walkTo(finalPoint, deadline);
        log(`local final walk: ${walked}`);
        if (facePoint) await faceNow(facePoint);
        const end = poseNow();
        log(`ARRIVED self=${end?.x.toFixed(2)} ${end?.y.toFixed(2)} ${end?.z.toFixed(2)} place=${end ? world.placeOf(end)?.id : "?"}`);
        appendFileSync(capture, JSON.stringify({ t: Number(secs()), event: "arrived", x: end?.x, y: end?.y, z: end?.z, place: end ? world.placeOf(end)?.id : null }) + "\n");
        for (;;) {
          const p2 = poseNow();
          log(`HOLD t=${secs()}s self=${p2?.x.toFixed(2)} ${p2?.y.toFixed(2)} ${p2?.z.toFixed(2)} place=${p2 ? world.placeOf(p2)?.id : "?"}`);
          await sleep(5000);
        }
      }
    }
  }
  for (const doorId of doorIds) {
    const pose = poseNow();
    const body = world.doorBody(doorId);
    if (pose && body && Math.hypot(pose.x - body.position[0], pose.z - body.position[2]) < 3.2) {
      if (await tryOpen(doorId, deadline)) log(`opened ${doorId} in place`);
    }
  }
  for (let index = 0; index < doorIds.length; index += 1) {
    const doorId = doorIds[index]!;
    const body = world.doorBody(doorId);
    if (!body) {
      log(`unknown door ${doorId}`);
      process.exit(2);
    }
    const outStand = doorStand(body, "out");
    const inStand = doorStand(body, "in");
    const outPlace = placeAt(graph, outStand.x, outStand.y, outStand.z).id;
    const inPlace = placeAt(graph, inStand.x, inStand.y, inStand.z).id;
    const pose = poseNow()!;
    const nowPlace = placeAt(graph, pose.x, pose.y, pose.z).id;
    const nearIsOut = outPlace === nowPlace;
    const near = nearIsOut ? outStand : inStand;
    const far = nearIsOut ? inStand : outStand;
    log(`door ${doorId}: now=${nowPlace} near=${nearIsOut ? "out" : "in"}(${near.x.toFixed(2)},${near.z.toFixed(2)}) far=${nearIsOut ? "in" : "out"}(${far.x.toFixed(2)},${far.z.toFixed(2)})`);

    const approach = await walkTo({ x: near.x, y: near.y, z: near.z }, deadline);
    log(`approach ${doorId}: ${approach}`);
    if (approach !== "arrived") {
      log("stop: could not centre on the doorway");
      process.exit(3);
    }

    // Face the leaf and wait for it to open before committing to the gap.
    for (let i = 0; i < 10; i += 1) {
      const p = poseNow();
      if (p) session.input.sendInput(wishTo(p, { x: body.position[0], z: body.position[2] }, 0));
      await sleep(STEP_MS);
    }
    const waitStart = Date.now();
    while (!world.door(doorId)?.open) {
      if (Date.now() - waitStart > 2_000) {
        if (!(await tryOpen(doorId, deadline))) {
          log(`door ${doorId} could not be opened (locked=${world.door(doorId)?.locked})`);
          process.exit(2);
        }
        break;
      }
      await sleep(100);
    }
    log(`door ${doorId} open, crossing`);
    const target: Point = { x: far.x, y: far.y, z: far.z };
    const crossed = await crossDoor(doorId, target, deadline);
    const after = poseNow();
    log(`crossed ${doorId}: ${crossed} self=${after?.x.toFixed(2)} ${after?.z.toFixed(2)} place=${after ? world.placeOf(after)?.id : "?"}`);
    appendFileSync(capture, JSON.stringify({ t: Number(secs()), event: "cross", door: doorId, crossed, x: after?.x, z: after?.z, place: after ? world.placeOf(after)?.id : null }) + "\n");
    if (!crossed) {
      log("stop: crossing did not finish");
      process.exit(3);
    }
  }

  if (finalPoint) {
    const pose = poseNow()!;
    if (Math.hypot(pose.x - finalPoint.x, pose.z - finalPoint.z) > 0.4) {
      const walked = await walkTo(finalPoint, deadline);
      log(`final walk: ${walked}`);
    }
  }
  if (facePoint) await faceNow(facePoint);
  const end = poseNow();
  log(`ARRIVED self=${end?.x.toFixed(2)} ${end?.y.toFixed(2)} ${end?.z.toFixed(2)} place=${end ? world.placeOf(end)?.id : "?"}`);
  appendFileSync(capture, JSON.stringify({ t: Number(secs()), event: "arrived", x: end?.x, y: end?.y, z: end?.z, place: end ? world.placeOf(end)?.id : null }) + "\n");

  for (;;) {
    const p = poseNow();
    log(`HOLD t=${secs()}s self=${p?.x.toFixed(2)} ${p?.y.toFixed(2)} ${p?.z.toFixed(2)} place=${p ? world.placeOf(p)?.id : "?"}`);
    await sleep(5000);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  session.close();
  process.exit(3);
}
