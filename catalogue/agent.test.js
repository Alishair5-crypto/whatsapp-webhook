'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isCatalogueIntent, wantsCatalogueImages, extractFilters, normalizeText, primaryImage } = require('./agent');

test('catalogue intent detects Roman Urdu product browse request', () => {
  assert.equal(isCatalogueIntent('Zara lawn ke 3 piece dikhao'), true);
});

test('catalogue intent detects Urdu product browse request', () => {
  assert.equal(isCatalogueIntent('لان کے سوٹ دکھائیں'), true);
});

test('clear order request is not hijacked into catalogue browse', () => {
  assert.equal(isCatalogueIntent('lawn ka order laga dein'), false);
});

test('filter extraction maps common fabric and color aliases', () => {
  assert.deepEqual(extractFilters('black lawn ke 3 piece dikhao'), {
    fabric: 'Lawn', color: 'Black', collection: '', name: '', limit: 5
  });
});

test('normalization is stable for mixed whitespace', () => {
  assert.equal(normalizeText('  Lawn   3-piece   dikhao  '), 'lawn 3-piece dikhao');
});

test('primary image prefers primary then first usable image', () => {
  const row = { images: [
    { url: 'https://example.com/second.jpg', isPrimary: false },
    { url: 'https://example.com/primary.jpg', isPrimary: true }
  ] };
  assert.equal(primaryImage(row), 'https://example.com/primary.jpg');
});

test('picture request enables image intent', () => {
  assert.equal(wantsCatalogueImages('black lawn ke designs ki pictures dikhao'), true);
});

test('price-only catalogue request does not enable image sending', () => {
  assert.equal(wantsCatalogueImages('black lawn ka price kya hai?'), false);
});

test('availability-only catalogue request does not enable image sending', () => {
  assert.equal(wantsCatalogueImages('black lawn available hai?'), false);
});

test('order request does not enable image sending', () => {
  assert.equal(wantsCatalogueImages('lawn ka order laga dein'), false);
});
