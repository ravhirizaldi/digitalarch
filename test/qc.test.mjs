import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { testApplication, scanned, until } from './support.mjs';

const info = { engine: 'Tesseract (NAPS2)', engineVersion: 'qc-fixture', configuration: {} };
export function mockOcr() {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    provider: {
      async info() {
        return info;
      },
      async process() {
        calls++;
        return {
          ...info,
          text: 'Judul: Machine title\nNomor: DOC-100\nTanggal: 14 November 2026',
          structuredResult: { lines: [] },
          processingMs: 1,
        };
      },
    },
  };
}
const good = (result) => {
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body;
};
const fieldsBody = (metadata, verified = false) => ({
  version: metadata.version,
  fields: metadata.fields.map(({ id, type, value, context }) => ({
    id,
    type,
    value,
    context,
    verification: verified ? 'verified' : 'needs_review',
  })),
});
async function drain(f) {
  for (let i = 0; i < 2000; i++) {
    if (!(await f.app.ocr.runOne())) break;
    assert.ok(i < 1999);
  }
  await f.app.qc.refresh();
}
const detail = async (client, id) => good(await client.request(`/api/qc/${id}`));
const mutate = async (client, id, action, body = {}) =>
  client.request(`/api/qc/${id}/${action}`, {
    version: (await detail(client, id)).document.version,
    ...body,
  });

test('QC: capture, manual metadata, claims, findings, same-batch rework, replacement, resubmit and pass', async (t) => {
  const mock = mockOcr();
  const f = await testApplication(t, { ocr: { provider: mock.provider } });
  const op = await f.account(),
    qc = await f.account(['qc_officer']),
    qc2 = await f.account(['qc_officer']),
    stranger = await f.account();
  let b = good(await op.request('/api/batches', {})).batch;
  const meta = `/api/batches/${b.id}/metadata`;
  good(
    await op.request(
      meta,
      { version: 0, fields: [{ id: null, type: 'title', value: 'Human title', context: '' }] },
      'PATCH',
    ),
  );
  b = good(await op.request(`/api/batches/${b.id}`)).batch;
  let capture = await scanned(op, b, { scenario: 'multi', pageDelay: 0 });
  b = capture.batch;
  b = good(await op.request(`/api/batches/${b.id}/pause`, { version: b.version })).batch;
  b = good(await op.request(`/api/batches/${b.id}/resume`, { version: b.version })).batch;
  capture = await scanned(op, b, { scenario: 'single', pageDelay: 0 });
  b = capture.batch;
  assert.equal(capture.sessions.length, 2);
  const originals = capture.pages.map(({ id, sha256, original_storage_key, capture_order }) => ({
    id,
    sha256,
    original_storage_key,
    capture_order,
  }));
  good(await op.request(`/api/batches/${b.id}/complete-capture`, { version: b.version }));
  await drain(f);
  let d = await detail(qc, b.id);
  assert.equal(d.document.workflow_status, 'qc_waiting');
  const queue = good(
    await qc.request(
      '/api/qc/queue?filter=all&metadata=needs_review&ocr=completed&sort=created_at&direction=desc',
    ),
  );
  assert.equal(queue.total, 1);
  assert.equal(queue.pages, capture.pages.length);
  assert.equal(queue.sessions, 2);
  assert.equal(queue.counts.waiting, 1);
  assert.equal(queue.counts.mine, 0);
  assert.equal(queue.batches[0].id, b.id);
  assert.ok(queue.batches[0].created_at);
  assert.equal(
    (await qc.request('/api/qc/queue?sort=updated_at%3BDROP%20TABLE%20documents')).status,
    400,
  );
  assert.equal((await qc.request('/api/qc/queue?metadata=unknown')).status, 400);
  assert.equal((await qc.request('/api/qc/queue?direction=sideways')).status, 400);
  assert.equal(good(await qc.request('/api/qc/queue?metadata=verified')).total, 0);
  assert.equal(d.metadata.fields.find((v) => v.type === 'title').value, 'Human title');
  assert.equal((await stranger.request(meta)).status, 403);
  assert.equal(
    (await op.request(`/api/qc/${b.id}/claim`, { version: d.document.version })).status,
    403,
  );
  assert.equal(
    (await f.admin.request(`/api/qc/${b.id}/claim`, { version: d.document.version })).status,
    403,
  );
  const claims = await Promise.all(
    [qc, qc2].map((c) => c.request(`/api/qc/${b.id}/claim`, { version: d.document.version })),
  );
  assert.deepEqual(claims.map((c) => c.status).sort(), [200, 409]);
  const winner = claims[0].status === 200 ? qc : qc2,
    loser = winner === qc ? qc2 : qc;
  d = await detail(winner, b.id);
  assert.equal((await op.request(meta, fieldsBody(d.metadata), 'PATCH')).status, 403);
  assert.equal(
    (
      await mutate(loser, b.id, 'save', {
        orderingReviewed: false,
        completenessReviewed: false,
        metadataReviewed: false,
        notes: '',
        ocrException: '',
      })
    ).status,
    409,
  );
  assert.equal((await mutate(winner, b.id, 'pass')).status, 409);
  good(
    await mutate(winner, b.id, 'findings', {
      pageIds: [d.pages[0].id],
      category: 'blurred_page',
      severity: 'critical',
      description: 'Replace the blurry page.',
    }),
  );
  assert.equal((await mutate(winner, b.id, 'return', { reason: '' })).status, 400);
  good(
    await mutate(winner, b.id, 'return', {
      reason: 'Replace blurry page and insert missing page.',
    }),
  );
  d = await detail(op, b.id);
  assert.equal(d.document.workflow_status, 'rework');
  assert.equal(d.batch.status, 'paused');
  b = good(await op.request(`/api/batches/${b.id}/resume`, { version: d.batch.version })).batch;
  const target = d.pages[0].id;
  good(
    await op.request(`/api/batches/${b.id}/scan-sessions`, {
      version: b.version,
      options: { scenario: 'multi', pageDelay: 0 },
      replacementPageId: target,
    }),
  );
  capture = await until(async () => {
    const c = good(await op.request(`/api/batches/${b.id}`));
    return c.sessions.every((s) => s.status !== 'running') ? c : null;
  });
  const session = capture.sessions.at(-1);
  const candidates = capture.pages.filter((p) => p.scan_session_id === session.id);
  assert.ok(candidates.length > 1);
  assert.equal(
    (
      await op.request(`/api/batches/${b.id}/replacement`, {
        version: capture.batch.version,
        sessionId: session.id,
      })
    ).status,
    400,
  );
  assert.equal(capture.pages.find((p) => p.id === target).image_revision, 1);
  capture = good(
    await op.request(`/api/batches/${b.id}/replacement`, {
      version: capture.batch.version,
      sessionId: session.id,
      candidateId: candidates[1].id,
      cancel: false,
    }),
  );
  assert.equal(capture.pages.find((p) => p.id === target).image_revision, 2);
  assert.equal(
    (await f.pool.query('SELECT count(*)::int AS n FROM page_revisions WHERE page_id=$1', [target]))
      .rows[0].n,
    1,
  );
  const anchor = capture.pages.find((p) => p.id === target);
  good(
    await op.request(`/api/batches/${b.id}/scan-sessions`, {
      version: capture.batch.version,
      options: { scenario: 'single', pageDelay: 0 },
      placement: 'after',
      anchorPageId: anchor.id,
    }),
  );
  capture = await until(async () => {
    const c = good(await op.request(`/api/batches/${b.id}`));
    return c.sessions.every((s) => s.status !== 'running') ? c : null;
  });
  const inserted = capture.pages.find((p) => p.scan_session_id === capture.sessions.at(-1).id);
  assert.equal(
    capture.pages[capture.pages.findIndex((p) => p.id === anchor.id) + 1].id,
    inserted.id,
  );
  const last = capture.pages.at(-1);
  capture = good(
    await op.request(`/api/batches/${b.id}/reorder`, {
      version: capture.batch.version,
      pageId: last.id,
      beforePageId: target,
    }),
  );
  assert.equal(capture.pages[0].id, last.id);
  good(await op.request(`/api/batches/${b.id}/resubmit-qc`, { version: capture.batch.version }));
  await drain(f);
  d = await detail(winner, b.id);
  assert.equal(d.reviews.length, 2);
  assert.equal(d.reviews[1].outcome, 'returned');
  assert.equal(d.reviews[1].snapshot.findings[0].status, 'open');
  assert.equal(d.findings[0].status, 'open');
  const currentOriginals = (
    await f.pool.query(
      'SELECT id,sha256,original_storage_key,capture_order FROM pages WHERE id=ANY($1::uuid[]) ORDER BY capture_order',
      [originals.map((p) => p.id)],
    )
  ).rows;
  assert.deepEqual(
    currentOriginals,
    originals.sort((a, b) => a.capture_order - b.capture_order),
  );
  good(await mutate(winner, b.id, 'claim'));
  d = await detail(winner, b.id);
  good(await winner.request(meta, fieldsBody(d.metadata, true), 'PATCH'));
  d = await detail(winner, b.id);
  const finding = d.findings[0];
  good(
    await mutate(winner, b.id, 'findings', {
      id: finding.id,
      pageIds: finding.page_ids,
      category: finding.category,
      severity: finding.severity,
      description: finding.description,
      status: 'resolved',
      resolutionNote: 'Replacement visually checked.',
    }),
  );
  good(
    await mutate(winner, b.id, 'save', {
      orderingReviewed: true,
      completenessReviewed: true,
      metadataReviewed: true,
      notes: 'Complete bundle checked.',
      ocrException: '',
    }),
  );
  good(await mutate(winner, b.id, 'pass'));
  d = await detail(winner, b.id);
  assert.equal(d.document.workflow_status, 'awaiting_approval_l1');
  assert.equal(d.reviews[0].outcome, 'passed');
  assert.ok(d.reviews[0].snapshot);
  assert.equal((await op.request(meta, fieldsBody(d.metadata), 'PATCH')).status, 409);
  assert.equal(
    (await mutate(winner, b.id, 'page-edit', { pageId: target, action: 'rotate-right' })).status,
    409,
  );
  assert.equal((await op.request(`/api/batches/${b.id}/ocr`, {})).status, 409);
  assert.ok(mock.calls > 0);
});

test('QC: stale claim recovery, release, self-QC, CSRF, current text corrections and non-destructive page edits', async (t) => {
  const mock = mockOcr();
  const f = await testApplication(t, { ocr: { provider: mock.provider } });
  const op = await f.account(['operator', 'qc_officer', 'system_admin']),
    a = await f.account(['qc_officer']),
    b = await f.account(['qc_officer']);
  let batch = good(await op.request('/api/batches', {})).batch;
  batch = (await scanned(op, batch, { scenario: 'multi', pageDelay: 0 })).batch;
  good(await op.request(`/api/batches/${batch.id}/complete-capture`, { version: batch.version }));
  await drain(f);
  let d = await detail(a, batch.id);
  assert.equal((await mutate(op, batch.id, 'claim')).body.code, 'self_qc');
  assert.equal(
    (
      await a.request(`/api/qc/${batch.id}/claim`, { version: d.document.version }, 'POST', {
        'X-CSRF-Token': 'bad',
      })
    ).status,
    403,
  );
  good(await mutate(a, batch.id, 'claim'));
  assert.equal((await mutate(b, batch.id, 'claim')).status, 409);
  await f.pool.query(
    "UPDATE qc_reviews SET claim_expires_at=now()-interval '1 minute' WHERE document_id=$1",
    [d.document.id],
  );
  assert.equal(
    (await mutate(a, batch.id, 'page-review', { pageIds: [d.pages[0].id], status: 'reviewed' }))
      .status,
    409,
  );
  good(await mutate(b, batch.id, 'claim'));
  good(await mutate(b, batch.id, 'release'));
  good(await mutate(a, batch.id, 'claim'));
  d = await detail(a, batch.id);
  const page = d.pages[0];
  const before = mock.calls;
  good(
    await mutate(a, batch.id, 'page-edit', {
      pageId: page.id,
      action: 'reorder',
      beforePageId: null,
    }),
  );
  assert.equal(mock.calls, before);
  const p = good(await a.request(`/api/qc/${batch.id}/pages/${page.id}`));
  good(
    await mutate(a, batch.id, 'correct-text', {
      resultId: p.ocr.result_id,
      text: 'Human OCR correction',
    }),
  );
  const corrected = good(await a.request(`/api/qc/${batch.id}/pages/${page.id}`));
  assert.equal(corrected.ocr.corrected_text, 'Human OCR correction');
  assert.notEqual(corrected.ocr.extracted_text, 'Human OCR correction');
  good(await mutate(a, batch.id, 'reprocess-ocr', { requestId: crypto.randomUUID() }));
  await drain(f);
  const reused = good(await a.request(`/api/qc/${batch.id}/pages/${page.id}`));
  assert.equal(
    reused.ocr.corrected_text,
    'Human OCR correction',
    'Exact-result reuse retains this page’s human text correction',
  );
  assert.equal(mock.calls, before, 'Reprocessing unchanged inputs uses the existing success cache');
  const other = good(await a.request(`/api/qc/${batch.id}/pages/${d.pages[1].id}`));
  assert.equal(
    other.ocr.corrected_text,
    null,
    'Corrections do not leak to other pages sharing an OCR result',
  );
  good(await mutate(a, batch.id, 'page-edit', { pageId: page.id, action: 'rotate-right' }));
  d = await detail(a, batch.id);
  assert.equal(d.pages.find((p) => p.id === page.id).rotation_degrees, 90);
  assert.equal(
    (await f.pool.query('SELECT is_stale FROM page_ocr_results WHERE id=$1', [p.ocr.result_id]))
      .rows[0].is_stale,
    true,
  );
  await drain(f);
  assert.equal(mock.calls, before + 1, 'Only the changed page runs inference again');
  good(await mutate(a, batch.id, 'page-edit', { pageId: page.id, action: 'exclude' }));
  good(await mutate(a, batch.id, 'page-edit', { pageId: page.id, action: 'restore' }));
  await drain(f);
  assert.equal(mock.calls, before + 1, 'Restoring identical input reuses preserved OCR');
  const unchanged = (
    await f.pool.query('SELECT sha256,original_storage_key FROM pages WHERE id=$1', [page.id])
  ).rows[0];
  assert.equal(unchanged.sha256, page.sha256);
  assert.equal(
    (await f.pool.query("SELECT count(*)::int AS n FROM audit_logs WHERE action='qc.claimed'"))
      .rows[0].n,
    3,
  );
});

test('QC: metadata concurrency, policies, cancelled replacement and integrity block an invalid pass', async (t) => {
  const f = await testApplication(t, { ocr: { provider: mockOcr().provider } });
  const op = await f.account(),
    qc = await f.account(['qc_officer']);
  let c = good(await op.request('/api/batches', {}));
  c = await scanned(op, c.batch, { scenario: 'single', pageDelay: 0 });
  const id = c.batch.id,
    target = c.pages[0];
  good(
    await op.request(`/api/batches/${id}/scan-sessions`, {
      version: c.batch.version,
      options: { scenario: 'single', pageDelay: 0 },
      replacementPageId: target.id,
    }),
  );
  c = await until(async () => {
    const next = good(await op.request(`/api/batches/${id}`));
    return next.sessions.every((s) => s.status !== 'running') ? next : null;
  });
  const pending = c.sessions.at(-1);
  assert.equal(
    (await op.request(`/api/batches/${id}/complete-capture`, { version: c.batch.version })).status,
    409,
  );
  c = good(
    await op.request(`/api/batches/${id}/replacement`, {
      version: c.batch.version,
      sessionId: pending.id,
      cancel: true,
    }),
  );
  assert.equal(
    c.pages.find((p) => p.id === target.id).active_image_sha256,
    target.active_image_sha256,
  );
  assert.equal(c.pages.find((p) => p.id === target.id).image_revision, 1);
  assert.equal(c.pages.filter((p) => p.is_excluded).length, 1);
  const url = `/api/batches/${id}/metadata`;
  assert.equal(
    (
      await op.request(
        url,
        {
          version: 0,
          fields: [{ id: null, type: 'date', value: '31 February 2026', context: '' }],
        },
        'PATCH',
      )
    ).status,
    400,
  );
  const saved = good(
    await op.request(
      url,
      { version: 0, fields: [{ id: null, type: 'title', value: 'Manual title', context: '' }] },
      'PATCH',
    ),
  );
  assert.equal((await op.request(url, { version: 0, fields: [] }, 'PATCH')).status, 409);
  let d = await detail(f.admin, id);
  good(
    await f.admin.request(`/api/qc/${id}/policy`, {
      version: d.document.version,
      requiredMetadata: ['document_number', 'title'],
    }),
  );
  c = good(await op.request(`/api/batches/${id}`));
  good(await op.request(`/api/batches/${id}/complete-capture`, { version: c.batch.version }));
  await drain(f);
  good(await mutate(qc, id, 'claim'));
  d = await detail(qc, id);
  good(await qc.request(url, fieldsBody(d.metadata, true), 'PATCH'));
  d = await detail(qc, id);
  good(await qc.request(url, fieldsBody(d.metadata), 'PATCH'));
  d = await detail(qc, id);
  assert.ok(d.metadata.fields.every((field) => field.verification === 'needs_review'));
  good(await qc.request(url, fieldsBody(d.metadata, true), 'PATCH'));
  good(
    await mutate(qc, id, 'save', {
      orderingReviewed: true,
      completenessReviewed: true,
      metadataReviewed: true,
      notes: 'Checked',
      ocrException: '',
    }),
  );
  const before = await detail(qc, id);
  await unlink(path.join(f.app.storage.root, target.original_storage_key));
  assert.equal((await mutate(qc, id, 'pass')).status, 503);
  const after = await detail(qc, id);
  assert.equal(after.document.workflow_status, 'qc_in_review');
  assert.equal(after.document.version, before.document.version);
  assert.equal(after.reviews[0].outcome, null);
  assert.ok(saved.metadata.version > 0);
});

test('QC: an OCR exception cannot pass a revision while outstanding jobs may still change its text', async (t) => {
  const f = await testApplication(t, { ocr: { provider: mockOcr().provider } });
  const op = await f.account(),
    qc = await f.account(['qc_officer']);
  let c = good(await op.request('/api/batches', {}));
  c = await scanned(op, c.batch, { scenario: 'single', pageDelay: 0 });
  const id = c.batch.id;
  good(await op.request(`/api/batches/${id}/complete-capture`, { version: c.batch.version }));
  await drain(f);
  good(await mutate(qc, id, 'claim'));
  good(await mutate(qc, id, 'reprocess-ocr', { requestId: crypto.randomUUID() }));
  good(
    await mutate(qc, id, 'save', {
      orderingReviewed: true,
      completenessReviewed: true,
      metadataReviewed: true,
      notes: 'Reviewed',
      ocrException: 'Terminal OCR errors may be accepted.',
    }),
  );
  const pass = await mutate(qc, id, 'pass');
  assert.equal(pass.status, 409);
  assert.match(pass.body.error, /outstanding OCR/i);
  assert.equal((await detail(qc, id)).document.workflow_status, 'qc_in_review');
});

test('metadata continuity: adopt saved run corrections without replacing newer document edits', async (t) => {
  const f = await testApplication(t, { ocr: { provider: mockOcr().provider } });
  const op = await f.account();
  let c = good(await op.request('/api/batches', {}));
  c = await scanned(op, c.batch, { scenario: 'single', pageDelay: 0 });
  good(
    await op.request(`/api/batches/${c.batch.id}/complete-capture`, { version: c.batch.version }),
  );
  await drain(f);
  const job = (await f.pool.query('SELECT id FROM ocr_jobs WHERE batch_id=$1', [c.batch.id]))
    .rows[0];
  const fields = [
    {
      id: 'legacy-title',
      type: 'title',
      value: 'Historical correction',
      originalValue: 'Machine title',
      context: '',
      source: [{ pageId: c.pages[0].id }],
    },
  ];
  await f.pool.query(
    "INSERT INTO document_metadata(ocr_job_id,extractor_version,fields,warnings,updated_by) VALUES($1,1,$2,'[]',$3)",
    [job.id, JSON.stringify(fields), op.user.id],
  );
  const sql = await readFile(
    new URL('../migrations/011_metadata_continuity.sql', import.meta.url),
    'utf8',
  );
  await f.pool.query(sql);
  let d = await detail(op, c.batch.id);
  assert.equal(d.metadata.fields.find((f) => f.type === 'title').value, 'Historical correction');
  assert.equal(d.metadata.fields.find((f) => f.type === 'title').origin, 'corrected');
  const body = fieldsBody(d.metadata);
  body.fields.find((f) => f.type === 'title').value = 'Newer human correction';
  good(await op.request(`/api/batches/${c.batch.id}/metadata`, body, 'PATCH'));
  await f.pool.query(sql);
  d = await detail(op, c.batch.id);
  assert.equal(d.metadata.fields.find((f) => f.type === 'title').value, 'Newer human correction');
  assert.deepEqual(
    (await f.pool.query('SELECT fields FROM document_metadata WHERE ocr_job_id=$1', [job.id]))
      .rows[0].fields,
    fields,
  );
  await f.pool.query("UPDATE document_metadata SET fields='[]' WHERE ocr_job_id=$1", [job.id]);
  await f.pool.query("UPDATE documents SET metadata_json='{}' WHERE batch_id=$1", [c.batch.id]);
  await f.pool.query(sql);
  assert.deepEqual(
    (await detail(op, c.batch.id)).metadata.fields,
    [],
    'Empty saved run metadata adopts without a null history row',
  );
});
