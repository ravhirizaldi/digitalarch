import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, symlink, chmod, unlink } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { migrate, database } from '../server/db.mjs';
import { createRuntimeService } from '../server.mjs';
import { batchCode } from '../server/batches.mjs';
import { captureStorage } from '../server/capture-storage.mjs';
import { testApplication, scanned, until } from './support.mjs';

test('database: vector, migration idempotency, UUID relationships, constraints, nonunique locations', async (t) => {
  const f = await testApplication(t);
  assert.equal(
    (await f.pool.query("SELECT extversion FROM pg_extension WHERE extname='vector'")).rowCount,
    1,
  );
  await migrate(f.pool);
  await migrate(f.pool);
  assert.equal((await f.pool.query('SELECT * FROM schema_migrations')).rowCount, 11);
  const operator = await f.account();
  const a = (await operator.request('/api/batches', { physicalLocation: 'Rack A-12' })).body;
  const b = (await operator.request('/api/batches', { physicalLocation: 'Rack A-12' })).body;
  assert.notEqual(a.batch.id, b.batch.id);
  assert.notEqual(a.batch.batch_code, b.batch.batch_code);
  assert.equal(a.batch.physical_location, b.batch.physical_location);
  assert.match(batchCode(new Date('2026-11-13T04:02:05Z')), /^B-20261113-110205-[A-F0-9]{8}$/);
  const docs = (await f.pool.query('SELECT * FROM documents WHERE batch_id=$1', [a.batch.id])).rows;
  assert.equal(docs.length, 1);
  assert.equal(docs[0].title, null);
  assert.equal(docs[0].metadata_status, 'not_extracted');
  await f.pool.query('INSERT INTO documents(batch_id,document_index) VALUES($1,2)', [a.batch.id]);
  await assert.rejects(
    f.pool.query('INSERT INTO documents(batch_id,document_index) VALUES($1,1)', [randomUUID()]),
    { code: '23503' },
  );
  await assert.rejects(
    f.pool.query('UPDATE archive_batches SET batch_code=$1 WHERE id=$2', [
      a.batch.batch_code,
      b.batch.id,
    ]),
    { code: '23505' },
  );
});

test('batch lists sort the full owned result and return filtered counters', async (t) => {
  const f = await testApplication(t);
  const operator = await f.account();
  const other = await f.account();
  const z = (await operator.request('/api/batches', { physicalLocation: 'Rack Z' })).body.batch;
  const a = (await operator.request('/api/batches', { physicalLocation: 'Rack A' })).body.batch;
  await other.request('/api/batches', { physicalLocation: 'Rack A' });
  const first = await operator.request('/api/batches?sort=physical_location&direction=asc&limit=1');
  assert.equal(first.status, 200);
  assert.equal(first.body.total, 2);
  assert.equal(first.body.pages, 0);
  assert.equal(first.body.sessions, 0);
  assert.equal(first.body.batches[0].id, a.id);
  assert.equal(
    (await operator.request('/api/batches?sort=physical_location&direction=asc&limit=1&offset=1'))
      .body.batches[0].id,
    z.id,
  );
  const filtered = await operator.request('/api/batches?search=Rack%20Z');
  assert.equal(filtered.body.total, 1);
  assert.equal(filtered.body.batches[0].id, z.id);
  assert.equal(
    (await operator.request('/api/batches?sort=updated_at%3BDROP%20TABLE%20archive_batches'))
      .status,
    400,
  );
  assert.equal((await operator.request('/api/batches?direction=sideways')).status, 400);
});

test('authentication: bootstrap once, Argon2id, forced change, cookies, CSRF, logout and revoked/expired/disabled sessions', async (t) => {
  const f = await testApplication(t);
  await assert.rejects(
    f.app.admin.create(
      null,
      { username: 'another-admin', displayName: 'Other', roles: ['system_admin'] },
      true,
    ),
    { code: 'already_bootstrapped' },
  );
  const created = await f.app.admin.create(f.bootstrap.user, {
    username: 'Case.User',
    displayName: 'Case User',
    roles: ['operator'],
  });
  const raw = (await f.pool.query('SELECT password_hash FROM users WHERE id=$1', [created.user.id]))
    .rows[0];
  assert.match(raw.password_hash, /^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
  assert.ok(!JSON.stringify(created.user).includes('password_hash'));
  const operator = await f.client('case.USER', created.temporaryPassword, false);
  assert.equal(operator.login.body.user.must_change_password, true);
  const cookie = operator.login.response.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.equal((await operator.request('/api/batches', {})).body.code, 'password_change_required');
  assert.equal(
    (
      await operator.request(
        '/api/auth/change-password',
        { currentPassword: created.temporaryPassword, newPassword: 'test-secure-passphrase' },
        'POST',
        { 'X-CSRF-Token': '' },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await operator.request('/api/auth/change-password', {
        currentPassword: 'wrong',
        newPassword: 'test-secure-passphrase',
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await operator.request('/api/auth/change-password', {
        currentPassword: created.temporaryPassword,
        newPassword: 'test-secure-passphrase',
      })
    ).status,
    200,
  );
  const hashedSession = (
    await f.pool.query(
      'SELECT token_hash FROM auth_sessions WHERE user_id=$1 AND revoked_at IS NULL',
      [created.user.id],
    )
  ).rows[0].token_hash;
  assert.notEqual(hashedSession, operator.cookie.split('=')[1]);
  assert.equal((await operator.request('/api/auth/logout', {})).status, 200);
  assert.equal((await operator.request('/api/auth/me')).status, 401);
  const session = await f.client('case.user', 'test-secure-passphrase', false);
  await f.pool.query(
    "UPDATE auth_sessions SET created_at=now()-interval '2 hours',expires_at=now()-interval '1 hour' WHERE user_id=$1 AND revoked_at IS NULL",
    [created.user.id],
  );
  assert.equal((await session.request('/api/auth/me')).status, 401);
  const disabled = await f.client('case.user', 'test-secure-passphrase', false);
  await f.app.admin.update(f.bootstrap.user, created.user.id, {
    version: (await f.app.auth.user(created.user.id)).version,
    isActive: false,
  });
  assert.equal((await disabled.request('/api/auth/me')).status, 401);
  const response = await fetch(f.origin + '/api/auth/login', {
    method: 'POST',
    headers: { Origin: f.origin, 'X-Scan-Request': '1' },
    body: JSON.stringify({ username: 'Case.User', password: 'test-secure-passphrase' }),
  });
  assert.equal(response.status, 401);
  for (let i = 0; i < 6; i++) {
    const bad = await fetch(f.origin + '/api/auth/login', {
      method: 'POST',
      headers: { Origin: f.origin, 'X-Scan-Request': '1' },
      body: JSON.stringify({ username: 'unknown', password: 'invalid-password' }),
    });
    assert.equal(bad.status, i === 5 ? 429 : 401);
  }
});

test('RBAC: all six roles, admin separation, cross-owner access, role policy and administration safeguards', async (t) => {
  const f = await testApplication(t);
  const operator = await f.account();
  const other = await f.account();
  const batch = (await operator.request('/api/batches', {})).body.batch;
  assert.equal((await other.request(`/api/batches/${batch.id}`)).status, 403);
  assert.equal(
    (await other.request(`/api/batches/${batch.id}/resume`, { version: batch.version })).status,
    403,
  );
  assert.equal((await operator.request('/api/admin/users')).status, 403);
  assert.equal(
    (
      await operator.request(
        `/api/admin/users/${other.user.id}`,
        { version: other.user.version, roles: ['system_admin'] },
        'PATCH',
      )
    ).status,
    403,
  );
  assert.equal((await f.admin.request('/api/batches', {})).status, 403);
  assert.equal((await f.admin.request('/api/scanner/status')).status, 403);
  assert.equal((await f.admin.request('/api/batches')).status, 200);
  for (const [role, permission] of [
    ['qc_officer', 'qc:review'],
    ['approver_l1', 'approval_l1:approve'],
    ['approver_l2', 'approval_l2:approve'],
    ['archive_viewer', 'archive:read'],
  ]) {
    const account = await f.account([role]);
    assert.ok(account.user.permissions.includes(permission));
    assert.equal((await account.request('/api/batches', {})).status, 403);
    assert.equal((await account.request('/api/admin/users')).status, 403);
    assert.equal((await account.request('/api/auth/me')).status, 200);
  }
  await assert.rejects(
    f.app.admin.create(f.bootstrap.user, {
      username: 'bad-role',
      displayName: 'Bad',
      roles: ['operator', 'approver_l1'],
    }),
    { code: 'separation_of_duties' },
  );
  await assert.rejects(
    f.app.admin.create(f.bootstrap.user, {
      username: 'bad-role',
      displayName: 'Bad',
      roles: ['approver_l1', 'approver_l2'],
    }),
    { code: 'separation_of_duties' },
  );
  const adminUser = await f.app.auth.user(f.bootstrap.user.id);
  assert.equal(
    (
      await f.admin.request(
        `/api/admin/users/${adminUser.id}`,
        { version: adminUser.version, isActive: false },
        'PATCH',
      )
    ).body.code,
    'own_admin_access',
  );
  assert.equal(
    (
      await f.admin.request(
        `/api/admin/users/${adminUser.id}`,
        { version: adminUser.version, roles: ['operator'] },
        'PATCH',
      )
    ).status,
    409,
  );
  await assert.rejects(
    f.app.admin.update({ id: operator.user.id }, adminUser.id, {
      version: adminUser.version,
      isActive: false,
    }),
    { code: 'last_admin' },
  );
  const reassigned = await f.admin.request(`/api/batches/${batch.id}/reassign`, {
    version: batch.version,
    operatorId: other.user.id,
  });
  assert.equal(reassigned.status, 200);
  assert.equal((await operator.request(`/api/batches/${batch.id}`)).status, 403);
  assert.equal((await other.request(`/api/batches/${batch.id}`)).status, 200);
  const reset = await f.admin.request(`/api/admin/users/${other.user.id}/reset-password`, {});
  assert.ok(reset.body.temporaryPassword);
  assert.equal((await other.request('/api/auth/me')).status, 401);
  const logs = await f.admin.request('/api/admin/audit-logs');
  assert.ok(logs.body.logs.some((log) => log.action === 'batch.reassigned'));
  assert.ok(!JSON.stringify(logs.body).includes(reset.body.temporaryPassword));
});

test('batch lifecycle: multiple sessions, feeder order, pause/resume/switch, completion lock, originals and revisions', async (t) => {
  const f = await testApplication(t);
  const operator = await f.account();
  let a = (await operator.request('/api/batches', {})).body;
  assert.equal(a.batch.physical_location, null);
  assert.equal(
    (
      await operator.request(`/api/batches/${a.batch.id}/complete-capture`, {
        version: a.batch.version,
      })
    ).body.code,
    'empty_batch',
  );
  a = await scanned(operator, a.batch);
  assert.equal(a.pages.length, 3);
  assert.equal(a.sessions[0].session_number, 1);
  assert.equal(a.sessions[0].status, 'completed');
  const first = a.pages[0];
  const bytes = await readFile(path.join(f.app.storage.root, first.original_storage_key));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), first.sha256);
  assert.deepEqual(
    a.pages.map((page) => page.capture_order),
    [1, 2, 3],
  );
  for (const page of a.pages) {
    assert.equal(page.batch_id, a.batch.id);
    assert.equal(page.scan_session_id, a.sessions[0].id);
    assert.equal(page.source, 'simulator');
    assert.equal(page.original_storage_key, page.active_storage_key);
    assert.ok(page.width_px && page.height_px);
  }
  assert.equal((await operator.request(`/api/pages/${first.id}/image`)).status, 200);
  assert.equal((await operator.request(`/api/pages/${first.id}/thumbnail`)).status, 200);
  const other = await f.account();
  assert.equal((await other.request(`/api/pages/${first.id}/image`)).status, 403);
  a = (await operator.request(`/api/batches/${a.batch.id}/pause`, { version: a.batch.version }))
    .body;
  assert.equal(a.batch.status, 'paused');
  assert.equal(
    (
      await operator.request(`/api/batches/${a.batch.id}/scan-sessions`, {
        version: a.batch.version,
        options: { scenario: 'single', pageDelay: 0 },
      })
    ).status,
    409,
  );
  let b = (await operator.request('/api/batches', {})).body;
  b = await scanned(operator, b.batch, { scenario: 'single', pageDelay: 0 });
  assert.equal(b.pages.length, 1);
  a = (await operator.request(`/api/batches/${a.batch.id}/resume`, { version: a.batch.version }))
    .body;
  a = await scanned(operator, a.batch);
  assert.equal(a.pages.length, 6);
  assert.deepEqual(
    a.sessions.map((session) => session.session_number),
    [1, 2],
  );
  assert.deepEqual(
    a.pages.map((page) => page.capture_order),
    [1, 2, 3, 4, 5, 6],
  );
  assert.equal(new Set(a.pages.map((page) => page.id)).size, 6);
  assert.equal(
    (await operator.request(`/api/batches/${a.batch.id}/cancel`, { version: a.batch.version })).body
      .code,
    'has_pages',
  );
  a = (
    await operator.request(`/api/batches/${a.batch.id}/complete-capture`, {
      version: a.batch.version,
    })
  ).body;
  assert.equal(a.batch.status, 'capture_completed');
  assert.ok(a.batch.capture_completed_at);
  for (const operation of ['resume', 'pause', 'scan-sessions'])
    assert.equal(
      (
        await operator.request(`/api/batches/${a.batch.id}/${operation}`, {
          version: a.batch.version,
        })
      ).status,
      409,
    );
  assert.equal(
    (
      await operator.request(
        `/api/batches/${a.batch.id}`,
        { version: a.batch.version, physicalLocation: 'changed' },
        'PATCH',
      )
    ).status,
    409,
  );
  await assert.rejects(
    f.pool.query('UPDATE pages SET original_storage_key=$2 WHERE id=$1', [first.id, 'changed']),
    /immutable/,
  );
  await assert.rejects(
    f.pool.query('DELETE FROM pages WHERE id=$1', [first.id]),
    /cannot be deleted/,
  );
  assert.deepEqual(
    await readFile(path.join(f.app.storage.root, first.original_storage_key)),
    bytes,
  );
  const documentB = (await f.pool.query('SELECT id FROM documents WHERE batch_id=$1', [b.batch.id]))
    .rows[0].id;
  await assert.rejects(
    f.pool.query('UPDATE pages SET document_id=$2 WHERE id=$1', [first.id, documentB]),
  );
  const empty = (await operator.request('/api/batches', {})).body.batch;
  assert.equal(
    (await operator.request(`/api/batches/${empty.id}/cancel`, { version: empty.version })).body
      .batch.status,
    'cancelled',
  );
});

test('batch deletion: own paused batch leaves lists and APIs while originals, metadata and audit remain', async (t) => {
  const f = await testApplication(t);
  const operator = await f.account();
  let result = (await operator.request('/api/batches', {})).body;
  result = await scanned(operator, result.batch);
  result = (
    await operator.request(`/api/batches/${result.batch.id}/pause`, {
      version: result.batch.version,
    })
  ).body;
  const batch = result.batch;
  const first = result.pages[0];
  const filename = path.join(f.app.storage.root, first.original_storage_key);
  const original = await readFile(filename);
  const deleted = await operator.request(`/api/batches/${batch.id}/delete`, {
    version: batch.version,
  });
  assert.equal(deleted.status, 200);
  assert.deepEqual(deleted.body, { deleted: true, batchId: batch.id });
  for (const account of [operator, f.admin]) {
    assert.equal((await account.request(`/api/batches/${batch.id}`)).status, 404);
    assert.equal(
      (await account.request(`/api/batches?status=paused&search=${batch.batch_code}`)).body.total,
      0,
    );
    assert.equal((await account.request(`/api/pages/${first.id}/image`)).status, 404);
  }
  for (const suffix of ['pages', 'scan-sessions'])
    assert.equal((await operator.request(`/api/batches/${batch.id}/${suffix}`)).status, 404);
  for (const operation of ['resume', 'scan-sessions', 'delete'])
    assert.equal(
      (
        await operator.request(`/api/batches/${batch.id}/${operation}`, {
          version: batch.version + 1,
        })
      ).status,
      404,
    );
  assert.equal(
    (
      await operator.request(
        `/api/pages/${first.id}`,
        { version: batch.version + 1, action: 'rotate-right' },
        'PATCH',
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await f.admin.request(`/api/batches/${batch.id}/reassign`, {
        version: batch.version + 1,
        operatorId: operator.user.id,
      })
    ).status,
    404,
  );
  const stored = (await f.pool.query('SELECT * FROM archive_batches WHERE id=$1', [batch.id]))
    .rows[0];
  assert.ok(stored.deleted_at);
  assert.equal(stored.deleted_by, operator.user.id);
  assert.equal(stored.status, 'paused');
  assert.equal(stored.version, batch.version + 1);
  assert.equal(
    (await f.pool.query('SELECT * FROM pages WHERE batch_id=$1', [batch.id])).rowCount,
    3,
  );
  assert.equal(
    (await f.pool.query('SELECT * FROM documents WHERE batch_id=$1', [batch.id])).rowCount,
    1,
  );
  assert.equal(
    (await f.pool.query('SELECT * FROM scan_sessions WHERE batch_id=$1', [batch.id])).rowCount,
    1,
  );
  assert.deepEqual(await readFile(filename), original);
  const logs = (
    await f.pool.query("SELECT * FROM audit_logs WHERE batch_id=$1 AND action='batch.deleted'", [
      batch.id,
    ])
  ).rows;
  assert.equal(logs.length, 1);
  assert.equal(logs[0].actor_id, operator.user.id);
  assert.equal(logs[0].metadata.originalsRetained, true);
  await f.app.batches.reconcile(result.sessions[0], true);
  assert.equal(
    (await f.pool.query('SELECT version FROM archive_batches WHERE id=$1', [batch.id])).rows[0]
      .version,
    stored.version,
  );
});

test('batch deletion: ownership, permissions, CSRF, stale versions and running-session guards', async (t) => {
  const f = await testApplication(t);
  const operator = await f.account();
  const other = await f.account();
  const batch = (await operator.request('/api/batches', {})).body.batch;
  const route = `/api/batches/${batch.id}/delete`;
  const body = { version: batch.version };
  assert.equal((await other.request(route, body)).status, 403);
  assert.equal((await f.admin.request(route, body)).status, 403);
  assert.equal((await operator.request(route, body, 'POST', { 'X-CSRF-Token': '' })).status, 403);
  assert.equal((await operator.request(route, { version: batch.version - 1 })).status, 409);
  assert.equal((await operator.request(route, { ...body, removeFiles: true })).status, 400);
  assert.equal((await operator.request('/api/batches/invalid/delete', body)).status, 400);
  assert.equal((await operator.request(`/api/batches/${randomUUID()}/delete`, body)).status, 404);
  const started = await operator.request(`/api/batches/${batch.id}/scan-sessions`, {
    version: batch.version,
    options: { scenario: 'multi', pageDelay: 150 },
  });
  assert.equal(started.status, 200);
  assert.equal(
    (await operator.request(route, { version: started.body.batch.version })).body.code,
    'session_running',
  );
  const finished = await until(async () => {
    const current = (await operator.request(`/api/batches/${batch.id}`)).body;
    return current.sessions[0].status === 'completed' ? current : null;
  });
  assert.equal(
    (await operator.request(route, { version: started.body.batch.version })).status,
    409,
  );
  const completed = (
    await operator.request(`/api/batches/${batch.id}/complete-capture`, {
      version: finished.batch.version,
    })
  ).body.batch;
  const locked = await operator.request(route, { version: completed.version });
  assert.equal(locked.status, 409);
  assert.equal(locked.body.code, 'batch_locked');
  assert.equal((await operator.request(`/api/batches/${batch.id}`)).status, 200);
  const stored = (
    await f.pool.query('SELECT deleted_at,version FROM archive_batches WHERE id=$1', [batch.id])
  ).rows[0];
  assert.equal(stored.deleted_at, null);
  assert.equal(stored.version, completed.version);
  assert.equal(
    (
      await f.pool.query("SELECT 1 FROM audit_logs WHERE batch_id=$1 AND action='batch.deleted'", [
        batch.id,
      ])
    ).rowCount,
    0,
  );
  const draft = (await operator.request('/api/batches', {})).body.batch;
  assert.equal(
    (await operator.request(`/api/batches/${draft.id}/delete`, { version: draft.version })).status,
    200,
  );
  const empty = (await operator.request('/api/batches', {})).body.batch;
  const paused = (
    await operator.request(`/api/batches/${empty.id}/pause`, { version: empty.version })
  ).body.batch;
  const results = await Promise.all(
    [1, 2].map(() =>
      operator.request(`/api/batches/${empty.id}/delete`, { version: paused.version }),
    ),
  );
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 404]);
});

test('page corrections: persistent rotation, recoverable removal, accurate counts, undo and immutable originals', async (t) => {
  const f = await testApplication(t);
  const operator = await f.account();
  let result = (await operator.request('/api/batches', {})).body;
  result = await scanned(operator, result.batch);
  const first = result.pages[0];
  const original = await readFile(path.join(f.app.storage.root, first.original_storage_key));
  const edit = async (id, action) => {
    const response = await operator.request(
      `/api/pages/${id}`,
      { version: result.batch.version, action },
      'PATCH',
    );
    assert.equal(response.status, 200, JSON.stringify(response.body));
    result = response.body;
    return result.pages.find((page) => page.id === id);
  };
  for (const rotation of [90, 180, 270, 0])
    assert.equal((await edit(first.id, 'rotate-right')).rotation_degrees, rotation);
  assert.equal((await edit(first.id, 'rotate-left')).rotation_degrees, 270);
  const competing = await Promise.all(
    ['rotate-left', 'rotate-right'].map((action) =>
      operator.request(
        `/api/pages/${first.id}`,
        { version: result.batch.version, action },
        'PATCH',
      ),
    ),
  );
  assert.deepEqual(competing.map((response) => response.status).sort(), [200, 409]);
  result = (await operator.request(`/api/batches/${result.batch.id}`)).body;
  const rotation = result.pages[0].rotation_degrees;
  assert.equal((await edit(first.id, 'remove')).is_excluded, true);
  assert.equal(result.batch.page_count, 2);
  assert.equal(result.pages.length, 3);
  assert.equal(
    result.sessions[0].page_count,
    3,
    'Capture provenance retains the actual feeder count',
  );
  assert.equal(
    (await operator.request(`/api/batches?status=in_progress`)).body.batches[0].page_count,
    2,
  );
  assert.equal(
    (
      await operator.request(
        `/api/pages/${first.id}`,
        { version: result.batch.version, action: 'rotate-right' },
        'PATCH',
      )
    ).body.code,
    'page_removed',
  );
  const persisted = (
    await operator.request(`/api/batches/${result.batch.id}/pages`)
  ).body.pages.find((page) => page.id === first.id);
  assert.equal(persisted.is_excluded, true);
  assert.equal(persisted.rotation_degrees, rotation);
  const image = await operator.request(`/api/pages/${first.id}/image`);
  assert.equal(image.status, 200);
  assert.deepEqual(Buffer.from(await image.response.arrayBuffer()), original);
  assert.equal((await edit(first.id, 'restore')).is_excluded, false);
  assert.equal(result.batch.page_count, 3);
  for (const page of result.pages) await edit(page.id, 'remove');
  assert.equal(result.batch.page_count, 0);
  assert.equal(
    (
      await operator.request(`/api/batches/${result.batch.id}/complete-capture`, {
        version: result.batch.version,
      })
    ).body.code,
    'empty_batch',
  );
  assert.equal(
    (
      await operator.request(`/api/batches/${result.batch.id}/cancel`, {
        version: result.batch.version,
      })
    ).body.code,
    'has_pages',
  );
  await edit(first.id, 'restore');
  const page = result.pages.find((page) => page.id === first.id);
  for (const field of [
    'sha256',
    'original_storage_key',
    'active_storage_key',
    'capture_order',
    'byte_size',
    'source',
  ])
    assert.equal(page[field], first[field]);
  assert.deepEqual(
    await readFile(path.join(f.app.storage.root, first.original_storage_key)),
    original,
  );
  const logs = (
    await f.pool.query(
      "SELECT action FROM audit_logs WHERE entity_id=$1 AND action LIKE 'page.%' ORDER BY created_at",
      [first.id],
    )
  ).rows;
  assert.ok(logs.some((log) => log.action === 'page.rotated'));
  assert.ok(logs.some((log) => log.action === 'page.removed'));
  assert.equal(logs.at(-1).action, 'page.restored');
  const completed = await operator.request(`/api/batches/${result.batch.id}/complete-capture`, {
    version: result.batch.version,
  });
  assert.equal(completed.status, 200);
  assert.equal(completed.body.batch.page_count, 1);
  for (const action of ['rotate-left', 'rotate-right', 'remove', 'restore'])
    assert.equal(
      (
        await operator.request(
          `/api/pages/${first.id}`,
          { version: completed.body.batch.version, action },
          'PATCH',
        )
      ).body.code,
      'batch_locked',
    );
});

test('page corrections: owner permissions, CSRF, validation and active-capture guards', async (t) => {
  const f = await testApplication(t);
  const operator = await f.account();
  const other = await f.account();
  const qc = await f.account(['qc_officer']);
  let result = (await operator.request('/api/batches', {})).body;
  result = await scanned(operator, result.batch, { scenario: 'single', pageDelay: 0 });
  const route = `/api/pages/${result.pages[0].id}`;
  const body = { version: result.batch.version, action: 'remove' };
  for (const account of [other, qc, f.admin])
    assert.equal((await account.request(route, body, 'PATCH')).status, 403);
  assert.equal((await operator.request(route, body, 'PATCH', { 'X-CSRF-Token': '' })).status, 403);
  assert.equal(
    (
      await fetch(f.origin + route, {
        method: 'PATCH',
        headers: { Origin: f.origin, 'X-Scan-Request': '1' },
        body: '{}',
      })
    ).status,
    401,
  );
  for (const action of ['delete', 'rotate', null, 90, {}, []])
    assert.equal((await operator.request(route, { ...body, action }, 'PATCH')).status, 400);
  assert.equal(
    (await operator.request(route, { ...body, original_storage_key: 'replacement.png' }, 'PATCH'))
      .status,
    400,
  );
  assert.equal((await operator.request(route, { action: 'remove' }, 'PATCH')).status, 409);
  assert.equal((await operator.request('/api/pages/invalid', body, 'PATCH')).status, 400);
  assert.equal((await operator.request(`/api/pages/${randomUUID()}`, body, 'PATCH')).status, 404);
  const started = await operator.request(`/api/batches/${result.batch.id}/scan-sessions`, {
    version: result.batch.version,
    options: { scenario: 'multi', pageDelay: 200 },
  });
  assert.equal(started.status, 200);
  assert.equal(
    (await operator.request(route, { ...body, version: started.body.batch.version }, 'PATCH')).body
      .code,
    'session_running',
  );
  await until(
    async () =>
      !(await operator.request(`/api/batches/${result.batch.id}`)).body.sessions.some(
        (session) => session.status === 'running',
      ),
  );
});

test('history deep links: fresh HTTP loads retain running capture, persistence and security', async (t) => {
  const f = await testApplication(t);
  const operator = await f.account();
  const batch = (await operator.request('/api/batches', {})).body.batch;
  const started = await operator.request(`/api/batches/${batch.id}/scan-sessions`, {
    version: batch.version,
    options: { scenario: 'duplex', pageDelay: 150 },
  });
  assert.equal(started.status, 200);
  const document = await fetch(`${f.origin}/scanner/${batch.id}`);
  assert.equal(document.status, 200);
  assert.match(document.headers.get('content-type'), /text\/html/);
  assert.match(await document.text(), /name="csp-nonce"/);
  assert.ok(document.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
  assert.equal((await fetch(`${f.origin}/api/batches/${batch.id}`)).status, 401);
  assert.equal(
    (await operator.request(`/api/batches/${batch.id}`)).body.sessions[0].status,
    'running',
  );
  const result = await until(async () => {
    const current = (await operator.request(`/api/batches/${batch.id}`)).body;
    return current.sessions[0].status === 'completed' ? current : null;
  });
  assert.equal(result.pages.length, 4);
  assert.equal(result.batch.status, 'in_progress');
  assert.equal(
    (
      await f.pool.query("SELECT 1 FROM audit_logs WHERE batch_id=$1 AND action='batch.paused'", [
        batch.id,
      ])
    ).rowCount,
    0,
  );
  for (const pathname of [
    '/capture',
    '/batches',
    '/scanner',
    '/admin/users',
    '/admin/audit',
    '/workspace',
  ])
    assert.equal((await fetch(f.origin + pathname)).status, 200);
  for (const pathname of ['/scanner/invalid', '/scans/scan-001.png', '/unknown', '/.env'])
    assert.equal((await fetch(f.origin + pathname)).status, 404);
});

test('concurrency: version conflicts, atomic sequential sessions and single active scanner', async (t) => {
  const f = await testApplication(t);
  const operator = await f.account();
  let batch = (await operator.request('/api/batches', {})).body.batch;
  const edits = await Promise.all(
    ['Box 1', 'Box 2'].map((physicalLocation) =>
      operator.request(
        `/api/batches/${batch.id}`,
        { version: batch.version, physicalLocation },
        'PATCH',
      ),
    ),
  );
  assert.deepEqual(edits.map((result) => result.status).sort(), [200, 409]);
  batch = (await operator.request(`/api/batches/${batch.id}`)).body.batch;
  const starts = await Promise.all(
    [1, 2].map(() =>
      operator.request(`/api/batches/${batch.id}/scan-sessions`, {
        version: batch.version,
        options: { scenario: 'multi', pageDelay: 150 },
      }),
    ),
  );
  assert.deepEqual(starts.map((result) => result.status).sort(), [200, 409]);
  const active = (await operator.request(`/api/batches/${batch.id}`)).body;
  assert.equal(
    (
      await operator.request(`/api/batches/${batch.id}/complete-capture`, {
        version: active.batch.version,
      })
    ).status,
    409,
  );
  await until(
    async () =>
      !(await operator.request(`/api/batches/${batch.id}`)).body.sessions.some(
        (session) => session.status === 'running',
      ),
  );
  const sessions = (await f.pool.query('SELECT * FROM scan_sessions WHERE batch_id=$1', [batch.id]))
    .rows;
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].session_number, 1);
});

test('scanner failures: partial pages retained, empty/error sessions failed and explicit acknowledgement', async (t) => {
  const f = await testApplication(t);
  const operator = await f.account();
  let batch = (await operator.request('/api/batches', {})).body;
  batch = await scanned(operator, batch.batch, { scenario: 'jam', pageDelay: 0 });
  assert.equal(batch.sessions[0].status, 'partial');
  assert.equal(batch.sessions[0].page_count, 2);
  assert.match(batch.sessions[0].error_summary, /paper jam/);
  assert.equal(
    (
      await operator.request(`/api/batches/${batch.batch.id}/complete-capture`, {
        version: batch.batch.version,
      })
    ).body.code,
    'partial_acknowledgement',
  );
  for (const scenario of ['empty', 'error']) {
    batch = await scanned(operator, batch.batch, { scenario, pageDelay: 0 });
    assert.equal(batch.sessions.at(-1).status, 'failed');
    assert.equal(batch.sessions.at(-1).page_count, 0);
    assert.equal(batch.pages.length, 2);
  }
  assert.equal(
    (
      await operator.request(`/api/batches/${batch.batch.id}/complete-capture`, {
        version: batch.batch.version,
        acknowledgePartial: true,
      })
    ).status,
    200,
  );
});

test('security: no old routes/static scans, no traversal, origin/CSRF/identifier/SQL injection rejection, append-only audit', async (t) => {
  const f = await testApplication(t);
  const operator = await f.account();
  assert.equal((await fetch(f.origin + '/api/batches')).status, 401);
  assert.equal(
    (await operator.request('/api/batches', {}, 'POST', { Origin: 'https://evil.example' })).status,
    403,
  );
  assert.equal(
    (await operator.request('/api/batches', {}, 'POST', { 'X-CSRF-Token': 'stolen' })).status,
    403,
  );
  assert.equal(
    (await operator.request('/api/batches', {}, 'POST', { 'X-Scan-Request': '' })).status,
    403,
  );
  for (const id of ['invalid', "x' OR 1=1--", randomUUID()])
    assert.ok(
      [400, 404].includes(
        (await operator.request(`/api/batches/${encodeURIComponent(id)}`)).status,
      ),
    );
  for (const endpoint of [
    '/api/state',
    '/api/documents',
    '/api/scanner/scan',
    '/api/scan',
    '/api/scanner/jobs/example',
  ])
    assert.equal((await operator.request(endpoint)).status, 404);
  for (const endpoint of [
    '/scans/scan-123-001.png',
    '/simulated-scans/scan-123-001.png',
    '/.env',
    '/server.mjs',
    '/fixtures/basic/page-001.png',
  ])
    assert.equal((await fetch(f.origin + endpoint)).status, 404);
  assert.equal(
    (await operator.request('/api/batches?search=' + encodeURIComponent("' OR 1=1 --"))).body.total,
    0,
  );
  assert.equal(
    (await operator.request('/api/batches', { assigned_operator_id: operator.user.id })).status,
    400,
  );
  const store = captureStorage(f.app.storage.root);
  await assert.rejects(store.open('../../.env'), { code: 'invalid_storage_key' });
  const key = `batches/${randomUUID()}/sessions/${randomUUID()}/page-0001.png`;
  await mkdir(path.dirname(path.join(store.root, key)), { recursive: true });
  await symlink(path.resolve('README.md'), path.join(store.root, key));
  await assert.rejects(store.open(key));
  await assert.rejects(f.pool.query("UPDATE audit_logs SET action='changed'"), /append-only/);
  const first = await fetch(f.origin);
  const html = await first.text();
  const nonce = html.match(/name="csp-nonce" content="([^"]+)"/)[1];
  assert.ok(first.headers.get('content-security-policy').includes(`'nonce-${nonce}'`));
  assert.ok(!first.headers.get('content-security-policy').includes('unsafe-inline'));
  assert.ok(!(await (await fetch(f.origin)).text()).includes(nonce));
});

test('recovery: unregistered generated files survive database failure and restart without duplicate pages', async (t) => {
  const f = await testApplication(t);
  const operator = await f.account();
  const batch = (await operator.request('/api/batches', {})).body.batch;
  const sessionId = randomUUID();
  const jobId = `scan-${Date.now()}-${sessionId}`;
  const documentId = (await f.pool.query('SELECT id FROM documents WHERE batch_id=$1', [batch.id]))
    .rows[0].id;
  await f.pool.query(
    "INSERT INTO scan_sessions(id,batch_id,document_id,session_number,status,created_by,scanner_mode,job_id) VALUES($1,$2,$3,1,'running',$4,'simulator',$5)",
    [sessionId, batch.id, documentId, operator.user.id, jobId],
  );
  const spool = f.service.providers.simulator.scans;
  await mkdir(spool, { recursive: true });
  const buffer = await readFile('fixtures/basic/page-001.png');
  await writeFile(path.join(spool, `${jobId}-001.png`), buffer);
  // Simulate finalization succeeding, but page registration never committing.
  const session = (await f.pool.query('SELECT * FROM scan_sessions WHERE id=$1', [sessionId]))
    .rows[0];
  await f.app.storage.finalize(session, 1, spool, `${jobId}-001.png`);
  await f.app.batches.recover();
  await f.app.batches.recover();
  const recovered = (await operator.request(`/api/batches/${batch.id}`)).body;
  assert.equal(recovered.sessions[0].status, 'interrupted');
  assert.equal(recovered.pages.length, 1);
  assert.deepEqual(await readFile(path.join(spool, `${jobId}-001.png`)), buffer);
  // A second live runtime cannot recover or capture over the first one's database.
  const otherPool = database({ options: `-c search_path=${f.schema},public -c timezone=UTC` });
  const second = await createRuntimeService({ pool: otherPool, dataDir: f.dataDir });
  await assert.rejects(
    second.application.route(
      { method: 'GET', headers: {} },
      {},
      new URL(f.origin + '/api/auth/me'),
    ),
    { code: 'runtime_busy' },
  );
  await second.application.close();
  const nextSessionId = randomUUID();
  const nextJobId = `scan-${Date.now()}-${nextSessionId}`;
  await f.pool.query(
    "INSERT INTO scan_sessions(id,batch_id,document_id,session_number,status,created_by,scanner_mode,job_id,capture_order_base) VALUES($1,$2,$3,2,'running',$4,'simulator',$5,1)",
    [nextSessionId, batch.id, documentId, operator.user.id, nextJobId],
  );
  await writeFile(path.join(spool, `${nextJobId}-001.png`), buffer);
  await writeFile(path.join(spool, `${nextJobId}-002.png.partial`), buffer.subarray(0, 10));
  await f.app.close();
  const restartPool = database({ options: `-c search_path=${f.schema},public -c timezone=UTC` });
  const restarted = await createRuntimeService({ pool: restartPool, dataDir: f.dataDir });
  f.service.application = restarted.application;
  const persisted = (await operator.request(`/api/batches/${batch.id}`)).body;
  assert.equal(persisted.pages.length, 2);
  assert.equal(persisted.sessions[0].status, 'interrupted');
  assert.equal(persisted.sessions[1].status, 'interrupted');
  assert.deepEqual(
    persisted.pages.map((page) => page.capture_order),
    [1, 2],
  );
  assert.equal(persisted.pages[0].sha256, recovered.pages[0].sha256);
});

test('file integrity: corrupt/missing originals block completion, concurrent previews are safe, originals cannot be overwritten', async (t) => {
  const f = await testApplication(t);
  const operator = await f.account();
  let result = (await operator.request('/api/batches', {})).body;
  result = await scanned(operator, result.batch, { scenario: 'single', pageDelay: 0 });
  const page = result.pages[0];
  const file = path.join(f.app.storage.root, page.original_storage_key);
  const original = await readFile(file);
  const previews = await Promise.all(
    Array.from({ length: 8 }, () => operator.request(`/api/pages/${page.id}/thumbnail`)),
  );
  assert.ok(previews.every((response) => response.status === 200));
  await chmod(file, 0o600);
  await writeFile(file, 'broken PNG');
  assert.equal(
    (
      await operator.request(`/api/batches/${result.batch.id}/complete-capture`, {
        version: result.batch.version,
      })
    ).status,
    422,
  );
  await writeFile(file, await readFile('fixtures/basic/page-002.png'));
  assert.equal(
    (
      await operator.request(`/api/batches/${result.batch.id}/complete-capture`, {
        version: result.batch.version,
      })
    ).body.code,
    'image_changed',
  );
  await unlink(file);
  assert.notEqual(
    (
      await operator.request(`/api/batches/${result.batch.id}/complete-capture`, {
        version: result.batch.version,
      })
    ).status,
    200,
  );
  const session = result.sessions[0];
  const spoolFile = `${session.job_id}-001.png`;
  const restored = await f.app.storage.finalize(
    session,
    1,
    f.service.providers.simulator.scans,
    spoolFile,
  );
  assert.equal(restored.sha256, page.sha256);
  await writeFile(
    path.join(f.service.providers.simulator.scans, spoolFile),
    await readFile('fixtures/basic/page-002.png'),
  );
  await assert.rejects(
    f.app.storage.finalize(session, 1, f.service.providers.simulator.scans, spoolFile),
    { code: 'image_conflict' },
  );
  assert.deepEqual(await readFile(file), original);
});

test('reconciliation preserves reserved feeder order across a corrupt page, another session and later repair', async (t) => {
  const f = await testApplication(t);
  const operator = await f.account();
  let result = (await operator.request('/api/batches', {})).body;
  const doc = (await f.pool.query('SELECT id FROM documents WHERE batch_id=$1', [result.batch.id]))
    .rows[0].id;
  const id = randomUUID();
  const job = `scan-${Date.now()}-${id}`;
  await f.pool.query(
    "INSERT INTO scan_sessions(id,batch_id,document_id,session_number,status,created_by,scanner_mode,job_id) VALUES($1,$2,$3,1,'running',$4,'simulator',$5)",
    [id, result.batch.id, doc, operator.user.id, job],
  );
  const spool = f.service.providers.simulator.scans;
  await mkdir(spool, { recursive: true });
  await writeFile(path.join(spool, `${job}-001.png`), 'invalid');
  await writeFile(
    path.join(spool, `${job}-002.png`),
    await readFile('fixtures/basic/page-002.png'),
  );
  await f.app.batches.recover();
  result = (await operator.request(`/api/batches/${result.batch.id}`)).body;
  assert.deepEqual(
    result.pages.map((page) => page.capture_order),
    [2],
  );
  result = await scanned(operator, result.batch, { scenario: 'single', pageDelay: 0 });
  assert.deepEqual(
    result.pages.map((page) => page.capture_order),
    [2, 3],
  );
  await writeFile(
    path.join(spool, `${job}-001.png`),
    await readFile('fixtures/basic/page-001.png'),
  );
  await f.app.batches.reconcile(result.sessions[0], true);
  result = (await operator.request(`/api/batches/${result.batch.id}`)).body;
  assert.deepEqual(
    result.pages.map((page) => page.capture_order),
    [1, 2, 3],
  );
  assert.equal(new Set(result.pages.map((page) => page.id)).size, 3);
  await f.app.batches.reconcile(result.sessions[0], true);
  assert.equal((await operator.request(`/api/batches/${result.batch.id}`)).body.pages.length, 3);
});

test('database unavailable: never invokes scanner or falls back to JSON', async (t) => {
  const f = await testApplication(t);
  const operator = await f.account();
  const batch = (await operator.request('/api/batches', {})).body.batch;
  let scans = 0;
  f.service.providers.simulator.scan = async () => {
    scans++;
  };
  const oldQuery = f.pool.query.bind(f.pool);
  f.pool.query = async () => {
    throw Object.assign(new Error('Unavailable'), { code: 'ECONNREFUSED' });
  };
  try {
    assert.equal(
      (await operator.request(`/api/batches/${batch.id}/scan-sessions`, { version: batch.version }))
        .status,
      503,
    );
    assert.equal(scans, 0);
  } finally {
    f.pool.query = oldQuery;
  }
});
