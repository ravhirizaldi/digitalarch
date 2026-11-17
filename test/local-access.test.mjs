import test from 'node:test';
import assert from 'node:assert/strict';
import { localAccessError } from '../server/local-access.mjs';

const request = (host, headers = {}, url = '/', method = 'GET') => ({
  url,
  method,
  headers: { host, ...headers },
});

test('localhost and numeric loopback allow direct and same-origin access', () => {
  for (const host of ['localhost:3000', '127.0.0.1:3000', 'LOCALHOST:3000', 'localhost']) {
    assert.equal(localAccessError(request(host)), null);
    assert.equal(
      localAccessError(request(host, { 'sec-fetch-site': 'same-origin' }, '/api/auth/me')),
      null,
    );
  }
  for (const host of [
    'localhost.evil.test:3000',
    '192.168.1.1:3000',
    'localhost:3000@evil.test',
    '',
  ])
    assert.match(localAccessError(request(host)), /unsupported hostname/);
});

test('cross-site links can open the local UI, without allowing cross-site API or resource requests', () => {
  const navigation = {
    'sec-fetch-site': 'cross-site',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-dest': 'document',
  };
  assert.equal(
    localAccessError(request('localhost:3000', navigation, 'http://[')),
    'Invalid local request URL.',
  );
  for (const host of ['localhost:3000', '127.0.0.1:3000']) {
    assert.equal(localAccessError(request(host, navigation, '/capture')), null);
    assert.match(localAccessError(request(host, navigation, '/api/auth/me')), /Cross-site/);
    assert.match(
      localAccessError(request(host, navigation, '/api/auth/logout', 'POST')),
      /Cross-site/,
    );
    assert.match(
      localAccessError(request(host, { 'sec-fetch-site': 'cross-site' }, '/capture')),
      /Cross-site/,
    );
    assert.match(
      localAccessError(request(host, { ...navigation, 'sec-fetch-dest': 'iframe' })),
      /Cross-site/,
    );
  }
});
