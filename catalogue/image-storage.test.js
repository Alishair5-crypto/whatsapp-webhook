'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');

const storage = require('./image-storage');
const handler = require('./image-handler');

function pngBytes(extra = Buffer.alloc(0)) {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    extra
  ]);
}

function fakeReq(chunks = [], headers = {}) {
  const req = new EventEmitter();
  req.headers = headers;
  req.method = 'POST';
  req.url = '/';
  process.nextTick(() => {
    for (const chunk of chunks) req.emit('data', chunk);
    req.emit('end');
  });
  return req;
}

function fakeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[name] = value; },
    end(body) { this.body = body || ''; }
  };
}

test('validates product ids and image bytes', () => {
  assert.equal(storage.validateImageInput({
    productId: '7',
    buffer: pngBytes(Buffer.from('test')),
    contentType: 'image/png'
  }).productId, 7);

  assert.throws(
    () => storage.validateImageInput({ productId: 0, buffer: pngBytes(), contentType: 'image/png' }),
    /Invalid product id/
  );
});

test('rejects unsupported, spoofed, empty and oversized images', () => {
  assert.throws(
    () => storage.validateImageInput({ productId: 1, buffer: pngBytes(), contentType: 'image/svg+xml' }),
    /Unsupported image type/
  );
  assert.throws(
    () => storage.validateImageInput({ productId: 1, buffer: pngBytes(), contentType: 'image/jpeg' }),
    /Image content does not match type/
  );
  assert.throws(
    () => storage.validateImageInput({ productId: 1, buffer: Buffer.alloc(0), contentType: 'image/png' }),
    /Image body is empty/
  );
  assert.throws(
    () => storage.validateImageInput({ productId: 1, buffer: Buffer.alloc(storage.MAX_IMAGE_BYTES + 1), contentType: 'image/png' }),
    /Image exceeds 4 MB limit/
  );
});

test('cleans and bounds alt text', () => {
  const value = storage.cleanText('  front\n  image\u0000  ', 20);
  assert.equal(value, 'front image');
  assert.equal(storage.cleanText('x'.repeat(300), 10).length, 10);
});

test('blob path never uses user filenames', () => {
  const path = storage.makeBlobPath(12, 'webp');
  assert.match(path, /^catalogue\/products\/12\/[0-9a-f-]+\.webp$/);
});

test('timing-safe auth rejects missing and mismatched tokens', () => {
  assert.equal(handler.timingSafeTokenMatch('', 'secret'), false);
  assert.equal(handler.timingSafeTokenMatch('wrong', 'secret'), false);
  assert.equal(handler.timingSafeTokenMatch('secret', 'secret'), true);
});

test('handler fails closed when auth is not configured', async () => {
  const previous = process.env.CATALOGUE_API_TOKEN;
  delete process.env.CATALOGUE_API_TOKEN;
  const res = fakeRes();
  await handler({ method: 'GET', url: '/?productId=1', headers: {} }, res);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(JSON.parse(res.body), { ok: false, error: 'Catalogue API is not configured' });
  if (previous === undefined) delete process.env.CATALOGUE_API_TOKEN;
  else process.env.CATALOGUE_API_TOKEN = previous;
});

test('handler rejects unauthorized requests', async () => {
  const previous = process.env.CATALOGUE_API_TOKEN;
  process.env.CATALOGUE_API_TOKEN = 'secret';
  const res = fakeRes();
  await handler({ method: 'GET', url: '/?productId=1', headers: {} }, res);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(JSON.parse(res.body), { ok: false, error: 'Unauthorized' });
  if (previous === undefined) delete process.env.CATALOGUE_API_TOKEN;
  else process.env.CATALOGUE_API_TOKEN = previous;
});

test('readBody enforces the upload size limit', async () => {
  const req = fakeReq([Buffer.alloc(storage.MAX_IMAGE_BYTES + 1)]);
  await assert.rejects(() => handler.readBody(req), /Image exceeds 4 MB limit/);
});
