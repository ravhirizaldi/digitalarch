import test from 'node:test';
import assert from 'node:assert/strict';
import { pageName } from '../src/pageLabels.js';

test('page names default to logical numbers without renaming capture history', () => {
  const page = { page_number: 6, capture_order: 11, page_label: null };
  assert.equal(pageName(page), 'Page 6');
  assert.equal(pageName({ ...page, page_label: 'Cover' }), 'Cover');
  assert.equal(pageName({ ...page, page_number: 1 }), 'Page 1');
  assert.equal(pageName({ ...page, page_number: 1, page_label: 'Cover' }), 'Cover');
  assert.equal(pageName({ ...page, page_number: null }), 'Removed scan 11');
  assert.equal(
    pageName({ ...page, page_number: null, replacement_candidate: true }),
    'Replacement scan 11',
  );
  assert.equal(pageName(null), 'Page unavailable');
});
