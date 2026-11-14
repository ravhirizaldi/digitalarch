import test from 'node:test';
import assert from 'node:assert/strict';
import { testApplication, scanned } from './support.mjs';

test('metadata API: all pages, persisted edits, conflicts, ownership, CSRF and unchanged OCR', async (t) => {
  const info = { engine: 'Tesseract (NAPS2)', engineVersion: 'fixture', configuration: {} };
  const f = await testApplication(t, {
    ocr: {
      provider: {
        async info() {
          return info;
        },
        async process() {
          return {
            ...info,
            text: 'Nama: Rina Contoh\nSerial Number: ZX1000A749',
            structuredResult: { lines: [] },
            processingMs: 1,
          };
        },
      },
    },
  });
  const operator = await f.account(),
    other = await f.account();
  let batch = (await operator.request('/api/batches', {})).body.batch;
  batch = (await scanned(operator, batch, { scenario: 'multi', pageDelay: 0 })).batch;
  await operator.request(`/api/batches/${batch.id}/complete-capture`, { version: batch.version });
  const job = (await f.pool.query('SELECT id FROM ocr_jobs WHERE batch_id=$1', [batch.id])).rows[0];
  const path = `/api/batches/${batch.id}/metadata`;
  assert.equal((await operator.request(path)).body.metadata.version, 0);
  assert.equal((await operator.request(`${path}/extract`, { version: 0 })).status, 409);
  while (await f.app.ocr.runOne()) {
    /* drain synthetic OCR */
  }
  await f.app.qc.refresh();
  const before = (
    await f.pool.query(
      'SELECT id,extracted_text,image_sha256 FROM page_ocr_results WHERE ocr_job_id=$1 ORDER BY id',
      [job.id],
    )
  ).rows;
  assert.equal((await other.request(path)).status, 403);
  assert.equal((await other.request(`${path}/extract`, { version: 0 })).status, 403);
  assert.equal(
    (
      await operator.request(`${path}/extract`, { version: 0 }, 'POST', {
        'X-CSRF-Token': 'invalid',
      })
    ).status,
    403,
  );
  const initial = (await operator.request(path)).body.metadata;
  const extracted = await operator.request(`${path}/extract`, { version: initial.version });
  assert.equal(extracted.status, 200);
  const metadata = extracted.body.metadata;
  assert.equal(metadata.fields[0].pageCount, before.length);
  assert.equal(metadata.fields.length, 2);
  const fields = metadata.fields.map(({ id, type, value, context }) => ({
    id,
    type,
    value,
    context,
  }));
  fields[0].value = 'Reviewed value';
  fields.push({
    id: null,
    type: 'address',
    value: 'An operator-entered address',
    context: 'Office',
  });
  const saved = await operator.request(path, { version: metadata.version, fields }, 'PATCH');
  assert.equal(saved.status, 200);
  assert.equal(saved.body.metadata.fields[0].source[0].text, metadata.fields[0].source[0].text);
  assert.equal(saved.body.metadata.fields[0].originalValue, metadata.fields[0].value);
  assert.equal((await operator.request(path)).body.metadata.fields[0].value, 'Reviewed value');
  assert.equal(
    (await operator.request(path, { version: metadata.version, fields }, 'PATCH')).status,
    409,
  );
  assert.equal((await operator.request(`${path}/extract`, { version: 0 })).status, 409);
  assert.equal(
    (
      await operator.request(
        path,
        {
          version: saved.body.metadata.version,
          fields: [{ id: 'invented', type: 'person', value: 'Test', context: '' }],
        },
        'PATCH',
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await operator.request(
        path,
        {
          version: saved.body.metadata.version,
          fields: [{ id: null, type: 'unknown', value: 'Test', context: '' }],
        },
        'PATCH',
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await operator.request(
        path,
        {
          version: saved.body.metadata.version,
          fields: [{ id: null, type: 'person', value: ' ', context: '' }],
        },
        'PATCH',
      )
    ).status,
    400,
  );
  assert.deepEqual(
    (
      await f.pool.query(
        'SELECT id,extracted_text,image_sha256 FROM page_ocr_results WHERE ocr_job_id=$1 ORDER BY id',
        [job.id],
      )
    ).rows,
    before,
  );
  const audits = (
    await f.pool.query(
      "SELECT metadata FROM audit_logs WHERE entity_type='document' AND action IN ('metadata.updated','metadata.extracted')",
    )
  ).rows;
  assert.equal(audits.length, 2);
  assert.ok(audits.every(({ metadata }) => !JSON.stringify(metadata).includes('Rina')));
  assert.equal(
    (await operator.request(`/api/ocr/jobs/${job.id}/metadata/extract`, { version: 0 })).body.code,
    'metadata_moved',
  );
});
