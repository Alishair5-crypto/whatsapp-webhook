'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { safePublicImageUrl } = require('./image-selection');

test('accepts HTTPS Vercel Blob catalogue image URLs', () => {
  const result = safePublicImageUrl('https://abc.public.blob.vercel-storage.com/dress.jpg');
  assert.equal(result?.protocol, 'https:');
  assert.equal(result?.hostname, 'abc.public.blob.vercel-storage.com');
});

test('accepts explicitly allowlisted public image hosts', () => {
  const result = safePublicImageUrl('https://images.example.com/dress.png', ['example.com']);
  assert.equal(result?.hostname, 'images.example.com');
});

test('rejects insecure or credentialed URLs', () => {
  assert.equal(safePublicImageUrl('http://abc.public.blob.vercel-storage.com/dress.jpg'), null);
  assert.equal(safePublicImageUrl('https://user:pass@abc.public.blob.vercel-storage.com/dress.jpg'), null);
  assert.equal(safePublicImageUrl('https://abc.public.blob.vercel-storage.com:8443/dress.jpg'), null);
});

test('rejects local, private, and literal-IP targets', () => {
  assert.equal(safePublicImageUrl('https://localhost/image.jpg'), null);
  assert.equal(safePublicImageUrl('https://127.0.0.1/image.jpg'), null);
  assert.equal(safePublicImageUrl('https://192.168.1.10/image.jpg'), null);
  assert.equal(safePublicImageUrl('https://metadata.google.internal/computeMetadata/v1'), null);
});

test('rejects unapproved external hosts and malformed values', () => {
  assert.equal(safePublicImageUrl('https://untrusted.example/image.jpg'), null);
  assert.equal(safePublicImageUrl('not-a-url'), null);
  assert.equal(safePublicImageUrl(''), null);
});
