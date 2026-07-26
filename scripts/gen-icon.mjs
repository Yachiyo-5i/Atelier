#!/usr/bin/env node
/**
 * Generate the 1024x1024 app icon source (no image deps — raw PNG encoding).
 * Design: indigo→violet vertical gradient in a rounded square, white astroid
 * spark in the center. Output: assets/icon-source.png (feed to `tauri icon`).
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outPath = path.join(root, 'assets', 'icon-source.png');

const SIZE = 1024;
const CORNER = 190; // rounded-corner radius
const TOP = [0x63, 0x66, 0xf1]; // indigo-500
const BOTTOM = [0x8b, 0x2f, 0xd6]; // violet

function insideRoundedSquare(x, y) {
  const min = CORNER;
  const max = SIZE - 1 - CORNER;
  const cx = x < min ? min : x > max ? max : x;
  const cy = y < min ? min : y > max ? max : y;
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= CORNER * CORNER;
}

function sparkAlpha(x, y) {
  // Astroid: |x|^(2/3) + |y|^(2/3) <= r^(2/3), soft edge for anti-aliasing.
  const r = 330;
  const dx = Math.abs(x - SIZE / 2);
  const dy = Math.abs(y - SIZE / 2);
  const v = Math.pow(dx, 2 / 3) + Math.pow(dy, 2 / 3);
  const edge = Math.pow(r, 2 / 3);
  if (v <= edge - 1.5) return 1;
  if (v >= edge + 1.5) return 0;
  return (edge + 1.5 - v) / 3;
}

const raw = Buffer.alloc(SIZE * (1 + SIZE * 4));
for (let y = 0; y < SIZE; y += 1) {
  const rowStart = y * (1 + SIZE * 4);
  raw[rowStart] = 0; // filter: none
  const t = y / (SIZE - 1);
  const bg = [
    Math.round(TOP[0] + (BOTTOM[0] - TOP[0]) * t),
    Math.round(TOP[1] + (BOTTOM[1] - TOP[1]) * t),
    Math.round(TOP[2] + (BOTTOM[2] - TOP[2]) * t),
  ];
  for (let x = 0; x < SIZE; x += 1) {
    const o = rowStart + 1 + x * 4;
    if (!insideRoundedSquare(x, y)) {
      raw.writeUInt32BE(0, o);
      continue;
    }
    const a = sparkAlpha(x, y);
    raw[o] = Math.round(bg[0] + (255 - bg[0]) * a);
    raw[o + 1] = Math.round(bg[1] + (255 - bg[1]) * a);
    raw[o + 2] = Math.round(bg[2] + (255 - bg[2]) * a);
    raw[o + 3] = 255;
  }
}

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

mkdirSync(path.dirname(outPath), { recursive: true });
writeFileSync(outPath, png);
console.log(`icon source written: ${outPath} (${png.length} bytes)`);
