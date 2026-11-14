import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { database, migrate } from '../server/db.mjs';
import { createRuntimeService, createApp } from '../server.mjs';

export async function testApplication(t, options = {}) {
  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  const root = database();
  await root.query(`CREATE SCHEMA ${schema}`);
  const pool = database({ options: `-c search_path=${schema},public -c timezone=UTC` });
  await migrate(pool);
  const dataDir = await mkdtemp('/tmp/opencode/digitalarch-enterprise-');
  const service = await createRuntimeService({
    pool,
    dataDir,
    customFixtures: options.customFixtures,
    ocr: { enabled: false, ...options.ocr },
    prepare: () => {
      throw new Error('Hardware access forbidden in automated tests');
    },
  });
  const server = createApp({ service });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const app = service.application;
  const bootstrap = await app.admin.create(
    null,
    { username: 'test-admin', displayName: 'Test Administrator', roles: ['system_admin'] },
    true,
  );
  async function client(username, password, change = true) {
    let cookie = '';
    let csrf = '';
    const request = async (route, body, method = 'POST', extra = {}) => {
      const response = await fetch(origin + route, {
        method: body === undefined ? 'GET' : method,
        headers: {
          Origin: origin,
          'X-Scan-Request': '1',
          'Content-Type': 'application/json',
          Cookie: cookie,
          'X-CSRF-Token': csrf,
          ...extra,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (response.headers.get('set-cookie'))
        cookie = response.headers.get('set-cookie').split(';')[0];
      const result = response.headers.get('content-type')?.includes('json')
        ? await response.json()
        : null;
      if (result?.csrfToken) csrf = result.csrfToken;
      return { status: response.status, body: result, response };
    };
    const login = await request('/api/auth/login', { username, password });
    if (login.status !== 200) throw new Error(`Test login failed: ${JSON.stringify(login.body)}`);
    if (change)
      await request('/api/auth/change-password', {
        currentPassword: password,
        newPassword: `test-passphrase-${randomUUID()}`,
      });
    return {
      request,
      login,
      get cookie() {
        return cookie;
      },
      get csrf() {
        return csrf;
      },
    };
  }
  const admin = await client(bootstrap.user.username, bootstrap.temporaryPassword);
  const account = async (roles = ['operator'], username = `u-${randomUUID()}`) => {
    const result = await app.admin.create(bootstrap.user, {
      username,
      displayName: username,
      roles,
    });
    return {
      ...(await client(username, result.temporaryPassword)),
      user: await app.auth.user(result.user.id),
    };
  };
  const cleanup = async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await service.application.close();
    await root.query(`DROP SCHEMA ${schema} CASCADE`);
    await root.end();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };
  if (t) t.after(cleanup);
  return {
    pool,
    root,
    schema,
    service,
    app,
    origin,
    dataDir,
    bootstrap,
    admin,
    client,
    account,
    cleanup,
  };
}

export async function until(operation, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await operation();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error('Timed out waiting for capture persistence');
}

export async function scanned(operator, batch, options = { scenario: 'multi', pageDelay: 0 }) {
  const start = await operator.request(`/api/batches/${batch.id}/scan-sessions`, {
    version: batch.version,
    options,
  });
  if (start.status !== 200) throw new Error(JSON.stringify(start.body));
  return until(async () => {
    const result = await operator.request(`/api/batches/${batch.id}`);
    return !result.body.sessions.some((session) => session.status === 'running')
      ? result.body
      : null;
  });
}
