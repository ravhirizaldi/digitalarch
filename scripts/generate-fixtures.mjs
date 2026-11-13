// Synthetic public-domain test sheets; no source documents or personal information.
import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const glyphs = {
  A: '01110/10001/10001/11111/10001/10001/10001',
  B: '11110/10001/10001/11110/10001/10001/11110',
  C: '01111/10000/10000/10000/10000/10000/01111',
  D: '11110/10001/10001/10001/10001/10001/11110',
  E: '11111/10000/10000/11110/10000/10000/11111',
  F: '11111/10000/10000/11110/10000/10000/10000',
  G: '01111/10000/10000/10111/10001/10001/01111',
  H: '10001/10001/10001/11111/10001/10001/10001',
  I: '11111/00100/00100/00100/00100/00100/11111',
  J: '00111/00010/00010/00010/10010/10010/01100',
  K: '10001/10010/10100/11000/10100/10010/10001',
  L: '10000/10000/10000/10000/10000/10000/11111',
  M: '10001/11011/10101/10101/10001/10001/10001',
  N: '10001/11001/10101/10011/10001/10001/10001',
  O: '01110/10001/10001/10001/10001/10001/01110',
  P: '11110/10001/10001/11110/10000/10000/10000',
  Q: '01110/10001/10001/10001/10101/10010/01101',
  R: '11110/10001/10001/11110/10100/10010/10001',
  S: '01111/10000/10000/01110/00001/00001/11110',
  T: '11111/00100/00100/00100/00100/00100/00100',
  U: '10001/10001/10001/10001/10001/10001/01110',
  V: '10001/10001/10001/10001/10001/01010/00100',
  W: '10001/10001/10001/10101/10101/10101/01010',
  X: '10001/10001/01010/00100/01010/10001/10001',
  Y: '10001/10001/01010/00100/00100/00100/00100',
  Z: '11111/00001/00010/00100/01000/10000/11111',
  0: '01110/10001/10011/10101/11001/10001/01110',
  1: '00100/01100/00100/00100/00100/00100/01110',
  2: '01110/10001/00001/00010/00100/01000/11111',
  3: '11110/00001/00001/01110/00001/00001/11110',
  4: '00010/00110/01010/10010/11111/00010/00010',
  5: '11111/10000/10000/11110/00001/00001/11110',
  6: '01110/10000/10000/11110/10001/10001/01110',
  7: '11111/00001/00010/00100/01000/01000/01000',
  8: '01110/10001/10001/01110/10001/10001/01110',
  9: '01110/10001/10001/01111/00001/00001/01110',
  '-': '00000/00000/00000/11111/00000/00000/00000',
  '.': '00000/00000/00000/00000/00000/00100/00100',
};
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([size, name, data, checksum]);
}
function sheet(title, number, variant) {
  const width = 850,
    height = 1100;
  const pixels = Buffer.alloc(width * height * 3, 255);
  function rect(x, y, w, h, color = [35, 62, 83]) {
    for (let row = Math.max(0, y); row < Math.min(height, y + h); row++)
      for (let col = Math.max(0, x); col < Math.min(width, x + w); col++) {
        const index = (row * width + col) * 3;
        pixels[index] = color[0];
        pixels[index + 1] = color[1];
        pixels[index + 2] = color[2];
      }
  }
  function text(value, x, y, scale = 3, color) {
    for (const char of value) {
      (glyphs[char] || '').split('/').forEach((row, dy) =>
        [...row].forEach((bit, dx) => {
          if (bit === '1') rect(x + dx * scale, y + dy * scale, scale, scale, color);
        }),
      );
      x += 6 * scale;
    }
  }
  text('DIGITALARCH - SYNTHETIC SAMPLE', 60, 55, 3);
  rect(60, 100, 730, 3);
  text('SIMULATED - NOT A PHYSICAL SCAN', 60, 130, 3, [39, 91, 129]);
  text(title, 60, 225, 4);
  text(`PAGE ${number}`, 60, 280, 3);
  if (variant !== 'blank') {
    const ink = variant === 'faint' ? [210, 210, 210] : [65, 75, 85];
    text('TEST DOCUMENT - NO PERSONAL DATA', 60, 365, 3, ink);
    text('KEEP EVERY PAGE INCLUDING BLANK ONES', 60, 415, 3, ink);
    for (let row = 0; row < 8; row++) {
      rect(60, 500 + row * 42, 730, 1, [210, 220, 225]);
      text(`SAMPLE RECORD ${row + 1}`, 75, 510 + row * 42, 2, ink);
      text(`TEST ${number}`, 580, 510 + row * 42, 2, ink);
    }
  }
  if (variant === 'dirty')
    for (let i = 0; i < 100; i++)
      rect(60 + ((i * 67) % 730), 330 + ((i * 113) % 620), 2 + (i % 5), 2, [180, 180, 170]);
  text('LOCAL FIXTURE - SAFE TO COMMIT', 60, 1000, 3);
  if (variant === 'rotated') {
    for (let i = 0; i < pixels.length / 6; i++) {
      const other = pixels.length / 3 - i - 1;
      for (let channel = 0; channel < 3; channel++)
        [pixels[i * 3 + channel], pixels[other * 3 + channel]] = [
          pixels[other * 3 + channel],
          pixels[i * 3 + channel],
        ];
    }
  }
  const raw = Buffer.alloc(height * (width * 3 + 1));
  for (let y = 0; y < height; y++)
    pixels.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk(
      'tEXt',
      Buffer.from(
        'Source\0Generated synthetic DigitalArch test sheet; scripts/generate-fixtures.mjs; no real documents.',
      ),
    ),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const root = fileURLToPath(new URL('../fixtures/', import.meta.url));
for (const folder of ['basic', 'duplex', 'edge-cases'])
  await mkdir(path.join(root, folder), { recursive: true });
for (let i = 1; i <= 3; i++)
  await writeFile(path.join(root, 'basic', `page-00${i}.png`), sheet('FEEDER TEST DOCUMENT', i));
for (let i = 1; i <= 2; i++)
  for (const side of ['front', 'back'])
    await writeFile(
      path.join(root, 'duplex', `page-00${i}-${side === 'front' ? 'a-front' : 'b-back'}.png`),
      sheet(`SHEET ${i} ${side.toUpperCase()}`, (i - 1) * 2 + (side === 'front' ? 1 : 2)),
    );
for (const [name, variant] of [
  ['mostly-blank', 'blank'],
  ['faint-text', 'faint'],
  ['dirty-paper', 'dirty'],
  ['rotated-page', 'rotated'],
])
  await writeFile(
    path.join(root, 'edge-cases', `${name}.png`),
    sheet(name.toUpperCase(), 1, variant),
  );
console.log('Generated 11 synthetic PNG fixtures.');
