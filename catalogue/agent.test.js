'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isCatalogueIntent, wantsCatalogueImages, extractFilters, normalizeText, primaryImage, allImages, normalizeImageUrl, isCompleteCatalogueRequest, buildContext } = require('./agent');

test('catalogue intent detects Roman Urdu product browse request', () => assert.equal(isCatalogueIntent('Zara lawn ke 3 piece dikhao'), true));
test('catalogue intent detects Urdu product browse request', () => assert.equal(isCatalogueIntent('لان کے سوٹ دکھائیں'), true));
test('clear order request is not hijacked into catalogue browse', () => assert.equal(isCatalogueIntent('lawn ka order laga dein'), false));
test('filter extraction maps common fabric and color aliases', () => assert.deepEqual(extractFilters('black lawn ke 3 piece dikhao'), { fabric: 'Lawn', color: 'Black', collection: '', name: '', limit: 5 }));
test('complete catalogue request is detected and expands limit', () => assert.equal(isCompleteCatalogueRequest('poora catalogue dikhao'), true));
test('complete catalogue gets 20 product limit', () => assert.deepEqual(extractFilters('complete catalogue'), { fabric: '', color: '', collection: '', name: '', limit: 20 }));
test('blue Urdu inflection maps to Blue', () => assert.equal(extractFilters('نیلے لان کے سوٹ دکھائیں').color, 'Blue'));
test('normalization is stable for mixed whitespace', () => assert.equal(normalizeText('  Lawn   3-piece   dikhao  '), 'lawn 3-piece dikhao'));
test('primary image prefers primary then first usable image', () => assert.equal(primaryImage({ images: [{ url: 'https://example.com/second.jpg', isPrimary: false }, { url: 'https://example.com/primary.jpg', isPrimary: true }] }), 'https://example.com/primary.jpg'));
test('allImages returns every unique valid https image', () => assert.deepEqual(allImages({ images: [{ url: 'https://example.com/a.jpg' }, { url: 'https://example.com/b.jpg' }, { url: 'https://example.com/a.jpg' }, { url: 'http://example.com/c.jpg' }] }), ['https://example.com/a.jpg', 'https://example.com/b.jpg']));
test('primary image strips surrounding quotes from stored URL', () => assert.equal(primaryImage({ images: [{ url: '  "https://example.com/primary.jpg"  ', isPrimary: true }] }), 'https://example.com/primary.jpg'));
test('primary image rejects non-https URL', () => assert.equal(primaryImage({ images: [{ url: 'http://example.com/primary.jpg', isPrimary: true }] }), ''));
test('primary image skips malformed primary and uses valid fallback', () => assert.equal(primaryImage({ images: [{ url: 'not a uri', isPrimary: true }, { url: 'https://example.com/fallback.jpg', isPrimary: false }] }), 'https://example.com/fallback.jpg'));
test('image URL normalization rejects credentials', () => assert.equal(normalizeImageUrl('https://user:pass@example.com/image.jpg'), ''));
test('picture request enables image intent', () => assert.equal(wantsCatalogueImages('black lawn ke designs ki pictures dikhao'), true));
test('simple product show request enables image intent', () => assert.equal(wantsCatalogueImages('black lawn show me'), true));
test('complete catalogue enables image intent', () => assert.equal(wantsCatalogueImages('complete catalogue dikhao'), true));
test('price-only request does not enable image sending', () => assert.equal(wantsCatalogueImages('black lawn ka price kya hai?'), false));
test('availability-only request does not enable image sending', () => assert.equal(wantsCatalogueImages('black lawn available hai?'), false));
test('order request does not enable image sending', () => assert.equal(wantsCatalogueImages('lawn ka order laga dein'), false));
test('empty input is safe', () => assert.equal(wantsCatalogueImages(''), false));
test('whitespace input is safe', () => assert.equal(wantsCatalogueImages('   '), false));
test('case and whitespace normalize for visual intent', () => assert.equal(wantsCatalogueImages('  BLACK   LAWN   PICTURES  '), true));
test('Urdu picture request enables image intent', () => assert.equal(wantsCatalogueImages('لان کی تصاویر دکھائیں'), true));
test('non-image catalogue wording does not trigger image intent', () => assert.equal(wantsCatalogueImages('lawn ka rate batao'), false));
test('catalogue context never claims photos when records have no images', () => {
  const context = buildContext([{ name: 'Test Lawn', collection: 'Printed', fabric: 'Lawn', color: 'Blue', price: 5000, currency: 'PKR', stock_quantity: 2, images: [] }], { fabric: 'Lawn', color: 'Blue', collection: '', name: '', limit: 5 });
  assert.match(context, /NO VERIFIED PRODUCT IMAGE URL IS AVAILABLE/);
  assert.doesNotMatch(context, /photos are being shared/);
});