// ARCHITECTURE: The wander-stall dump: pose, plan path, follower grid window,
//   place spec, and host colliders captured together.
// Wiring: game.ts writes it when ARENA_WANDER_DEBUG=1 and the follower reports
//   stuck; it has no other caller.
import type { Grid } from "../shared/nav/grid.js";
import type { Vec3 } from "../shared/scene-graph.js";

/**
 * Wander Stall type.
 */
export type WanderStall = {
  at: number;
  tick: number;
  agent: number;
  pose: { x: number; y: number; z: number; yaw: number };
  place: string;
  goal: { x: number; y: number; z: number } | undefined;
  claim: boolean;
  path: { count: number; yMin: number; yMax: number; points: Vec3[] };
  follower: { baseY: number; cell: number; minX: number; minZ: number; w: number; h: number };
  cells: Array<{ i: number; j: number; floor: number; blocked: number; poly: boolean }>;
  spec?: { baseY: number; minX: number; maxX: number; minZ: number; maxZ: number; blocks: number };
  colliders: Array<{ id: number; minX: number; maxX: number; minY?: number; maxY?: number; minZ: number; maxZ: number; source?: string }>;
  source: "follower" | "install";
};

type Box = { id: number; minX: number; maxX: number; minY?: number; maxY?: number; minZ: number; maxZ: number; source?: string };

/**
 * Builds Wander Stall Dump.
 */
export function buildWanderStallDump(input: {
  at: number;
  tick: number;
  agent: number;
  pose: { x: number; y: number; z: number; yaw: number };
  place: string;
  goal?: { x: number; y: number; z: number };
  claim: boolean;
  path: { points: Vec3[]; baseY: number };
  grid: Grid;
  spec?: { baseY: number; minX: number; maxX: number; minZ: number; maxZ: number; blocks: number };
  colliders: Box[];
  source: "follower" | "install";
}): WanderStall {
  const { grid, pose } = input;
  let yMin = pose.y;
  let yMax = pose.y;
  for (const point of input.path.points) {
    if (point[1] < yMin) yMin = point[1];
    if (point[1] > yMax) yMax = point[1];
  }
  const ci = Math.floor((pose.x - grid.minX) / grid.cell);
  const cj = Math.floor((pose.z - grid.minZ) / grid.cell);
  const cells: WanderStall["cells"] = [];
  for (let j = Math.max(0, cj - 3); j <= Math.min(grid.h - 1, cj + 3); j += 1) {
    for (let i = Math.max(0, ci - 3); i <= Math.min(grid.w - 1, ci + 3); i += 1) {
      const idx = j * grid.w + i;
      const blocked = grid.blocked[idx] ?? 0;
      cells.push({ i, j, floor: grid.floor[idx] ?? 0, blocked, poly: blocked > 1 });
    }
  }
  return {
    at: input.at,
    tick: input.tick,
    agent: input.agent,
    pose: { ...pose },
    place: input.place,
    goal: input.goal ? { ...input.goal } : undefined,
    claim: input.claim,
    path: {
      count: input.path.points.length,
      yMin,
      yMax,
      points: input.path.points.map((point) => [point[0], point[1], point[2]]),
    },
    follower: {
      baseY: input.path.baseY,
      cell: grid.cell,
      minX: grid.minX,
      minZ: grid.minZ,
      w: grid.w,
      h: grid.h,
    },
    cells,
    ...(input.spec ? { spec: { ...input.spec } } : {}),
    colliders: input.colliders.map((box) => ({ ...box })),
    source: input.source,
  };
}

/**
 * Wander Dump Writer type.
 */
export type WanderDumpWriter = (dump: WanderStall, dir?: string) => string | undefined;

/**
 * Write one dump through the Node writer installed by
 * `wander-debug-node.ts`. The solo bundle has no writer and returns undefined.
 * @post Undefined when no writer is installed or the directory is not writable.
 */
export function writeWanderStallDump(dump: WanderStall, dir?: string): string | undefined {
  const writer = (globalThis as { __wanderDumpWriter?: WanderDumpWriter }).__wanderDumpWriter;
  return writer?.(dump, dir);
}
