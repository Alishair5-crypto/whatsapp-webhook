const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const requestContext = new AsyncLocalStorage();
const originalFetch = global.fetch;
const inner = require('./index.js');

function explicitConfirmation(text) {
  const s = String(text || '').toLowerCase().replace(/[.!?,]/g, ' ');
  return /(^|\s)(yes|yup|yeah|confirm|confirmed|ok|okay|haan|han|ji|bilkul|theek|thik|done|proceed)(\s|$)/i.test(s) ||
    /order\s+(confirm|kar|kardo|kardain|kar dein|bhej|bhej dein)/i.test(s) ||
    /(kar\s+dein|kar\s+do|bhej\s+dein|bhej\s+do)/i.test(s) || /(^|\s)(ہاں|جی|تصدیق|ٹھیک|ٹھیک ہے|کر دیں|آرڈر کر دیں)(\s|$)/u.test(s);
}

function validateRow(row) {
  if (!Array.isArray(row) || row.length < 10) return 'invalid_row_shape';
  const [, name, phone, product, qty, price, payment, address, city] = row;
  if (![name, phone, product, qty, price, payment, address, city].every(v => String(v ?? '').trim())) return 'missing_order_field';
  if (!Number.isInteger(Number(qty)) || Number(qty) < 1 || Number(qty) > 1000) return 'invalid_qty';
  const p = Number(String(price).replace(/,/g, ''));
  if (!Number.isFinite(p) || p <= 0 || p > 10000000) return 'invalid_price';
  if (!['cod', 'jazzcash', 'easypaisa'].includes(String(payment).trim().toLowerCase())) return 'invalid_payment';
  if (String(address).trim().length < 8) return 'invalid_address';
  if (String(city).trim().length < 2) return 'invalid_city';
  return null;
}

// Install once. AsyncLocalStorage keeps each webhook's order context isolated,
// including work continued through Vercel waitUntil().
if (!global.__orderSaveGuardInstalled) {
  global.__orderSaveGuardInstalled = true;
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const ctx = requestContext.getStore();

    if (ctx && u.includes('api.groq.com/openai/v1/audio/transcriptions')) {
      const transcriptionResponse = await originalFetch(url, opts);
      try {
        const data = await transcriptionResponse.clone().json();
        if (data?.text) ctx.confirmed = explicitConfirmation(data.text);
      } catch (_) {}
      return transcriptionResponse;
    }

    if (ctx && u.includes('sheets.googleapis.com/v4/spreadsheets/') && u.includes('/values/Sheet1!A:J:append')) {
      if (!ctx.confirmed) {
        console.warn('[ORDER GUARD] customer confirmation missing msg=', ctx.messageId || 'unknown');
        return new Response(JSON.stringify({ error: { code: 400, message: 'Order confirmation required' } }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      let payload;
      try { payload = JSON.parse(opts.body || '{}'); } catch (_) { payload = null; }
      const row = payload?.values?.[0];
      const validationError = validateRow(row);
      if (validationError) {
        console.error('[ORDER GUARD]', validationError, 'msg=', ctx.messageId || 'unknown');
        return new Response(JSON.stringify({ error: { code: 400, message: validationError } }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      const orderId = crypto.createHash('sha256')
        .update(`${ctx.phone}:${ctx.messageId}`)
        .digest('hex')
        .slice(0, 24);

      const auth = opts.headers?.Authorization || opts.headers?.authorization;
      const checkUrl = u.replace('/values/Sheet1!A:J:append', '/values/Sheet1!K:K');
      const check = await originalFetch(checkUrl, { headers: { Authorization: auth } });
      if (!check.ok) {
        console.error('[ORDER GUARD] duplicate check failed', check.status, 'msg=', ctx.messageId || 'unknown');
        return check;
      }

      const existing = (await check.json())?.values || [];
      if (existing.some(r => String(r?.[0] || '') === orderId)) {
        console.log('[ORDER GUARD] duplicate skipped msg=', ctx.messageId || 'unknown');
        return new Response(JSON.stringify({ updates: { updatedRows: 0 }, duplicate: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      payload.values[0] = [...row, orderId];
      const appendUrl = u.replace('/values/Sheet1!A:J:append', '/values/Sheet1!A:K:append');
      return originalFetch(appendUrl, { ...opts, body: JSON.stringify(payload) });
    }

    return originalFetch(url, opts);
  };
}

module.exports = async (req, res) => {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (_) {}
  }

  const message = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  const text = message?.type === 'text' ? message?.text?.body || '' : '';
  const context = {
    messageId: message?.id || '',
    phone: message?.from || '',
    confirmed: message?.type === 'text' ? explicitConfirmation(text) : false
  };

  return requestContext.run(context, () => inner(req, res));
};
