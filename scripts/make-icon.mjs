// Generate the extension icon (128x128 PNG) — a simple isometric cube in the
// OpenSCAD yellow family on a dark ground. Dependency-free: hand-rolled PNG
// (RGB, no filter) compressed with Node's built-in zlib. Run: npm run make-icon.

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const SIZE = 128;

// --- palette ---
const BG = [0x1e, 0x1e, 0x1e];
const TOP = [0xf4, 0xd0, 0x3f]; // bright
const LEFT = [0xc9, 0xa2, 0x27]; // mid
const RIGHT = [0x9c, 0x7d, 0x1e]; // dark

// --- isometric cube hexagon (pointy top), centered ---
const cx = 64,
  cy = 64,
  R = 46;
const v = (deg) => [
  cx + R * Math.cos((deg * Math.PI) / 180),
  cy - R * Math.sin((deg * Math.PI) / 180),
];
const top = v(90),
  ul = v(150),
  ll = v(210),
  bot = v(270),
  lr = v(330),
  ur = v(30),
  ctr = [cx, cy];

const FACES = [
  { color: TOP, quad: [top, ur, ctr, ul] },
  { color: LEFT, quad: [ul, ctr, bot, ll] },
  { color: RIGHT, quad: [ctr, ur, lr, bot] },
];

const sign = (px, py, a, b) => (px - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (py - b[1]);
function inTri(p, a, b, c) {
  const d1 = sign(p[0], p[1], a, b);
  const d2 = sign(p[0], p[1], b, c);
  const d3 = sign(p[0], p[1], c, a);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}
const inQuad = (p, [a, b, c, d]) => inTri(p, a, b, c) || inTri(p, a, c, d);

function colorAt(x, y) {
  const p = [x + 0.5, y + 0.5];
  for (const f of FACES) if (inQuad(p, f.quad)) return f.color;
  return BG;
}

// --- raw RGB scanlines (filter byte 0 per row) ---
const raw = Buffer.alloc(SIZE * (1 + SIZE * 3));
let o = 0;
for (let y = 0; y < SIZE; y++) {
  raw[o++] = 0; // filter: none
  for (let x = 0; x < SIZE; x++) {
    const [r, g, b] = colorAt(x, y);
    raw[o++] = r;
    raw[o++] = g;
    raw[o++] = b;
  }
}

// --- CRC32 (table) + PNG chunk framing ---
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return (buf) => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
})();

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(CRC(body), 0);
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 2; // color type: RGB
// 10,11,12 = compression/filter/interlace = 0

const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = path.resolve('icon.png');
writeFileSync(out, png);
console.log(`[make-icon] wrote ${out} (${SIZE}x${SIZE}, ${png.length} bytes)`);
