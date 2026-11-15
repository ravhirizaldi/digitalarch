import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  unchangedReworkCapture,
  assertReworkAction,
  operatorFieldLocked,
} from '../server/workflow.mjs';
import { editedFields } from '../server/qc-metadata.mjs';
import { testApplication } from './support.mjs';

test('QC locks distinguish sections, reviewed pages and new missing-page work', () => {
  const locks = {
    metadataLocked: true,
    orderingLocked: true,
    completenessLocked: true,
    reviewedPageIds: ['reviewed'],
  };
  for (const action of [
    'metadata',
    'location',
    'capture',
    'reorder',
    'remove',
    'restore',
    'replacement',
    'rename',
    'rotate-right',
  ])
    assert.throws(() => assertReworkAction(locks, action, 'reviewed'), { code: 'qc_locked' });
  const reopened = { ...locks, orderingLocked: false, completenessLocked: false };
  for (const action of ['capture', 'reorder', 'rename', 'rotate-right', 'replacement'])
    assert.doesNotThrow(() => assertReworkAction(reopened, action, 'new'));
  assert.throws(() => assertReworkAction(reopened, 'rename', 'reviewed'), { code: 'qc_locked' });
  assert.throws(() => assertReworkAction(reopened, 'metadata'), { code: 'qc_locked' });
});

test('QC-corrected fields are protected, retained in mixed saves, and explicitly reopenable', () => {
  const user = { id: 'qc', display_name: 'QC' };
  const field = {
    id: 'title',
    type: 'title',
    value: 'QC title',
    context: '',
    verification: 'needs_review',
    operatorLocked: true,
  };
  const doc = { metadata_version: 1, metadata_json: { fields: [field] } };
  const save = (fields, qc = false) => editedFields(doc, { version: 1, fields }, user, qc);
  const body = {
    id: field.id,
    type: field.type,
    value: field.value,
    context: field.context,
    verification: field.verification,
  };
  assert.throws(() => save([{ ...body, value: 'Operator override' }]), { code: 'qc_locked' });
  assert.throws(() => save([]), { code: 'qc_locked' });
  assert.throws(() => save([{ ...body, operatorLocked: false }]), { code: 'forbidden' });
  assert.throws(() => save([{ type: 'title', value: 'Shadow title', context: '' }, body]), {
    code: 'qc_locked',
  });
  assert.deepEqual(
    save([body, { type: 'other', value: 'Open correction', context: '' }])[0],
    field,
  );
  assert.equal(save([{ ...body, operatorLocked: false }], true)[0].operatorLocked, false);
  assert.equal(save([{ ...body, value: 'QC correction' }], true)[0].operatorLocked, true);
  assert.equal(
    operatorFieldLocked({ editedBy: 'qc' }, ['qc']),
    true,
    'Legacy QC edits stay protected',
  );
  assert.equal(
    operatorFieldLocked({ editedBy: 'qc', operatorLocked: false }, ['qc']),
    false,
    'Explicit reopening overrides legacy provenance',
  );
});

test('metadata-only rework reuses capture; new sessions and image generations do not', () => {
  const doc = { workflow_status: 'rework', review_cycle: 1 };
  const page = {
    id: 'page',
    scan_session_id: 'session',
    image_revision: 1,
    rotation_degrees: 0,
    active_image_sha256: 'original',
  };
  const review = { outcome: 'returned', cycle: 1, snapshot: { pages: [page] } };
  const sessions = [{ id: 'session', status: 'completed' }];
  const ready = (patch = {}, pages = [page], sessionList = sessions) =>
    unchangedReworkCapture({ ...doc, ...patch }, review, pages, sessionList);
  assert.equal(ready({ metadata_version: 99, revision: 99 }), true);
  assert.equal(ready({}, [{ ...page, page_label: 'Renamed', display_order: 9 }]), true);
  assert.equal(ready({}, [{ ...page, image_revision: 2 }]), false);
  assert.equal(ready({}, [{ ...page, rotation_degrees: 90 }]), false);
  assert.equal(ready({}, [{ ...page, active_image_sha256: 'replaced' }]), false);
  assert.equal(ready({}, [{ ...page, is_excluded: true }]), false);
  const second = { ...page, id: 'second' };
  assert.equal(
    unchangedReworkCapture(
      doc,
      { ...review, snapshot: { pages: [page, second] } },
      [{ ...page, is_excluded: true }, second],
      sessions,
    ),
    true,
    'Excluding a page does not change retained images',
  );
  assert.equal(ready({}, [page, { ...page, id: 'new-page' }]), false);
  assert.equal(
    ready({}, [page], [...sessions, { id: 'empty-new-session', status: 'partial' }]),
    false,
  );
  for (const session of [
    { ...sessions[0], status: 'running' },
    { ...sessions[0], recovery_pending: true },
    { ...sessions[0], replacement_status: 'pending' },
  ])
    assert.equal(ready({}, [page], [session]), false);
  assert.equal(ready({ workflow_status: 'operator_preparation' }), false);
  assert.equal(ready({ review_cycle: 2 }), false);
  const oldEmptySession = { id: 'old-empty', status: 'partial' };
  assert.equal(
    ready({}, [page], [...sessions, oldEmptySession]),
    false,
    'Legacy snapshots cannot prove omitted sessions',
  );
  assert.equal(
    unchangedReworkCapture(
      doc,
      { ...review, snapshot: { pages: [page], captureSessions: ['session', 'old-empty'] } },
      [page],
      [...sessions, oldEmptySession],
    ),
    true,
  );
});

// Saved image/state assembly only. These regression sources are not permission to execute OCR tests.
test('saved metadata can resubmit paused rework without another completion or OCR; OP/QC share guarded Batch Info', async (t) => {
  const f = await testApplication(t);
  f.app.qc.refresh = async () => {};
  const op = await f.account();
  const qc = await f.account(['qc_officer']);
  const other = await f.account(['qc_officer']);
  const good = (result) => {
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body;
  };
  let batch = good(await op.request('/api/batches', {})).batch;
  const doc = (await f.pool.query('SELECT * FROM documents WHERE batch_id=$1', [batch.id])).rows[0];
  const session = (
    await f.pool.query(
      `INSERT INTO scan_sessions(batch_id,document_id,session_number,status,created_by,scanner_mode,job_id)
    VALUES($1,$2,1,'completed',$3,'simulator',$4) RETURNING *`,
      [batch.id, doc.id, op.user.id, randomUUID()],
    )
  ).rows[0];
  const image = await f.app.storage.finalize(
    session,
    1,
    path.resolve('fixtures/basic'),
    'page-001.png',
  );
  const page = (
    await f.pool.query(
      `INSERT INTO pages(batch_id,document_id,scan_session_id,capture_order,display_order,
    original_storage_key,active_storage_key,mime_type,byte_size,sha256,width_px,height_px,source)
    VALUES($1,$2,$3,1,1,$4,$4,'image/png',$5,$6,$7,$8,'simulator') RETURNING *`,
      [
        batch.id,
        doc.id,
        session.id,
        image.key,
        image.byteSize,
        image.sha256,
        image.width,
        image.height,
      ],
    )
  ).rows[0];
  await f.pool.query(
    `INSERT INTO ocr_jobs(batch_id,manifest_hash,language,status,total_pages,processed_pages)
    VALUES($1,$2,'ind+eng','completed',1,1)`,
    [batch.id, randomUUID()],
  );
  const review = (
    await f.pool.query(
      `INSERT INTO qc_reviews(document_id,cycle,outcome,submitted_at,decided_by,decided_at,snapshot,decision_reason)
    VALUES($1,1,'returned',now(),$2,now(),$3,'Fix metadata only') RETURNING *`,
      [doc.id, qc.user.id, JSON.stringify({ pages: [page] })],
    )
  ).rows[0];
  await f.pool.query("UPDATE documents SET workflow_status='rework',review_cycle=1 WHERE id=$1", [
    doc.id,
  ]);
  await f.pool.query(
    "UPDATE archive_batches SET status='paused',ocr_status='completed',capture_completed_at=now() WHERE id=$1",
    [batch.id],
  );
  let detail = good(await op.request(`/api/qc/${batch.id}`));
  assert.equal(detail.can_resubmit_without_capture, true);
  good(
    await op.request(
      `/api/batches/${batch.id}/metadata`,
      {
        version: detail.document.metadata_version,
        fields: [{ type: 'title', value: 'Corrected metadata' }],
      },
      'PATCH',
    ),
  );
  detail = good(await op.request(`/api/qc/${batch.id}`));
  good(
    await op.request(
      `/api/batches/${batch.id}`,
      { version: detail.batch.version, physicalLocation: 'Correct rack' },
      'PATCH',
    ),
  );
  batch = good(await op.request(`/api/batches/${batch.id}`)).batch;
  assert.equal(
    (
      await qc.request(
        `/api/batches/${batch.id}`,
        { version: batch.version, physicalLocation: 'Not claimed' },
        'PATCH',
      )
    ).status,
    403,
  );
  const captureTime = batch.capture_completed_at;
  const result = good(
    await op.request(`/api/batches/${batch.id}/resubmit-qc`, { version: batch.version }),
  );
  assert.equal(result.batch.status, 'capture_completed');
  assert.equal(
    result.batch.capture_completed_at,
    captureTime,
    'Do not invent a new capture completion',
  );
  assert.equal(
    (await f.pool.query('SELECT count(*)::int AS n FROM ocr_jobs WHERE batch_id=$1', [batch.id]))
      .rows[0].n,
    1,
    'No OCR queued',
  );
  detail = good(await qc.request(`/api/qc/${batch.id}`));
  assert.equal(detail.document.review_cycle, 2);
  assert.equal(
    detail.reviews.find((row) => row.id === review.id).decision_reason,
    'Fix metadata only',
  );
  good(await qc.request(`/api/qc/${batch.id}/claim`, { version: detail.document.version }));
  detail = good(await qc.request(`/api/qc/${batch.id}`));
  assert.equal(
    (
      await other.request(
        `/api/batches/${batch.id}`,
        { version: detail.batch.version, physicalLocation: 'Another claim' },
        'PATCH',
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await op.request(
        `/api/batches/${batch.id}`,
        { version: detail.batch.version, physicalLocation: 'Operator locked' },
        'PATCH',
      )
    ).status,
    403,
  );
  good(
    await qc.request(
      `/api/batches/${batch.id}`,
      { version: detail.batch.version, physicalLocation: 'QC corrected rack' },
      'PATCH',
    ),
  );
  assert.equal(
    good(await qc.request(`/api/qc/${batch.id}`)).batch.physical_location,
    'QC corrected rack',
  );
  assert.equal(
    (
      await qc.request(
        `/api/batches/${batch.id}`,
        { version: detail.batch.version, physicalLocation: 'Stale overwrite' },
        'PATCH',
      )
    ).status,
    409,
  );
});

test('missing page rework queues only the new image and carries reviewed pages and metadata forward', async (t) => {
  const f = await testApplication(t);
  f.app.qc.refresh = async () => {};
  const op = await f.account();
  const qc = await f.account(['qc_officer']);
  const good = (result) => {
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body;
  };
  const batch = good(await op.request('/api/batches', {})).batch;
  const doc = (await f.pool.query('SELECT * FROM documents WHERE batch_id=$1', [batch.id])).rows[0];
  async function session(number) {
    return (
      await f.pool.query(
        `INSERT INTO scan_sessions(batch_id,document_id,session_number,status,created_by,scanner_mode,job_id)
      VALUES($1,$2,$3,'completed',$4,'simulator',$5) RETURNING *`,
        [batch.id, doc.id, number, op.user.id, randomUUID()],
      )
    ).rows[0];
  }
  async function page(scan, number) {
    const image = await f.app.storage.finalize(
      scan,
      number,
      path.resolve('fixtures/basic'),
      'page-001.png',
    );
    return (
      await f.pool.query(
        `INSERT INTO pages(batch_id,document_id,scan_session_id,capture_order,display_order,
      original_storage_key,active_storage_key,mime_type,byte_size,sha256,width_px,height_px,source)
      VALUES($1,$2,$3,$4,$4,$5,$5,'image/png',$6,$7,$8,$9,'simulator') RETURNING *`,
        [
          batch.id,
          doc.id,
          scan.id,
          number,
          image.key,
          image.byteSize,
          image.sha256,
          image.width,
          image.height,
        ],
      )
    ).rows[0];
  }
  const originalSession = await session(1);
  const pages = [];
  for (let n = 1; n <= 9; n++) pages.push(await page(originalSession, n));
  const job = (
    await f.pool.query(
      `INSERT INTO ocr_jobs(batch_id,manifest_hash,language,status,total_pages,processed_pages)
    VALUES($1,$2,'ind+eng','completed',9,9) RETURNING *`,
      [batch.id, randomUUID()],
    )
  ).rows[0];
  await f.pool.query(
    `INSERT INTO page_ocr_results(page_id,batch_id,ocr_job_id,image_sha256,storage_key,rotation_degrees,
    language,image_revision,status,config_hash,engine_version,processed_at,extracted_text)
    SELECT id,batch_id,$2,active_image_sha256,active_storage_key,rotation_degrees,'ind+eng',image_revision,
      'completed','saved-config','saved-version',now(),'Saved text' FROM pages WHERE batch_id=$1`,
    [batch.id, job.id],
  );
  const originalResults = (
    await f.pool.query('SELECT * FROM page_ocr_results WHERE ocr_job_id=$1 ORDER BY page_id', [
      job.id,
    ])
  ).rows;
  await f.pool.query(
    'INSERT INTO ocr_text_corrections(result_id,corrected_text,created_by) VALUES($1,$2,$3)',
    [originalResults[0].id, 'QC corrected text', qc.user.id],
  );
  const review = (
    await f.pool.query(
      `INSERT INTO qc_reviews(document_id,cycle,outcome,submitted_at,decided_by,decided_at,
    metadata_reviewed,snapshot,decision_reason) VALUES($1,1,'returned',now(),$2,now(),true,$3,'Insert missing page 3') RETURNING *`,
      [doc.id, qc.user.id, JSON.stringify({ pages, captureSessions: [originalSession.id] })],
    )
  ).rows[0];
  await f.pool.query(
    `INSERT INTO qc_page_reviews(review_id,page_id,status,image_revision,reviewed_by)
    SELECT $2,id,'reviewed',image_revision,$3 FROM pages WHERE batch_id=$1`,
    [batch.id, review.id, qc.user.id],
  );
  await f.pool.query(
    `UPDATE documents SET workflow_status='rework',review_cycle=1,metadata_json=$2 WHERE id=$1`,
    [
      doc.id,
      JSON.stringify({
        fields: [
          {
            id: randomUUID(),
            type: 'title',
            value: 'Approved metadata',
            context: '',
            verification: 'verified',
          },
        ],
      }),
    ],
  );
  await f.pool.query(
    "UPDATE archive_batches SET status='paused',ocr_status='completed',capture_completed_at=now() WHERE id=$1",
    [batch.id],
  );
  let detail = good(await op.request(`/api/qc/${batch.id}`));
  assert.equal(detail.operator_locks.metadataLocked, true);
  assert.equal(detail.operator_locks.orderingLocked, false);
  assert.equal(detail.operator_locks.reviewedPageIds.length, 9);
  for (const action of ['rename', 'rotate-right', 'remove']) {
    const result = await op.request(
      `/api/pages/${pages[0].id}`,
      { version: detail.batch.version, action, label: 'Forbidden' },
      'PATCH',
    );
    assert.equal(result.body.code, 'qc_locked');
  }
  assert.equal(
    (await op.request(`/api/batches/${batch.id}/metadata`, { version: 0, fields: [] }, 'PATCH'))
      .body.code,
    'qc_locked',
  );
  assert.equal(
    (await op.request(`/api/batches/${batch.id}/metadata/extract`, { version: 0 })).body.code,
    'qc_locked',
  );
  assert.equal(
    (
      await op.request(
        `/api/batches/${batch.id}`,
        { version: detail.batch.version, physicalLocation: 'Bypass' },
        'PATCH',
      )
    ).body.code,
    'qc_locked',
  );
  const missing = await page(await session(2), 10);
  detail = good(await op.request(`/api/qc/${batch.id}`));
  let capture = good(
    await op.request(
      `/api/pages/${missing.id}`,
      { version: detail.batch.version, action: 'rename', label: 'Missing page 3' },
      'PATCH',
    ),
  );
  capture = good(
    await op.request(`/api/batches/${batch.id}/reorder`, {
      version: capture.batch.version,
      pageId: missing.id,
      beforePageId: pages[2].id,
    }),
  );
  assert.equal(capture.pages[2].id, missing.id);
  assert.equal(capture.pages[2].page_label, 'Missing page 3');
  capture = good(
    await op.request(`/api/batches/${batch.id}/complete-capture`, {
      version: capture.batch.version,
    }),
  );
  const nextJob = (
    await f.pool.query(
      'SELECT * FROM ocr_jobs WHERE batch_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1',
      [batch.id],
    )
  ).rows[0];
  const results = (
    await f.pool.query('SELECT * FROM page_ocr_results WHERE ocr_job_id=$1', [nextJob.id])
  ).rows;
  assert.equal(results.filter((result) => result.status === 'queued').length, 1);
  assert.equal(results.find((result) => result.status === 'queued').page_id, missing.id);
  assert.equal(
    results.filter((result) => result.status === 'completed' && result.reused_result_id).length,
    9,
  );
  assert.equal(nextJob.processed_pages, 9);
  assert.equal(nextJob.total_pages, 10);
  assert.deepEqual(
    (
      await f.pool.query('SELECT * FROM page_ocr_results WHERE ocr_job_id=$1 ORDER BY page_id', [
        job.id,
      ])
    ).rows,
    originalResults,
  );
  const info = good(await op.request(`/api/qc/${batch.id}/pages/${originalResults[0].page_id}`));
  assert.equal(info.ocr.corrected_text, 'QC corrected text');
  assert.equal(
    (await op.request(`/api/ocr/jobs/${nextJob.id}/reprocess`, { version: nextJob.version })).body
      .code,
    'qc_locked',
  );
  // Assemble a saved terminal state; never start a recognition provider in this regression.
  await f.pool.query(
    `UPDATE page_ocr_results SET status='completed',config_hash='saved-config',engine_version='saved-version',
    processed_at=now(),extracted_text='New page text' WHERE ocr_job_id=$1 AND status='queued'`,
    [nextJob.id],
  );
  await f.pool.query("UPDATE ocr_jobs SET status='completed',processed_pages=10 WHERE id=$1", [
    nextJob.id,
  ]);
  await f.pool.query("UPDATE archive_batches SET ocr_status='completed' WHERE id=$1", [batch.id]);
  capture = good(await op.request(`/api/batches/${batch.id}`));
  good(
    await op.request(`/api/batches/${batch.id}/resubmit-qc`, { version: capture.batch.version }),
  );
  detail = good(await qc.request(`/api/qc/${batch.id}`));
  assert.equal(detail.reviews[0].metadata_reviewed, true);
  assert.equal(detail.reviews[0].ordering_reviewed, false);
  assert.equal(detail.pages.filter((p) => p.review_status === 'reviewed').length, 9);
  assert.equal(detail.pages.find((p) => p.id === missing.id).review_status, null);
  assert.equal(detail.document.metadata_json.fields[0].value, 'Approved metadata');
  good(await qc.request(`/api/qc/${batch.id}/claim`, { version: detail.document.version }));
  detail = good(await qc.request(`/api/qc/${batch.id}`));
  good(
    await qc.request(`/api/qc/${batch.id}/save`, {
      version: detail.document.version,
      orderingReviewed: true,
      completenessReviewed: true,
      metadataReviewed: true,
      notes: 'QC-only notes',
      ocrException: 'QC-only exception',
    }),
  );
  detail = good(await qc.request(`/api/qc/${batch.id}`));
  good(
    await qc.request(`/api/qc/${batch.id}/return`, {
      version: detail.document.version,
      reason: 'All reviewed sections stay protected',
    }),
  );
  detail = good(await op.request(`/api/qc/${batch.id}`));
  assert.equal(
    (
      await op.request(`/api/batches/${batch.id}/reorder`, {
        version: detail.batch.version,
        pageId: missing.id,
        beforePageId: pages[0].id,
      })
    ).body.code,
    'qc_locked',
  );
  capture = good(
    await op.request(`/api/batches/${batch.id}/resume`, { version: detail.batch.version }),
  );
  assert.equal(
    (
      await op.request(`/api/batches/${batch.id}/scan-sessions`, {
        version: capture.batch.version,
        options: { scenario: 'single' },
      })
    ).body.code,
    'qc_locked',
  );
  assert.notEqual(
    (
      await op.request(`/api/qc/${batch.id}/save`, {
        version: detail.document.version,
        orderingReviewed: false,
        completenessReviewed: false,
        metadataReviewed: false,
        notes: 'Operator overwrite',
        ocrException: 'Operator exception',
      })
    ).status,
    200,
  );
  const failedJob = (
    await f.pool.query(
      `INSERT INTO ocr_jobs(batch_id,manifest_hash,language,status,total_pages,failed_pages)
    VALUES($1,$2,'ind+eng','failed',1,1) RETURNING *`,
      [batch.id, randomUUID()],
    )
  ).rows[0];
  await f.pool.query(
    `INSERT INTO page_ocr_results(page_id,batch_id,ocr_job_id,image_sha256,storage_key,rotation_degrees,
    language,image_revision,status) SELECT id,batch_id,$2,active_image_sha256,active_storage_key,rotation_degrees,
    'ind+eng',image_revision,'failed' FROM pages WHERE id=$1`,
    [pages[0].id, failedJob.id],
  );
  assert.equal(
    (await op.request(`/api/ocr/jobs/${failedJob.id}/retry-failed`, { version: failedJob.version }))
      .body.code,
    'qc_locked',
  );
  assert.equal(
    (await f.pool.query('SELECT status FROM page_ocr_results WHERE ocr_job_id=$1', [failedJob.id]))
      .rows[0].status,
    'failed',
  );
});
