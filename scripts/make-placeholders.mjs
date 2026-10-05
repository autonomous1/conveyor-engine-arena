import { deflateSync } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeGlb } from "conveyor-engine-assets";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "web", "assets");

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = rgba(x, y);
      const i = row + 1 + x * 4;
      raw[i] = r;
      raw[i + 1] = g;
      raw[i + 2] = b;
      raw[i + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function boxGlb(name, hx, hy, hz, y0, color) {
  const x0 = -hx;
  const x1 = hx;
  const z0 = -hz;
  const z1 = hz;
  const y1 = y0 + hy;
  const corners = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  const faces = [
    [0, 3, 2, 1],
    [4, 5, 6, 7],
    [0, 4, 7, 3],
    [1, 2, 6, 5],
    [3, 7, 6, 2],
    [0, 1, 5, 4],
  ];
  const positions = [];
  const indices = [];
  for (const face of faces) {
    const base = positions.length / 3;
    for (const index of face) positions.push(...corners[index]);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const pos = new Float32Array(positions);
  const idx = new Uint16Array(indices);
  const bin = new Uint8Array(pos.byteLength + idx.byteLength);
  bin.set(new Uint8Array(pos.buffer), 0);
  bin.set(new Uint8Array(idx.buffer), pos.byteLength);
  const doc = {
    asset: { version: "2.0", generator: "conveyor-engine-arena placeholders" },
    scene: 0,
    scenes: [{ name, nodes: [0] }],
    nodes: [{ name, mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
    materials: [{
      pbrMetallicRoughness: { baseColorFactor: [...color, 1], metallicFactor: 0.05, roughnessFactor: 0.7 },
    }],
    accessors: [
      {
        bufferView: 0, componentType: 5126, count: pos.length / 3, type: "VEC3",
        min: [x0, y0, z0], max: [x1, y1, z1],
      },
      { bufferView: 1, componentType: 5123, count: idx.length, type: "SCALAR" },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: pos.byteLength, target: 34962 },
      { buffer: 0, byteOffset: pos.byteLength, byteLength: idx.byteLength, target: 34963 },
    ],
    buffers: [{ byteLength: bin.byteLength }],
  };
  return encodeGlb(doc, bin);
}

const floor = png(128, 128, (x, y) => {
  const tile = 16;
  const gx = Math.floor(x / tile);
  const gy = Math.floor(y / tile);
  const edge = x % tile === 0 || y % tile === 0;
  const alt = (gx + gy) % 2;
  if (edge) return [70, 64, 58, 255];
  return alt ? [128, 118, 104, 255] : [108, 100, 88, 255];
});

const buildings = png(256, 128, (x, y) => {
  const col = Math.floor(x / 32);
  const sky = y < 28;
  if (sky) return [126, 166, 196, 255];
  const facade = col % 2 ? [92, 86, 96, 255] : [74, 78, 92, 255];
  const wx = x % 32;
  const wy = (y - 28) % 22;
  const windowOn = wx > 8 && wx < 22 && wy > 6 && wy < 16 && y < 118;
  if (windowOn) return [186, 214, 196, 255];
  return facade;
});

const sky = png(128, 128, (x, y) => {
  const t = y / 127;
  let r = 78 + (168 - 78) * t;
  let g = 128 + (206 - 128) * t;
  let b = 176 + (232 - 176) * t;
  const blob = (cx, cy, rad) => Math.max(0, 1 - Math.hypot((x - cx) / 1.6, (y - cy) / 0.7) / rad);
  let cloud = 0;
  for (let row = 8; row < 128; row += 18) {
    for (let col = (row / 18) % 2 ? 8 : 24; col < 140; col += 36) {
      cloud += blob(col, row, 16);
    }
  }
  const c = Math.min(1, cloud * 0.75);
  r = r * (1 - c) + 250 * c;
  g = g * (1 - c) + 252 * c;
  b = b * (1 - c) + 255 * c;
  return [r, g, b, 255].map((n) => Math.max(0, Math.min(255, Math.round(n))));
});

const files = {
  "textures/floor-stone.png": floor,
  "textures/buildings.png": buildings,
  "textures/cloudy-sky.png": sky,
  "models/player-a.glb": boxGlb("player-a", 0.28, 1.7, 0.22, 0, [0.22, 0.48, 0.86]),
  "models/player-b.glb": boxGlb("player-b", 0.4, 1.35, 0.32, 0, [0.86, 0.42, 0.18]),
  "models/cover-crate.glb": boxGlb("cover-crate", 0.5, 1, 0.5, 0, [0.45, 0.32, 0.18]),
};

for (const [rel, bytes] of Object.entries(files)) {
  const path = join(root, rel);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
  console.log(rel, bytes.length);
}
