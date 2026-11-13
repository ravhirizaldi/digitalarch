import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { ocrProvider } from '../server/ocr-engines.mjs';
import { ocrSettings } from '../server/ocr-provider.mjs';
import { processingConfig } from '../server/ocr-profiles.mjs';

test('installed PaddleOCR Small CPU: Indonesian/English, bounds, model identity and original integrity', async () => {
  const lines = [
    'Perjanjian kerja sama dokumen arsip Indonesia.',
    'English document number TEST/001/2026',
    'Jakarta, 13 November 2026',
  ];
  const buffer = await sharp(
    Buffer.from(
      `<svg width="1800" height="600"><rect width="100%" height="100%" fill="white"/>${lines.map((line, i) => `<text x="90" y="${140 + i * 100}" font-family="DejaVu Sans" font-size="44">${line}</text>`).join('')}</svg>`,
    ),
  )
    .png()
    .toBuffer();
  const before = Buffer.from(buffer);
  const engine = ocrProvider(ocrSettings({}));
  const config = processingConfig({ engine: 'paddleocr' });
  for (const language of ['ind', 'eng', 'ind+eng']) {
    const info = await engine.info(language, undefined, config);
    const output = await engine.process(
      buffer,
      { rotation_degrees: 0 },
      language,
      undefined,
      config,
    );
    assert.equal(output.engine, 'PaddleOCR');
    assert.equal(output.text, lines.join('\n'));
    assert.deepEqual(output.configuration, info.configuration);
    assert.equal(output.configuration.device, 'cpu');
    assert.equal(output.configuration.cpuThreads, 1);
    assert.ok(output.structuredResult.runtime.enginePeakWorkingSetBytes > 0);
    assert.ok(
      output.structuredResult.lines.every(
        (line) =>
          line.bounds.x >= 0 &&
          line.bounds.y >= 0 &&
          line.bounds.x + line.bounds.width <= 1800 &&
          line.bounds.y + line.bounds.height <= 600,
      ),
    );
    assert.deepEqual(buffer, before);
  }
  const rotated = await sharp(buffer).rotate(270).png().toBuffer();
  const corrected = await engine.process(
    rotated,
    { rotation_degrees: 90 },
    'ind+eng',
    undefined,
    config,
  );
  assert.equal(corrected.text, lines.join('\n'));
  const controller = new AbortController();
  controller.abort(new Error('self-check cancellation'));
  await assert.rejects(
    engine.process(buffer, { rotation_degrees: 0 }, 'ind+eng', controller.signal, config),
    /self-check cancellation/,
  );
});
