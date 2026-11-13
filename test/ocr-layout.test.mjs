import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { detectRegions } from '../server/ocr-layout.mjs';
import { removePenLines } from '../server/ocr-pixels.mjs';
import { processingConfig } from '../server/ocr-profiles.mjs';
import { fullPageScore } from '../scripts/ocr-benchmark.mjs';

async function drawing(content, width = 900, height = 1200) {
  const { data } = await sharp(
    Buffer.from(
      `<svg width="${width}" height="${height}"><rect width="100%" height="100%" fill="white"/>${content}</svg>`,
    ),
  )
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { pixels: data, width, height };
}
const contains = (region, x, y) =>
  x >= region.x && x < region.x + region.width && y >= region.y && y < region.y + region.height;

test('OCR layout: opt-in versioned settings preserve legacy profile identities and reject unsupported options', () => {
  const old = processingConfig();
  assert.equal(old.version, 1);
  assert.equal('layout' in old, false);
  const config = processingConfig({ layout: 'regions', preprocessing: { lineRemoval: true } });
  assert.equal(config.version, 2);
  assert.equal(config.layout, 'regions');
  assert.equal(config.preprocessing.lineRemoval, true);
  assert.throws(() => processingConfig({ layout: 'agreement-template' }));
  assert.throws(() => processingConfig({ preprocessing: { lineRemoval: 'yes' } }));
});

test('OCR layout: empty pages fall back, letterhead graphics are separate from unrelated header/body text', async () => {
  const blank = await drawing('');
  assert.equal(detectRegions(blank.pixels, blank.width, blank.height).fallback, true);
  const page = await drawing(
    '<circle cx="85" cy="75" r="30" stroke="black" fill="none" stroke-width="3"/><text x="140" y="80" font-size="22">EXAMPLE OFFICE</text><text x="620" y="80" font-size="22">OTHER HEADER</text><path d="M40 140 H860" stroke="black" stroke-width="3"/><text x="240" y="210" font-size="26">UNRELATED DOCUMENT</text><text x="65" y="400" font-size="22">A body paragraph with arbitrary words and 123456789.</text><text x="65" y="440" font-size="22">The detector has no document-name or field-value rules.</text><text x="390" y="1100" font-size="20">Footer 42</text>',
  );
  const layout = detectRegions(page.pixels, page.width, page.height);
  assert.equal(layout.fallback, false);
  assert.ok(layout.ignored.some((box) => contains(box, 85, 75)));
  for (const [x, y] of [
    [180, 70],
    [700, 70],
    [350, 200],
    [200, 390],
    [200, 430],
    [420, 1090],
  ])
    assert.ok(
      layout.regions.some((box) => contains(box, x, y)),
      `Missing printed area ${x},${y}`,
    );
});

test('OCR line cleanup: removes only supported long thin diagonals and retains thick intersections', () => {
  const width = 600,
    height = 800,
    pixels = new Uint8Array(width * height).fill(255);
  for (let y = 20; y < 780; y++) {
    const x = Math.round(60 + y * 0.4);
    pixels[y * width + x] = 20;
    pixels[y * width + x + 1] = 20;
  }
  for (let y = 350; y < 365; y++) for (let x = 170; x < 250; x++) pixels[y * width + x] = 20;
  const before = Buffer.from(pixels);
  const result = removePenLines(pixels, width, height);
  assert.ok(result.lines.length > 0);
  assert.ok(result.removedPixels > 300);
  assert.equal(result.pixels[355 * width + 205], 20);
  assert.deepEqual(Buffer.from(pixels), before);
  const level = new Uint8Array(width * height).fill(255);
  for (let x = 40; x < 560; x++) level[300 * width + x] = 0;
  assert.equal(removePenLines(level, width, height).removedPixels, 0);
});

test('OCR layout: unrelated two-column pages, ruled forms, landscape and edge content fall back without cropping', async () => {
  const columns = Array.from(
    { length: 22 },
    (_, i) =>
      `<text x="65" y="${160 + i * 32}" font-size="16">Left column ordinary text</text><text x="550" y="${160 + i * 32}" font-size="16">Right column other words</text>`,
  ).join('');
  const cases = [
    { content: columns, reason: 'multiple-columns' },
    {
      content:
        '<path d="M50 200 H850 M50 450 H850 M50 750 H850" stroke="black" stroke-width="3"/><text x="80" y="300" font-size="22">FORM VALUE</text>',
      reason: 'ruled-layout',
    },
    {
      content:
        '<rect x="1" y="300" width="20" height="15" fill="black"/><text x="80" y="500" font-size="22">Other text</text>',
      reason: 'edge-content',
    },
    {
      content: '<text x="60" y="100" font-size="20">Landscape memo</text>',
      width: 1200,
      height: 700,
      reason: 'landscape',
    },
  ];
  for (const item of cases) {
    const page = await drawing(item.content, item.width, item.height);
    const result = detectRegions(page.pixels, page.width, page.height);
    assert.equal(result.fallback, true, item.reason);
    assert.equal(result.reason, item.reason);
    assert.deepEqual(result.ignored, []);
    assert.deepEqual(result.regions[0], {
      x: 0,
      y: 0,
      width: page.width,
      height: page.height,
      kind: 'page-fallback',
    });
  }
});

test('OCR full-page scoring: penalizes added/missing text, measures exact digit tokens without changing them', () => {
  const reference = { text: 'HEADER\nCode 123456789. Footer', exactValues: ['123456789'] };
  assert.equal(fullPageScore(reference, reference.text).characterErrorRate, 0);
  assert.ok(fullPageScore(reference, 'Code 123456789.').errors > 0);
  assert.ok(fullPageScore(reference, `${reference.text} EXTRA NOISE`).errors > 0);
  assert.equal(fullPageScore(reference, 'HEADER Code 1234567890. Footer').exactValuesMatched, 0);
  assert.equal(fullPageScore(reference, 'HEADER Code 123456789. Footer').exactValuesMatched, 1);
  assert.equal(fullPageScore({ text: 'Nomor : ................' }, 'Nomor : …').errors, 0);
});
