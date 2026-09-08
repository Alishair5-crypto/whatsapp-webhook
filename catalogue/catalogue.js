'use strict';

// Zara Catalogue v1: isolated runtime catalogue access.
// This module does not import or modify index.js.

function getSql(dbUrl) {
  if (!dbUrl || !dbUrl.startsWith('postgres')) return null;
  try {
    if (!global.__zaraCatalogueSql) {
      const { neon } = require('@neondatabase/serverless');
      global.__zaraCatalogueSql = require('@neondatabase/serverless').neon(dbUrl);
    }
    return global.__zaraCatalogueSql;
  } catch (e) {
    console.error('[CATALOGUE INIT]', e.message);
    return null;
  }
}

function clean(value, max = 120) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function positiveInt(value, fallback, max) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) return fallback;
  return Math.min(n, max);
}

async function searchCatalogue(dbUrl, filters = {}) {
  const sql = getSql(dbUrl);
  if (!sql) throw new Error('Catalogue database is not configured');

  const fabric = clean(filters.fabric);
  const color = clean(filters.color);
  const collection = clean(filters.collection);
  const name = clean(filters.name);
  const limit = positiveInt(filters.limit, 5, 20);

  const rows = await sql`
    SELECT
      p.id,
      p.name,
      p.collection,
      p.fabric,
      p.color,
      p.price,
      p.currency,
      p.description,
      i.stock_quantity,
      COALESCE(
        json_agg(
          json_build_object(
            'url', ci.image_url,
            'altText', ci.alt_text,
            'isPrimary', ci.is_primary,
            'sortOrder', ci.sort_order
          ) ORDER BY ci.is_primary DESC, ci.sort_order ASC, ci.id ASC
        ) FILTER (WHERE ci.id IS NOT NULL),
        '[]'::json
      ) AS images
    FROM catalog_products p
    JOIN catalog_inventory i ON i.product_id = p.id
    LEFT JOIN catalog_images ci ON ci.product_id = p.id
    WHERE p.status = 'active'
      AND i.stock_quantity > 0
      AND (${fabric} = '' OR LOWER(p.fabric) = LOWER(${fabric}))
      AND (${color} = '' OR LOWER(p.color) = LOWER(${color}))
      AND (${collection} = '' OR LOWER(p.collection) = LOWER(${collection}))
      AND (${name} = '' OR LOWER(p.name) LIKE LOWER(${`%${name}%`}))
    GROUP BY p.id, i.stock_quantity
    ORDER BY p.updated_at DESC, p.id DESC
    LIMIT ${limit}
  `;

  return rows || [];
}

module.exports = { searchCatalogue };
