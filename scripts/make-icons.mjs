/**
 * Generates the PWA icons as real PNGs with no image dependencies.
 *
 * Writes a flat Sleeper-navy square with a teal football, which is all the
 * home-screen icon needs to be. Encodes PNG by hand (uncompressed deflate
 * blocks) so the project stays dependency-free.
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');

const BG = [15, 21, 33]; // #0f1521
const FG = [18, 214, 172]; // #12d6ac

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** Football shape: an ellipse with laces, drawn analytically per pixel. */
function pixelColor(x, y, size) {
  const cx = size / 2;
  const cy = size / 2;
  const rx = size * 0.31;
  const ry = size * 0.19;

  const dx = (x - cx) / rx;
  const dy = (y - cy) / ry;
  const inBall = dx * dx + dy * dy <= 1;

  if (!inBall) return BG;

  // Laces: a short horizontal bar with cross-stitches.
  const nearCenterY = Math.abs(y - cy) < size * 0.012;
  const withinLaceX = Math.abs(x - cx) < size * 0.1;
  if (nearCenterY && withinLaceX) return BG;

  const stitchSpacing = size * 0.045;
  const onStitch =
    Math.abs(((x - cx) % stitchSpacing) - stitchSpacing / 2) < size * 0.008 &&
    Math.abs(y - cy) < size * 0.045 &&
    withinLaceX;
  if (onStitch) return BG;

  return FG;
}

function makePng(size) {
  // Raw scanlines: one filter byte (0 = none) then RGB triples.
  const raw = Buffer.alloc(size * (1 + size * 3));
  let offset = 0;
  for (let y = 0; y < size; y++) {
    raw[offset++] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b] = pixelColor(x, y, size);
      raw[offset++] = r;
      raw[offset++] = g;
      raw[offset++] = b;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of [192, 512]) {
  const png = makePng(size);
  writeFileSync(join(PUBLIC_DIR, `icon-${size}.png`), png);
  console.log(`  icon-${size}.png (${(png.length / 1024).toFixed(1)}kb)`);
}

console.log('✓ icons generated');
