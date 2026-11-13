import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, chmod, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { testApplication, scanned, until } from './support.mjs';
import { ocrProcessing } from '../server/ocr.mjs';
import { ocrSettings } from '../server/ocr-provider.mjs';
import { failure } from '../server/errors.mjs';
import { benchmark } from '../scripts/ocr-benchmark.mjs';

const info = {
  engine: 'Tesseract (NAPS2)',
  engineVersion: 'test-engine',
  configuration: {
    sdk: 'NAPS2.Sdk/1.6.0',
    languageData: { ind: 'a'.repeat(64), eng: 'b'.repeat(64) },
    mode: 'Fast',
    preprocessing: 'none',
    priority: 'low',
  },
};
function provider(process = async () => ({})) {
  return {
    info: async () => info,
    async process(buffer, page, language, signal) {
      assert.equal(buffer.readUInt32BE(0), 0x89504e47);
      return {
        ...info,
        text: `Test page ${page.page_id}`,
        structuredResult: { lines: [] },
        processingMs: 1,
        ...(await process(page, signal, language)),
      };
    },
  };
}
async function fixture(t, engine = provider(), settings = {}) {
  const f = await testApplication(t, {
    ocr: { provider: engine, settings: { retryDelayMs: 0, ...settings } },
  });
  const operator = await f.account();
  const create = async (scenario = 'multi') => {
    let result = (await operator.request('/api/batches', {})).body;
    result = await scanned(operator, result.batch, { scenario, pageDelay: 0 });
    const response = await operator.request(`/api/batches/${result.batch.id}/complete-capture`, {
      version: result.batch.version,
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const job = (await f.pool.query('SELECT * FROM ocr_jobs WHERE batch_id=$1', [result.batch.id]))
      .rows[0];
    assert.ok(job);
    return { ...response.body, job, completionVersion: result.batch.version };
  };
  const drain = async () => {
    for (let i = 0; i < 30; i++) if (!(await f.app.ocr.runOne())) return;
    throw new Error('OCR retries did not terminate');
  };
  const job = async (id) => (await operator.request(`/api/ocr/jobs/${id}`)).body.job;
  const control = async (id, action) =>
    operator.request(`/api/ocr/jobs/${id}/${action}`, { version: (await job(id)).version });
  return { ...f, operator, create, drain, job, control };
}

test('OCR configuration: defaults and bounded resources, no implicit language fallback', () => {
  assert.equal(ocrSettings({}).concurrency, 1);
  assert.equal(ocrSettings({}).language, 'ind+eng');
  for (const env of [
    { OCR_LANGUAGE: 'eng;cmd' },
    { OCR_PRIORITY: 'high' },
    { OCR_WORKER_CONCURRENCY: '0' },
    { OCR_WORKER_CONCURRENCY: '2' },
    { OCR_TIMEOUT_SECONDS: '900' },
    { OCR_MAX_ATTEMPTS: '50' },
  ])
    assert.throws(() => ocrSettings(env));
});

test('OCR enqueue: atomic completion, idempotent concurrent repeats, excluded pages and no pause/cancel jobs', async (t) => {
  const f = await fixture(t);
  let result = (await f.operator.request('/api/batches', {})).body;
  assert.equal(
    (
      await f.operator.request(`/api/batches/${result.batch.id}/complete-capture`, {
        version: result.batch.version,
      })
    ).status,
    409,
  );
  result = (
    await f.operator.request(`/api/batches/${result.batch.id}/pause`, {
      version: result.batch.version,
    })
  ).body;
  assert.equal((await f.pool.query('SELECT * FROM ocr_jobs')).rowCount, 0);
  result = (
    await f.operator.request(`/api/batches/${result.batch.id}/cancel`, {
      version: result.batch.version,
    })
  ).body;
  assert.equal(result.batch.status, 'cancelled');
  result = (await f.operator.request('/api/batches', {})).body;
  result = await scanned(f.operator, result.batch);
  result = (
    await f.operator.request(
      `/api/pages/${result.pages[0].id}`,
      { version: result.batch.version, action: 'remove' },
      'PATCH',
    )
  ).body;
  const responses = await Promise.all(
    [1, 2, 3].map(() =>
      f.operator.request(`/api/batches/${result.batch.id}/complete-capture`, {
        version: result.batch.version,
      }),
    ),
  );
  assert.deepEqual(
    responses.map((r) => r.status),
    [200, 200, 200],
  );
  const jobs = (await f.pool.query('SELECT * FROM ocr_jobs')).rows;
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].total_pages, 2);
  assert.equal(responses[0].body.batch.ocr_status, 'queued');
  assert.equal((await f.pool.query('SELECT * FROM page_ocr_results')).rowCount, 2);
  assert.equal(
    (await f.pool.query("SELECT * FROM audit_logs WHERE action='batch.capture_completed'"))
      .rowCount,
    1,
  );
});

test('OCR processing: one page per claim, immediate persistence, immutable files, successful-result uniqueness', async (t) => {
  const f = await fixture(t);
  const captured = await f.create();
  const file = path.join(f.app.storage.root, captured.pages[0].original_storage_key);
  const bytes = await readFile(file);
  assert.equal(await f.app.ocr.runOne(), true);
  let job = await f.job(captured.job.id);
  assert.equal(job.processed_pages, 1);
  assert.equal(job.status, 'queued');
  await f.drain();
  job = await f.job(job.id);
  assert.equal(job.status, 'completed');
  assert.equal(job.processed_pages, 3);
  assert.equal(job.failed_pages, 0);
  assert.equal(
    (await f.operator.request(`/api/batches/${captured.batch.id}`)).body.batch.ocr_status,
    'completed',
  );
  assert.ok(job.completed_at);
  const pages = (await f.operator.request(`/api/ocr/jobs/${job.id}/pages`)).body.pages;
  assert.equal(pages.length, 3);
  assert.equal(pages[0].image_sha256, captured.pages[0].sha256);
  assert.equal(pages[0].extracted_text, `Test page ${captured.pages[0].id}`);
  assert.ok(pages[0].processed_at);
  assert.deepEqual(await readFile(file), bytes);
  assert.equal(
    (await f.operator.request(`/api/pages/${captured.pages[0].id}/ocr`)).body.result.status,
    'completed',
  );
  await assert.rejects(
    f.pool
      .query(`INSERT INTO page_ocr_results(id,page_id,batch_id,ocr_job_id,image_sha256,storage_key,rotation_degrees,language,config_hash,engine_version,status,processed_at)
    SELECT gen_random_uuid(),page_id,batch_id,ocr_job_id,image_sha256,storage_key,rotation_degrees,language,config_hash,engine_version,'completed',now() FROM page_ocr_results LIMIT 1`),
    { code: '23505' },
  );
  assert.equal((await f.operator.request('/api/ocr/jobs')).body.overview.completed, 1);
  const source = `/api/ocr/jobs/${job.id}/pages/${captured.pages[0].id}/image`;
  const original = await f.operator.request(source);
  assert.equal(original.status, 200);
  assert.deepEqual(Buffer.from(await original.response.arrayBuffer()), bytes);
  assert.equal((await (await f.account()).request(source)).status, 403);
});

test('OCR backfill: explicitly queue pre-feature completed captures, idempotently and without reopening capture', async (t) => {
  const f = await fixture(t);
  let captured = (await f.operator.request('/api/batches', {})).body;
  const route = `/api/batches/${captured.batch.id}/ocr`;
  assert.equal((await f.operator.request(route, {})).status, 409);
  captured = await scanned(f.operator, captured.batch, { scenario: 'single', pageDelay: 0 });
  // Represents a capture completed by the pre-OCR backend.
  await f.pool.query(
    "UPDATE archive_batches SET status='capture_completed',capture_completed_at=now() WHERE id=$1",
    [captured.batch.id],
  );
  assert.equal((await f.pool.query('SELECT * FROM ocr_jobs')).rowCount, 0);
  const other = await f.account();
  assert.equal((await other.request(route, {})).status, 403);
  assert.equal((await f.operator.request(route, {}, 'POST', { 'X-CSRF-Token': '' })).status, 403);
  assert.equal((await f.operator.request(route, { image: '/etc/passwd' })).status, 400);
  const responses = await Promise.all([1, 2].map(() => f.operator.request(route, {})));
  assert.deepEqual(
    responses.map((r) => r.status),
    [200, 200],
  );
  assert.equal(responses[0].body.job.id, responses[1].body.job.id);
  assert.equal((await f.pool.query('SELECT * FROM ocr_jobs')).rowCount, 1);
  assert.equal(
    (await f.operator.request(`/api/batches/${captured.batch.id}`)).body.batch.status,
    'capture_completed',
  );
  await f.drain();
  assert.equal((await f.job(responses[0].body.job.id)).status, 'completed');
});

test('OCR reprocessing: new profile snapshots retain old text, repeated requests are idempotent and ownership is enforced', async (t) => {
  const engine = provider();
  const originalProcess = engine.process;
  const configuration = (config) => ({ ...info.configuration, processing: config });
  engine.info = async (language, signal, config) => ({
    ...info,
    configuration: configuration(config),
  });
  engine.process = async (buffer, page, language, signal, config) => ({
    ...(await originalProcess(buffer, page, language, signal)),
    configuration: configuration(config),
  });
  const f = await fixture(t, engine);
  const captured = await f.create('single');
  await f.drain();
  const job = await f.job(captured.job.id);
  const body = {
    version: job.version,
    profile: 'enhanced',
    psm: 4,
    preprocessing: { denoise: false },
  };
  const url = `/api/ocr/jobs/${job.id}/reprocess`;
  assert.equal((await (await f.account()).request(url, body)).status, 403);
  assert.equal((await f.operator.request(url, { ...body, psm: 7 })).status, 400);
  assert.equal((await f.operator.request(url, body, 'POST', { 'X-CSRF-Token': '' })).status, 403);
  const results = await Promise.all([1, 2].map(() => f.operator.request(url, body)));
  assert.deepEqual(
    results.map((result) => result.status),
    [200, 200],
  );
  assert.equal(results[0].body.job.id, results[1].body.job.id);
  assert.notEqual(results[0].body.job.id, job.id);
  assert.equal(results[0].body.job.processing_config.quality, 'best');
  assert.equal(results[0].body.job.processing_config.psm, 4);
  assert.equal(
    (await f.operator.request(`/api/ocr/jobs/${job.id}/pages`)).body.pages[0].status,
    'completed',
  );
  await f.drain();
  assert.equal((await f.job(job.id)).status, 'completed');
  assert.equal((await f.job(results[0].body.job.id)).status, 'completed');
  assert.equal(
    (
      await f.pool.query(
        "SELECT count(DISTINCT config_hash)::int AS count FROM page_ocr_results WHERE status='completed' AND reused_result_id IS NULL",
      )
    ).rows[0].count,
    2,
  );
  assert.equal((await f.operator.request(url, { ...body, layout: 'fixed-contract' })).status, 400);
  const regionBody = {
    ...body,
    layout: 'regions',
    preprocessing: { denoise: false, lineRemoval: true },
  };
  const regionRun = await f.operator.request(url, regionBody);
  assert.equal(regionRun.status, 200);
  assert.equal(regionRun.body.job.processing_config.layout, 'regions');
  assert.equal(regionRun.body.job.processing_config.preprocessing.lineRemoval, true);
  assert.equal((await f.operator.request(url, regionBody)).body.job.id, regionRun.body.job.id);
  await f.drain();
  assert.equal((await f.job(regionRun.body.job.id)).status, 'completed');
  assert.equal((await f.job(job.id)).processing_config.version, 1);
});

test('OCR benchmark: nine identical snapshots, private report and rejection of changed source jobs', async (t) => {
  const f = await fixture(t);
  const captured = await f.create('single');
  await f.drain();
  const output = path.join(f.dataDir, 'benchmark.json');
  const pending = benchmark({ pool: f.pool, jobId: captured.job.id, output });
  await until(async () => (await f.pool.query('SELECT * FROM ocr_jobs')).rowCount === 10);
  await f.drain();
  const report = await pending;
  assert.equal(report.runs.length, 9);
  assert.deepEqual(new Set(report.runs.map((run) => `${run.profile}:${run.psm}`)).size, 9);
  assert.ok(
    report.runs.every((run) => run.pages[0].image_sha256 === report.baseline[0].image_sha256),
  );
  assert.ok(report.runs.every((run) => run.excerptCharacterErrorRate === null));
  assert.equal((await stat(output)).mode & 0o777, 0o600);
  const fullReferences = { [captured.pages[0].id]: { text: `Test page ${captured.pages[0].id}` } };
  const layoutPending = benchmark({
    pool: f.pool,
    jobId: captured.job.id,
    output: path.join(f.dataDir, 'layout.json'),
    mode: 'layout',
    fullReferences,
  });
  await until(async () => (await f.pool.query('SELECT * FROM ocr_jobs')).rowCount === 16);
  await f.drain();
  const layoutReport = await layoutPending;
  assert.equal(layoutReport.runs.length, 6);
  assert.ok(layoutReport.runs.every((run) => run.pages[0].processing_config.layout === 'regions'));
  assert.ok(layoutReport.runs.every((run) => run.fullPageCharacterErrorRate === 0));
  await assert.rejects(
    benchmark({ pool: f.pool, jobId: captured.job.id, output, mode: 'unknown' }),
    /Benchmark mode/,
  );
  await assert.rejects(
    benchmark({
      pool: f.pool,
      jobId: captured.job.id,
      output,
      fullReferences: { page: { text: '', exactValues: [123] } },
    }),
    /Full references/,
  );
  await assert.rejects(
    benchmark({ pool: f.pool, jobId: captured.job.id, output, references: { page: [''] } }),
    /nonempty transcribed excerpts/,
  );
  await f.pool.query('UPDATE pages SET rotation_degrees=90 WHERE id=$1', [captured.pages[0].id]);
  const count = (await f.pool.query('SELECT * FROM ocr_jobs')).rowCount;
  await assert.rejects(
    benchmark({ pool: f.pool, jobId: captured.job.id, output }),
    /differ from the current batch/,
  );
  assert.equal((await f.pool.query('SELECT * FROM ocr_jobs')).rowCount, count);
});

test('OCR queue: competing claims exclude one another and expired claims recover with fencing', async (t) => {
  const f = await fixture(t);
  const captured = await f.create();
  const other = ocrProcessing(f.pool, f.app.storage, {
    provider: provider(),
    enabled: false,
    settings: { retryDelayMs: 0 },
  });
  const claims = await Promise.all([f.app.ocr.claim(), other.claim()]);
  assert.equal(claims.filter(Boolean).length, 1);
  const claimed = claims.find(Boolean);
  await f.pool.query(
    "UPDATE page_ocr_results SET status='processing',attempt_count=1 WHERE id=(SELECT id FROM page_ocr_results WHERE ocr_job_id=$1 LIMIT 1)",
    [claimed.id],
  );
  await f.pool.query("UPDATE ocr_jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [
    claimed.id,
  ]);
  assert.equal(await other.recover(), 1);
  await f.drain();
  assert.equal((await f.job(captured.job.id)).status, 'completed');
  const tokenWrite = await f.pool.query(
    'UPDATE ocr_jobs SET last_error=$3 WHERE id=$1 AND lease_token=$2',
    [claimed.id, claimed.lease_token, 'stale writer'],
  );
  assert.equal(tokenWrite.rowCount, 0);
  assert.equal(
    (await f.pool.query("SELECT * FROM audit_logs WHERE action='ocr.recovered'")).rowCount,
    1,
  );
  await other.close();
});

test('OCR failures: bounded retries, subsequent pages continue, explicit retry only reprocesses failed pages', async (t) => {
  const attempts = new Map();
  let badPage;
  let repaired = false;
  const f = await fixture(
    t,
    provider(async (page) => {
      badPage ||= page.page_id;
      attempts.set(page.page_id, (attempts.get(page.page_id) || 0) + 1);
      if (page.page_id === badPage && !repaired) throw new Error('transient OCR failure');
    }),
    { maxAttempts: 2 },
  );
  const captured = await f.create();
  await f.drain();
  const job = await f.job(captured.job.id);
  assert.equal(job.status, 'completed_with_errors');
  assert.equal(job.processed_pages, 2);
  assert.equal(job.failed_pages, 1);
  assert.equal(attempts.get(badPage), 2);
  repaired = true;
  assert.equal((await f.control(job.id, 'retry-failed')).status, 200);
  await f.drain();
  assert.equal((await f.job(job.id)).status, 'completed');
  assert.equal(attempts.get(badPage), 3);
  for (const [id, count] of attempts) if (id !== badPage) assert.equal(count, 1);
});

test('OCR controls: pause at page boundary, resume, cancel queued without deleting completed text', async (t) => {
  let begin;
  let finish;
  const started = new Promise((resolve) => (begin = resolve));
  const gate = new Promise((resolve) => (finish = resolve));
  let first = true;
  const f = await fixture(
    t,
    provider(async () => {
      if (first) {
        first = false;
        begin();
        await gate;
      }
    }),
  );
  const captured = await f.create();
  const work = f.app.ocr.runOne();
  await started;
  assert.equal((await f.control(captured.job.id, 'cancel')).status, 409);
  assert.equal((await f.control(captured.job.id, 'pause')).status, 200);
  finish();
  await work;
  assert.equal((await f.job(captured.job.id)).status, 'paused');
  assert.equal(await f.app.ocr.runOne(), false);
  assert.equal((await f.control(captured.job.id, 'resume')).status, 200);
  assert.equal((await f.control(captured.job.id, 'cancel')).status, 200);
  assert.equal((await f.job(captured.job.id)).processed_pages, 1);
  const results = (await f.operator.request(`/api/ocr/jobs/${captured.job.id}/pages`)).body.pages;
  assert.equal(results.filter((r) => r.status === 'completed').length, 1);
  assert.equal(results.filter((r) => r.status === 'cancelled').length, 2);
  assert.ok(results.find((r) => r.status === 'completed').extracted_text);
  assert.equal((await f.control(captured.job.id, 'resume')).status, 409);
});

test('OCR completion rollback: an enqueue failure cannot leave capture completed without a job', async (t) => {
  const f = await fixture(t, provider(), { language: 'invalid-server-setting' });
  let result = (await f.operator.request('/api/batches', {})).body;
  result = await scanned(f.operator, result.batch, { scenario: 'single', pageDelay: 0 });
  const response = await f.operator.request(`/api/batches/${result.batch.id}/complete-capture`, {
    version: result.batch.version,
  });
  assert.equal(response.status, 400);
  const stored = (await f.operator.request(`/api/batches/${result.batch.id}`)).body.batch;
  assert.equal(stored.status, 'in_progress');
  assert.equal(stored.version, result.batch.version);
  assert.equal((await f.pool.query('SELECT * FROM ocr_jobs')).rowCount, 0);
});

test('OCR resource configuration: sequential claims keep one page active even with multiple queued jobs', async (t) => {
  let active = 0;
  let maximum = 0;
  let finish;
  const gate = new Promise((resolve) => (finish = resolve));
  const f = await fixture(
    t,
    provider(async () => {
      active++;
      maximum = Math.max(maximum, active);
      await gate;
      active--;
    }),
  );
  const a = await f.create();
  const b = await f.create();
  await f.app.ocr.tick();
  await until(async () => active === 1);
  assert.equal(maximum, 1);
  const rows = (
    await f.pool.query(
      "SELECT ocr_job_id,count(*)::int AS count FROM page_ocr_results WHERE status='processing' GROUP BY ocr_job_id",
    )
  ).rows;
  assert.equal(rows.length, 1);
  assert.ok(rows.every((row) => row.count === 1));
  finish();
  await until(async () => (await f.job(a.job.id)).processed_pages === 1);
  await f.drain();
  assert.equal((await f.job(a.job.id)).status, 'completed');
  assert.equal((await f.job(b.job.id)).status, 'completed');
});

test('OCR integrity: checksum mismatch is permanent and never reuses old text', async (t) => {
  const f = await fixture(t);
  const captured = await f.create();
  const file = path.join(f.app.storage.root, captured.pages[0].original_storage_key);
  const original = await readFile(file);
  const replacement = await readFile(path.resolve('fixtures/basic/page-002.png'));
  await chmod(file, 0o600);
  await writeFile(file, replacement);
  await f.drain();
  const job = await f.job(captured.job.id);
  assert.equal(job.status, 'completed_with_errors');
  assert.equal(job.failed_pages, 1);
  const pages = (await f.operator.request(`/api/ocr/jobs/${job.id}/pages`)).body.pages;
  assert.equal(pages[0].error_code, 'image_changed');
  assert.equal(pages[0].attempt_count, 1);
  assert.equal(pages[0].extracted_text, null);
  assert.equal((await f.operator.request(`/api/pages/${captured.pages[0].id}/ocr`)).status, 422);
  await writeFile(file, original);
});

test('OCR revisions: preserve stale history, queue replacement, never present stale current text, reuse exact unchanged results', async (t) => {
  let calls = 0;
  const f = await fixture(
    t,
    provider(async () => {
      calls++;
    }),
  );
  const captured = await f.create();
  await f.drain();
  assert.equal(calls, 3);
  const page = captured.pages[0];
  const stored = await f.app.storage.finalize(
    { batch_id: page.batch_id, id: randomUUID() },
    1,
    path.resolve('fixtures/duplex'),
    'page-001-a-front.png',
  );
  await f.pool.query(
    'INSERT INTO page_revisions(page_id,storage_key,sha256,created_by) VALUES($1,$2,$3,$4)',
    [page.id, stored.key, stored.sha256, f.operator.user.id],
  );
  await f.pool.query('UPDATE pages SET active_storage_key=$2 WHERE id=$1', [page.id, stored.key]);
  const jobs = (await f.pool.query('SELECT * FROM ocr_jobs ORDER BY created_at')).rows;
  assert.equal(jobs.length, 2);
  const pending = (await f.operator.request(`/api/pages/${page.id}/ocr`)).body.result;
  assert.equal(pending.status, 'queued');
  assert.equal(pending.extracted_text, null);
  const previous = (await f.operator.request(`/api/ocr/jobs/${captured.job.id}/pages`)).body.pages;
  assert.equal(previous[0].is_stale, true);
  assert.ok(previous[0].extracted_text);
  await f.drain();
  assert.equal(calls, 4);
  const current = (await f.operator.request(`/api/pages/${page.id}/ocr`)).body.result;
  assert.equal(current.status, 'completed');
  assert.equal(current.image_sha256, stored.sha256);
  assert.equal(current.is_stale, false);
  assert.equal(
    (await f.pool.query('SELECT sha256 FROM pages WHERE id=$1', [page.id])).rows[0].sha256,
    page.sha256,
  );
  assert.equal(
    (await f.pool.query('SELECT * FROM page_ocr_results WHERE reused_result_id IS NOT NULL'))
      .rowCount,
    2,
  );
  await f.pool.query('UPDATE pages SET active_storage_key=original_storage_key WHERE id=$1', [
    page.id,
  ]);
  assert.equal((await f.pool.query('SELECT * FROM ocr_jobs')).rowCount, 3);
  assert.equal(
    (await f.operator.request(`/api/pages/${page.id}/ocr`)).body.result.extracted_text,
    null,
  );
  await f.drain();
  assert.equal(
    calls,
    4,
    'Returning to exact bytes/configuration reuses preserved recognition, not a stale current row',
  );
  assert.equal(
    (await f.operator.request(`/api/pages/${page.id}/ocr`)).body.result.status,
    'completed',
  );
});

test('OCR preflight: missing Indonesian resources fail visibly; repair and explicit retry recover', async (t) => {
  const engine = provider();
  let missing = true;
  engine.info = async () => {
    if (missing)
      throw failure('ocr_language_missing', 'Required OCR resource ind.traineddata is missing.');
    return info;
  };
  const f = await fixture(t, engine);
  const captured = await f.create('single');
  await f.drain();
  assert.equal((await f.job(captured.job.id)).status, 'failed');
  assert.match((await f.job(captured.job.id)).last_error, /ind.traineddata/);
  assert.equal(
    (await f.pool.query("SELECT * FROM page_ocr_results WHERE status='queued'")).rowCount,
    1,
  );
  missing = false;
  await f.control(captured.job.id, 'retry-failed');
  await f.drain();
  assert.equal((await f.job(captured.job.id)).status, 'completed');
});

test('OCR security: authentication, ownership, admin permissions, CSRF, validation and path redaction', async (t) => {
  const f = await fixture(t);
  const captured = await f.create('single');
  const other = await f.account();
  const qc = await f.account(['qc_officer']);
  const url = `/api/ocr/jobs/${captured.job.id}`;
  assert.equal((await fetch(f.origin + url)).status, 401);
  for (const route of [url, `${url}/pages`, `/api/pages/${captured.pages[0].id}/ocr`]) {
    assert.equal((await other.request(route)).status, 403);
    assert.equal((await qc.request(route)).status, 403);
    assert.equal((await f.admin.request(route)).status, 200);
  }
  assert.equal((await other.request('/api/ocr/jobs')).body.total, 0);
  assert.equal(
    (
      await f.operator.request(`${url}/pause`, { version: captured.job.version }, 'POST', {
        'X-CSRF-Token': '',
      })
    ).status,
    403,
  );
  assert.equal((await f.operator.request(`${url}/pause`, { version: 0 })).status, 409);
  assert.equal(
    (
      await f.operator.request(`${url}/pause`, {
        version: captured.job.version,
        image: '/etc/passwd',
      })
    ).status,
    400,
  );
  assert.equal((await f.operator.request('/api/ocr/jobs/invalid')).status, 400);
  assert.equal((await f.operator.request('/api/ocr/jobs?status=unknown')).status, 400);
  for (const route of [url, `${url}/pages`]) {
    const body = JSON.stringify((await f.operator.request(route)).body);
    assert.ok(!body.includes('storage_key'));
    assert.ok(!body.includes('lease_token'));
    assert.ok(!body.includes(f.dataDir));
  }
});

test('OCR worker: default concurrency one, graceful shutdown returns interrupted page for restart', async (t) => {
  let active = 0;
  let maximum = 0;
  let entered;
  const started = new Promise((resolve) => (entered = resolve));
  const f = await fixture(
    t,
    provider(async (_page, signal) => {
      active++;
      maximum = Math.max(maximum, active);
      entered();
      await new Promise((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener('abort', resolve, { once: true });
      });
      active--;
    }),
  );
  const a = await f.create('single');
  await f.create('single');
  await f.app.ocr.tick();
  await started;
  await f.app.ocr.tick();
  assert.equal(maximum, 1);
  await f.app.ocr.close();
  assert.equal((await f.job(a.job.id)).status, 'queued');
  assert.equal(
    (await f.pool.query("SELECT * FROM page_ocr_results WHERE status='processing'")).rowCount,
    0,
  );
  const worker = ocrProcessing(f.pool, f.app.storage, { provider: provider(), enabled: false });
  t.after(() => worker.close());
  await worker.runOne();
  assert.equal((await f.job(a.job.id)).status, 'completed');
  await until(async () => active === 0);
});
