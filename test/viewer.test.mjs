import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { testApplication, until } from './support.mjs';
import { publicPage } from '../server/workflow.mjs';
import { parsePageSelection } from '../src/viewerPages.js';

const good = (result) => {
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body;
};
async function guest(f, route, body) {
  const response = await fetch(f.origin + route, {
    method: 'POST',
    headers: { Origin: f.origin, 'X-Scan-Request': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json(), response };
}

test('viewer page ranges: bounded, ordered, deduplicated and invalid selections rejected', () => {
  assert.deepEqual(parsePageSelection('1, 3, 8–12, 3, 10-11', 500), [1, 3, 8, 9, 10, 11, 12]);
  assert.equal(parsePageSelection('1-500', 500).length, 500);
  for (const value of ['', '0', '501', '5-1', '1,,2', '1.5', '1-999999999999', '-1', '1e2', 'x'])
    assert.throws(() => parsePageSelection(value, 500));
});

test('viewer registration: pending cannot sign in, only admin approves, no public role injection, disable revokes', async (t) => {
  const f = await testApplication(t);
  f.app.qc.refresh = async () => {};
  const username = `viewer-${randomUUID()}`,
    password = 'viewer-private-passphrase';
  const body = { username, displayName: 'Reader', password, confirmPassword: password };
  assert.equal(
    (await guest(f, '/api/auth/register', { ...body, roles: ['system_admin'] })).status,
    400,
  );
  assert.equal(
    (await guest(f, '/api/auth/register', { ...body, confirmPassword: 'different' })).status,
    400,
  );
  assert.equal(good(await guest(f, '/api/auth/register', body)).registrationStatus, 'pending');
  assert.equal((await guest(f, '/api/auth/register', body)).status, 409);
  const pending = good(await guest(f, '/api/auth/login', { username, password }));
  assert.equal(pending.registrationStatus, 'pending');
  assert.equal(pending.user, undefined);
  assert.equal(
    (
      await f.pool.query(
        'SELECT * FROM auth_sessions WHERE user_id=(SELECT id FROM users WHERE username=$1)',
        [username],
      )
    ).rowCount,
    0,
  );
  const applicant = good(await f.admin.request('/api/admin/viewer-registrations')).requests[0];
  const operator = await f.account();
  assert.equal(
    (
      await operator.request(`/api/admin/viewer-registrations/${applicant.id}`, {
        action: 'approve',
        version: applicant.version,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.admin.request(
        `/api/admin/users/${applicant.id}`,
        { version: applicant.version, isActive: true },
        'PATCH',
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await f.admin.request(`/api/admin/viewer-registrations/${applicant.id}`, {
        action: 'approve',
        version: 0,
      })
    ).status,
    409,
  );
  good(
    await f.admin.request(`/api/admin/viewer-registrations/${applicant.id}`, {
      action: 'approve',
      version: applicant.version,
    }),
  );
  assert.equal(
    (
      await f.admin.request(`/api/admin/viewer-registrations/${applicant.id}`, {
        action: 'reject',
        version: applicant.version,
      })
    ).status,
    409,
  );
  const reader = await f.client(username, password, false);
  const account = good(await reader.request('/api/auth/me')).user;
  assert.deepEqual(account.roles, ['archive_viewer']);
  assert.equal(account.must_change_password, false);
  assert.equal(good(await reader.request('/api/viewer/documents')).total, 0);
  for (const route of [
    '/api/records',
    '/api/qc/queue',
    '/api/admin/users',
    '/api/admin/audit-logs',
    '/api/admin/viewer-registrations',
  ])
    assert.equal((await reader.request(route)).status, 403);
  good(
    await f.admin.request(
      `/api/admin/users/${account.id}`,
      { version: account.version, isActive: false },
      'PATCH',
    ),
  );
  assert.equal((await reader.request('/api/viewer/documents')).status, 401);
  const actions = (
    await f.pool.query(
      'SELECT action FROM viewer_registration_audit WHERE subject_user_id=$1 ORDER BY sequence',
      [account.id],
    )
  ).rows.map((r) => r.action);
  assert.deepEqual(actions, [
    'viewer_registration.submitted',
    'viewer_registration.approved',
    'viewer_registration.disabled',
  ]);
  for (const table of [
    'viewer_registration_audit',
    'viewer_access_audit',
    'viewer_activity_audit',
  ]) {
    await assert.rejects(
      f.pool.query(
        `UPDATE ${table} SET action='changed' WHERE id=(SELECT id FROM ${table} LIMIT 1)`,
      ),
      /append-only/,
    );
  }
});

async function publication(f) {
  const op = await f.account(),
    qc = await f.account(['qc_officer']),
    l1 = await f.account(['approver_l1']);
  const batch = good(await op.request('/api/batches', {})).batch;
  await f.pool.query("UPDATE archive_batches SET status='capture_completed' WHERE id=$1", [
    batch.id,
  ]);
  const doc = (
    await f.pool.query(
      `UPDATE documents SET workflow_status='qc_in_review',review_cycle=1,approval_l2_required=false,
    approval_policy_version=1,title='Published agreement',archive_number='ARCH/001',document_type='Agreement' WHERE batch_id=$1 RETURNING *`,
      [batch.id],
    )
  ).rows[0];
  const session = (
    await f.pool.query(
      "INSERT INTO scan_sessions(batch_id,document_id,session_number,status,created_by,scanner_mode,job_id) VALUES($1,$2,1,'completed',$3,'simulator',$4) RETURNING *",
      [batch.id, doc.id, op.user.id, randomUUID()],
    )
  ).rows[0];
  const pages = [];
  for (let n = 1; n <= 3; n++) {
    const image = await f.app.storage.finalize(
      session,
      n,
      path.resolve('fixtures/basic'),
      `page-00${n}.png`,
    );
    const page = (
      await f.pool.query(
        `INSERT INTO pages(batch_id,document_id,scan_session_id,capture_order,display_order,original_storage_key,active_storage_key,mime_type,byte_size,sha256,width_px,height_px,source)
      VALUES($1,$2,$3,$4,$4,$5,$5,'image/png',$6,$7,$8,$9,'simulator') RETURNING id`,
        [
          batch.id,
          doc.id,
          session.id,
          n,
          image.key,
          image.byteSize,
          image.sha256,
          image.width,
          image.height,
        ],
      )
    ).rows[0];
    pages.push(
      publicPage(
        (await f.pool.query('SELECT * FROM document_pages WHERE id=$1', [page.id])).rows[0],
      ),
    );
  }
  await f.pool.query(
    `INSERT INTO qc_reviews(document_id,cycle,outcome,decided_by,decided_at,reviewed_revision,snapshot,submitted_at)
    VALUES($1,1,'passed',$2,now(),$3,$4,now())`,
    [
      doc.id,
      qc.user.id,
      doc.revision,
      JSON.stringify({
        revision: doc.revision,
        metadata: {
          fields: [
            {
              type: 'date',
              value: '1 November 2026',
              normalized: '2026-11-01',
              context: 'Document date',
              verifiedBy: qc.user.id,
            },
            {
              type: 'company',
              value: 'Example Company',
              context: 'Issuer',
              editedBy: op.user.id,
              candidates: [{ value: 'Internal suggestion' }],
            },
            { type: 'physical_location', value: 'Internal shelf' },
          ],
        },
        pages,
        ocr: [],
        findings: [],
      }),
    ],
  );
  await f.pool.query("UPDATE documents SET workflow_status='awaiting_approval_l1' WHERE id=$1", [
    doc.id,
  ]);
  const current = good(await l1.request(`/api/records/${batch.id}`));
  good(
    await l1.request(`/api/records/${batch.id}/decision`, {
      version: current.document.version,
      action: 'approve',
    }),
  );
  return { batch, doc, pages, op, qc, l1 };
}

test('viewer: publication-only safe metadata/images, isolated tabs and audited PDF selections', async (t) => {
  const f = await testApplication(t);
  f.app.qc.refresh = async () => {};
  const reader = await f.account(['archive_viewer']),
    other = await f.account(['archive_viewer']);
  const p = await publication(f);
  const unsent = good(await p.op.request('/api/batches', {})).batch;
  const list = good(await reader.request('/api/viewer/documents'));
  assert.equal(list.total, 1);
  assert.deepEqual(
    Object.keys(list.records[0]).sort(),
    [
      'document_id',
      'id',
      'title',
      'archive_number',
      'document_type',
      'document_date',
      'published_at',
      'revision',
      'page_count',
      'cover_page_id',
      'cover_rotation',
    ].sort(),
  );
  const detail = good(await reader.request(`/api/viewer/documents/${p.batch.id}`));
  assert.deepEqual(Object.keys(detail).sort(), ['document', 'metadata', 'pages']);
  assert.equal(list.records[0].document_date, '2026-11-01');
  assert.deepEqual(detail.metadata, [
    { type: 'date', value: '1 November 2026', context: 'Document date' },
    { type: 'company', value: 'Example Company', context: 'Issuer' },
  ]);
  assert.ok(!Object.hasOwn(detail.document, 'publication_id'));
  assert.equal(list.records[0].cover_page_id, p.pages[0].id);
  assert.equal(list.records[0].cover_rotation, p.pages[0].rotation_degrees || 0);
  assert.deepEqual(Object.keys(detail.pages[0]).sort(), ['id', 'number', 'rotation']);
  assert.equal((await reader.request(`/api/viewer/documents/${unsent.id}`)).status, 404);
  const base = `/api/viewer/documents/${p.batch.id}`;
  assert.equal((await reader.request(`${base}/pages/${p.pages[0].id}/preview`)).status, 200);
  assert.equal((await reader.request(`${base}/pages/${randomUUID()}/image`)).status, 404);
  assert.equal((await reader.request(`${base}/pages/${p.pages[0].id}/text`)).status, 404);
  assert.equal((await reader.request(`/api/pages/${p.pages[0].id}/image`)).status, 403);
  assert.equal(
    (
      await reader.request(`${base}/downloads`, {
        revision: p.doc.revision,
        selection: 'selected',
        range: '0',
      })
    ).status,
    400,
  );
  assert.equal(
    (await reader.request(`${base}/downloads`, { revision: 0, selection: 'all' })).status,
    409,
  );
  for (const [selection, extra, count] of [
    ['current', { currentPage: 2 }, 1],
    ['selected', { range: '1,3' }, 2],
    ['all', {}, 3],
  ]) {
    const job = good(
      await reader.request(`${base}/downloads`, { revision: p.doc.revision, selection, ...extra }),
    );
    assert.equal((await other.request(`/api/viewer/downloads/${job.id}`)).status, 404);
    const ready = await until(async () => {
      const value = good(await reader.request(`/api/viewer/downloads/${job.id}`));
      assert.notEqual(value.status, 'failed', value.error);
      return value.status === 'ready' && value;
    });
    assert.equal(ready.total, count);
    assert.equal((await reader.request(`/api/viewer/downloads/${job.id}/file`)).status, 404);
    assert.equal((await reader.request(`/api/viewer/downloads/${job.id}/transfer`)).status, 404);
    assert.equal(
      (
        await reader.request(`/api/viewer/downloads/${job.id}/transfer`, {}, 'POST', {
          'X-CSRF-Token': '',
        })
      ).status,
      403,
    );
    const result = await reader.request(`/api/viewer/downloads/${job.id}/transfer`, {});
    assert.equal(result.status, 200);
    assert.equal(
      result.response.headers.get('content-type'),
      'application/vnd.digitalarch.transfer',
    );
    assert.equal(result.response.headers.get('content-disposition'), null);
    const pdf = Buffer.concat(
      (await result.response.text())
        .trim()
        .split('\n')
        .map((line) => Buffer.from(JSON.parse(line).data, 'base64')),
    );
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
    assert.equal((pdf.toString('latin1').match(/\/Type \/Page\b/g) || []).length, count);
    assert.ok(!pdf.includes(Buffer.from(p.op.user.display_name)));
    await until(
      async () =>
        (
          await f.pool.query(
            "SELECT 1 FROM viewer_download_audit WHERE download_id=$1 AND action='viewer_download.delivered'",
            [job.id],
          )
        ).rowCount,
    );
    const audit = (
      await f.pool.query(
        "SELECT metadata FROM viewer_download_audit WHERE download_id=$1 AND action='viewer_download.requested'",
        [job.id],
      )
    ).rows[0].metadata;
    assert.equal(audit.pages.length, count);
    assert.equal(audit.selection, selection);
    assert.equal(audit.pages[0].id, p.pages[selection === 'current' ? 1 : 0].id);
  }
  const events = good(await f.admin.request('/api/admin/audit-logs?category=viewer_download'));
  assert.equal(events.total, 12);
  await assert.rejects(
    f.pool.query("UPDATE viewer_download_audit SET action='changed'"),
    /append-only/,
  );
  const failed = good(
    await reader.request(`${base}/downloads`, { revision: p.doc.revision, selection: 'all' }),
  );
  const l2 = await f.account(['approver_l2']);
  const record = good(await l2.request(`/api/records/${p.batch.id}`));
  good(
    await l2.request(`/api/records/${p.batch.id}/decision`, {
      action: 'take-down',
      version: record.document.version,
      target: 'l1',
      reason: 'Publication requires another approval review',
    }),
  );
  assert.equal(good(await reader.request('/api/viewer/documents')).total, 0);
  assert.equal((await reader.request(`${base}/pages/${p.pages[0].id}/preview`)).status, 404);
  assert.equal(
    (await reader.request(`/api/viewer/downloads/${failed.id}/transfer`, {})).status,
    404,
  );
  const again = good(await p.l1.request(`/api/records/${p.batch.id}`));
  good(
    await p.l1.request(`/api/records/${p.batch.id}/decision`, {
      action: 'approve',
      version: again.document.version,
    }),
  );
  assert.equal(good(await reader.request('/api/viewer/documents')).total, 1);
  assert.equal(
    (await reader.request(`/api/viewer/downloads/${failed.id}/transfer`, {})).status,
    409,
  );
});
