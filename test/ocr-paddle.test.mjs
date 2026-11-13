import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePaddle, paddleOcrProvider } from '../server/ocr-paddle.mjs';
import { processingConfig } from '../server/ocr-profiles.mjs';
import { ocrSettings } from '../server/ocr-provider.mjs';
import { fullPageScore, fieldScore, engineVariants } from '../scripts/ocr-benchmark.mjs';
import { testApplication, scanned } from './support.mjs';

test('PaddleOCR: config is explicit, legacy Tesseract identity is unchanged, no PSM/layout pretend support', () => {
  assert.deepEqual(processingConfig({ engine: 'tesseract' }), processingConfig());
  assert.equal(processingConfig().version, 1);
  assert.equal(ocrSettings({}).processingConfig.engine, undefined);
  const config = processingConfig({ engine: 'paddleocr' });
  assert.equal(config.version, 3);
  assert.equal(config.model, 'PP-OCRv6 Small');
  assert.deepEqual(ocrSettings({ OCR_ENGINE: 'paddleocr' }).processingConfig, config);
  for (const bad of [
    { engine: 'unknown' },
    { engine: 'paddleocr', model: 'PP-OCRv5' },
    { engine: 'paddleocr', psm: 6 },
    { engine: 'paddleocr', layout: 'regions' },
  ])
    assert.throws(() => processingConfig(bad));
});

test('PaddleOCR: line geometry/confidence normalize without inventing word boxes or changing digits', () => {
  const value = {
    texts: ['Kode 123456789012345', 'English words'],
    polygons: [
      [
        [10, 20],
        [210, 20],
        [210, 50],
        [10, 50],
      ],
      [
        [15, 70],
        [200, 72],
        [198, 100],
        [12, 98],
      ],
    ],
    scores: [0.9, 0.8],
  };
  const result = normalizePaddle(value, 300, 200);
  assert.equal(result.text, 'Kode 123456789012345\nEnglish words');
  assert.deepEqual(result.lines[0].bounds, { x: 10, y: 20, width: 200, height: 30 });
  assert.equal(result.lines[0].confidence, 0.9);
  assert.deepEqual(result.lines[0].words, []);
  assert.deepEqual(normalizePaddle({ texts: [], polygons: [], scores: [] }, 300, 200), {
    text: '',
    lines: [],
  });
  for (const broken of [
    { ...value, scores: [] },
    { ...value, texts: [null, 'text'] },
    { ...value, polygons: [[[NaN, 0]], []] },
    { ...value, scores: [2, 0.1] },
  ])
    assert.throws(() => normalizePaddle(broken, 300, 200));
});

test('PaddleOCR: missing runtime/models fails explicitly and never falls back to Tesseract', async () => {
  const engine = paddleOcrProvider({
    ...ocrSettings({}),
    paddleModels: '/tmp/opencode/nonexistent-paddle-models',
  });
  await assert.rejects(
    engine.info('ind+eng', undefined, processingConfig({ engine: 'paddleocr' })),
    (error) => error.code === 'ocr_unavailable',
  );
});

test('OCR metrics: WER includes insertions/deletions; document/date values require exact token-bounded text', () => {
  assert.equal(fullPageScore({ text: 'one two three' }, 'one four three').wordErrorRate, 1 / 3);
  assert.equal(fullPageScore({ text: 'one two' }, 'one two extra').wordErrors, 1);
  assert.equal(fullPageScore({ text: 'one two' }, 'one').wordErrors, 1);
  const ref = { documentNumbers: ['TEST/001/2026'], dates: ['13 November 2026'] };
  assert.deepEqual(fieldScore(ref, 'No TEST/001/2026, 13\nNovember 2026.'), {
    documentNumbers: { checked: 1, matched: 1 },
    dates: { checked: 1, matched: 1 },
  });
  assert.equal(fieldScore(ref, 'TEST/001/20260 13 November 20260').dates.matched, 0);
  assert.equal(fieldScore(ref, 'XTEST/001/2026').documentNumbers.matched, 0);
  assert.equal(engineVariants.length, 5);
  assert.equal(engineVariants.filter((v) => v.config.engine === 'paddleocr').length, 3);
});

test('OCR engines: ordinary queue reprocessing isolates engines, preserves history and idempotency', async (t) => {
  const information = (config) => ({
    engine: config.engine === 'paddleocr' ? 'PaddleOCR' : 'Tesseract (NAPS2)',
    engineVersion: 'fixture',
    configuration: { processing: config },
  });
  const f = await testApplication(t, {
    ocr: {
      provider: {
        info: async (language, signal, config) => information(config),
        process: async (buffer, page, language, signal, config) => ({
          ...information(config),
          text: `${config.engine || 'tesseract'} 123456`,
          structuredResult: { lines: [] },
          processingMs: 1,
        }),
      },
    },
  });
  const user = await f.account();
  let batch = (await user.request('/api/batches', {})).body.batch;
  batch = (await scanned(user, batch, { scenario: 'single', pageDelay: 0 })).batch;
  await user.request(`/api/batches/${batch.id}/complete-capture`, { version: batch.version });
  while (await f.app.ocr.runOne()) {
    /* Drain the existing queue. */
  }
  const old = (await f.pool.query('SELECT * FROM ocr_jobs WHERE batch_id=$1', [batch.id])).rows[0];
  const url = `/api/ocr/jobs/${old.id}/reprocess`;
  const body = { version: old.version, engine: 'paddleocr' };
  const next = await user.request(url, body);
  assert.equal(next.status, 200);
  assert.equal(next.body.job.engine, 'PaddleOCR');
  assert.equal((await user.request(url, body)).body.job.id, next.body.job.id);
  while (await f.app.ocr.runOne()) {
    /* One page at a time. */
  }
  const rows = (
    await f.pool.query(
      'SELECT engine,status,extracted_text,reused_result_id FROM page_ocr_results ORDER BY created_at',
    )
  ).rows;
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((r) => r.engine),
    ['Tesseract (NAPS2)', 'PaddleOCR'],
  );
  assert.ok(rows.every((r) => r.status === 'completed' && !r.reused_result_id));
  assert.equal(rows[0].extracted_text, 'tesseract 123456');
  assert.equal(rows[1].extracted_text, 'paddleocr 123456');
  assert.equal((await user.request(url, { version: old.version, engine: 'unlisted' })).status, 400);
  const outsider = await f.account();
  assert.equal((await outsider.request(url, body)).status, 403);
  assert.equal((await f.admin.request('/api/ocr/engines')).status, 200);
  const viewer = await f.account(['archive_viewer']);
  assert.equal((await viewer.request('/api/ocr/engines')).status, 403);
  const completed = (await user.request(`/api/ocr/jobs/${next.body.job.id}`)).body.job;
  const back = await user.request(`/api/ocr/jobs/${completed.id}/reprocess`, {
    version: completed.version,
    engine: 'tesseract',
  });
  assert.equal(back.status, 200);
  assert.equal(back.body.job.engine, 'Tesseract (NAPS2)');
  while (await f.app.ocr.runOne()) {
    /* Exact Tesseract history may be reused. */
  }
  const restored = (
    await f.pool.query('SELECT * FROM page_ocr_results WHERE ocr_job_id=$1', [back.body.job.id])
  ).rows[0];
  assert.equal(restored.status, 'completed');
  assert.ok(restored.reused_result_id);
  await assert.rejects(
    f.pool.query(
      'UPDATE ocr_jobs SET processing_config=processing_config || \'{"engine":"unknown"}\'::jsonb WHERE id=$1',
      [next.body.job.id],
    ),
  );
});
