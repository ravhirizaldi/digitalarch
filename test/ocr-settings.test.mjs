import test from 'node:test';
import assert from 'node:assert/strict';
import { testApplication, scanned } from './support.mjs';
import { ocrProcessing } from '../server/ocr.mjs';
import { processingConfig } from '../server/ocr-profiles.mjs';
import { threadVariants } from '../scripts/ocr-benchmark.mjs';
import { failure } from '../server/errors.mjs';

async function fixture(t) {
  let unavailable = false;
  const info = (config) => ({
    engine: config.engine === 'paddleocr' ? 'PaddleOCR' : 'Tesseract (NAPS2)',
    engineVersion: 'fixture',
    configuration: { processing: config },
  });
  const provider = {
    async info(language, signal, config) {
      if (unavailable) throw failure('ocr_unavailable', 'Test runtime unavailable.', 503);
      return info(config);
    },
    async process(buffer, page, language, signal, config) {
      return {
        ...info(config),
        text: `${language}:${config.engine || 'tesseract'}:${config.cpuThreads || 1}`,
        structuredResult: { lines: [] },
        processingMs: 1,
      };
    },
    async catalog() {
      return {
        engines: [
          { id: 'tesseract', name: 'Tesseract (NAPS2)', model: 'Best', available: true },
          { id: 'paddleocr', name: 'PaddleOCR', model: 'PP-OCRv6 Small', available: true },
        ],
      };
    },
  };
  const f = await testApplication(t, { ocr: { provider } });
  const operator = await f.account();
  async function capture() {
    let batch = (await operator.request('/api/batches', {})).body.batch;
    batch = (await scanned(operator, batch, { scenario: 'single', pageDelay: 0 })).batch;
    assert.equal(
      (
        await operator.request(`/api/batches/${batch.id}/complete-capture`, {
          version: batch.version,
        })
      ).status,
      200,
    );
    return (await f.pool.query('SELECT * FROM ocr_jobs WHERE batch_id=$1', [batch.id])).rows[0];
  }
  async function drain() {
    for (let i = 0; i < 20; i++) if (!(await f.app.ocr.runOne())) return;
    throw Error('Queue did not drain');
  }
  return {
    ...f,
    operator,
    capture,
    drain,
    provider,
    setUnavailable: (value) => {
      unavailable = value;
    },
  };
}

test('OCR global settings: persisted defaults reach capture, enqueue and reprocess; existing snapshots remain immutable', async (t) => {
  const f = await fixture(t);
  const initial = await f.admin.request('/api/settings/ocr');
  assert.equal(initial.status, 200);
  assert.equal(initial.body.defaults.processing_config.version, 1);
  assert.equal(initial.body.defaults.processing_config.engine, undefined);
  const original = await f.capture();
  const budget = initial.body.hardware.paddleThreadOptions.includes(2) ? 2 : 1;
  const body = {
    version: initial.body.defaults.version,
    language: 'eng+ind',
    engine: 'paddleocr',
    profile: 'enhanced',
    cpuThreads: budget,
  };
  const saved = await f.admin.request('/api/settings/ocr', body, 'PATCH');
  assert.equal(saved.status, 200);
  assert.equal(saved.body.defaults.processing_config.cpuThreads, budget);
  assert.equal(saved.body.defaults.processing_config.version, 4);
  assert.equal((await f.operator.request('/api/ocr/defaults')).body.defaults.language, 'eng+ind');
  assert.equal((await f.operator.request('/api/ocr/engines')).body.defaultEngine, 'paddleocr');
  const unchanged = (await f.pool.query('SELECT * FROM ocr_jobs WHERE id=$1', [original.id]))
    .rows[0];
  assert.deepEqual(unchanged.processing_config, original.processing_config);
  assert.equal(unchanged.language, original.language);
  assert.equal(unchanged.status, 'queued');
  const manual = await f.operator.request(`/api/batches/${original.batch_id}/ocr`, {});
  assert.equal(manual.status, 200);
  assert.equal(manual.body.job.engine, 'PaddleOCR');
  assert.equal(manual.body.job.language, 'eng+ind');
  const next = await f.capture();
  assert.equal(next.engine, 'PaddleOCR');
  assert.equal(next.language, 'eng+ind');
  assert.deepEqual(next.processing_config, saved.body.defaults.processing_config);
  await assert.rejects(
    f.pool.query(
      "UPDATE ocr_jobs SET processing_config=jsonb_set(processing_config,'{cpuThreads}','3') WHERE id=$1",
      [next.id],
    ),
  );
  await f.drain();
  const old = (await f.operator.request(`/api/ocr/jobs/${original.id}`)).body.job;
  const rerun = await f.operator.request(`/api/ocr/jobs/${old.id}/reprocess`, {
    version: old.version,
  });
  assert.equal(rerun.status, 200);
  assert.equal(rerun.body.job.language, 'eng+ind');
  assert.deepEqual(rerun.body.job.processing_config, next.processing_config);
  assert.equal(
    (await f.operator.request(`/api/ocr/jobs/${old.id}/reprocess`, { version: old.version })).body
      .job.id,
    rerun.body.job.id,
  );
  await f.drain();
  const oldPage = (
    await f.pool.query('SELECT * FROM page_ocr_results WHERE ocr_job_id=$1', [old.id])
  ).rows[0];
  assert.equal(oldPage.extracted_text, 'ind+eng:tesseract:1');
  // Explicit old-style API overrides still work; only the ordinary UI uses globals.
  const override = await f.operator.request(`/api/ocr/jobs/${old.id}/reprocess`, {
    version: old.version,
    engine: 'tesseract',
    psm: 4,
  });
  assert.equal(override.status, 200);
  assert.equal(override.body.job.engine, 'Tesseract (NAPS2)');
  assert.equal(override.body.job.language, old.language);
  await f.drain();
  const restarted = ocrProcessing(f.pool, f.app.storage, {
    enabled: false,
    provider: f.provider,
    settings: { processingConfig: processingConfig({ profile: 'high-accuracy' }) },
  });
  assert.deepEqual(
    (await restarted.currentDefaults(f.operator.user)).defaults.processing_config,
    next.processing_config,
  );
  await restarted.close();
  assert.equal(
    (
      await f.pool.query(
        "SELECT count(*)::int AS n FROM audit_logs WHERE action='ocr.settings_updated'",
      )
    ).rows[0].n,
    1,
  );
});

test('OCR global settings: administrator permission, CSRF, bounds, resource validation and optimistic concurrency', async (t) => {
  const f = await fixture(t);
  const initial = (await f.admin.request('/api/settings/ocr')).body.defaults;
  const body = {
    version: initial.version,
    language: 'ind+eng',
    engine: 'tesseract',
    profile: 'standard',
  };
  assert.equal((await f.operator.request('/api/settings/ocr')).status, 403);
  assert.equal((await f.operator.request('/api/settings/ocr', body, 'PATCH')).status, 403);
  assert.equal(
    (await f.admin.request('/api/settings/ocr', body, 'PATCH', { 'X-CSRF-Token': 'invalid' }))
      .status,
    403,
  );
  const viewer = await f.account(['archive_viewer']);
  assert.equal((await viewer.request('/api/ocr/defaults')).status, 403);
  for (const invalid of [
    { ...body, cpuThreads: 2 },
    { ...body, engine: 'paddleocr', cpuThreads: 3 },
    { ...body, engine: 'paddleocr', cpuThreads: 8 },
    { ...body, device: 'gpu' },
    { ...body, language: 'id' },
    { ...body, version: '1' },
  ])
    assert.equal((await f.admin.request('/api/settings/ocr', invalid, 'PATCH')).status, 400);
  f.setUnavailable(true);
  assert.equal((await f.admin.request('/api/settings/ocr', body, 'PATCH')).status, 503);
  assert.equal((await f.admin.request('/api/settings/ocr')).body.defaults.version, initial.version);
  f.setUnavailable(false);
  const races = await Promise.all([
    f.admin.request('/api/settings/ocr', body, 'PATCH'),
    f.admin.request('/api/settings/ocr', { ...body, profile: 'enhanced' }, 'PATCH'),
  ]);
  assert.deepEqual(races.map((r) => r.status).sort(), [200, 409]);
  assert.equal((await f.admin.request('/api/settings/ocr', body, 'PATCH')).status, 409);
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM ocr_defaults')).rows[0].n, 1);
  assert.equal(
    (
      await f.pool.query(
        "SELECT count(*)::int AS n FROM audit_logs WHERE action='ocr.settings_updated'",
      )
    ).rows[0].n,
    1,
  );
});

test('OCR CPU budgets: versioned explicit 1/2/4 threads, legacy one-thread identity and fresh benchmark variants', () => {
  const legacy = processingConfig({ engine: 'paddleocr' });
  assert.equal(legacy.version, 3);
  assert.equal('cpuThreads' in legacy, false);
  for (const cpuThreads of [1, 2, 4]) {
    const config = processingConfig({ engine: 'paddleocr', cpuThreads });
    assert.equal(config.version, 4);
    assert.equal(config.cpuThreads, cpuThreads);
  }
  for (const cpuThreads of [0, 3, 8, 1.5, '2'])
    assert.throws(() => processingConfig({ engine: 'paddleocr', cpuThreads }));
  assert.throws(() => processingConfig({ cpuThreads: 2 }));
  assert.deepEqual(
    threadVariants.map((v) => v.config.cpuThreads),
    [1, 2, 4],
  );
  assert.ok(threadVariants.every((v) => v.config.profile === 'enhanced'));
});
