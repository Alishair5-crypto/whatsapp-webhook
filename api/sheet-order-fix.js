// Orders Sheet adapter for Zara/Fatima Arts.
// Keeps the existing AI, memory, WhatsApp and catalogue code unchanged.
// Converts the legacy 10-column order payload into the actual 12-column Orders sheet.
const crypto = require('node:crypto');

const TARGET_SHEET_ID = '1JTMYJsWj2ZgMBKlI-p0ghXQuLcDJsK9E5_7d-_nPg28';
const SHEETS_HOST = 'sheets.googleapis.com';
const legacyAppend = /https:\/\/sheets\.googleapis\.com\/v4\/spreadsheets\/[^/]+\/values\/Sheet1!A:J:append(?:\?|$)/i;

const originalFetch = globalThis.fetch;

function makeOrderId(row) {
  const stable = [row?.[1], row?.[2], row?.[3], row?.[4], row?.[5], row?.[6], row?.[7], row?.[8]]
    .map(v => String(v ?? '').trim().toLowerCase())
    .join('|');
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

  // Actual Orders sheet:
  // A Order ID | B Date | C Customer Name | D Contact Number | E Product Name
  // F Quantity | G Size | H Color | I Total Amount | J Address
  // K Payment Method | L Status
  const fullAddress = [String(address).trim(), String(city).trim()]
    .filter(Boolean)
    .join(', ');
  const totalAmount = qty > 0 && unitPrice > 0 ? qty * unitPrice : unitPrice;

  return [
    makeOrderId(row),
    date,
    name,
    phone,
    product,
    qty || row[4] || '',
    '', // Size — all Fatima Arts products are unstitched.
    '', // Color — legacy order tag does not contain a confirmed color.
    totalAmount,
    fullAddress,
    payment,
    status
  ];
}

function targetUrl(url) {
  const parsed = new URL(url);
  parsed.hostname = SHEETS_HOST;
  parsed.pathname = `/v4/spreadsheets/${TARGET_SHEET_ID}/values/Sheet1!A:L:append`;
  return parsed.toString();
}

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input?.url;

  if (url && legacyAppend.test(url) && String(init?.method || 'GET').toUpperCase() === 'POST') {
    let payload;
    try {
      payload = typeof init.body === 'string' ? JSON.parse(init.body) : null;
    } catch (_) {
      payload = null;
    }

    if (Array.isArray(payload?.values)) {
      payload.values = payload.values.map(convertRow);
      const rewrittenUrl = targetUrl(url);
      console.log('[ORDER SHEET FIX] Legacy A:J → actual A:L Orders schema');
      console.log('[ORDER SHEET FIX] Target sheet:', TARGET_SHEET_ID);
      return originalFetch(rewrittenUrl, { ...init, body: JSON.stringify(payload) });
    }
  }

  return originalFetch(input, init);
};

// Load the existing production handler after the adapter is installed.
// api/index.js still provides the existing memory/catalogue/voice behaviour.
module.exports = require('./index.js');
