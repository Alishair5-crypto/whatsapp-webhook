// Voice-note compatibility wrapper.
// Keeps the verified voice pipeline intact and adds a TTS/text Urdu normalization
// layer. Original AI reasoning/history is untouched; memory is an additive wrapper.
const { AsyncLocalStorage } = require('async_hooks');
const { getMemoryContext, remember } = require('../zara-memory');
const { getCatalogueForMessage, primaryImage, allImages } = require('../catalogue/agent');
const originalFetch = globalThis.fetch;
const memoryContext = new AsyncLocalStorage();
const URDU_NORMALIZATION = [['مارینا', 'مرینہ'], ['مارینا فیبرک', 'مرینہ فیبرک'], ['ویلٹ', 'ویلویٹ'], ['ویلویٹ', 'ویلویٹ'], ['فابریکس', 'فیبرکس'], ['فابریک', 'فیبرک'], ['فیبرکس', 'فیبرکس'], ['سوٹس', 'سوٹس'], ['سوٹ', 'سوٹ'], ['رچ', 'شاندار'], ['پریمیم', 'اعلیٰ معیار کا'], ['کوالٹی', 'معیار'], ['کلر', 'رنگ'], ['کلرز', 'رنگ'], ['ڈیزائن', 'ڈیزائن'], ['پرنٹڈ', 'پرنٹ شدہ'], ['ایمبروئیڈری', 'کڑھائی'], ['ایمبروئیڈرڈ', 'کڑھائی والا'], ['کلیکشن', 'کلیکشن'], ['آرڈر', 'آرڈر'], ['ایویلیبل', 'دستیاب'], ['ایویلیبل ہیں', 'دستیاب ہیں'], ['براہ کرم', 'براہِ کرم'], ['مہربانی کر کے', 'مہربانی کرکے'], ['آپکو', 'آپ کو'], ['آپکے', 'آپ کے'], ['آپکی', 'آپ کی'], ['اسکے', 'اس کے'], ['اسکی', 'اس کی'], ['انکے', 'ان کے'], ['انکی', 'ان کی'], ['کہتےہیں', 'کہتے ہیں'], ['چاہتےہیں', 'چاہتے ہیں'], ['ہیں—', 'ہیں — '], ['ہے—', 'ہے — ']];
function normalizeUrdu(text) { if (typeof text !== 'string' || !text) return text; let out = text.normalize('NFC'); for (const [from, to] of URDU_NORMALIZATION) out = out.split(from).join(to); out = out.replace(/[\u200B-\u200D\uFEFF]/g, ''); return out.replace(/\s{2,}/g, ' ').trim(); }
function normalizeUrduText(text) { if (typeof text !== 'string' || !text) return text; let out = text.normalize('NFC'); for (const [from, to] of URDU_NORMALIZATION) out = out.split(from).join(to); return out.replace(/[\u200B-\u200D\uFEFF]/g, ''); }
function isElevenLabsTTS(url) { return url && url.includes('api.elevenlabs.io/v1/text-to-speech/'); }
function isWhatsAppSend(url) { return url && /graph\.facebook\.com\/v\d+\.\d+\//.test(url) && /\/messages(?:\?|$)/.test(url); }
function isChatCompletion(url) { return url && /\/chat\/completions(?:\?|$)/.test(url); }
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
async function sendCatalogueImages(ctx, headers) {
  if (!ctx?.catalogue?.wantsImages || !ctx?.catalogue?.products?.length || ctx.catalogueImagesSent) return;
  if (!ctx.phone || !process.env.WHATSAPP_TOKEN || !process.env.PHONE_NUMBER_ID) return;
  const isComplete = Boolean(ctx.catalogue.completeCatalogue); const selected = []; const urls = new Set();
  for (const product of ctx.catalogue.products) {
    const productUrls = allImages(product);
    for (const url of productUrls) { if (!url || urls.has(url) || !/^https:\/\//i.test(url)) continue; urls.add(url); selected.push({ product, url }); }
  }
  if (!selected.length) return;
  ctx.catalogueImagesSent = true;
  for (const item of selected) {
    try {
      const price = Number(item.product?.price); const priceText = Number.isFinite(price) ? `${item.product?.currency || 'PKR'} ${price.toLocaleString('en-PK')}` : ''; const caption = `${item.product?.name || 'Product'}${priceText ? ` — ${priceText}` : ''}`.slice(0, 1024);
      const response = await originalFetch(`https://graph.facebook.com/v20.0/${process.env.PHONE_NUMBER_ID}/messages`, { method: 'POST', headers, body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: ctx.phone, type: 'image', image: { link: item.url, caption } }) });
      if (response.ok) console.log('[CATALOGUE IMAGE] Sent:', item.product?.name || item.url); else console.error('[CATALOGUE IMAGE] Send failed:', (await response.text()).slice(0, 300));
    } catch (error) { console.error('[CATALOGUE IMAGE] Error:', error.message); }
  }
}
if (originalFetch && !globalThis.__zaraVoiceFetchPatched) {
  globalThis.__zaraVoiceFetchPatched = true;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input?.url; const headers = new Headers(init.headers || (typeof input !== 'string' ? input.headers : undefined)); const ctx = memoryContext.getStore();
    if (ctx && (isChatCompletion(url) || (url && url.includes('generativelanguage.googleapis.com')))) init = await injectMemoryIntoAI(url, init, ctx);
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
        if (payload?.type === 'text' && typeof payload?.text?.body === 'string') { payload.text.body = normalizeUrduText(payload.text.body); if (ctx) ctx.aiReply = payload.text.body; const response = await originalFetch(input, { ...init, headers, body: JSON.stringify(payload) }); if (response.ok) { await maybeRemember(ctx); await sendCatalogueImages(ctx, headers); } return response; }
        if (payload?.type === 'audio' && ctx?.aiReply) { const response = await originalFetch(input, { ...init, headers }); if (response.ok) { await maybeRemember(ctx); await sendCatalogueImages(ctx, headers); } return response; }
      } catch (_) {}
    }
    return originalFetch(input, init);
  };
}
const originalHandler = require('../index.js');
module.exports = async (req, res) => {
  const body = req?.body && typeof req.body === 'object' ? req.body : {}; const message = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]; const contact = body?.entry?.[0]?.changes?.[0]?.value?.contacts?.find(c => c?.wa_id === message?.from) || body?.entry?.[0]?.changes?.[0]?.value?.contacts?.[0];
  const ctx = { phone: message?.from || '', msgId: message?.id || '', customerName: (contact?.profile?.name || '').trim(), userText: typeof message?.text?.body === 'string' ? message.text.body : '', aiReply: '', remembered: false, catalogueChecked: false, catalogue: null, catalogueImagesSent: false };
  return memoryContext.run(ctx, () => originalHandler(req, res));
};