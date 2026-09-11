'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeFilters } = require('./catalogue');

test('normalizes whitespace and caps string filters', () => {
  const result = normalizeFilters({
    fabric: '  Lawn  ',
    color: ' Blue\n',
    collection: ' TEST ',
    name: 'x'.repeat(200),
    limit: '7'
  });

  assert.equal(result.fabric, 'Lawn');
  assert.equal(result.color, 'Blue');
  assert.equal(result.collection, 'TEST');
  assert.equal(result.name.length, 120);
  assert.equal(result.limit, 7);
});

test('rejects invalid limits and clamps oversized valid limits', () => {
  assert.equal(normalizeFilters({ limit: 0 }).limit, 5);
  assert.equal(normalizeFilters({ limit: -1 }).limit, 5);
  assert.equal(normalizeFilters({ limit: 'abc' }).limit, 5);
  assert.equal(normalizeFilters({ limit: 999 }).limit, 50);
  assert.equal(normalizeFilters({ limit: 50 }).limit, 50);
  assert.equal(normalizeFilters({ limit: 1 }).limit, 1);
});

test('strips control characters from filters', () => {
  const result = normalizeFilters({ fabric: 'La\nwn\t' });
  assert.equal(result.fabric, 'La wn');
});