'use strict';

// Generates resources/icon.png (1024x1024) - a simple football icon.
// Pure Node (zlib), no image libraries needed.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 1024;

// ---------- tiny PNG writer ----------
function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0; // filter none
    rgba.copy(raw, row + 1, y * size * 4, (y + 1) * size * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- tiny rasterizer ----------
const buf = Buffer.alloc(SIZE * SIZE * 4);

function insidePoly(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// draw with soft 1px edge (faster than AA) over base color
function draw(predicate, color, base) {
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (predicate(x, y)) {
        const i = (y * SIZE + x) * 4;
        buf[i] = color[0]; buf[i + 1] = color[1]; buf[i + 2] = color[2]; buf[i + 3] = 255;
      }
    }
  }
}

function circle(cx, cy, r) {
  return (x, y) => (x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r;
}
function ring(cx, cy, ro, ri) {
  return (x, y) => {
    const d = (x - cx) * (x - cx) + (y - cy) * (y - cy);
    return d <= ro * ro && d >= ri * ri;
  };
}
function polygon(pts) {
  return (x, y) => insidePoly(x, y, pts);
}

// ---------- draw the icon ----------
// 1) green pitch background
draw(() => true, [23, 122, 61], null);

// simple pitch markings (lighter green)
draw(circle (SIZE / 2, SIZE / 2, 420), [39, 140, 74], null);
draw(circle (SIZE / 2, SIZE / 2, 422), [39, 140, 74], null);

// 2) white soccer ball
const ballR = 300;
const bx = SIZE / 2, by = SIZE / 2;
draw(circle(bx, by, ballR), [245, 245, 245], null);
draw(ring(bx, by, ballR + 6, ballR), [33, 33, 33], null);

// 3) black pentagon at center
function pentagon(cx, cy, r, rot) {
  const pts = [];
  for (let i = 0; i < 5; i++) {
    const a = rot + (i * 2 * Math.PI) / 5 - Math.PI / 2;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}
draw(polygon(pentagon(bx, by, 108, 0)), [26, 26, 26], null);
for (let i = 0; i < 5; i++) {
  const a = (i * 2 * Math.PI) / 5 - Math.PI / 2;
  const px = bx + 165 * Math.cos(a), py = by + 165 * Math.sin(a);
  draw(polygon(pentagon(px, py, 46, a + Math.PI / 5)), [26, 26, 26], null);
}
// subtle white ball highlight
draw(circle(bx - 55, by - 75, 42), [255, 255, 255], null);

// ---------- write file ----------
const outDir = path.join(__dirname, '..', 'resources');
fs.mkdirSync(outDir, { recursive: true });
const file = path.join(outDir, 'icon.png');
fs.writeFileSync(file, encodePng(SIZE, buf));
console.log('Wrote ' + file);