import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { startDevelopment } from '../scripts/dev.mjs';
import { testApplication } from './support.mjs';

test('development: HMR and protected same-origin API proxy, no CORS or authentication bypass', async (t) => {
  const f = await testApplication(t);
  const app = await startDevelopment({ service: f.service, port: 0 });
  t.after(() => app.close());
  const origin = `http://127.0.0.1:${app.frontend.httpServer.address().port}`;
  assert.match(await (await fetch(origin)).text(), /@vite\/client/);
  assert.match(await (await fetch(origin + '/capture')).text(), /@vite\/client/);
  assert.match(
    await (await fetch(origin + '/scanner/00000000-0000-0000-0000-000000000001')).text(),
    /@vite\/client/,
  );
  assert.equal((await fetch(origin + '/api/batches')).status, 401);
  const operator = await f.account();
  const send = (headers) =>
    fetch(origin + '/api/batches', {
      method: 'POST',
      headers: {
        Origin: origin,
        'X-Scan-Request': '1',
        'X-CSRF-Token': operator.csrf,
        Cookie: operator.cookie,
        ...headers,
      },
      body: '{}',
    });
  assert.equal((await send({})).status, 200);
  assert.equal((await send({ Origin: 'https://evil.example' })).status, 403);
  assert.equal((await send({ 'X-CSRF-Token': '' })).status, 403);
  const hostileHostStatus = await new Promise((resolve, reject) => {
    request(origin + '/api/auth/me', { headers: { Host: 'untrusted.example' } }, (response) => {
      response.resume();
      resolve(response.statusCode);
    })
      .on('error', reject)
      .end();
  });
  assert.equal(hostileHostStatus, 403);
  assert.equal(
    (await fetch(origin + '/api/auth/me')).headers.has('Access-Control-Allow-Origin'),
    false,
  );
});
