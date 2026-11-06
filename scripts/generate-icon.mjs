import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const w = 128;
const h = 128;
const raw = Buffer.alloc((w * 4 + 1) * h);
for (let y = 0; y < h; y++) {
  const row = y * (w * 4 + 1);
  raw[row] = 0;
  for (let x = 0; x < w; x++) {
    const p = row + 1 + x * 4;
    const dx = x - 64;
    const dy = y - 64;
    const r = Math.hypot(dx, dy);
    const ring = Math.abs(r - 42) < 6 || r < 14;
    raw[p] = ring ? 56 : 15;
    raw[p + 1] = ring ? 189 : 23;
    raw[p + 2] = ring ? 248 : 42;
    raw[p + 3] = 255;
  }
}

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c >>> 0;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const tb = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([tb, data])), 0);
  return Buffer.concat([len, tb, data, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(w, 0);
ihdr.writeUInt32BE(h, 4);
ihdr[8] = 8;
ihdr[9] = 6;

const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
]);

mkdirSync('apps/vscode-extension/media', { recursive: true });
writeFileSync('apps/vscode-extension/media/icon.png', png);

