import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { processingConfig } from '../server/ocr-profiles.mjs';
import { preprocessOcr } from '../server/ocr-preprocess.mjs';
import { adaptiveThreshold, estimateSkew } from '../server/ocr-pixels.mjs';
import { excerptDistance } from '../scripts/ocr-benchmark.mjs';
import { digest } from '../server/auth.mjs';

test('OCR profiles: best data and explicit preprocessing, safe bounded PSM/flags', () => {
  assert.equal(processingConfig().quality, 'best');
  assert.equal(processingConfig({ profile: 'standard' }).preprocessing.grayscale, false);
  assert.equal(processingConfig({ profile: 'enhanced' }).preprocessing.deskew, true);
  assert.equal(
    processingConfig({ profile: 'high-accuracy' }).preprocessing.adaptiveThreshold,
    true,
  );
  assert.equal(
    processingConfig({ profile: 'enhanced', preprocessing: { denoise: false } }).preprocessing
      .denoise,
    false,
  );
  for (const value of [
    { profile: 'other' },
    { psm: 1 },
    { psm: '6' },
    { preprocessing: { bad: true } },
    { preprocessing: { constructor: true } },
    { preprocessing: { contrast: 'yes' } },
  ])
    assert.throws(() => processingConfig(value));
});
test('OCR pixels: adaptive threshold retains local ink and ignores uniform backgrounds', () => {
  const pixels = new Uint8Array(25 * 25).fill(240);
  for (let y = 5; y < 20; y++) pixels[y * 25 + 12] = 60;
  const result = adaptiveThreshold(pixels, 25, 25, 4);
  assert.equal(result[10 * 25 + 12], 0);
  assert.equal(result[0], 255);
  assert.ok(result.every((value) => value === 0 || value === 255));
  assert.equal(estimateSkew(new Uint8Array(100 * 100).fill(255), 100, 100), 0);
});
test('OCR deskew: detects a small skew and leaves level rows unchanged', () => {
  const image = (angle) => {
    const width = 600,
      height = 600,
      pixels = new Uint8Array(width * height).fill(255);
    const slope = Math.tan((angle * Math.PI) / 180);
    for (let line = 0; line < 10; line++)
      for (let x = 40; x < 550; x++)
        for (let stroke = 0; stroke < 3; stroke++) {
          const y = Math.round(80 + line * 40 + slope * (x - 300)) + stroke;
          pixels[y * width + x] = 20;
        }
    return pixels;
  };
  assert.equal(estimateSkew(image(0), 600, 600), 0);
  assert.ok(Math.abs(estimateSkew(image(2), 600, 600) + 2) < 0.4);
});
test('OCR preprocessing: disposable output, density 300, adaptive profile and no source mutation', async () => {
  const input = await sharp({
    create: { width: 300, height: 400, channels: 3, background: '#dedede' },
  })
    .composite([
      {
        input: Buffer.from(
          '<svg width="300" height="400"><text x="25" y="200" font-size="32">OCR TEST</text></svg>',
        ),
      },
    ])
    .png()
    .withMetadata({ density: 300 })
    .toBuffer();
  const before = digest(input);
  for (const profile of ['standard', 'enhanced', 'high-accuracy']) {
    const result = await preprocessOcr(input, 0, processingConfig({ profile }), undefined);
    const metadata = await sharp(result.buffer).metadata();
    assert.equal(metadata.format, 'png');
    assert.equal(metadata.density, 300);
    assert.ok(metadata.width >= 300);
    assert.equal(digest(input), before);
    assert.ok(Math.abs(result.transform.deskewDegrees) <= 3);
  }
});
test('OCR benchmark scoring is excerpt-only and supports missing and inserted characters', () => {
  assert.equal(excerptDistance('DAN Nomor', 'prefix DAN Nomor suffix'), 0);
  assert.equal(excerptDistance('VIII', 'VIN'), 2);
  assert.equal(excerptDistance('hello', ''), 5);
});

test('OCR preprocessing: transparent PNGs produce one-channel threshold data without corrupt indexing', async () => {
  const input = await sharp({
    create: { width: 32, height: 40, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .png()
    .toBuffer();
  const result = await preprocessOcr(input, 0, processingConfig({ profile: 'high-accuracy' }));
  const { data, info } = await sharp(result.buffer)
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  assert.equal(info.channels, 1);
  assert.ok(data.every((value) => value === 255));
});
