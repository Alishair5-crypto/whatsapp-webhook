'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { prepareImageLimitedProducts } = require('./agent');

const product = (id, urls) => ({
  id,
  name: `Design ${id}`,
  images: urls.map((url, index) => ({ url, isPrimary: index === 0 }))
});

test('requested designs are distinct products with one representative image each', () => {
  const rows = [
    product('ML1203-10', ['https://img.example/a.jpg', 'https://img.example/a-back.jpg']),
    product('ML1203-16', ['https://img.example/b.jpg']),
    product('ML1203-15', ['https://img.example/c.jpg'])
  ];
  const selected = prepareImageLimitedProducts(rows, 3);
  assert.deepEqual(selected.map(row => row.id), ['ML1203-10', 'ML1203-16', 'ML1203-15']);
  assert.deepEqual(selected.map(row => row.images.map(image => image.url)), [
    ['https://img.example/a.jpg'],
    ['https://img.example/b.jpg'],
    ['https://img.example/c.jpg']
  ]);
});

test('image selection respects the exact requested count', () => {
  const rows = [
    product('A', ['https://img.example/a.jpg']),
    product('B', ['https://img.example/b.jpg']),
    product('C', ['https://img.example/c.jpg'])
  ];
  assert.deepEqual(prepareImageLimitedProducts(rows, 1).map(row => row.id), ['A']);
  assert.deepEqual(prepareImageLimitedProducts(rows, 2).map(row => row.id), ['A', 'B']);
});

test('duplicate image URLs do not produce duplicate selected designs', () => {
  const rows = [
    product('A', ['https://img.example/shared.jpg']),
    product('B', ['https://img.example/shared.jpg']),
    product('C', ['https://img.example/c.jpg'])
  ];
  assert.deepEqual(prepareImageLimitedProducts(rows, 3).map(row => row.id), ['A', 'C']);
});

test('products without a valid representative image are skipped', () => {
  const rows = [
    { id: 'NO-IMAGE', name: 'No image', images: [] },
    product('VALID', ['https://img.example/valid.jpg'])
  ];
  assert.deepEqual(prepareImageLimitedProducts(rows, 2).map(row => row.id), ['VALID']);
});

test('complete-catalogue limit includes all unique products with images', () => {
  const rows = [
    product('A', ['https://img.example/a.jpg']),
    product('B', ['https://img.example/b.jpg'])
  ];
  assert.deepEqual(prepareImageLimitedProducts(rows, 50).map(row => row.id), ['A', 'B']);
});
