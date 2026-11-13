import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { matchRoute, permittedRoute, routePath } from '../src/routes.js';

test('history routes: exact deep links, safe fallback and navigation round trips', () => {
  const id = randomUUID();
  assert.deepEqual(matchRoute(`/scanner/${id}`), { view: 'scanner', batchId: id });
  assert.equal(routePath('scanner', id), `/scanner/${id}`);
  assert.deepEqual(matchRoute(`/ocr/jobs/${id}`), { view: 'ocr', batchId: null, jobId: id });
  assert.equal(routePath('ocr', id), `/ocr/jobs/${id}`);
  for (const view of [
    'home',
    'batches',
    'scanner',
    'ocr',
    'users',
    'assignments',
    'audit',
    'system',
    'settings',
    'future',
  ])
    assert.deepEqual(matchRoute(routePath(view)), { view, batchId: null });
  assert.deepEqual(matchRoute('/'), { view: null, batchId: null });
  for (const pathname of [
    '/scanner/invalid',
    '/api/batches',
    '/scans/scan-001.png',
    '/.env',
    '/server.mjs',
    '/unknown',
    `/scanner/${id}/extra`,
  ])
    assert.equal(matchRoute(pathname), null);
});

test('history routes: role-aware restoration never grants a different workspace', () => {
  const operator = { permissions: ['batches:create', 'batches:read'] };
  const admin = { permissions: ['users:read', 'batches:reassign', 'audit:read', 'system:read'] };
  const viewer = { permissions: ['archive:read'] };
  const scanner = matchRoute(`/scanner/${randomUUID()}`);
  assert.deepEqual(permittedRoute(operator, scanner), scanner);
  assert.deepEqual(permittedRoute(operator, matchRoute('/admin/users')), {
    view: 'home',
    batchId: null,
  });
  assert.deepEqual(permittedRoute(admin, scanner), { view: 'users', batchId: null });
  assert.deepEqual(permittedRoute(admin, matchRoute('/admin/audit')), {
    view: 'audit',
    batchId: null,
  });
  assert.deepEqual(permittedRoute(viewer, scanner), { view: 'future', batchId: null });
  assert.deepEqual(permittedRoute(operator, null), { view: 'home', batchId: null });
  assert.deepEqual(matchRoute('/settings'), { view: 'settings', batchId: null });
  assert.equal(permittedRoute(operator, matchRoute('/settings')).view, 'home');
  assert.equal(
    permittedRoute({ permissions: ['settings:read'] }, matchRoute('/settings')).view,
    'settings',
  );
});
