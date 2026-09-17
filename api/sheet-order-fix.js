// Targeted production adapter for Zara/Fatima Arts.
// Keeps the existing AI, memory, WhatsApp, voice and catalogue flow unchanged.
// 1) Normalizes legacy A:J order writes into the actual A:L Orders schema.
// 2) Uses GOOGLE_SHEETS_ID instead of silently forcing a different spreadsheet.
// 3) Logs the final Zara reply transcript.
// 4) Hard-bans garment-size claims because Fatima Arts products are unstitched.
// 5) Records Zara replies for the targeted unfinished-chat follow-up timer.
const crypto = require('node:crypto');
const { waitUntil } = require('@vercel/functions');
const { recordZaraReply } = require('../lib/followup-store');

const TARGET_SHEET_ID = String(process.env.GOOGLE_SHEETS_ID || '1JTMYJsWj2ZgMBKlI-p0ghXQuLcDJsK9E5_7d-_nPg28').trim();
const SHEETS_HOST = 'sheets.googleapis.com';
const legacyAppend = /https:\/\/sheets\.googleapis\.com\/v4\/spreadsheets\/[^/]+\/values\/Sheet1!A:J:append(?:\?|$)/i;
const whatsappSend = /graph\.facebook\.com\/v\d+\.\d+\/\d+\/messages(?:\?|$)/i;
const elevenLabsTTS = /api\.elevenlabs\.io\/v1\/text-to-speech\//i;

const originalFetch = globalThis.fetch;

function makeOrderId(row) {
  const stable = [row?.[1], row?.[2], row?.[3], row?.[4], row?.[5], row?.[6], row?.[7], row?.[8]]
    .map(v => String(v ?? '').trim().toLowerCase()).join('|');
  const digest = crypto.createHash('sha256').update(stable).digest('hex').slice(0, 10).toUpperCase();
  return `FA-${digest}`;
}

function convertRow(row) {
  if (!Array.isArray(row) || row.length < 10) return row;
  const date = row[0] || '';
  const name = row[1] || '';
  const phone = row[2] || '';
  const product = row[3] || '';
  const qty = Number(String(row[4] ?? '').replace(/[^\d.]/g, '')) || 0;
  const unitPrice = Number(String(row[5] ?? '').replace(/[^\d.]/g, '')) || 0;
  const payment = row[6] || '';
  const address = row[7] || '';
  const city = row[8] || '';
  const status = row[9] || 'Pending';
  const fullAddress = [String(address).trim(), String(city).trim()].filter(Boolean).join(', ');
  const totalAmount = qty > 0 && unitPrice > 0 ? qty * unitPrice : unitPrice;
  return [
    makeOrderId(row), date, name, phone, product, qty || row[4] || '',
    '', '', totalAmount, fullAddress, payment, status
  ];
}

function targetUrl(url) {
  const parsed = new URL(url);
  parsed.hostname = SHEETS_HOST;
  parsed.pathname = `/v4/spreadsheets/${TARGET_SHEET_ID}/values/Sheet1!A:L:append`;
  return parsed.toString();
}

function sanitizeZaraReply(text) {
  let out = String(text || '').trim();
  if (!out) return out;
  const sizePattern = /(?:\b(?:size|sizes|small|medium|large|extra\s*large|xl|xxl|s|m|l)\b|سائز|سائزز|چھوٹا سائز|درمیانہ سائز|بڑا سائز|سائز چارٹ|measurement|measurements|ماپ|پیمائش)/i;
  if (!sizePattern.test(out)) return out;
  const sentences = out.split(/(?<=[.!?۔؟])\s+/).filter(Boolean);
  const kept = sentences.filter(sentence => !sizePattern.test(sentence));
  const guard = 'یہ تمام فیبرک unstitched ہیں، اس لیے garment size applicable نہیں ہے۔';
  const cleaned = kept.join(' ').trim();
  console.warn('[SIZE BAN] Removed garment-size claim from Zara reply.');
  return cleaned ? `${cleaned} ${guard}` : guard;
}

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input?.url;

  if (url && legacyAppend.test(url) && String(init?.method || 'GET').toUpperCase() === 'POST') {
    let payload;
    try { payload = typeof init.body === 'string' ? JSON.parse(init.body) : null; } catch (_) { payload = null; }
    if (Array.isArray(payload?.values)) {
      payload.values = payload.values.map(convertRow);
      const rewrittenUrl = targetUrl(url);
      console.log('[ORDER SHEET TARGET]', TARGET_SHEET_ID);
      console.log('[ORDER SHEET WRITE] Legacy A:J normalized to A:L Orders schema');
      const response = await originalFetch(rewrittenUrl, { ...init, body: JSON.stringify(payload) });
      if (response.ok) console.log('[ORDER SHEET SUCCESS] Google Sheets append accepted.');
      else console.error('[ORDER SHEET FAIL] Google Sheets HTTP', response.status);
      return response;
    }
  }

  // Final outbound voice guard: sanitize the exact text before ElevenLabs and
  // therefore also before the existing Azure fallback receives it.
  if (url && elevenLabsTTS && typeof init.body === 'string') {
    let payload = null;
    try { payload = JSON.parse(init.body); } catch (_) {}
    if (payload && typeof payload.text === 'string') {
      payload.text = sanitizeZaraReply(payload.text);
      console.log('[ZARA REPLY]', payload.text);
      return originalFetch(input, { ...init, body: JSON.stringify(payload) });
    }
  }

  if (url && whatsappSend && typeof init.body === 'string' && String(init?.method || 'POST').toUpperCase() === 'POST') {
    let payload = null;
    try { payload = JSON.parse(init.body); } catch (_) {}

    if (payload?.type === 'text' && typeof payload?.text?.body === 'string' && payload?.to) {
      const phone = String(payload.to).trim();
      payload.text.body = sanitizeZaraReply(payload.text.body);
      console.log('[ZARA REPLY]', payload.text.body);
      const response = await originalFetch(input, { ...init, body: JSON.stringify(payload) });
      if (response.ok) waitUntil(recordZaraReply(phone, '', payload.text.body));
      else console.error('[ZARA REPLY SEND FAIL]', response.status);
      return response;
    }

    if (payload?.type === 'audio' && payload?.to) {
      const phone = String(payload.to).trim();
      const response = await originalFetch(input, init);
      if (response.ok) waitUntil(recordZaraReply(phone, '', 'voice reply'));
      return response;
    }
  }

  return originalFetch(input, init);
};

module.exports = require('./index.js');
