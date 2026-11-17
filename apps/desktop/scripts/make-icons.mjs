// Renders the HQP Studio app icon — the H·Q·S monogram, one joined white line on a single flat
// colour — to every PNG the apps ship. Pure Node, no image libraries:
//
//   pnpm icons
//
// The same shapes are in apps/remote/public/icon.svg and in BrandMark (packages/ui); keep the
// three in sync when the mark changes.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');

/** The one background colour, and the colour of the mark. */
const BG = [0x1b, 0x2c, 0xc1];
const FG = [0xff, 0xff, 0xff];
/** Drawn on a 256-unit grid; stroke width in the same units. */
const STROKE = 20;

/** Points along a cubic Bézier. */
function cubic(p0, p1, p2, p3, steps = 24) {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    pts.push([
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
    ]);
  }
  return pts;
}
function circle(cx, cy, r, steps = 96) {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}

/** The mark as polylines (round caps and joins come free from the distance field). */
const PATHS = [
  // H
  [
    [36, 84],
    [36, 172],
  ],
  [
    [36, 128],
    [80, 128],
  ],
  [
    [80, 84],
    [80, 172],
  ],
  // Q: ring + tail
  circle(128, 128, 36),
  [
    [150, 150],
    [172, 172],
  ],
  // S: three cubics
  [
    ...cubic([218, 102], [210, 86], [180, 84], [178, 104]),
    ...cubic([178, 104], [176, 124], [220, 124], [220, 150]),
    ...cubic([220, 150], [220, 174], [184, 176], [176, 156]),
  ],
];
const SEGMENTS = PATHS.flatMap((pts) => pts.slice(1).map((p, i) => [pts[i], p]));

function distanceToMark(x, y) {
  let best = Infinity;
  for (const [[ax, ay], [bx, by]] of SEGMENTS) {
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / len2));
    const d = Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
    if (d < best) best = d;
  }
  return best;
}

const clamp01 = (v) => Math.min(1, Math.max(0, v));

/** Signed distance (px) from a point to a rounded rectangle. */
function roundRect(px, py, cx, cy, halfW, halfH, r) {
  const qx = Math.abs(px - cx) - (halfW - r);
  const qy = Math.abs(py - cy) - (halfH - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/**
 * @param size   output width/height in px
 * @param shape  'rounded' = rounded square on transparency, 'full' = full-bleed square
 * @param glyph  scale of the mark (maskable icons keep it inside the safe zone)
 */
function render(size, { shape = 'rounded', glyph = 1 } = {}) {
  const px = Buffer.alloc(size * size * 4);
  const c = size / 2;
  const unit = (size / 256) * glyph; // px per grid unit
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sx = x + 0.5;
      const sy = y + 0.5;
      // back into the 256 grid, scaled about the centre
      const gx = 128 + (sx - c) / unit;
      const gy = 128 + (sy - c) / unit;
      const ink = clamp01(0.5 - (distanceToMark(gx, gy) - STROKE / 2) * unit);
      const alpha =
        shape === 'full' ? 1 : clamp01(0.5 - roundRect(sx, sy, c, c, c, c, size * 0.225));
      const o = (y * size + x) * 4;
      for (let k = 0; k < 3; k++) px[o + k] = Math.round(BG[k] + (FG[k] - BG[k]) * ink);
      px[o + 3] = Math.round(alpha * 255);
    }
  }
  return px;
}

function chunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, tail]);
}

function png(size, rgba, { opaque = false } = {}) {
  const channels = opaque ? 3 : 4;
  const stride = size * channels + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const src = (y * size + x) * 4;
      rgba.copy(raw, y * stride + 1 + x * channels, src, src + channels);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = opaque ? 2 : 6; // RGB / RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const OUTPUTS = [
  // Web Remote (PWA) — also the source of the desktop tray icon.
  ['apps/remote/public/icon-192.png', 192, {}],
  ['apps/remote/public/icon-512.png', 512, {}],
  ['apps/remote/public/icon-maskable-512.png', 512, { shape: 'full', glyph: 0.8 }],
  ['apps/remote/public/apple-touch-icon.png', 180, { shape: 'full', opaque: true }],
  // Desktop app (electron-builder converts it to .ico / .icns).
  ['apps/desktop/build/icon.png', 1024, {}],
];

for (const [file, size, opts] of OUTPUTS) {
  const out = join(root, file);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, png(size, render(size, opts), opts));
  console.log(`${file} (${size}×${size})`);
}
