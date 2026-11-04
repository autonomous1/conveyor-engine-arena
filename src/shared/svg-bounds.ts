/**
 * Map extents from the `bounds` layer of an Inkscape design SVG.
 *
 * The layer is a `<g inkscape:label="bounds">` holding one `<rect>`. The rect's
 * four corners go through the rect's own `transform` and every ancestor
 * group's `transform` (outermost first), then into world XZ with the design
 * convention used by blueprint-scene: world X = svg x, world Z = viewBox
 * height − svg y (the SVG is flipped vertically). The result is the axis-aligned
 * box of the transformed corners. No DOM: plain text parsing, so it runs in
 * Node and in tests.
 */

export type SvgMapBounds = { minX: number; maxX: number; minZ: number; maxZ: number };

/** 2D affine [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f. */
export type Affine = [number, number, number, number, number, number];

const IDENTITY: Affine = [1, 0, 0, 1, 0, 0];

export function multiply(m: Affine, n: Affine): Affine {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export function parseTransform(text: string | undefined): Affine {
  let out: Affine = [...IDENTITY];
  if (!text) return out;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  for (const match of text.matchAll(re)) {
    const args = (match[2] ?? "").trim().split(/[\s,]+/).filter(Boolean).map(Number);
    if (args.some((v) => !Number.isFinite(v))) throw new Error(`bad transform: ${match[0]}`);
    let t: Affine;
    switch (match[1]) {
      case "matrix":
        if (args.length !== 6) throw new Error(`bad transform: ${match[0]}`);
        t = args as Affine;
        break;
      case "translate":
        t = [1, 0, 0, 1, args[0] ?? 0, args[1] ?? 0];
        break;
      case "scale":
        t = [args[0] ?? 1, 0, 0, args[1] ?? args[0] ?? 1, 0, 0];
        break;
      case "rotate": {
        const r = ((args[0] ?? 0) * Math.PI) / 180;
        const cos = Math.cos(r);
        const sin = Math.sin(r);
        t = [cos, sin, -sin, cos, 0, 0];
        if (args.length >= 3) {
          const cx = args[1]!;
          const cy = args[2]!;
          t = multiply(multiply([1, 0, 0, 1, cx, cy], t), [1, 0, 0, 1, -cx, -cy]);
        }
        break;
      }
      case "skewX":
        t = [1, 0, Math.tan(((args[0] ?? 0) * Math.PI) / 180), 1, 0, 0];
        break;
      default:
        t = [1, Math.tan(((args[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0];
    }
    out = multiply(out, t);
  }
  return out;
}

type Tag = { name: string; attrs: Record<string, string>; close: boolean; selfClose: boolean };

function* tags(svg: string): Generator<Tag> {
  const re = /<(\/?)([A-Za-z_][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  const clean = svg.replace(/<!--[\s\S]*?-->/g, "").replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "");
  for (const m of clean.matchAll(re)) {
    const attrs: Record<string, string> = {};
    for (const a of (m[3] ?? "").matchAll(/([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
      attrs[a[1]!] = a[3] ?? a[4] ?? "";
    }
    yield { name: m[2]!, attrs, close: m[1] === "/", selfClose: m[4] === "/" };
  }
}

function num(value: string | undefined, name: string): number {
  const n = Number.parseFloat(value ?? "0");
  if (!Number.isFinite(n)) throw new Error(`bounds rect: bad ${name}`);
  return n;
}

/** Bounds from the first `<rect>` in the layer labelled `label` (default `bounds`). */
export function svgMapBounds(svg: string, label = "bounds"): SvgMapBounds {
  const stack: Array<{ name: string; matrix: Affine; inLayer: boolean }> = [];
  let viewHeight: number | undefined;
  for (const tag of tags(svg)) {
    if (tag.name.startsWith("?") || tag.name.startsWith("!")) continue;
    if (tag.close) {
      stack.pop();
      continue;
    }
    const parent = stack[stack.length - 1];
    const parentMatrix = parent?.matrix ?? IDENTITY;
    if (tag.name === "svg" && viewHeight === undefined) {
      const box = tag.attrs.viewBox?.trim().split(/[\s,]+/).map(Number);
      viewHeight = box && box.length === 4 && Number.isFinite(box[3]) ? box[3] : num(tag.attrs.height, "svg height");
    }
    const matrix = multiply(parentMatrix, parseTransform(tag.attrs.transform));
    const inLayer = (parent?.inLayer ?? false) || (tag.name === "g" && tag.attrs["inkscape:label"] === label);
    if (tag.name === "rect" && inLayer) {
      if (viewHeight === undefined) throw new Error("svg has no viewBox or height");
      const x = num(tag.attrs.x, "x");
      const y = num(tag.attrs.y, "y");
      const w = num(tag.attrs.width, "width");
      const h = num(tag.attrs.height, "height");
      if (!(w > 0) || !(h > 0)) throw new Error("bounds rect has no area");
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const [px, py] of [[x, y], [x + w, y], [x + w, y + h], [x, y + h]] as const) {
        const sx = matrix[0] * px + matrix[2] * py + matrix[4];
        const sy = matrix[1] * px + matrix[3] * py + matrix[5];
        const z = viewHeight - sy;
        minX = Math.min(minX, sx); maxX = Math.max(maxX, sx);
        minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
      }
      return { minX, maxX, minZ, maxZ };
    }
    if (!tag.selfClose) stack.push({ name: tag.name, matrix, inLayer });
  }
  throw new Error(`no <rect> in the "${label}" layer`);
}
