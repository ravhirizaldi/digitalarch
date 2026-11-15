import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { testApplication, until } from './support.mjs';

test('capture lock permits only owner cancellation, retains saved pages, and cannot cancel a newer session', async (t) => {
  const f = await testApplication(t);
  const operator = await f.account();
  const other = await f.account();
  const simulate = f.service.providers.simulator.scan;
  f.service.providers.simulator.scan = async (job, _options, signal) => {
    await simulate(job, { scenario: 'single', pageDelay: 0 }, signal);
    await new Promise((_, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  };
  const good = (result) => {
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body;
  };
  const batch = good(await operator.request('/api/batches', {})).batch;
  const started = good(
    await operator.request(`/api/batches/${batch.id}/scan-sessions`, {
      version: batch.version,
      options: { scenario: 'multi', pageDelay: 1000 },
    }),
  );
  const session = started.sessions[0];
  const route = `/api/batches/${batch.id}/cancel-scan`;
  assert.equal((await other.request(route, { sessionId: session.id })).status, 403);
  assert.equal((await f.admin.request(route, { sessionId: session.id })).status, 403);
  assert.equal(
    (await operator.request(route, { sessionId: session.id }, 'POST', { 'X-CSRF-Token': '' }))
      .status,
    403,
  );
  assert.equal((await operator.request(route, { sessionId: randomUUID() })).status, 404);
  for (const [path, body, method] of [
    ['/api/batches', {}, 'POST'],
    ['/api/auth/logout', {}, 'POST'],
    ['/api/scanner/refresh', {}, 'POST'],
    [
      `/api/batches/${batch.id}`,
      { version: started.batch.version, physicalLocation: 'Blocked' },
      'PATCH',
    ],
  ])
    assert.equal((await operator.request(path, body, method)).body.code, 'scan_in_progress');
  assert.equal(
    good(await other.request('/api/scanner/status')).capture,
    null,
    'Other users do not inherit this operator lock',
  );
  const capture = good(await operator.request('/api/scanner/status')).capture;
  assert.equal(capture.id, session.id);
  assert.equal(capture.batch_id, batch.id);
  const partial = await until(async () => {
    const current = good(await operator.request(`/api/batches/${batch.id}`));
    return current.pages.length ? current : null;
  });
  const saved = partial.pages.map((page) => ({
    id: page.id,
    sha256: page.sha256,
    key: page.original_storage_key,
  }));
  good(await operator.request(route, { sessionId: session.id }));
  good(await operator.request(route, { sessionId: session.id }));
  const stopped = await until(async () => {
    const current = good(await operator.request(`/api/batches/${batch.id}`));
    return current.sessions[0].status !== 'running' ? current : null;
  });
  assert.equal(stopped.sessions[0].status, 'interrupted');
  assert.match(stopped.sessions[0].error_summary, /cancelled/i);
  for (const page of saved) {
    assert.deepEqual(
      stopped.pages
        .filter((current) => current.id === page.id)
        .map((current) => ({
          id: current.id,
          sha256: current.sha256,
          key: current.original_storage_key,
        })),
      [page],
    );
    assert.equal((await operator.request(`/api/pages/${page.id}/image`)).status, 200);
  }
  assert.equal(good(await operator.request('/api/scanner/status')).capture, null);
  assert.equal(
    (
      await f.pool.query(
        "SELECT count(*)::int AS n FROM audit_logs WHERE entity_id=$1 AND action='scan_session.cancel_requested'",
        [session.id],
      )
    ).rows[0].n,
    1,
  );
  const next = good(
    await operator.request(`/api/batches/${batch.id}/scan-sessions`, {
      version: stopped.batch.version,
      options: { scenario: 'multi', pageDelay: 10000 },
    }),
  ).sessions.at(-1);
  good(await operator.request(route, { sessionId: session.id }));
  assert.equal(
    good(await operator.request('/api/scanner/status')).capture.cancelRequested,
    false,
    'An old request cannot stop the new job',
  );
  good(await operator.request(route, { sessionId: next.id }));
  await until(async () => !good(await operator.request('/api/scanner/status')).capture);
  assert.equal(
    (await operator.request('/api/batches', {})).status,
    200,
    'Normal mutations resume after reconciliation',
  );
});
