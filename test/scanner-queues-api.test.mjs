import test from 'node:test';
import assert from 'node:assert/strict';
import { testApplication, until } from './support.mjs';

test('scanner endpoints enforce permissions/CSRF and isolate simultaneous operator captures', async (t) => {
  const f = await testApplication(t);
  const one = await f.account();
  const two = await f.account();
  const good = (result) => {
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body;
  };
  for (const action of ['reserve', 'release']) {
    const route = `/api/scanner/${action}`;
    assert.equal((await f.admin.request(route, {})).status, 403);
    assert.equal((await one.request(route, {}, 'POST', { 'X-CSRF-Token': '' })).status, 403);
  }
  assert.equal((await one.request('/api/scanner/reserve', {})).body.code, 'device_required');
  assert.equal((await one.request('/api/scanner/reserve', { userId: two.user.id })).status, 400);
  const pending = new Map();
  f.service.providers.simulator.scan = async (job, _options, signal) =>
    new Promise((resolve, reject) => {
      pending.set(job.id, resolve);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  const batches = [];
  for (const operator of [one, two]) {
    const batch = good(await operator.request('/api/batches', {})).batch;
    const started = good(
      await operator.request(`/api/batches/${batch.id}/scan-sessions`, { version: batch.version }),
    );
    batches.push(started);
  }
  await until(() => pending.size === 2);
  const [a, b] = await Promise.all(
    [one, two].map(async (operator) => good(await operator.request('/api/scanner/status'))),
  );
  assert.notEqual(a.capture.id, b.capture.id);
  assert.equal(
    (
      await two.request(`/api/batches/${batches[0].batch.id}/cancel-scan`, {
        sessionId: a.capture.id,
      })
    ).status,
    403,
  );
  good(
    await one.request(`/api/batches/${batches[0].batch.id}/cancel-scan`, {
      sessionId: a.capture.id,
    }),
  );
  await until(async () => !good(await one.request('/api/scanner/status')).capture);
  assert.equal(good(await two.request('/api/scanner/status')).capture.id, b.capture.id);
  pending.get(batches[1].sessions[0].job_id)();
  await until(async () => !good(await two.request('/api/scanner/status')).capture);
});
