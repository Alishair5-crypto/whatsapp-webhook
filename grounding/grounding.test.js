'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildEvidencePack } = require('./contracts');
const { evaluateClaim, validateClaims } = require('./validator');
const { evaluateShadow } = require('./shadow');

const NOW = Date.parse('2026-11-09T12:00:00.000Z');
const fresh = (overrides = {}) => ({
  field: 'price',
  value: 4500,
  source: 'catalogue_products',
  status: 'verified',
  verifiedAt: '2026-11-09T11:59:00.000Z',
  subjectId: 'product-1',
  ...overrides
});

test('accepts a fresh exact verified claim', () => {
  const evidence = buildEvidencePack([fresh()]);
  assert.equal(evaluateClaim({ field: 'price', value: 4500, subjectId: 'product-1' }, evidence, { now: NOW }).allowed, true);
});

test('blocks absent evidence and invalid claims', () => {
  assert.equal(evaluateClaim({ field: 'stock', value: 4, subjectId: 'product-1' }, [], { now: NOW }).reason, 'evidence_missing');
  assert.equal(evaluateClaim({ field: 'unknown_field', value: 4, subjectId: 'product-1' }, [], { now: NOW }).reason, 'invalid_claim');
  assert.equal(evaluateClaim(null, [], { now: NOW }).reason, 'invalid_claim');
  assert.equal(evaluateClaim({ field: 'price', value: 4500 }, [], { now: NOW }).reason, 'invalid_claim');
  assert.equal(evaluateClaim({ field: 'price', value: null, subjectId: 'product-1' }, [], { now: NOW }).reason, 'invalid_claim');
  assert.equal(evaluateClaim({ field: 'price', value: 'x'.repeat(1001), subjectId: 'product-1' }, [], { now: NOW }).reason, 'invalid_claim');
});

test('blocks unknown, unavailable, partial and stale statuses', () => {
  for (const status of ['unknown', 'unavailable', 'partial', 'stale']) {
    const result = evaluateClaim({ field: 'price', value: 4500, subjectId: 'product-1' }, buildEvidencePack([fresh({ status, verifiedAt: null })]), { now: NOW });
    assert.equal(result.allowed, false, status);
  }
});

test('blocks evidence older than the freshness window and future timestamps', () => {
  assert.equal(evaluateClaim({ field: 'price', value: 4500, subjectId: 'product-1' }, buildEvidencePack([fresh({ verifiedAt: '2026-11-09T11:00:00.000Z' })]), { now: NOW, maxAgeMs: 60000 }).reason, 'evidence_stale');
  assert.equal(evaluateClaim({ field: 'price', value: 4500, subjectId: 'product-1' }, buildEvidencePack([fresh({ verifiedAt: '2026-11-09T12:01:00.000Z' })]), { now: NOW }).reason, 'evidence_stale');
});

test('blocks conflicting verified values and explicit conflict status', () => {
  const evidence = buildEvidencePack([fresh(), fresh({ value: 4700, source: 'alternate_price_source' })]);
  assert.equal(evaluateClaim({ field: 'price', value: 4500, subjectId: 'product-1' }, evidence, { now: NOW }).reason, 'evidence_conflict');
  assert.equal(evaluateClaim({ field: 'price', value: 4500, subjectId: 'product-1' }, buildEvidencePack([fresh({ status: 'conflict' })]), { now: NOW }).reason, 'evidence_conflict');
});

test('prevents cross-subject evidence from authorizing another product', () => {
  const evidence = buildEvidencePack([fresh({ subjectId: 'product-A' })]);
  assert.equal(evaluateClaim({ field: 'price', value: 4500, subjectId: 'product-B' }, evidence, { now: NOW }).reason, 'evidence_missing');
});

test('requires an explicit subject identifier on evidence and claims', () => {
  assert.throws(() => buildEvidencePack([fresh({ subjectId: undefined })]), /subjectId is required/);
  assert.equal(evaluateClaim({ field: 'price', value: 4500 }, buildEvidencePack([fresh()]), { now: NOW }).reason, 'invalid_claim');
});

test('blocks mismatched values but normalizes harmless string casing and whitespace', () => {
  const evidence = buildEvidencePack([fresh({ field: 'color', value: ' Blue ' })]);
  assert.equal(evaluateClaim({ field: 'color', value: 'blue', subjectId: 'product-1' }, evidence, { now: NOW }).allowed, true);
  assert.equal(evaluateClaim({ field: 'color', value: 'red', subjectId: 'product-1' }, evidence, { now: NOW }).reason, 'claim_mismatch');
});

test('rejects malformed evidence at the boundary', () => {
  for (const item of [
    { ...fresh(), field: 'sql;drop' },
    { ...fresh(), source: '' },
    { ...fresh(), status: 'maybe' },
    { ...fresh(), value: { price: 4500 } },
    { ...fresh(), verifiedAt: 'not-a-date' },
    { ...fresh(), status: 'verified', verifiedAt: null },
    { ...fresh(), status: 'verified', value: null },
    { ...fresh(), value: 'x'.repeat(1001) }
  ]) assert.throws(() => buildEvidencePack([item]), TypeError);
  assert.throws(() => buildEvidencePack(null), TypeError);
});

test('uses the newest timestamp when duplicate verified sources agree', () => {
  const evidence = buildEvidencePack([
    fresh({ verifiedAt: '2026-11-09T11:40:00.000Z', source: 'old_source' }),
    fresh({ verifiedAt: '2026-11-09T11:59:30.000Z', source: 'new_source' })
  ]);
  const result = evaluateClaim({ field: 'price', value: 4500, subjectId: 'product-1' }, evidence, { now: NOW });
  assert.equal(result.allowed, true);
  assert.equal(result.source, 'new_source');
});

test('handles empty claims and rejects malformed collection arguments', () => {
  assert.deepEqual(validateClaims([], [], { now: NOW }), { allowed: true, results: [] });
  assert.throws(() => validateClaims({}, []), TypeError);
  assert.throws(() => validateClaims([], {}), TypeError);
  assert.throws(() => validateClaims(null, []), TypeError);
  assert.throws(() => evaluateClaim({ field: 'price', value: 1, subjectId: 'p1' }, null), TypeError);
  assert.throws(() => evaluateClaim({ field: 'price', value: 1, subjectId: 'p1' }, [], null), TypeError);
});

test('rejects oversized evidence and claim batches', () => {
  assert.throws(() => buildEvidencePack(Array(501).fill(fresh())), RangeError);
  assert.throws(() => validateClaims(Array(501).fill({ field: 'price', value: 4500, subjectId: 'product-1' }), []), RangeError);
});

test('shadow mode reports a block without mutating the input or producing a reply', () => {
  const input = { claims: [{ field: 'payment_status', value: 'paid', subjectId: 'order-1' }], evidence: [] };
  const before = JSON.stringify(input);
  const result = evaluateShadow(input, { now: NOW });
  assert.equal(result.mode, 'shadow_only');
  assert.equal(result.wouldBlock, true);
  assert.equal(result.wouldAllow, false);
  assert.equal(JSON.stringify(input), before);
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'reply'), false);
});

test('shadow mode rejects null collections rather than silently treating them as empty', () => {
  assert.throws(() => evaluateShadow({ claims: null, evidence: [] }), TypeError);
  assert.throws(() => evaluateShadow({ claims: [], evidence: null }), TypeError);
});

test('shadow mode allows an empty claims batch without any DB/network dependency', () => {
  assert.deepEqual(evaluateShadow({ claims: [], evidence: [] }, { now: NOW }), {
    mode: 'shadow_only', wouldAllow: true, wouldBlock: false, checkedClaims: 0, results: []
  });
});
