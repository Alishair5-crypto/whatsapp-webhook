// Voice-note compatibility wrapper.
// Keeps the verified voice pipeline intact and adds a TTS/text Urdu normalization
// layer. Original AI reasoning/history is untouched; memory is an additive wrapper.
const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('async_hooks');
const { getMemoryContext, remember } = require('../zara-memory');
const { getCatalogueForMessage, primaryImage, allImages } = require('../catalogue/agent');
const originalFetch = globalThis.fetch;
const memoryContext = new AsyncLocalStorage();
const catalogueRotation = new Map();
const URDU_NORMALIZATION = [['مارینا', 'مرینہ'], ['مارینا فیبرک', 'مرینہ فیبرک'], ['ویلٹ', 'ویلویٹ'], ['ویلویٹ', 'ویلویٹ'], ['فابریکس', 'فیبرکس'], ['فابریک', 'فیبرک'], ['فیبرکس', 'فیبرکس'], ['سوٹس', 'سوٹس'], ['سوٹ', 'سوٹ'], ['رچ', 'شاندار'], ['پریمیم', 'اعلیٰ معیار کا'], ['کوالٹی', 'معیار'], ['کلر', 'رنگ'], ['کلرز', 'رنگ'], ['ڈیزائن', 'ڈیزائن'], ['پرنٹڈ', 'پرنٹ شدہ'], ['ایمبروئیڈری', 'کڑھائی'], ['ایمبروئیڈرڈ', 'کڑھائی والا'], ['کلیکشن', 'کلیکشن'], ['آرڈر', 'آرڈر'], ['ایویلیبل', 'دستیاب'], ['ایویلیبل ہیں', 'دستیاب ہیں'], ['براہ کرم', 'براہِ کرم'], ['مہربانی کر کے', 'مہربانی کرکے'], ['آپکو', 'آپ کو'], ['آپکے', 'آپ کے'], ['آپکی', 'آپ کی'], ['اسکے', 'اس کے'], ['اسکی', 'اس کی'], ['انکے', 'ان کے'], ['انکی', 'ان کی'], ['کہتےہیں', 'کہتے ہیں'], ['چاہتےہیں', 'چاہتے ہیں'], ['ہیں—', 'ہیں — '], ['ہے—', 'ہے — ']];
function normalizeUrdu(text) { if (typeof text !== 'string' || !text) return text; let out = text.normalize('NFC'); for (const [from, to] of URDU_NORMALIZATION) out = out.split(from).join(to); out = out.replace(/[\u200B-\u200D\uFEFF]/g, ''); return out.replace(/\s{2,}/g, ' ').trim(); }
function normalizeUrduText(text) { if (typeof text !== 'string' || !text) return text; let out = text.normalize('NFC'); for (const [from, to] of URDU_NORMALIZATION) out = out.split(from).join(to); return out.replace(/[\u200B-\u200D\uFEFF]/g, ''); }
function isElevenLabsTTS(url) { return url && url.includes('api.elevenlabs.io/v1/text-to-speech/'); }
function isWhatsAppSend(url) { return url && /graph\.facebook\.com\/v\d+\.\d+\//.test(url) && /\/messages(?:\?|$)/.test(url); }
function isChatCompletion(url) { return url && /\/chat\/completions(?:\?|$)/.test(url); }
function isGoogleSheetsAppend(url) { return url && /sheets\.googleapis\.com\/v4\/spreadsheets\/[^/]+\/values\/Sheet1!A:J:append(?:\?|$)/.test(url); }
async function fetchGoogleSheetsWithRetry(input, init = {}, ctx = null) {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const response = await originalFetch(input, init);
    if (response.ok) { if (ctx) ctx.orderSheetWriteSucceeded = true; return response; }
    const retryable = [408, 429, 500, 502, 503, 504].includes(response.status);
    if (!retryable || attempt === maxAttempts) {
      let detail = '';
      try { detail = (await response.clone().text()).slice(0, 1000); } catch (_) {}
      throw new Error(`[SHEET APPEND] HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
    }
    const retryAfter = Number(response.headers.get('retry-after'));
    const delayMs = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 10000) : attempt * 1500;
    console.warn(`[SHEET APPEND] Retry ${attempt + 1}/${maxAttempts} after HTTP ${response.status}`);
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  throw new Error('[SHEET APPEND] Exhausted retries');
}
function normalizeRecoveredOrder(order, phone) {
  if (!order || !phone) return null;
  const out = { name: String(order.name || '').trim(), product: String(order.product || '').trim(), qty: String(order.qty || '').trim(), price: String(order.price || '').replace(/[^\d.]/g, '').trim(), payment: String(order.payment || '').trim(), address: normalizeUrduText(String(order.address || '').trim()), city: normalizeUrduText(String(order.city || '').trim()) };
  if (!out.name || !out.product || !out.qty || !out.price || !out.payment || !out.address || !out.city) return null;
  if (!/^\d+(?:\.\d+)?$/.test(out.qty) || Number(out.qty) < 1 || Number(out.qty) > 100) return null;
  if (!/^\d+(?:\.\d+)?$/.test(out.price) || Number(out.price) <= 0 || Number(out.price) > 1000000) return null;
  if (!/^(?:cod|cash on delivery|jazzcash|easypaisa)$/i.test(out.payment)) return null;
  if (out.address.length < 8 || out.address.length > 500 || out.city.length < 2 || out.city.length > 80) return null;
  return out;
}
async function getServiceAccountToken(email, key) {
  if (!email || !key) return null;
  try {
    const now = Math.floor(Date.now() / 1000); const b64 = value => Buffer.from(value).toString('base64url');
    const header = b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const payload = b64(JSON.stringify({ iss: email, scope: 'https://www.googleapis.com/auth/spreadsheets', aud: 'https://oauth2.googleapis.com/token', exp: now + 3600, iat: now }));
    const signer = crypto.createSign('RSA-SHA256'); signer.update(`${header}.${payload}`);
    const signature = signer.sign(key.replace(/\\n/g, '\n'), 'base64url');
    const response = await originalFetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${header}.${payload}.${signature}` });
    const data = await response.json().catch(() => null); return data?.access_token || null;
  } catch (error) { console.error('[ORDER RECOVERY TOKEN]', error.message); return null; }
}
async function recoverConfirmedOrder(ctx) {
  if (!ctx?.phone || !ctx.userText || !process.env.GEMINI_API_KEY || ctx.orderSheetWriteSucceeded) return null;
  if (!process.env.GOOGLE_SHEETS_ID || !process.env.GOOGLE_SA_EMAIL || !process.env.GOOGLE_SA_KEY) return null;
  if (/\[ORDER:/i.test(ctx.aiReply || '')) return null;
  try {
    const memory = await getMemoryContext(process.env.DATABASE_URL || '', ctx.phone, ctx.userText);
    const prompt = `Extract an order ONLY if the customer has explicitly confirmed every required field. Required: name, product, qty, price, payment (COD/JazzCash/EasyPaisa), full delivery address, city. Never infer missing fields. Return ONLY JSON or null with keys name, product, qty, price, payment, address, city. Customer message: ${ctx.userText}\nZara reply: ${ctx.aiReply}\nRelevant saved conversation context: ${String(memory || '').slice(-7000)}`;
    const response = await originalFetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${process.env.GEMINI_API_KEY}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ system_instruction: { parts: [{ text: 'You are a strict order validator. Never guess. Return JSON only.' }] }, contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature: 0, maxOutputTokens: 300, responseMimeType: 'application/json' } }) });
    if (!response.ok) return null;
    const data = await response.json(); const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!raw || raw === 'null') return null;
    const order = normalizeRecoveredOrder(JSON.parse(raw), ctx.phone); if (!order) return null;
    const token = await getServiceAccountToken(process.env.GOOGLE_SA_EMAIL.trim(), process.env.GOOGLE_SA_KEY.trim()); if (!token) return null;
    const row = [new Date().toLocaleString('en-PK', { timeZone: 'Asia/Karachi' }), order.name, ctx.phone, order.product, order.qty, order.price, order.payment, order.address, order.city, 'Pending'];
    const sheetUrl = `https://sheets.googleapis.com/v4/spreadsheets/${process.env.GOOGLE_SHEETS_ID.trim()}/values/Sheet1!A:J:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
    const appendResponse = await fetchGoogleSheetsWithRetry(sheetUrl, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ values: [row] }) }, null);
    const result = await appendResponse.json().catch(() => null);
    if (Number(result?.updates?.updatedRows || 0) < 1) { console.error('[ORDER RECOVERY] Sheets returned no updated row'); return null; }
    console.log('[ORDER RECOVERY] Confirmed order saved to Google Sheets:', order.name, order.product, order.qty); return order;
  } catch (error) { console.error('[ORDER RECOVERY] Failed:', error.message); return null; }
}
async function injectMemoryIntoAI(url, init, ctx) {
  if (!ctx || !init || typeof init.body !== 'string') return init; let payload; try { payload = JSON.parse(init.body); } catch (_) { return init; } if (!ctx.phone) return init;
  let query = ctx.userText || ''; try { const last = payload?.contents?.[payload.contents.length - 1]?.parts?.[0]?.text; if (typeof last === 'string') query = last; } catch (_) {}
  if (!query) { try { const last = payload?.messages?.[payload.messages.length - 1]?.content; if (typeof last === 'string') query = last; } catch (_) {} }
  if (query) ctx.userText = query.replace(/^Customer name:\s*[^\n]+\n/i, '').trim();
  if (!ctx.catalogueChecked && ctx.userText) { ctx.catalogueChecked = true; ctx.catalogue = await getCatalogueForMessage(process.env.DATABASE_URL || '', ctx.userText); }
  const memory = await getMemoryContext(process.env.DATABASE_URL || '', ctx.phone, ctx.userText); const catalogueContext = ctx.catalogue?.context || ''; if (!memory && !catalogueContext) return init;
  if (Array.isArray(payload.contents)) { const system = payload.system_instruction?.parts?.[0]?.text; if (typeof system === 'string') payload.system_instruction.parts[0].text = system + (memory || '') + catalogueContext; }
  if (Array.isArray(payload.messages)) { const systemIndex = payload.messages.findIndex(m => m?.role === 'system'); if (systemIndex >= 0 && typeof payload.messages[systemIndex].content === 'string') payload.messages[systemIndex].content += (memory || '') + catalogueContext; }
  return { ...init, body: JSON.stringify(payload) };
}
async function maybeRemember(ctx) { if (!ctx || ctx.remembered || !ctx.phone || !ctx.msgId || !ctx.userText || !ctx.aiReply) return; ctx.remembered = true; await remember(process.env.DATABASE_URL || '', ctx.phone, ctx.msgId, ctx.userText, ctx.aiReply, ctx.customerName); }
function rotateProducts(products, phone) { if (!Array.isArray(products) || products.length < 2 || !phone) return products || []; const previous = catalogueRotation.get(phone) || 0; const offset = previous % products.length; catalogueRotation.set(phone, (offset + 1) % products.length); return products.slice(offset).concat(products.slice(0, offset)); }
async function sendCatalogueImages(ctx, headers) {
  if (!ctx?.catalogue?.wantsImages || !ctx?.catalogue?.products?.length || ctx.catalogueImagesSent) return;
  if (!ctx.phone || !process.env.WHATSAPP_TOKEN || !process.env.PHONE_NUMBER_ID) return;
  const products = rotateProducts(ctx.catalogue.products, ctx.phone); const selected = []; const urls = new Set();
  for (const product of products) { const productUrls = allImages(product); for (const url of productUrls) { if (!url || urls.has(url) || !/^https:\/\//i.test(url)) continue; urls.add(url); selected.push({ product, url }); } }
  if (!selected.length) return; ctx.catalogueImagesSent = true; console.log('[CATALOGUE] Sending relevant image set:', selected.length, 'images');
  for (const item of selected) {
    try { const price = Number(item.product?.price); const priceText = Number.isFinite(price) ? `${item.product?.currency || 'PKR'} ${price.toLocaleString('en-PK')}` : ''; const caption = `${item.product?.name || 'Product'}${priceText ? ` — ${priceText}` : ''}`.slice(0, 1024); const response = await originalFetch(`https://graph.facebook.com/v20.0/${process.env.PHONE_NUMBER_ID}/messages`, { method: 'POST', headers, body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: ctx.phone, type: 'image', image: { link: item.url, caption } }) }); if (response.ok) console.log('[CATALOGUE IMAGE] Sent:', item.product?.name || item.url); else console.error('[CATALOGUE IMAGE] Send failed:', (await response.text()).slice(0, 300)); } catch (error) { console.error('[CATALOGUE IMAGE] Error:', error.message); }
  }
}
if (originalFetch && !globalThis.__zaraVoiceFetchPatched) {
  globalThis.__zaraVoiceFetchPatched = true;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input?.url; const headers = new Headers(init.headers || (typeof input !== 'string' ? input.headers : undefined)); const ctx = memoryContext.getStore();
    if (ctx && (isChatCompletion(url) || (url && url.includes('generativelanguage.googleapis.com')))) init = await injectMemoryIntoAI(url, init, ctx);
    if (isGoogleSheetsAppend(url)) { if (ctx) ctx.orderSheetWriteAttempted = true; try { return await fetchGoogleSheetsWithRetry(input, { ...init, headers }, ctx); } catch (error) { if (ctx) ctx.orderSheetWriteSucceeded = false; throw error; } }
    if (isElevenLabsTTS(url)) {
      headers.set('Accept', 'audio/mpeg'); let body = init.body;
      if (typeof body === 'string') { try { const payload = JSON.parse(body); payload.model_id = 'eleven_v3'; payload.language_code = 'ur'; if (typeof payload.text === 'string') { payload.text = normalizeUrdu(payload.text); if (ctx) ctx.aiReply = payload.text; } body = JSON.stringify(payload); } catch (_) {} }
      const response = await originalFetch(input, { ...init, headers, body });
      if (!response.ok) { try { const errorBody = await response.clone().text(); const requestId = response.headers.get('request-id') || response.headers.get('x-request-id') || null; console.error('[ELEVENLABS HTTP ERROR]', JSON.stringify({ status: response.status, contentType: response.headers.get('content-type') || null, requestId, body: errorBody.slice(0, 2000) })); } catch (e) { console.error('[ELEVENLABS HTTP ERROR] Failed to read error body:', e.message); } }
      return response;
    }
    if (isWhatsAppSend(url) && typeof init.body === 'string') {
      try {
        const payload = JSON.parse(init.body);
        if (payload?.type === 'text' && typeof payload?.text?.body === 'string') { payload.text.body = normalizeUrduText(payload.text.body); if (ctx) ctx.aiReply = payload.text.body; const response = await originalFetch(input, { ...init, headers, body: JSON.stringify(payload) }); if (response.ok) { await maybeRemember(ctx); await recoverConfirmedOrder(ctx); await sendCatalogueImages(ctx, headers); } return response; }
        if (payload?.type === 'audio' && ctx?.aiReply) { const response = await originalFetch(input, { ...init, headers }); if (response.ok) { await maybeRemember(ctx); await recoverConfirmedOrder(ctx); await sendCatalogueImages(ctx, headers); } return response; }
      } catch (_) {}
    }
    return originalFetch(input, init);
  };
}
const originalHandler = require('../index.js');
module.exports = async (req, res) => {
  const body = req?.body && typeof req.body === 'object' ? req.body : {}; const message = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]; const contact = body?.entry?.[0]?.changes?.[0]?.value?.contacts?.find(c => c?.wa_id === message?.from) || body?.entry?.[0]?.changes?.[0]?.value?.contacts?.[0];
  const ctx = { phone: message?.from || '', msgId: message?.id || '', customerName: (contact?.profile?.name || '').trim(), userText: typeof message?.text?.body === 'string' ? message.text.body : '', aiReply: '', remembered: false, catalogueChecked: false, catalogue: null, catalogueImagesSent: false, orderSheetWriteAttempted: false, orderSheetWriteSucceeded: false };
  return memoryContext.run(ctx, () => originalHandler(req, res));
};
