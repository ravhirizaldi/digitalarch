import test from 'node:test';
import assert from 'node:assert/strict';
import { queryChoice, queryPage, queryZoom } from '../src/useUrlState.js';

test('QC URL values accept supported options and reject invalid pagination', () => {
  assert.equal(queryChoice(new URLSearchParams('tab=mine'), 'tab', ['all', 'mine']), 'mine');
  assert.equal(queryChoice(new URLSearchParams('tab=unknown'), 'tab', ['all', 'mine']), 'all');
  assert.equal(queryPage(new URLSearchParams('page=12'), 'page'), 12);
  for (const value of ['', '0', '-1', '1.5', 'Infinity', '40002', 'text'])
    assert.equal(queryPage(new URLSearchParams({ page: value }), 'page'), 1);
});

test('QC preview URL restores fit modes and bounds numeric zoom', () => {
  for (const [value, expected] of [
    ['width', 'width'],
    ['page', 'page'],
    ['1.25', 1.25],
    ['0.02', 0.02],
    ['8', 8],
    ['0', 'width'],
    ['9', 'width'],
    ['Infinity', 'width'],
    ['', 'width'],
  ])
    assert.equal(queryZoom(new URLSearchParams({ zoom: value })), expected);
});
