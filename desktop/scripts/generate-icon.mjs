/**
 * Generates the application icons - ORIGINAL designs.
 *
 * The unofficial wrapper deliberately ships no Velxio logo or trademark: this
 * is a generic chip glyph with a play mark, drawn programmatically with a tiny
 * dependency-free encoder (node:zlib only).
 *
 * Outputs:
 *   build/icon.png   512x512, used by the window and by electron-builder
 *   build/icon.ico   multi-size ICO (16..256), used by the Windows shortcut
 *
 * Usage: node scripts/generate-icon.mjs [size]
 */
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUILD = path.join(HERE, '..', 'build');
const OUT_PNG = path.join(BUILD, 'icon.png');
const OUT_ICO = path.join(BUILD, 'icon.ico');

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Windows ICO container holding PNG-compressed entries (Vista+ reads these).
 * Dependency-free on purpose - see the file header.
 */
function encodeIco(entries) {
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0);              // reserved
  dir.writeUInt16LE(1, 2);              // type: icon
  dir.writeUInt16LE(entries.length, 4);

  const table = Buffer.alloc(16 * entries.length);
  let offset = 6 + table.length;
  entries.forEach((e, i) => {
    const at = i * 16;
    table[at] = e.size >= 256 ? 0 : e.size;      // 0 means 256
    table[at + 1] = e.size >= 256 ? 0 : e.size;
    table[at + 2] = 0;                            // palette count
    table[at + 3] = 0;                            // reserved
    table.writeUInt16LE(1, at + 4);               // colour planes
    table.writeUInt16LE(32, at + 6);              // bits per pixel
    table.writeUInt32LE(e.png.length, at + 8);    // size of image data
    table.writeUInt32LE(offset, at + 12);         // offset of image data
    offset += e.png.length;
  });

  return Buffer.concat([dir, table, ...entries.map((e) => e.png)]);
}

// ── tiny raster helpers ────────────────────────────────────────────────────
function makeCanvas(size) {
  return { size, px: Buffer.alloc(size * size * 4) };
}

function blend(c, x, y, [r, g, b], a) {
  if (a <= 0 || x < 0 || y < 0 || x >= c.size || y >= c.size) return;
  const i = (y * c.size + x) * 4;
  const dstA = c.px[i + 3] / 255;
  const outA = a + dstA * (1 - a);
  if (outA <= 0) return;
  c.px[i] = Math.round((r * a + c.px[i] * dstA * (1 - a)) / outA);
  c.px[i + 1] = Math.round((g * a + c.px[i + 1] * dstA * (1 - a)) / outA);
  c.px[i + 2] = Math.round((b * a + c.px[i + 2] * dstA * (1 - a)) / outA);
  c.px[i + 3] = Math.round(outA * 255);
}

function sdRoundRect(px, py, x0, y0, x1, y1, r) {
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const hx = (x1 - x0) / 2 - r;
  const hy = (y1 - y0) / 2 - r;
  const dx = Math.abs(px - cx) - hx;
  const dy = Math.abs(py - cy) - hy;
  const ox = Math.max(dx, 0);
  const oy = Math.max(dy, 0);
  return Math.min(Math.max(dx, dy), 0) + Math.sqrt(ox * ox + oy * oy) - r;
}

function fillRoundRect(c, x0, y0, x1, y1, r, colour, alpha = 1) {
  const S = 3;
  for (let y = Math.floor(y0) - 1; y <= Math.ceil(y1) + 1; y++) {
    for (let x = Math.floor(x0) - 1; x <= Math.ceil(x1) + 1; x++) {
      let hits = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          if (sdRoundRect(x + (sx + 0.5) / S, y + (sy + 0.5) / S, x0, y0, x1, y1, r) <= 0) hits++;
        }
      }
      if (hits) blend(c, x, y, colour, alpha * (hits / (S * S)));
    }
  }
}

function fillTriangle(c, p0, p1, p2, colour, alpha = 1) {
  const S = 3;
  const minX = Math.floor(Math.min(p0[0], p1[0], p2[0]));
  const maxX = Math.ceil(Math.max(p0[0], p1[0], p2[0]));
  const minY = Math.floor(Math.min(p0[1], p1[1], p2[1]));
  const maxY = Math.ceil(Math.max(p0[1], p1[1], p2[1]));
  const inside = (x, y) => {
    const d = (ax, ay, bx, by, cx, cy) => (ax - cx) * (by - cy) - (bx - cx) * (ay - cy);
    const d1 = d(x, y, p0[0], p0[1], p1[0], p1[1]);
    const d2 = d(x, y, p1[0], p1[1], p2[0], p2[1]);
    const d3 = d(x, y, p2[0], p2[1], p0[0], p0[1]);
    return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
  };
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      let hits = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) if (inside(x + (sx + 0.5) / S, y + (sy + 0.5) / S)) hits++;
      }
      if (hits) blend(c, x, y, colour, alpha * (hits / (S * S)));
    }
  }
}

// ── the design ─────────────────────────────────────────────────────────────
function draw(size) {
  const c = makeCanvas(size);
  const u = size / 512; // design unit

  const BG = [18, 18, 20];
  const BLUE = [0, 113, 227];
  const BLUE_LIGHT = [78, 168, 255];
  const PAD = [29, 29, 31];

  fillRoundRect(c, 26 * u, 26 * u, 486 * u, 486 * u, 108 * u, BG, 1);

  const bx0 = 148 * u, by0 = 148 * u, bx1 = 364 * u, by1 = 364 * u, br = 40 * u;
  fillRoundRect(c, bx0, by0, bx1, by1, br, BLUE, 1);
  const t = 20 * u;
  fillRoundRect(c, bx0 + t, by0 + t, bx1 - t, by1 - t, br - t * 0.6, BG, 1);

  const pw = 16 * u;
  const pl = 34 * u;
  const positions = [200, 256, 312].map((v) => v * u);
  for (const p of positions) {
    fillRoundRect(c, bx0 - pl, p - pw / 2, bx0 + 4 * u, p + pw / 2, pw / 2, BLUE, 1);
    fillRoundRect(c, bx1 - 4 * u, p - pw / 2, bx1 + pl, p + pw / 2, pw / 2, BLUE, 1);
    fillRoundRect(c, p - pw / 2, by0 - pl, p + pw / 2, by0 + 4 * u, pw / 2, BLUE, 1);
    fillRoundRect(c, p - pw / 2, by1 - 4 * u, p + pw / 2, by1 + pl, pw / 2, BLUE, 1);
  }

  const pad = 34 * u;
  fillRoundRect(c, bx0 + pad, by0 + pad, bx1 - pad, by1 - pad, 22 * u, PAD, 1);
  fillTriangle(c, [228 * u, 210 * u], [228 * u, 302 * u], [308 * u, 256 * u], BLUE_LIGHT, 1);

  return c;
}

const size = Number(process.argv[2] || 512);
fs.mkdirSync(BUILD, { recursive: true });

const main = draw(size);
fs.writeFileSync(OUT_PNG, encodePng(size, size, main.px));
console.log('wrote ' + OUT_PNG + ' (' + size + 'x' + size + ', ' + fs.statSync(OUT_PNG).size + ' bytes)');

const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const entries = icoSizes.map((s) => {
  const c = draw(s);
  return { size: s, png: encodePng(s, s, c.px) };
});
fs.writeFileSync(OUT_ICO, encodeIco(entries));
console.log(
  'wrote ' + OUT_ICO + ' (' + icoSizes.join('/') + ', ' + fs.statSync(OUT_ICO).size + ' bytes)',
);
