import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import QRCode from 'qrcode';
import { testApplication } from './support.mjs';
import { publicPage } from '../server/workflow.mjs';

// Saved synthetic fixtures only: no scans, image recognition or browser operations.
async function savedPage(f, batch, operator) {
  const doc = (await f.pool.query('SELECT id FROM documents WHERE batch_id=$1', [batch.id]))
    .rows[0];
  const session = (
    await f.pool.query(
      `INSERT INTO scan_sessions(batch_id,document_id,session_number,status,created_by,scanner_mode,job_id)
    VALUES($1,$2,1,'completed',$3,'simulator',$4) RETURNING *`,
      [batch.id, doc.id, operator.user.id, `saved-${randomUUID()}`],
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
    VALUES($1,$2,$3,1,1,$4,$4,'image/png',$5,$6,$7,$8,'simulator') RETURNING id`,
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
  return publicPage(
    (await f.pool.query('SELECT * FROM document_pages WHERE id=$1', [page.id])).rows[0],
  );
}

async function fixture(t, l2Required = true) {
  const f = await testApplication(t);
  // State assembly must not race the runtime's independent metadata maintenance.
  f.app.qc.refresh = async () => {};
  const operator = await f.account();
  const qc = await f.account(['qc_officer']);
  const l1 = await f.account(['approver_l1']);
  const l2 = await f.account(['approver_l2']);
  const batch = (await operator.request('/api/batches', { physicalLocation: 'Rack Z' })).body.batch;
  await f.pool.query("UPDATE archive_batches SET status='capture_completed' WHERE id=$1", [
    batch.id,
  ]);
  const doc = (
    await f.pool.query(
      `UPDATE documents SET workflow_status='qc_in_review',review_cycle=1,
    approval_l2_required=$2,approval_policy_version=1,title='POC approval',archive_number='POC/001',document_type='Letter'
    WHERE batch_id=$1 RETURNING *`,
      [batch.id, l2Required],
    )
  ).rows[0];
  const page = await savedPage(f, batch, operator);
  const job = (
    await f.pool.query(
      `INSERT INTO ocr_jobs(batch_id,manifest_hash,language,status,total_pages,processed_pages)
    VALUES($1,$2,'ind+eng','completed',1,1) RETURNING id`,
      [batch.id, randomUUID()],
    )
  ).rows[0];
  const result = (
    await f.pool.query(
      `INSERT INTO page_ocr_results(page_id,batch_id,ocr_job_id,image_sha256,storage_key,
    rotation_degrees,language,config_hash,engine_version,status,processed_at,extracted_text)
    VALUES($1,$2,$3,$4,$5,0,'ind+eng',$6,'saved-fixture','completed',now(),'Saved machine text') RETURNING id`,
      [
        page.id,
        batch.id,
        job.id,
        page.sha256,
        (await f.pool.query('SELECT active_storage_key FROM pages WHERE id=$1', [page.id])).rows[0]
          .active_storage_key,
        'a'.repeat(64),
      ],
    )
  ).rows[0];
  const correction = (
    await f.pool.query(
      `INSERT INTO ocr_text_corrections(result_id,corrected_text,created_by)
    VALUES($1,'Reviewed correction',$2) RETURNING id`,
      [result.id, qc.user.id],
    )
  ).rows[0];
  const review = (
    await f.pool.query(
      `INSERT INTO qc_reviews(document_id,cycle,outcome,decided_by,decided_at,
    reviewed_revision,snapshot,submitted_at) VALUES($1,1,'passed',$2,now(),$3,$4,now()) RETURNING *`,
      [
        doc.id,
        qc.user.id,
        doc.revision,
        JSON.stringify({
          revision: doc.revision,
          metadata: { fields: [] },
          pages: [page],
          findings: [],
          ocr: [
            {
              page_id: page.id,
              result_id: result.id,
              correction_id: correction.id,
              image_revision: page.image_revision,
              status: 'completed',
            },
          ],
        }),
      ],
    )
  ).rows[0];
  await f.pool.query("UPDATE documents SET workflow_status='awaiting_approval_l1' WHERE id=$1", [
    doc.id,
  ]);
  const get = async (account = l1) => (await account.request(`/api/records/${batch.id}`)).body;
  const decide = async (account, action, extra = {}) =>
    account.request(`/api/records/${batch.id}/decision`, {
      action,
      version: (await get(account)).document.version,
      ...extra,
    });
  return { ...f, operator, qc, l1, l2, batch, doc, page, result, review, get, decide };
}

test('approval: selected L2, versioned publication, QR receipts and retained operator notifications', async (t) => {
  const f = await fixture(t);
  const viewer = await f.account(['archive_viewer']);
  const otherL2 = await f.account(['approver_l2']);
  assert.equal((await viewer.request('/api/records')).status, 403);
  assert.equal((await f.l2.request('/api/qc/queue')).status, 403);
  assert.equal(
    (
      await f.l1.request(
        `/api/records/${f.batch.id}/decision`,
        { action: 'approve', version: f.doc.version },
        'POST',
        { 'X-CSRF-Token': '' },
      )
    ).status,
    403,
  );
  assert.equal((await f.decide(f.l1, 'approve')).status, 400);
  const first = await f.decide(f.l1, 'approve', { authorityId: f.l2.user.id });
  assert.equal(first.status, 200);
  assert.equal(first.body.state, 'awaiting_approval_l2');
  assert.equal((await f.operator.request('/api/records?view=published')).body.total, 0);
  assert.equal((await otherL2.request('/api/records?view=l2')).body.total, 0);
  assert.equal((await f.l2.request('/api/records?view=l2')).body.total, 1);
  assert.equal((await f.decide(otherL2, 'approve')).status, 403);
  const current = await f.get(f.l2);
  assert.equal(current.document.assigned_l2_id, f.l2.user.id);
  assert.equal(current.document.published_by, null);
  const results = await Promise.all(
    [1, 2].map(() =>
      f.l2.request(`/api/records/${f.batch.id}/decision`, {
        action: 'approve',
        version: current.document.version,
      }),
    ),
  );
  assert.deepEqual(results.map(({ status }) => status).sort(), [200, 409]);
  const final = results.find(({ status }) => status === 200).body;
  assert.equal(final.state, 'approved');
  assert.equal((await f.get(f.l2)).document.published_by, f.l2.user.id);
  const publication = await f.operator.request(
    '/api/records?view=published&search=POC&type=letter&number=001&location=rack',
  );
  assert.equal(publication.body.total, 1);
  const receipt = (await f.operator.request(`/api/confirmations/${final.confirmationId}`)).body
    .confirmation;
  assert.equal(receipt.current, true);
  assert.equal(receipt.final, true);
  assert.equal(receipt.published, true);
  assert.equal(receipt.officer, f.l2.user.display_name);
  const qr = await f.operator.request(`/api/confirmations/${final.confirmationId}/qr`);
  assert.equal(qr.status, 200);
  assert.match(qr.response.headers.get('content-type'), /image\/svg\+xml/);
  assert.equal(
    await qr.response.text(),
    await QRCode.toString(`${f.origin}/confirmations/${final.confirmationId}`, {
      type: 'svg',
      width: 240,
      margin: 4,
      errorCorrectionLevel: 'M',
    }),
  );
  await f.pool.query(
    "INSERT INTO ocr_text_corrections(result_id,corrected_text,created_by) VALUES($1,'Later correction, not approved',$2)",
    [f.result.id, f.qc.user.id],
  );
  const text = (await f.l2.request(`/api/records/${f.batch.id}/pages/${f.page.id}/text`)).body.ocr;
  assert.equal(
    text.corrected_text,
    'Reviewed correction',
    'Text must resolve the snapshot correction, never a newer one',
  );
  assert.equal(
    (await viewer.request(`/api/records/${f.batch.id}/pages/${f.page.id}/text`)).status,
    403,
  );
  assert.equal((await viewer.request(`/api/confirmations/${final.confirmationId}/qr`)).status, 403);
  const outsider = await f.account();
  assert.equal(
    (await outsider.request(`/api/records/${f.batch.id}`)).status,
    200,
    'Published records are visible to working roles',
  );
  assert.equal(
    (await f.operator.request('/api/approval-notifications')).body.notifications.length,
    2,
  );
  await f.operator.request(`/api/confirmations/${first.body.confirmationId}/dismiss`, {});
  assert.equal(
    (await f.operator.request('/api/approval-notifications')).body.notifications.length,
    1,
  );
  assert.equal((await f.get(f.operator)).history.length, 2);
  await assert.rejects(
    f.pool.query("UPDATE approval_decisions SET reason='rewrite' WHERE id=$1", [
      final.confirmationId,
    ]),
  );
  await assert.rejects(
    f.pool.query("UPDATE qc_reviews SET snapshot='{}' WHERE id=$1", [f.review.id]),
  );
  await assert.rejects(
    f.pool.query("UPDATE documents SET title='rewritten' WHERE id=$1", [f.doc.id]),
  );
  await assert.rejects(
    f.pool.query('UPDATE documents SET approval_l2_required=false WHERE id=$1', [f.doc.id]),
  );
});

test('approval: fixed policy, assigned QC returns, inactive targets, new cycles and fresh decisions', async (t) => {
  const f = await fixture(t);
  const settings = (await f.admin.request('/api/settings/approval')).body.settings;
  const payload = {
    version: settings.version,
    l2Required: false,
    l1Label: 'Supervisor',
    l2Label: 'Authority',
  };
  assert.equal((await f.operator.request('/api/settings/approval', payload, 'PATCH')).status, 403);
  assert.equal((await f.admin.request('/api/settings/approval', payload, 'PATCH')).status, 200);
  assert.equal((await f.admin.request('/api/settings/approval', payload, 'PATCH')).status, 409);
  assert.equal((await f.get()).document.approval_l2_required, true);
  const first = await f.decide(f.l1, 'approve', { authorityId: f.l2.user.id });
  assert.equal(first.status, 200);
  assert.equal((await f.decide(f.l2, 'return', { reviewerId: f.qc.user.id })).status, 400);
  await f.pool.query('UPDATE users SET is_active=false WHERE id=$1', [f.qc.user.id]);
  assert.equal(
    (
      await f.decide(f.l2, 'return', {
        reviewerId: f.qc.user.id,
        reason: 'Correct the classification',
      })
    ).status,
    409,
  );
  const otherQc = await f.account(['qc_officer']);
  assert.equal(
    (
      await f.decide(f.l2, 'return', {
        reviewerId: otherQc.user.id,
        reason: 'Correct the classification',
      })
    ).status,
    200,
  );
  const returned = await f.get();
  assert.equal(returned.document.review_cycle, 2);
  assert.equal(returned.document.workflow_status, 'qc_waiting');
  assert.equal(
    (await f.operator.request(`/api/confirmations/${first.body.confirmationId}`)).body.confirmation
      .current,
    false,
  );
  const thirdQc = await f.account(['qc_officer']);
  assert.equal(
    (await thirdQc.request(`/api/qc/${f.batch.id}/claim`, { version: returned.document.version }))
      .status,
    403,
  );
  assert.equal(
    (await otherQc.request(`/api/qc/${f.batch.id}/claim`, { version: returned.document.version }))
      .status,
    200,
  );
  const current = (await f.pool.query('SELECT * FROM documents WHERE id=$1', [f.doc.id])).rows[0];
  assert.equal(current.approval_l2_required, true);
  // Save a second state-only QC snapshot without invoking the recognition/review pipeline.
  await f.pool.query(
    `UPDATE qc_reviews SET outcome='passed',decided_by=$2,decided_at=now(),reviewed_revision=$3,
    snapshot=$4,claimed_by=NULL,claim_expires_at=NULL WHERE document_id=$1 AND cycle=2`,
    [
      f.doc.id,
      otherQc.user.id,
      current.revision,
      JSON.stringify({
        revision: current.revision,
        metadata: { fields: [] },
        pages: [],
        findings: [],
        ocr: [],
      }),
    ],
  );
  await f.pool.query("UPDATE documents SET workflow_status='awaiting_approval_l1' WHERE id=$1", [
    f.doc.id,
  ]);
  assert.equal((await f.operator.request('/api/records?view=published')).body.total, 0);
  assert.equal((await f.decide(f.l2, 'approve')).status, 403);
  assert.equal(
    (await f.decide(f.l1, 'approve', { authorityId: f.l2.user.id })).body.state,
    'awaiting_approval_l2',
  );
  assert.equal((await f.decide(f.l2, 'approve')).body.state, 'approved');
  assert.equal((await f.get()).history.length, 4);
  assert.equal(
    (await f.pool.query('SELECT outcome FROM qc_reviews WHERE id=$1', [f.review.id])).rows[0]
      .outcome,
    'passed',
  );
});

test('approval: L2 takedown retains historical decisions, carries QC to L1 or requires a new QC cycle', async (t) => {
  const f = await fixture(t);
  const l2 = await f.account(['approver_l2']);
  await f.decide(f.l1, 'approve', { authorityId: f.l2.user.id });
  const final = await f.decide(f.l2, 'approve');
  const before = await f.get();
  assert.equal(
    (await f.decide(f.l1, 'take-down', { target: 'l1', reason: 'Review again' })).status,
    403,
  );
  assert.equal((await f.decide(l2, 'take-down', { target: 'l1', reason: ' ' })).status, 400);
  assert.equal(
    (await f.decide(l2, 'take-down', { target: 'l1', reason: 'Review again', version: 0 })).status,
    409,
  );
  assert.equal(
    (await f.decide(l2, 'take-down', { target: 'l1', reason: 'Policy needs another decision' }))
      .body.state,
    'awaiting_approval_l1',
  );
  const after = await f.get();
  assert.equal(after.document.revision, before.document.revision);
  assert.equal(after.document.review_cycle, before.document.review_cycle + 1);
  assert.equal(after.review.carried_from_review_id, f.review.id);
  assert.deepEqual(after.pages, before.pages);
  assert.deepEqual(after.metadata, before.metadata);
  assert.equal(after.history.length, 2);
  assert.equal(after.withdrawals.length, 1);
  assert.equal(after.document.published_at, null);
  assert.equal(after.document.published_by, null);
  const receipt = (await f.operator.request(`/api/confirmations/${final.body.confirmationId}`)).body
    .confirmation;
  assert.equal(receipt.current, false);
  assert.equal(receipt.published, false);
  assert.equal((await f.decide(f.l2, 'approve')).status, 403);
  assert.equal(
    (await f.decide(l2, 'take-down', { target: 'qc', reason: 'Again', reviewerId: f.qc.user.id }))
      .status,
    409,
  );
  await f.decide(f.l1, 'approve', { authorityId: f.l2.user.id });
  const republished = await f.decide(f.l2, 'approve');
  assert.equal(republished.body.state, 'approved');
  assert.notEqual(republished.body.confirmationId, final.body.confirmationId);
  const historical = (await f.operator.request(`/api/confirmations/${final.body.confirmationId}`))
    .body.confirmation;
  assert.equal(historical.current, false);
  assert.equal(historical.published, false);
  assert.equal(
    (
      await f.decide(l2, 'take-down', {
        target: 'qc',
        reason: 'Inspect pages again',
        reviewerId: f.qc.user.id,
      })
    ).body.state,
    'qc_waiting',
  );
  const review = (
    await f.pool.query(
      'SELECT * FROM qc_reviews WHERE document_id=$1 ORDER BY cycle DESC LIMIT 1',
      [f.doc.id],
    )
  ).rows[0];
  assert.equal(review.outcome, null);
  assert.equal(review.snapshot, null);
  assert.equal(review.carried_from_review_id, null);
  assert.equal(review.assigned_reviewer_id, f.qc.user.id);
  assert.equal(
    (await f.get()).document.approval_policy_version,
    before.document.approval_policy_version,
  );
  await assert.rejects(
    f.pool.query("UPDATE publication_withdrawals SET reason='rewrite'"),
    /append-only/,
  );
  const taker = await f.app.auth.user(l2.user.id);
  await f.app.admin.update(f.bootstrap.user, taker.id, {
    version: taker.version,
    roles: ['qc_officer'],
  });
  const asQc = await f.app.auth.user(taker.id);
  await assert.rejects(
    f.app.qc.claim(asQc, f.batch.id, { version: (await f.get()).document.version }),
    { code: 'self_approval' },
  );
});

test('approval: L1-only publication, whole-batch drop and historical officer independence', async (t) => {
  const single = await fixture(t, false);
  const final = await single.decide(single.l1, 'approve');
  assert.equal(final.body.state, 'approved');
  assert.equal(
    (await single.operator.request(`/api/confirmations/${final.body.confirmationId}`)).body
      .confirmation.final,
    true,
  );
  const f = await fixture(t);
  const first = await f.decide(f.l1, 'approve', { authorityId: f.l2.user.id });
  assert.equal(
    (await f.decide(f.l2, 'drop', { reason: 'Outside the retention scope' })).body.state,
    'dropped',
  );
  assert.equal((await f.operator.request('/api/records?view=published')).body.total, 0);
  assert.equal((await f.operator.request('/api/records?view=dropped')).body.total, 1);
  const receipt = (await f.operator.request(`/api/confirmations/${first.body.confirmationId}`)).body
    .confirmation;
  assert.equal(receipt.current, false);
  assert.equal(receipt.published, false);
  assert.equal(
    (await f.pool.query('SELECT deleted_at FROM archive_batches WHERE id=$1', [f.batch.id])).rows[0]
      .deleted_at,
    null,
  );
  assert.equal((await f.decide(f.l2, 'approve')).status, 409);
  await assert.rejects(
    f.pool.query("UPDATE documents SET title='rewritten' WHERE id=$1", [f.doc.id]),
  );
  const prior = await fixture(t);
  const qcUser = await prior.app.auth.user(prior.qc.user.id);
  await prior.app.admin.update(prior.bootstrap.user, qcUser.id, {
    version: qcUser.version,
    roles: ['approver_l1'],
  });
  const asL1 = await prior.app.auth.user(qcUser.id);
  await assert.rejects(
    prior.app.approval.decide(asL1, prior.batch.id, {
      action: 'approve',
      version: (await prior.get()).document.version,
      authorityId: prior.l2.user.id,
    }),
    { code: 'self_approval' },
  );
});

test('documents: private drafts, complete-result filters, paging and direct content authorization', async (t) => {
  const f = await fixture(t);
  const outsider = await f.account();
  const unsent = (await outsider.request('/api/batches', {})).body.batch;
  const foreignPage = await savedPage(f, unsent, outsider);
  assert.equal((await f.l1.request(`/api/records/${unsent.id}`)).status, 404);
  assert.equal((await f.qc.request(`/api/records/${unsent.id}`)).status, 404);
  assert.equal(
    (await f.operator.request(`/api/records/${unsent.id}/pages/${foreignPage.id}/image`)).status,
    404,
  );
  assert.equal(
    (await outsider.request(`/api/records/${unsent.id}/pages/${foreignPage.id}/image`)).status,
    200,
    'The denied foreign page actually exists and is readable to its owner',
  );
  assert.equal(
    (await f.l1.request(`/api/records/${unsent.id}/pages/${foreignPage.id}/text`)).status,
    404,
  );
  assert.equal((await f.admin.request(`/api/records/${unsent.id}`)).status, 200);
  assert.equal((await outsider.request('/api/records')).body.total, 1);
  const all = await f.admin.request('/api/records?limit=1&sort=title&direction=asc');
  assert.equal(all.body.total, 2);
  assert.equal(all.body.records.length, 1);
  const filtered = await f.admin.request(
    `/api/records?operator=${f.operator.user.id}&reviewer=${f.qc.user.id}&search=poc&type=letter&number=001&location=RACK`,
  );
  assert.equal(filtered.body.total, 1);
  assert.equal(filtered.body.records[0].id, f.batch.id);
  assert.equal(filtered.body.counts.all, 2);
  for (const query of [
    'sort=invalid',
    'direction=sideways',
    'from=2026-02-30',
    'from=2026-12-01&to=2026-01-01',
    'operator=invalid',
    `search=${'x'.repeat(241)}`,
    'status=invalid',
  ])
    assert.equal((await f.admin.request(`/api/records?${query}`)).status, 400);
  assert.equal((await f.operator.request('/api/records?view=l1')).status, 403);
});
