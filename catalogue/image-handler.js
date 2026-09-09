'use strict';

// Isolated catalogue image-management handler.
// It is intentionally NOT wired into the existing Zara webhook route.

const crypto = require('node:crypto');
const {
  MAX_IMAGE_BYTES,
  uploadProductImage,
  listProductImages,
  setPrimaryProductImage,
  deleteProductImage
} = require('./image-storage');

function timingSafeTokenMatch(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string' || !provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function getBearer(req) {
  const header = req.headers && req.headers.authorization;
  if (typeof header !== 'string') return '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function parseQuery(req) {
  const url = new URL(req.url || '/', 'https://catalogue.local');
  return url.searchParams;
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function publicError(error) {
  const message = error instanceof Error ? error.message : '';
  const known = new Set([
    'Invalid product id',
    'Invalid product or image id',
    'Image body is required',
    'Image body is empty',
    'Image exceeds 4 MB limit',
    'Unsupported image type',
    'Image content does not match type',
    'Invalid image sort order',
    'Product not found',
    'Image not found'
  ]);
  return known.has(message) ? message : 'Catalogue image operation failed';
}

function readBody(req, maxBytes = MAX_IMAGE_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    req.on('data', (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        fail(new Error('Image exceeds 4 MB limit'));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });

    req.on('error', (error) => fail(error));
    req.on('aborted', () => fail(new Error('Request aborted')));
  });
}

async function handler(req, res) {
  const expectedToken = process.env.CATALOGUE_API_TOKEN;
  if (!expectedToken) return send(res, 503, { ok: false, error: 'Catalogue API is not configured' });
  if (!timingSafeTokenMatch(getBearer(req), expectedToken)) {
    return send(res, 401, { ok: false, error: 'Unauthorized' });
  }

  const method = String(req.method || 'GET').toUpperCase();
  const query = parseQuery(req);
  const productId = query.get('productId');

  try {
    if (method === 'GET') {
      const images = await listProductImages(process.env.DATABASE_URL, productId);
      return send(res, 200, { ok: true, images });
    }

    if (method === 'POST') {
      const contentType = String(req.headers && req.headers['content-type'] || '').split(';', 1)[0].trim();
      const buffer = await readBody(req);
      const image = await uploadProductImage({
        dbUrl: process.env.DATABASE_URL,
        productId,
        buffer,
        contentType,
        altText: query.get('altText') || '',
        sortOrder: query.get('sortOrder') || 0,
        isPrimary: query.get('primary') === 'true'
      });
      return send(res, 201, { ok: true, image });
    }

    if (method === 'PUT') {
      const image = await setPrimaryProductImage(
        process.env.DATABASE_URL,
        productId,
        query.get('imageId')
      );
      return send(res, 200, { ok: true, image });
    }

    if (method === 'DELETE') {
      const deleted = await deleteProductImage(
        process.env.DATABASE_URL,
        productId,
        query.get('imageId')
      );
      return send(res, 200, { ok: true, deleted });
    }

    res.setHeader('Allow', 'GET, POST, PUT, DELETE');
    return send(res, 405, { ok: false, error: 'Method not allowed' });
  } catch (error) {
    console.error('[CATALOGUE IMAGE]', error instanceof Error ? error.message : error);
    const message = publicError(error);
    const status = message.includes('not found') || message.includes('Invalid') || message.includes('Unsupported') || message.includes('exceeds') || message.includes('empty') || message.includes('required') || message.includes('does not match') ? 400 : 500;
    return send(res, status, { ok: false, error: message });
  }
}

module.exports = handler;
module.exports.timingSafeTokenMatch = timingSafeTokenMatch;
module.exports.readBody = readBody;
