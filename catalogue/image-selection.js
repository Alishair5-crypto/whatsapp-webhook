'use strict';

const { isIP } = require('node:net');

let sqlClient = null;
let schemaReady = false;

function getSql(dbUrl) {
  if (!dbUrl || !/^postgres(?:ql)?:\/\//i.test(dbUrl)) return null;
  try {
    if (!sqlClient) {
      const { neon } = require('@neondatabase/serverless');
      sqlClient = neon(dbUrl);
    }
    return sqlClient;
  } catch (error) {
    console.error('[IMAGE SELECTION DB INIT]', error.message);
    return null;
  }
}

async function ensureSchema(sql) {
  if (!sql) return false;
  if (schemaReady) return true;
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS zara_sent_catalogue_images (
        phone_number TEXT NOT NULL,
        batch_id TEXT NOT NULL,
        product_id TEXT,
        product_name TEXT NOT NULL,
        image_url TEXT NOT NULL,
        sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (phone_number, batch_id, image_url)
      )
    `;
    await sql`CREATE INDEX IF NOT EXISTS idx_zara_sent_catalogue_images_recent ON zara_sent_catalogue_images(phone_number, sent_at DESC)`;
    schemaReady = true;
    return true;
  } catch (error) {
    console.error('[IMAGE SELECTION SCHEMA]', error.message);
    return false;
  }
}

function cleanText(value, max = 180) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function safePublicImageUrl(value, allowedHosts = []) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  let url;
  try { url = new URL(value); } catch (_) { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return null;
  if (isIP(host)) {
    const parts = host.split('.').map(Number);
    if (host.includes(':') || parts[0] === 10 || parts[0] === 127 || parts[0] === 0 ||
        (parts[0] === 169 && parts[1] === 254) || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
        (parts[0] === 192 && parts[1] === 168) || parts[0] >= 224) return null;
    return null; // Catalogue images must use a named public host, not a literal IP.
  }
  const explicitlyAllowed = allowedHosts.some(item => {
    const allowed = String(item || '').trim().toLowerCase();
    return allowed && (host === allowed || host.endsWith('.' + allowed));
  });
  const vercelBlob = host.endsWith('.public.blob.vercel-storage.com');
  if (!explicitlyAllowed && !vercelBlob) return null;
  url.hash = '';
  return url;
}

async function recordSentCandidate(dbUrl, phone, batchId, product, imageUrl) {
  const sql = getSql(dbUrl);
  if (!sql || !phone || !batchId || !safePublicImageUrl(imageUrl, (process.env.ZARA_CATALOGUE_IMAGE_HOSTS || '').split(','))) return false;
  if (!(await ensureSchema(sql))) return false;
  try {
    await sql`
      INSERT INTO zara_sent_catalogue_images
        (phone_number, batch_id, product_id, product_name, image_url, sent_at)
      VALUES
        (${String(phone)}, ${String(batchId)}, ${product?.id == null ? null : String(product.id)},
         ${cleanText(product?.name) || 'Catalogue design'}, ${imageUrl}, NOW())
      ON CONFLICT (phone_number, batch_id, image_url) DO UPDATE SET
        product_id = EXCLUDED.product_id,
        product_name = EXCLUDED.product_name,
        sent_at = NOW()
    `;
    await sql`DELETE FROM zara_sent_catalogue_images WHERE sent_at < NOW() - INTERVAL '48 hours'`;
    return true;
  } catch (error) {
    console.error('[IMAGE SELECTION SAVE]', error.message);
    return false;
  }
}

async function getRecentCandidates(dbUrl, phone) {
  const sql = getSql(dbUrl);
  if (!sql || !phone || !(await ensureSchema(sql))) return [];
  try {
    const rows = await sql`
      SELECT product_id, product_name, image_url, sent_at
      FROM zara_sent_catalogue_images
      WHERE phone_number = ${String(phone)}
        AND sent_at >= NOW() - INTERVAL '24 hours'
        AND batch_id = (
          SELECT batch_id FROM zara_sent_catalogue_images
          WHERE phone_number = ${String(phone)}
            AND sent_at >= NOW() - INTERVAL '24 hours'
          GROUP BY batch_id
          ORDER BY MAX(sent_at) DESC
          LIMIT 1
        )
      ORDER BY sent_at ASC
      LIMIT 5
    `;
    return (rows || []).filter(row => safePublicImageUrl(row.image_url, (process.env.ZARA_CATALOGUE_IMAGE_HOSTS || '').split(',')))
      .map(row => ({ id: row.product_id == null ? '' : String(row.product_id), name: cleanText(row.product_name) || 'Catalogue design', url: row.image_url }));
  } catch (error) {
    console.error('[IMAGE SELECTION LOAD]', error.message);
    return [];
  }
}

async function fetchCandidateImagePart(url, allowedHosts = []) {
  const safeUrl = safePublicImageUrl(url, allowedHosts);
  if (!safeUrl) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3500);
  try {
    const response = await fetch(safeUrl.href, { signal: controller.signal, redirect: 'error', headers: { Accept: 'image/jpeg,image/png,image/webp' } });
    if (!response.ok) return null;
    const mimeType = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const expectedTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
    if (!expectedTypes.has(mimeType)) return null;
    const declaredLength = Number(response.headers.get('content-length') || 0);
    if (declaredLength > 5 * 1024 * 1024) return null;
    const reader = response.body?.getReader();
    if (!reader) return null;
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > 5 * 1024 * 1024) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(Buffer.from(value));
    }
    if (!total) return null;
    const bytes = Buffer.concat(chunks, total);
    const validSignature =
      (mimeType === 'image/jpeg' && bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) ||
      (mimeType === 'image/png' && bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) ||
      (mimeType === 'image/webp' && bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP');
    if (!validSignature) return null;
    return { inlineData: { mimeType, data: bytes.toString('base64') } };
  } catch (error) {
    if (error?.name !== 'AbortError') console.error('[IMAGE SELECTION FETCH]', error.message);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { safePublicImageUrl, recordSentCandidate, getRecentCandidates, fetchCandidateImagePart };
