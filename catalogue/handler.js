'use strict';

// Isolated catalogue HTTP handler. It is intentionally NOT wired into the
// existing Zara webhook route yet. Activation requires an explicit routing
// change so the current production execution path remains untouched.

const crypto = require('crypto');
const { searchCatalogue } = require('./catalogue');

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function safeEqual(a, b) {
  if (!a || !b) return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function authorized(req) {
  const configured = process.env.CATALOGUE_API_TOKEN;
  if (!configured) return false;
  const header = req.headers?.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return Boolean(match && safeEqual(match[1], configured));
}

function queryValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return json(res, 405, { ok: false, error: 'Method not allowed' });
  }

  if (!authorized(req)) {
    return json(res, 401, { ok: false, error: 'Unauthorized' });
  }

  const query = req.query || {};
  const filters = {
    fabric: queryValue(query.fabric),
    color: queryValue(query.color),
    collection: queryValue(query.collection),
    name: queryValue(query.name),
    limit: queryValue(query.limit)
  };

  try {
    const products = await searchCatalogue(process.env.DATABASE_URL, filters);
    return json(res, 200, { ok: true, count: products.length, products });
  } catch (error) {
    console.error('[CATALOGUE SEARCH]', error.message);
    return json(res, 500, { ok: false, error: 'Catalogue search failed' });
  }
}

module.exports = handler;
