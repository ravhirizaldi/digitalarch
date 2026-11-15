import test from 'node:test';
import assert from 'node:assert/strict';
import { testApplication } from './support.mjs';

test('administration: generated or set temporary passwords retain onboarding, reset security and audit privacy', async (t) => {
  const f = await testApplication(t);
  const body = { username: 'manual-user', displayName: 'Manual User', roles: ['operator'] };
  for (const password of ['', 'too-short', ' '.repeat(12), 'x'.repeat(257), null, 42, {}]) {
    const response = await f.admin.request('/api/admin/users', { ...body, password });
    assert.equal(response.status, 400);
    assert.equal(response.body.code, 'invalid_password');
  }
  const password = '  A temporary passphrase!  ';
  const created = await f.admin.request('/api/admin/users', { ...body, password });
  assert.equal(created.status, 200);
  assert.equal(created.body.temporaryPassword, password, 'Do not trim or transform passwords');
  assert.equal(created.body.user.must_change_password, true);
  const account = await f.client(body.username, password, false);
  assert.equal((await account.request('/api/admin/users')).body.code, 'password_change_required');
  assert.equal(
    (
      await account.request('/api/auth/change-password', {
        currentPassword: password,
        newPassword: 'A different private passphrase!',
      })
    ).status,
    200,
  );

  const route = `/api/admin/users/${created.body.user.id}/reset-password`;
  assert.equal((await account.request(route, { password: 'Unauthorized password!' })).status, 403);
  for (const invalid of ['', 'short', null, 42, 'x'.repeat(257)])
    assert.equal((await f.admin.request(route, { password: invalid })).status, 400);
  assert.equal(
    (await account.request('/api/auth/me')).status,
    200,
    'Invalid resets must not revoke sessions',
  );
  const resetPassword = 'A new temporary password!';
  assert.equal(
    (await f.admin.request(route, { password: resetPassword }, 'POST', { 'X-CSRF-Token': '' }))
      .status,
    403,
  );
  const version = (await f.app.auth.user(created.body.user.id)).version;
  assert.equal((await f.admin.request(route, { password: resetPassword })).status, 400);
  assert.equal(
    (await f.admin.request(route, { password: resetPassword, version: version - 1 })).status,
    409,
  );
  const reset = await f.admin.request(route, { password: resetPassword, version });
  assert.equal(reset.status, 200);
  assert.equal(reset.body.temporaryPassword, resetPassword);
  assert.equal((await account.request('/api/auth/me')).status, 401);
  const resetAccount = await f.client(body.username, resetPassword, false);
  assert.equal(resetAccount.login.body.user.must_change_password, true);
  const automatic = await f.admin.request(route, { version: resetAccount.login.body.user.version });
  assert.equal(automatic.status, 200);
  assert.match(automatic.body.temporaryPassword, /^[A-Za-z0-9_-]{32}$/);
  assert.equal((await resetAccount.request('/api/auth/me')).status, 401);
  assert.equal(
    (await f.client(body.username, automatic.body.temporaryPassword, false)).login.status,
    200,
  );
  assert.equal((await f.admin.request(route, { passwordMode: 'auto' })).status, 400);

  const generated = await f.admin.request('/api/admin/users', {
    username: 'automatic-user',
    displayName: 'Automatic User',
    roles: ['archive_viewer'],
  });
  assert.match(generated.body.temporaryPassword, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(generated.body.user.must_change_password, true);
  const listed = await f.admin.request('/api/admin/users');
  const logs = await f.admin.request('/api/admin/audit-logs');
  const stored = JSON.stringify([listed.body, logs.body]);
  for (const secret of [
    password,
    resetPassword,
    automatic.body.temporaryPassword,
    generated.body.temporaryPassword,
  ])
    assert.ok(!stored.includes(secret), 'Passwords must never enter user lists or audit metadata');
  assert.ok(!stored.includes('password_hash'));
});

test('audit: category/search apply before paging and counters span the complete log', async (t) => {
  const f = await testApplication(t);
  await f.pool.query(
    `INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,metadata)
    SELECT $1,'user.fixture_event','user',$1,jsonb_build_object('sequence',n)
    FROM generate_series(1,31) n`,
    [f.bootstrap.user.id],
  );
  const all = await f.admin.request('/api/admin/audit-logs?limit=1');
  assert.equal(all.status, 200);
  assert.equal(all.body.logs.length, 1);
  assert.equal(
    Object.values(all.body.counts).reduce((sum, count) => sum + count, 0),
    all.body.total,
  );
  assert.ok(all.body.counts.user >= 31);
  const first = await f.admin.request(
    '/api/admin/audit-logs?category=user&search=USER.FIXTURE_EVENT&limit=25',
  );
  assert.equal(first.body.total, 31);
  assert.equal(first.body.logs.length, 25);
  assert.ok(first.body.logs.every((log) => log.action === 'user.fixture_event'));
  const second = await f.admin.request(
    '/api/admin/audit-logs?category=user&search=USER.FIXTURE_EVENT&limit=25&offset=25',
  );
  assert.equal(second.body.total, 31);
  assert.equal(second.body.logs.length, 6);
  assert.ok(!first.body.logs.some((a) => second.body.logs.some((b) => a.id === b.id)));
  assert.deepEqual(
    second.body.counts,
    first.body.counts,
    'Tab counts are independent of filters and paging',
  );
  const actor = await f.admin.request('/api/admin/audit-logs?category=user&search=TEST-ADMIN');
  assert.ok(actor.body.total >= 31);
  const entity = await f.admin.request(`/api/admin/audit-logs?search=${f.bootstrap.user.id}`);
  assert.ok(entity.body.total >= 31);
  const none = await f.admin.request(
    '/api/admin/audit-logs?category=ocr&search=user.fixture_event',
  );
  assert.equal(none.body.total, 0);
  assert.deepEqual(none.body.logs, []);
  assert.deepEqual(none.body.counts, first.body.counts);
  assert.equal((await f.admin.request('/api/admin/audit-logs?search=%20%20')).status, 200);
  assert.equal((await f.admin.request('/api/admin/audit-logs?category=user%27')).status, 400);
  assert.equal(
    (await f.admin.request(`/api/admin/audit-logs?search=${'x'.repeat(241)}`)).status,
    400,
  );
  const operator = await f.account();
  assert.equal((await operator.request('/api/admin/audit-logs')).status, 403);
});

test('bulk passwords: shared/manual or independent/generated, version fencing, atomic rollback and session revocation', async (t) => {
  const f = await testApplication(t);
  const accounts = [await f.account(), await f.account()].sort((a, b) =>
    a.user.id.localeCompare(b.user.id),
  );
  const targets = async () =>
    Promise.all(
      accounts.map(async ({ user }) => {
        const current = await f.app.auth.user(user.id);
        return { id: current.id, version: current.version };
      }),
    );
  const before = (await f.pool.query('SELECT id,password_hash,version FROM users ORDER BY id'))
    .rows;
  const stale = await targets();
  stale[1].version--;
  assert.equal(
    (
      await f.admin.request('/api/admin/users/bulk', {
        action: 'reset-password',
        users: stale,
        password: 'One shared temporary password!',
      })
    ).status,
    409,
  );
  assert.deepEqual(
    (await f.pool.query('SELECT id,password_hash,version FROM users ORDER BY id')).rows,
    before,
  );
  for (const account of accounts) assert.equal((await account.request('/api/auth/me')).status, 200);
  const shared = 'One shared temporary password!';
  const reset = await f.admin.request('/api/admin/users/bulk', {
    action: 'reset-password',
    users: await targets(),
    password: shared,
  });
  assert.equal(reset.status, 200);
  assert.equal(reset.body.affected, 2);
  assert.ok(reset.body.credentials.every(({ password }) => password === shared));
  for (const account of accounts) {
    assert.equal((await account.request('/api/auth/me')).status, 401);
    const temporary = await f.client(account.user.username, shared, false);
    assert.equal(temporary.login.body.user.must_change_password, true);
  }
  const automatic = await f.admin.request('/api/admin/users/bulk', {
    action: 'reset-password',
    users: await targets(),
  });
  assert.equal(automatic.status, 200);
  assert.equal(new Set(automatic.body.credentials.map(({ password }) => password)).size, 2);
  const hashes = (
    await f.pool.query('SELECT password_hash FROM users WHERE id=ANY($1::uuid[])', [
      accounts.map(({ user }) => user.id),
    ])
  ).rows;
  assert.ok(hashes.every(({ password_hash }) => password_hash.startsWith('$argon2id$')));
  const logs = JSON.stringify((await f.admin.request('/api/admin/audit-logs')).body);
  for (const secret of [shared, ...automatic.body.credentials.map(({ password }) => password)])
    assert.ok(!logs.includes(secret));
  const current = await targets();
  for (const users of [
    [],
    [current[0], current[0]],
    Array(101).fill(current[0]),
    [{ id: current[0].id }],
  ])
    assert.equal(
      (await f.admin.request('/api/admin/users/bulk', { action: 'reset-password', users })).status,
      400,
    );
  assert.equal(
    (
      await f.admin.request('/api/admin/users/bulk', {
        action: 'reset-password',
        users: current,
        password: 'short',
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.admin.request(
        '/api/admin/users/bulk',
        { action: 'reset-password', users: current },
        'POST',
        { 'X-CSRF-Token': '' },
      )
    ).status,
    403,
  );
});

test('user deletion: retained identity/history, hidden accounts, no resurrection and admin/bulk protections', async (t) => {
  const f = await testApplication(t);
  const operator = await f.account();
  const other = await f.account();
  const batch = (await operator.request('/api/batches', {})).body.batch;
  const targets = async (ids) =>
    Promise.all(
      ids.map(async (id) => {
        const current = await f.app.auth.user(id);
        return { id, version: current.version };
      }),
    );
  const route = '/api/admin/users/bulk';
  const self = await targets([operator.user.id, f.bootstrap.user.id]);
  assert.equal(
    (await f.admin.request(route, { action: 'delete', users: self })).body.code,
    'own_admin_access',
  );
  assert.equal((await operator.request('/api/auth/me')).status, 200);
  assert.equal((await f.app.auth.user(operator.user.id)).deleted_at, null);
  await assert.rejects(
    f.app.admin.bulk(
      { id: other.user.id },
      { action: 'delete', users: await targets([f.bootstrap.user.id]) },
    ),
    { code: 'last_admin' },
  );
  const secondAdmin = await f.account(['system_admin']);
  await assert.rejects(
    f.app.admin.bulk(
      { id: other.user.id },
      {
        action: 'delete',
        users: await targets([f.bootstrap.user.id, secondAdmin.user.id]),
      },
    ),
    { code: 'last_admin' },
  );
  assert.equal(
    (await f.app.auth.user(secondAdmin.user.id)).deleted_at,
    null,
    'Removing all admins must roll back the whole batch',
  );
  const users = await targets([operator.user.id, other.user.id]);
  assert.equal((await other.request(route, { action: 'delete', users })).status, 403);
  assert.equal(
    (await f.admin.request(route, { action: 'delete', users }, 'POST', { 'X-CSRF-Token': '' }))
      .status,
    403,
  );
  assert.equal(
    (
      await f.admin.request(route, {
        action: 'delete',
        users,
        password: 'Do not accept this field!',
      })
    ).status,
    400,
  );
  const deleted = await f.admin.request(route, { action: 'delete', users });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.affected, 2);
  assert.equal((await operator.request('/api/auth/me')).status, 401);
  assert.equal((await other.request('/api/auth/me')).status, 401);
  const retained = await f.app.auth.user(operator.user.id);
  assert.equal(retained.is_active, false);
  assert.ok(retained.deleted_at);
  const listed = (await f.admin.request('/api/admin/users')).body;
  assert.ok(!listed.users.some(({ id }) => users.some((target) => target.id === id)));
  assert.equal(
    (await f.pool.query('SELECT assigned_operator_id FROM archive_batches WHERE id=$1', [batch.id]))
      .rows[0].assigned_operator_id,
    operator.user.id,
  );
  const history = (await f.admin.request(`/api/admin/audit-logs?search=${batch.id}`)).body.logs;
  assert.ok(
    history.some(
      (event) => event.action === 'batch.created' && event.actor === operator.user.username,
    ),
  );
  const events = (await f.admin.request('/api/admin/audit-logs?category=user&search=user.deleted'))
    .body;
  assert.equal(events.total, 2);
  assert.equal(
    (
      await f.admin.request(
        `/api/admin/users/${operator.user.id}`,
        { version: retained.version, isActive: true },
        'PATCH',
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await f.admin.request(`/api/admin/users/${operator.user.id}/reset-password`, {
        version: retained.version,
      })
    ).status,
    404,
  );
  assert.equal((await f.admin.request(route, { action: 'reset-password', users })).status, 404);
  assert.equal(
    (
      await f.admin.request('/api/admin/users', {
        username: operator.user.username,
        displayName: 'Reuse',
        roles: ['operator'],
      })
    ).status,
    409,
  );
});
