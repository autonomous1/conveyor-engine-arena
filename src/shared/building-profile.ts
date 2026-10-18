/**
 * Building outlines from a plan SVG, in model space.
 *
 * A path point `(sx, sy)` is model `(sx, -sy)`: model +X is SVG +x and model
 * +Z is SVG −y, because the plan is toolbar Y-up while SVG y grows down.
 * The group's matrix yaw is the authoring yaw. It is not the mesh yaw.
 * Rings are unscaled, around the model origin. The map multiplies by the
 * placement scale and turns them with the mesh.
 */

export type ProfilePoint = [number, number];
export type ProfileRing = ProfilePoint[];

export type BuildingProfile = {
  id: string;
  /** Degrees about +Y, snapped to a quarter turn. The SVG group's yaw. */
  yaw: number;
  rings: ProfileRing[];
};

export type ProfileTable = Map<string, { yaw?: number; rings: ProfileRing[] }>;

const PATH_TOKEN = /[MmLlHhVvCcSsQqTtAaZz]|[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g;

/**
 * Closed subpaths of an SVG path, still in that path's SVG space.
 * Curves keep their endpoint. A ring shorter than 3 points is dropped.
 */
export function svgPathRings(d: string): Array<Array<[number, number]>> {
  const tokens = d.match(PATH_TOKEN) ?? [];
  const rings: Array<Array<[number, number]>> = [];
  let index = 0;
  let cmd = "";
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  let current: Array<[number, number]> = [];
  const isCommand = (token: string | undefined) => token != null && /^[A-Za-z]$/.test(token);
  const read = (): number => {
    const token = tokens[index];
    if (token == null || isCommand(token)) throw new Error("bad svg path");
    index += 1;
    return Number(token);
  };
  const push = (x: number, y: number) => {
    const last = current[current.length - 1];
    if (last && Math.abs(last[0] - x) < 1e-9 && Math.abs(last[1] - y) < 1e-9) return;
    current.push([x, y]);
  };
  const finish = () => {
    if (current.length >= 2) {
      const first = current[0]!;
      const last = current[current.length - 1]!;
      if (Math.abs(first[0] - last[0]) < 1e-9 && Math.abs(first[1] - last[1]) < 1e-9) current.pop();
    }
    if (current.length >= 3) rings.push(current);
    current = [];
  };

  while (index < tokens.length) {
    if (isCommand(tokens[index])) cmd = tokens[index++]!;
    else if (!cmd) throw new Error("bad svg path");
    const rel = cmd === cmd.toLowerCase();
    const op = cmd.toUpperCase();
    if (op === "Z") {
      cx = sx;
      cy = sy;
      finish();
      cmd = "";
      continue;
    }
    if (op === "H") {
      const x = read();
      cx = rel ? cx + x : x;
      push(cx, cy);
      continue;
    }
    if (op === "V") {
      const y = read();
      cy = rel ? cy + y : y;
      push(cx, cy);
      continue;
    }
    if (op === "M" || op === "L" || op === "T") {
      const ox = cx;
      const oy = cy;
      const x = read();
      const y = read();
      cx = rel ? ox + x : x;
      cy = rel ? oy + y : y;
      if (op === "M") {
        if (current.length > 0) finish();
        sx = cx;
        sy = cy;
        cmd = rel ? "l" : "L";
      }
      push(cx, cy);
      continue;
    }
    if (op === "C" || op === "S" || op === "Q") {
      const ox = cx;
      const oy = cy;
      const pairs = op === "C" ? 3 : 2;
      for (let pair = 0; pair < pairs; pair += 1) {
        const x = read();
        const y = read();
        cx = rel ? ox + x : x;
        cy = rel ? oy + y : y;
      }
      push(cx, cy);
      continue;
    }
    if (op === "A") {
      read();
      read();
      read();
      read();
      read();
      const ox = cx;
      const oy = cy;
      const x = read();
      const y = read();
      cx = rel ? ox + x : x;
      cy = rel ? oy + y : y;
      push(cx, cy);
      continue;
    }
    throw new Error(`bad svg path command ${cmd}`);
  }
  if (current.length > 0) finish();
  return rings;
}

/** SVG user-space rings to model XZ. `+x` stays `+X`. `+y` (down) becomes `−Z`. */
export function svgRingsToModel(rings: ReadonlyArray<ReadonlyArray<readonly [number, number]>>): ProfileRing[] {
  return rings.map((ring) => ring.map(([x, y]) => [x, -y] as ProfilePoint));
}

type Mat = [number, number, number, number, number, number];

/**
 * Quarter-turn yaw of an SVG matrix, degrees.
 * The same turn as Three.js `rotation.y`: 90 sends model +X to world −Z.
 */
export function yawOfSvgMatrix(matrix: readonly number[]): number {
  if (matrix.length !== 6) throw new Error("svg matrix needs 6 numbers");
  const a = matrix[0]!;
  const b = matrix[1]!;
  const len = Math.hypot(a, b);
  if (!(len > 1e-9)) throw new Error("svg transform scale is zero");
  const dx = a / len;
  const dz = -b / len;
  const theta = Math.atan2(-dz, dx) * 180 / Math.PI;
  return snapQuarter(theta);
}

function snapQuarter(degrees: number): number {
  const wrapped = ((degrees % 360) + 360) % 360;
  const cards = [0, 90, 180, 270, 360];
  let best = 0;
  let err = Infinity;
  for (const card of cards) {
    const delta = Math.abs(wrapped - card);
    if (delta < err) {
      err = delta;
      best = card === 360 ? 0 : card;
    }
  }
  if (err > 0.5) throw new Error(`svg yaw ${degrees} is not a quarter turn`);
  return best;
}

/**
 * One profile per group that carries `data-model` and a path.
 * Points stay in the group's local space. The group matrix is only the yaw.
 */
export function profilesFromPlanSvg(svg: string): BuildingProfile[] {
  const profiles: BuildingProfile[] = [];
  const seen = new Set<string>();
  const open = /<g\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = open.exec(svg))) {
    const tag = match[0];
    if (!/\bdata-model\s*=/.test(tag)) continue;
    const id = attr(tag, "id");
    if (!id) throw new Error("building group is missing id");
    if (seen.has(id)) throw new Error(`duplicate building id ${id}`);
    seen.add(id);
    const inner = elementInner(svg, open.lastIndex);
    const rings = pathsIn(inner);
    if (rings.length === 0) continue;
    const transform = attr(tag, "transform");
    const yaw = transform ? yawOfSvgMatrix(matrixOf(transform, id)) : 0;
    profiles.push({ id, yaw, rings: svgRingsToModel(rings) });
  }
  return profiles;
}

export function profileFileText(profiles: readonly BuildingProfile[]): string {
  const body: Record<string, { yaw: number; rings: ProfileRing[] }> = {};
  for (const profile of [...profiles].sort((a, b) => a.id.localeCompare(b.id))) {
    body[profile.id] = {
      yaw: profile.yaw,
      rings: profile.rings.map((ring) => ring.map(([x, z]) => [round6(x), round6(z)])),
    };
  }
  return `${JSON.stringify({ formatVersion: 1, units: "model", profiles: body }, null, 2)}\n`;
}

/** Read `building-profiles.json`. Throws when the document is not that file. */
export function parseBuildingProfiles(text: string): ProfileTable {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`building profiles are not json: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("building profiles must be an object");
  const record = parsed as Record<string, unknown>;
  if (record.formatVersion !== 1) throw new Error("building profiles formatVersion must be 1");
  if (record.units !== "model") throw new Error("building profiles units must be model");
  const profiles = record.profiles;
  if (!profiles || typeof profiles !== "object" || Array.isArray(profiles)) throw new Error("building profiles are missing");
  const table: ProfileTable = new Map();
  for (const [id, value] of Object.entries(profiles)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`profile ${id} must be an object`);
    const entry = value as Record<string, unknown>;
    const yaw = entry.yaw === undefined ? undefined : entry.yaw;
    if (yaw !== undefined && (typeof yaw !== "number" || !Number.isFinite(yaw))) throw new Error(`profile ${id} yaw is not a number`);
    table.set(id, { yaw: yaw as number | undefined, rings: readRings(entry.rings, id) });
  }
  return table;
}

export function attachBuildingProfiles<T extends { id: string; profile?: ProfileRing[]; authorYaw?: number }>(
  buildings: readonly T[],
  text: string | undefined,
): void {
  if (!text) return;
  const table = parseBuildingProfiles(text);
  for (const building of buildings) {
    const found = table.get(building.id);
    if (!found) continue;
    building.profile = found.rings;
    if (found.yaw !== undefined) building.authorYaw = found.yaw;
  }
}

function readRings(value: unknown, id: string): ProfileRing[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`profile ${id} has no rings`);
  const rings: ProfileRing[] = [];
  for (const ring of value) {
    if (!Array.isArray(ring) || ring.length < 3) throw new Error(`profile ${id} ring is shorter than 3`);
    const points: ProfilePoint[] = [];
    for (const point of ring) {
      if (!Array.isArray(point) || point.length < 2 || typeof point[0] !== "number" || typeof point[1] !== "number") {
        throw new Error(`profile ${id} point is not a pair`);
      }
      if (!Number.isFinite(point[0]) || !Number.isFinite(point[1])) throw new Error(`profile ${id} point is not finite`);
      points.push([point[0], point[1]]);
    }
    rings.push(points);
  }
  return rings;
}

function pathsIn(inner: string): Array<Array<[number, number]>> {
  const rings: Array<Array<[number, number]>> = [];
  const pathRe = /<path\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = pathRe.exec(inner))) {
    const d = attr(match[0], "d");
    if (!d) continue;
    const local = svgPathRings(d);
    const transform = attr(match[0], "transform");
    const matrix = transform ? matrixOf(transform, "path") : undefined;
    for (const ring of local) {
      const moved = matrix ? ring.map(([x, y]) => apply(matrix, x, y)) : ring;
      if (moved.length >= 3) rings.push(moved);
    }
  }
  return rings;
}

function elementInner(svg: string, from: number): string {
  const tags = /<\/?g\b[^>]*>/gi;
  tags.lastIndex = from;
  let depth = 1;
  let match: RegExpExecArray | null;
  while ((match = tags.exec(svg))) {
    depth += match[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return svg.slice(from, match.index);
  }
  return svg.slice(from);
}

function matrixOf(transform: string, id: string): Mat {
  const found = /matrix\s*\(([^)]*)\)/i.exec(transform);
  if (!found) throw new Error(`${id} transform is not a matrix`);
  const args = found[1]!.trim().split(/[\s,]+/).filter(Boolean).map(Number);
  if (args.length !== 6 || args.some((arg) => !Number.isFinite(arg))) throw new Error(`${id} matrix is invalid`);
  return [args[0]!, args[1]!, args[2]!, args[3]!, args[4]!, args[5]!];
}

function apply(m: Mat, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

function attr(tag: string, name: string): string | undefined {
  const found = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i").exec(tag);
  return found?.[1];
}

function round6(value: number): number {
  const rounded = Math.round(value * 1e6) / 1e6;
  return rounded === 0 ? 0 : rounded;
}
