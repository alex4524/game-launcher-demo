// Draws the menu-bar template icon (black + alpha, macOS tints it) without any image library.
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function png(size, alphaAt) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o + 3] = Math.round(255 * alphaAt((x + 0.5) / size, (y + 0.5) / size));
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Ring with a play triangle inside, coordinates in 0..1.
function shape(x, y) {
  const dx = x - 0.5, dy = y - 0.5;
  const r = Math.hypot(dx, dy);
  const ring = r > 0.36 && r < 0.46;
  const inTri = x > 0.4 && x < 0.68 && Math.abs(dy) < (0.68 - x) * 0.62;
  return ring || inTri ? 1 : 0;
}

mkdirSync('resources', { recursive: true });
writeFileSync('resources/trayTemplate.png', png(22, shape));
writeFileSync('resources/trayTemplate@2x.png', png(44, shape));
console.log('wrote resources/trayTemplate.png and @2x');
